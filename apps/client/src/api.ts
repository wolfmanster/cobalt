import type { DownloadJob } from './types';
import { Capacitor } from '@capacitor/core';
import { LocalArchive } from './nativeArchive';

const native = Capacitor.isNativePlatform();
export const xLoginSupported = native;

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: { 'content-type': 'application/json', ...options?.headers },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `请求失败（HTTP ${response.status}）`);
  return data as T;
}

export function listJobs() {
  if (native) return LocalArchive.listJobs().then((result) => result.jobs);
  return request<DownloadJob[]>('/api/jobs');
}

export function createJobs(urls: string[]) {
  if (native) return LocalArchive.createJobs({ urls });
  return request<{
    created: DownloadJob[];
    duplicates: DownloadJob[];
    rejected: Array<{ url: string; error: string }>;
  }>('/api/jobs', { method: 'POST', body: JSON.stringify({ urls }) });
}

export function cancelJob(id: string) {
  if (native) return LocalArchive.cancelJob({ id });
  return request<DownloadJob>(`/api/jobs/${id}/cancel`, { method: 'POST' });
}

export function retryJob(id: string) {
  if (native) return LocalArchive.retryJob({ id });
  return request<DownloadJob>(`/api/jobs/${id}/retry`, { method: 'POST' });
}

export function clearHistory() {
  if (native) return LocalArchive.clearHistory();
  return request<{ removed: number }>('/api/history', { method: 'DELETE' });
}

export function selectDownloadFolder() {
  if (native) return LocalArchive.selectDownloadFolder();
  return Promise.reject(new Error('仅 Android 应用支持选择下载文件夹'));
}

export function getDownloadFolder() {
  if (native) return LocalArchive.getDownloadFolder();
  return Promise.resolve({ selected: true });
}

export function getXSessionStatus() {
  if (native) return LocalArchive.getXSessionStatus();
  return Promise.resolve({ configured: false });
}

export function startXLogin() {
  if (native) return LocalArchive.startXLogin();
  return Promise.reject(new Error('仅 Android 应用支持内置 X 登录'));
}

export function clearXSession() {
  if (native) return LocalArchive.clearXSession();
  return Promise.resolve({ configured: false });
}

export function consumeSharedContent() {
  if (native) return LocalArchive.consumeSharedContent();
  return Promise.resolve({ text: '' });
}

export async function readClipboardText() {
  try {
    if (native) return (await LocalArchive.readClipboard()).text;
    if (!navigator.clipboard?.readText) return '';
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

export function openMedia(id: string) {
  if (native) return LocalArchive.openMedia({ id });
  window.open(`/api/jobs/media/${id}`, '_blank', 'noopener');
  return Promise.resolve();
}

export function shareMedia(id: string) {
  if (native) return LocalArchive.shareMedia({ id });
  return Promise.resolve();
}

export function subscribeJobs(onJobs: (jobs: DownloadJob[]) => void) {
  if (native) {
    let handle: { remove: () => Promise<void> } | undefined;
    const ready = LocalArchive.addListener('jobsChanged', (event) => onJobs(event.jobs)).then((value) => {
      handle = value;
      return value;
    });
    return {
      close: async () => {
        await ready;
        await handle?.remove();
      },
    };
  }
  const events = new EventSource('/api/events');
  events.onmessage = (event) => onJobs(JSON.parse(event.data) as DownloadJob[]);
  return { close: async () => events.close() };
}

export function subscribeSharedContent(onText: (text: string) => void) {
  if (!native) return { close: async () => undefined };
  let handle: { remove: () => Promise<void> } | undefined;
  const ready = LocalArchive.addListener('sharedContent', (event) => onText(event.text)).then((value) => {
    handle = value;
    return value;
  });
  return {
    close: async () => {
      await ready;
      await handle?.remove();
    },
  };
}
