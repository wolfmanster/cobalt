import type { DownloadJob } from './types';
import { LocalArchive } from './nativeArchive';
import type { DownloadedAuthor, TweetCategory } from './nativeArchive';
import { isNativeAndroid, remoteOrigin, usesLocalArchive, xLoginSupported } from './platform';
import { ArchiveHttpError, remoteRequest as request } from './archive-transport';
import { localCatalog, withLocalCopies } from './archive-catalog';
import { archivedPosts, catalogAuthors, catalogCategories, catalogPosts } from './archive-catalog-query';

export { xLoginSupported };

export interface JobList {
  jobs: DownloadJob[];
  historyTotal: number;
  completedToday: number;
}

export async function listJobs(options: { historyOffset?: number; historyLimit?: number } = {}) {
  if (usesLocalArchive) return LocalArchive.listJobs(options);
  const query = new URLSearchParams();
  if (options.historyOffset !== undefined) query.set('historyOffset', String(options.historyOffset));
  if (options.historyLimit !== undefined) query.set('historyLimit', String(options.historyLimit));
  const suffix = query.size ? `?${query}` : '';
  try {
    if (!navigator.onLine) throw new Error('设备当前离线');
    const result = await request<JobList>(`/api/jobs${suffix}`);
    return { ...result, jobs: result.jobs.map(withLocalCopies) };
  } catch (error) {
    if (error instanceof ArchiveHttpError && error.status === 401) throw error;
    const catalog = await localCatalog();
    if (!catalog) throw error;
    const posts = archivedPosts(catalog);
    const offset = options.historyOffset ?? 0;
    const today = new Date().toISOString().slice(0, 10);
    return { jobs: posts.slice(offset, offset + (options.historyLimit ?? 25)).map(withLocalCopies),
      historyTotal: posts.length, completedToday: posts.filter((post) => post.completedAt?.startsWith(today)).length };
  }
}

export function createJobs(urls: string[]) {
  if (usesLocalArchive) return LocalArchive.createJobs({ urls });
  return request<{
    created: DownloadJob[];
    duplicates: DownloadJob[];
    rejected: Array<{ url: string; error: string }>;
  }>('/api/jobs', { method: 'POST', body: JSON.stringify({ urls }) });
}

export function cancelJob(id: string) {
  if (usesLocalArchive) return LocalArchive.cancelJob({ id });
  return request<DownloadJob>(`/api/jobs/${id}/cancel`, { method: 'POST' });
}

export function retryJob(id: string) {
  if (usesLocalArchive) return LocalArchive.retryJob({ id });
  return request<DownloadJob>(`/api/jobs/${id}/retry`, { method: 'POST' });
}

export function clearHistory() {
  if (usesLocalArchive) return LocalArchive.clearHistory();
  return request<{ removed: number }>('/api/history/failed', { method: 'DELETE' });
}

export function selectDownloadFolder() {
  if (isNativeAndroid) return LocalArchive.selectDownloadFolder();
  return Promise.reject(new Error('仅 Android 应用支持选择下载文件夹'));
}

export function setDownloadPath(path: string) {
  if (isNativeAndroid) return LocalArchive.setDownloadPath({ path });
  return Promise.reject(new Error('仅 Android 应用支持设置下载位置'));
}

export function getDownloadFolder() {
  if (isNativeAndroid) return LocalArchive.getDownloadFolder();
  return Promise.resolve({ selected: true, mode: 'downloads' as const, label: 'Download/X Media Archive' });
}

function queryString(values: Record<string, string | number | undefined>) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const suffix = query.size ? `?${query}` : '';
  return suffix;
}

export async function listDownloadedPosts(options: { authorKey?: string; categoryId?: string; query: string; offset: number; limit: number }) {
  if (usesLocalArchive) return LocalArchive.listDownloadedPosts(options);
  const catalog = await localCatalog();
  const result = catalog ? catalogPosts(catalog, options) : await request<{ jobs: DownloadJob[]; total: number }>(`/api/posts${queryString(options)}`);
  return { ...result, jobs: result.jobs.map(withLocalCopies) };
}

export async function listAuthors(options: { query: string; offset: number; limit: number }) {
  if (usesLocalArchive) return LocalArchive.listAuthors(options);
  const catalog = await localCatalog();
  return catalog ? catalogAuthors(catalog, options) : request<{ authors: DownloadedAuthor[]; total: number }>(`/api/authors${queryString(options)}`);
}

export async function listTweetCategories() {
  if (usesLocalArchive) return LocalArchive.listTweetCategories();
  try {
    if (!navigator.onLine) throw new Error('设备当前离线');
    return await request<{ categories: TweetCategory[]; allTotal: number; uncategorizedTotal: number }>('/api/tweet-categories');
  } catch (error) {
    if (error instanceof ArchiveHttpError && error.status === 401) throw error;
    const catalog = await localCatalog();
    if (!catalog) throw error;
    return catalogCategories(catalog);
  }
}

export function createTweetCategory(name: string): Promise<TweetCategory> {
  if (usesLocalArchive) return LocalArchive.createTweetCategory({ name });
  return request<TweetCategory>('/api/tweet-categories', { method: 'POST', body: JSON.stringify({ name }) });
}

