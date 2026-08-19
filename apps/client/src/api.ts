import type { DownloadJob } from './types';

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
  return request<DownloadJob[]>('/api/jobs');
}

export function createJobs(urls: string[]) {
  return request<{
    created: DownloadJob[];
    duplicates: DownloadJob[];
    rejected: Array<{ url: string; error: string }>;
  }>('/api/jobs', { method: 'POST', body: JSON.stringify({ urls }) });
}

export function cancelJob(id: string) {
  return request<DownloadJob>(`/api/jobs/${id}/cancel`, { method: 'POST' });
}

export function retryJob(id: string) {
  return request<DownloadJob>(`/api/jobs/${id}/retry`, { method: 'POST' });
}

export function clearHistory() {
  return request<{ removed: number }>('/api/history', { method: 'DELETE' });
}
