import { useCallback, useEffect, useState } from 'react';
import { clearXSession, getXSessionStatus, saveXSession, startXLogin } from '../api';
import { usesLocalArchive, xLoginSupported } from '../platform';

type SessionStatus = { configured: boolean; available?: boolean; stored?: boolean; error?: string };

export function useXSession(onNotice: (message: string) => void) {
  const [configured, setConfigured] = useState(false);
  const [available, setAvailable] = useState(false);
  const [stored, setStored] = useState(false);
  const [error, setError] = useState('');
  const [panelOpen, setPanelOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!xLoginSupported && usesLocalArchive) return;
    try {
      const status = await getXSessionStatus() as SessionStatus;
      setConfigured(status.configured);
      setAvailable(status.available ?? true);
      setStored(status.stored ?? status.configured);
      setError(status.error ?? '');
    } catch (cause) {
      setAvailable(false);
      setStored(false);
      setError(cause instanceof Error ? cause.message : '无法读取 X 登录状态');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const connect = useCallback(async () => {
    if (!xLoginSupported) {
      onNotice('请在 Android 应用中使用内置 X 登录；auth_token 与 ct0 会通过 Keystore 加密保存');
      return;
    }
    setBusy(true);
    try {
      const result = await startXLogin();
      setConfigured(result.configured);
      if (!result.canceled && result.configured) {
        setPanelOpen(false);
        onNotice('X 登录已加密保存；现在可下载当前账号有权查看的受保护帖子');
      }
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : '无法打开 X 登录');
    } finally {
      setBusy(false);
    }
  }, [onNotice]);

  const save = useCallback(async (authToken: string, csrfToken: string): Promise<boolean> => {
    setBusy(true);
    setError('');
    try {
      const result = await saveXSession(authToken, csrfToken);
      setConfigured(result.configured);
      setAvailable(result.available);
      setStored(true);
      setPanelOpen(false);
      onNotice('X 会话已在服务器加密保存；现在可下载当前账号有权查看的受保护帖子');
      return true;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '无法保存 X 会话';
      setError(message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [onNotice]);

  const disconnect = useCallback(async () => {
    setBusy(true);
    try {
      const result = await clearXSession() as SessionStatus;
      setConfigured(result.configured);
      setAvailable(result.available ?? true);
      setStored(result.stored ?? result.configured);
      setError('');
      setPanelOpen(false);
      onNotice(usesLocalArchive ? '已移除本机保存的 X 登录；之后仅下载公开帖子' : '已移除服务器保存的 X 登录；之后仅下载公开帖子');
    } catch (cause) {
      onNotice(cause instanceof Error ? cause.message : '无法移除 X 登录');
    } finally {
      setBusy(false);
    }
  }, [onNotice]);

  return { configured, available, stored, error, panelOpen, setPanelOpen, busy, connect, save, disconnect };
}