export function renameTweetCategory(id: string, name: string): Promise<TweetCategory> {
  if (usesLocalArchive) return LocalArchive.renameTweetCategory({ id, name });
  return request<TweetCategory>(`/api/tweet-categories/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ name }) });
}

export function deleteTweetCategory(id: string) {
  if (usesLocalArchive) return LocalArchive.deleteTweetCategory({ id });
  return request<{ deleted: boolean }>(`/api/tweet-categories/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export function getTweetCategoryAssignments(tweetIds: string[]) {
  if (usesLocalArchive) return LocalArchive.getTweetCategoryAssignments({ tweetIds });
  return request<{ assignments: Record<string, string[]> }>('/api/tweet-categories/assignments/query', { method: 'POST', body: JSON.stringify({ tweetIds }) });
}

export function updateTweetCategories(tweetIds: string[], addCategoryIds: string[], removeCategoryIds: string[]) {
  if (usesLocalArchive) return LocalArchive.updateTweetCategories({ tweetIds, addCategoryIds, removeCategoryIds });
  return request<{ updated: number }>('/api/tweet-categories/assignments', {
    method: 'POST',
    body: JSON.stringify({ tweetIds, addCategoryIds, removeCategoryIds }),
  });
}

export async function getHealth(): Promise<{ ok: boolean; local?: boolean; cobalt?: boolean }> {
  if (usesLocalArchive) return LocalArchive.getHealth();
  try {
    const data = await request<{ ok?: boolean; cobalt?: boolean }>('/api/health');
    return { ok: data.ok === true, cobalt: data.cobalt === true, local: false };
  } catch {
    return { ok: false, cobalt: false, local: false };
  }
}

export function getXSessionStatus() {
  if (usesLocalArchive) return LocalArchive.getXSessionStatus();
  return request<{ available: boolean; configured: boolean; stored?: boolean; error?: string }>('/api/x-session');
}

export function saveXSession(authToken: string, csrfToken: string) {
  if (usesLocalArchive) return Promise.reject(new Error('Android 登录会话由应用内登录流程管理'));
  return request<{ available: boolean; configured: boolean }>('/api/x-session', {
    method: 'PUT',
    body: JSON.stringify({ auth_token: authToken, ct0: csrfToken }),
  });
}

export function startXLogin() {
  if (usesLocalArchive) return LocalArchive.startXLogin();
  return Promise.reject(new Error('仅 Android 应用支持内置 X 登录'));
}

export function clearXSession() {
  if (usesLocalArchive) return LocalArchive.clearXSession();
  return request<{ available: boolean; configured: boolean }>('/api/x-session', { method: 'DELETE' });
}

export function consumeSharedContent() {
  if (isNativeAndroid) return LocalArchive.consumeSharedContent();
  return Promise.resolve({ text: '' });
}

export async function readClipboardText() {
  try {
    if (isNativeAndroid) return (await LocalArchive.readClipboard()).text;
    if (!navigator.clipboard?.readText) return '';
    return await navigator.clipboard.readText();
  } catch {
    return '';
  }
}

export function openMedia(input: { id: string; downloadUrl?: string; jobId?: string; sha256?: string }) {
  if (usesLocalArchive) return LocalArchive.openMedia({ id: input.id });
  if (isNativeAndroid) {
    if (!input.sha256) return Promise.reject(new Error('本机副本尚未保存'));
    return LocalArchive.openSyncedFile({ origin: remoteOrigin, sha256: input.sha256 });
  }
  const href = input.downloadUrl || (input.jobId ? `/api/jobs/${input.jobId}/media/${input.id}?download=1` : '');
  if (!href) return Promise.reject(new Error('无法打开媒体文件'));
  const link = document.createElement('a');
  link.href = href;
  link.rel = 'noopener';
  if (input.downloadUrl || input.jobId) link.download = '';
  document.body.appendChild(link);
  link.click();
  link.remove();
  return Promise.resolve();
}

let nativeEventWatchers = 0;

export function subscribeServerEvents(onChange: () => void) {
  let closed = false;
  let events: EventSource | null = null;
  let reconnectTimer = 0;
  const nativeChange = isNativeAndroid ? LocalArchive.addListener('remoteChanged', () => pull()) : undefined;
  const nativeExpiry = isNativeAndroid ? LocalArchive.addListener('remoteExpired', () => window.dispatchEvent(new Event('archive-session-expired'))) : undefined;
  const pull = () => { if (!closed) onChange(); };
  const open = () => {
    if (closed) return;
    events?.close();
    events = new EventSource('/api/events');
    events.onopen = () => pull();
    events.onmessage = () => pull();
    events.onerror = () => {
      events?.close();
      events = null;
      if (!closed) reconnectTimer = window.setTimeout(open, 1000);
    };
  };
  if (isNativeAndroid) {
    nativeEventWatchers++;
    void LocalArchive.watchArchive({ origin: remoteOrigin, enabled: true }).catch(() => undefined);
  } else open();
  const onVisibility = () => { if (document.visibilityState === 'visible') pull(); };
  const onPageShow = () => pull();
  const onOnline = () => pull();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('pageshow', onPageShow);
  window.addEventListener('online', onOnline);
  return {
    close: async () => {
      if (closed) return;
      closed = true;
      if (isNativeAndroid) nativeEventWatchers--;
      window.clearTimeout(reconnectTimer);
      events?.close();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
      await (await nativeChange)?.remove();
      await (await nativeExpiry)?.remove();
      if (isNativeAndroid && nativeEventWatchers === 0) await LocalArchive.watchArchive({ origin: remoteOrigin, enabled: false });
    },
  };
}

export function subscribeJobs(onChange: () => void) {
  if (usesLocalArchive) {
    let handle: { remove: () => Promise<void> } | undefined;
    const ready = LocalArchive.addListener('jobsChanged', onChange).then((value) => {
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
  return subscribeServerEvents(onChange);
}

export function subscribeCategoryChanges(onChange: () => void) {
  if (!usesLocalArchive) return { close: async () => undefined };
  let handle: { remove: () => Promise<void> } | undefined;
  const ready = LocalArchive.addListener('categoriesChanged', onChange).then((value) => {
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

export function subscribeSharedContent(onText: (text: string) => void) {
  if (!isNativeAndroid) return { close: async () => undefined };
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
