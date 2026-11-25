import { LocalArchive } from './nativeArchive';
import { isNativeAndroid, remoteOrigin } from './platform';

export class ArchiveHttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export async function remoteRequest<T>(url: string, options: RequestInit = {}, origin = remoteOrigin): Promise<T> {
  let status: number;
  let data: { error?: string };
  if (isNativeAndroid) {
    const reply = await LocalArchive.remoteRequest({ origin, path: url, method: options.method ?? 'GET',
      body: typeof options.body === 'string' ? options.body : undefined });
    status = reply.status;
    data = reply.data;
  } else {
    const response = await fetch(url, {
      ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...options.headers },
      cache: 'no-store', signal: options.signal ?? AbortSignal.timeout(25_000),
    });
    status = response.status;
    data = await response.json().catch(() => ({}));
  }
  if (status < 200 || status >= 300) {
    if (status === 401 && url !== '/api/account/login') window.dispatchEvent(new Event('archive-session-expired'));
    throw new ArchiveHttpError(status, data.error ?? '归档请求失败（HTTP ' + status + '）');
  }
  return data as T;
}
