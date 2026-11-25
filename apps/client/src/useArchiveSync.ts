import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeServerEvents } from './api';
import { checkCopies, copyReady, localCatalog, mediaWork, pullCatalog, saveCopy } from './archive-catalog';
import { ArchiveHttpError } from './archive-transport';
import { LocalArchive, type ImportReport } from './nativeArchive';
import { isNativeAndroid, remoteOrigin } from './platform';
import { offlineMediaWorkerReady } from './pwa-register';

export function useArchiveSync(active: boolean) {
  const [message, setMessage] = useState('');
  const [report, setReport] = useState<ImportReport>();
  const request = useRef<(retry?: boolean) => void>(() => undefined);
  const retry = useCallback(() => request.current(true), []);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let running = false;
    let pending = false;
    let importNeeded = isNativeAndroid;
    let retryImport = false;
    let transfer: AbortController | undefined;
    let serverWake = 0;

    async function reconcile() {
      if (stopped || running || document.visibilityState === 'hidden') return;
      running = true;
      pending = false;
      transfer = new AbortController();
      const signal = transfer.signal;
      let remaining = 0;
      try {
        const local = await localCatalog();
        if (local) {
          await checkCopies(local);
          remaining = mediaWork(local).filter(({ media }) => !copyReady(media)).length;
        }
        if (!navigator.onLine) {
          setMessage(remaining ? '正在离线使用 · 待补齐 ' + remaining + ' 个文件' : '正在离线使用');
          return;
        }
        if (!isNativeAndroid && !offlineMediaWorkerReady()) {
          // Wait for the worker so a downloaded video can immediately be opened and seeked.
          setMessage('正在准备离线存储');
          return;
        }
        let catalog = await pullCatalog(signal);
        if (importNeeded) {
          setMessage('正在合并安卓原有下载');
          const result = await LocalArchive.importArchive({ origin: remoteOrigin, retry: retryImport });
          signal.throwIfAborted();
          setReport(result);
          retryImport = false;
          importNeeded = false;
          catalog = await pullCatalog(signal);
        }
        await checkCopies(catalog);
        const work = mediaWork(catalog).filter(({ media }) => !copyReady(media));
        remaining = work.length;
        let errors = 0;
        for (const { post, media } of work) {
          signal.throwIfAborted();
          const count = remaining;
          setMessage('正在保存本机副本 · 剩余 ' + count + ' 个文件');
          try {
            if (!isNativeAndroid && navigator.locks) {
              await navigator.locks.request('cobalt-copy-' + media.sha256, { signal }, () => saveCopy(post, media, catalog.chunkSize, signal));
            } else await saveCopy(post, media, catalog.chunkSize, signal);
            remaining--;
          } catch (error) {
            if (signal.aborted || isStorageError(error) || error instanceof ArchiveHttpError ||
                (error instanceof Error && /文件夹权限|重新选择下载位置/.test(error.message))) throw error;
            errors++;
          }
        }
        setMessage(errors ? '待补齐 ' + remaining + ' 个文件 · 将自动重试' : '');
      } catch (error) {
        if (signal.aborted || stopped) return;
        if (error instanceof ArchiveHttpError && error.status === 401) return;
        const detail = error instanceof Error ? error.message : String(error);
        if (isStorageError(error)) {
          const local = await localCatalog();
          if (local) remaining = mediaWork(local).filter(({ media }) => !copyReady(media)).length;
          setMessage('本机空间不足 · 已暂停 · 剩余 ' + remaining + ' 个文件');
        } else setMessage((remaining ? '待补齐 ' + remaining + ' 个文件 · ' : '') + detail);
      } finally {
        running = false;
        if (pending) void reconcile();
      }
    }

    const wake = () => {
      if (stopped) return;
      pending = true;
      void reconcile();
    };
    request.current = (manual) => {
      if (manual && isNativeAndroid) { importNeeded = true; retryImport = true; }
      wake();
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') transfer?.abort();
      else wake();
    };
    const offline = () => { transfer?.abort(); wake(); };
    const server = subscribeServerEvents(() => {
      window.dispatchEvent(new Event('archive-server-changed'));
      if (!serverWake) serverWake = window.setTimeout(() => {
        serverWake = 0;
        wake();
      }, 600);
    });
    const timer = window.setInterval(wake, 30_000);
    window.addEventListener('offline', offline);
    document.addEventListener('visibilitychange', visibility);
    navigator.serviceWorker?.addEventListener('controllerchange', wake);
    wake();
    return () => {
      stopped = true;
      transfer?.abort();
      request.current = () => undefined;
      window.clearTimeout(serverWake);
      window.clearInterval(timer);
      window.removeEventListener('offline', offline);
      document.removeEventListener('visibilitychange', visibility);
      navigator.serviceWorker?.removeEventListener('controllerchange', wake);
      void server.close().catch(() => undefined);
    };
  }, [active]);

  return { message, report, retry };
}

function isStorageError(error: unknown) {
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return true;
  const text = error instanceof Error ? error.message : String(error);
  return /ENOSPC|No space left|空间不足|QuotaExceededError/i.test(text);
}
