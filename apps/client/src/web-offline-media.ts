import { readOffline, writeOffline } from './offline-db';
import { ArchiveHttpError } from './archive-transport';
import type { SyncMedia } from './archive-catalog';

export type OfflineFile = {
  offset: number; size: number; chunkSize: number; contentType: string; filename: string;
};

export async function webCopy(media: SyncMedia, chunkSize: number, signal: AbortSignal) {
  const key = media.sha256;
  let file = await readOffline<OfflineFile>('files', key);
  let offset = file?.size === media.size && file.chunkSize === chunkSize ? file.offset : 0;
  while (offset < media.size) {
    signal.throwIfAborted();
    const end = Math.min(offset + chunkSize, media.size) - 1;
    const response = await fetch(media.previewUrl, {
      headers: { Range: 'bytes=' + offset + '-' + end }, cache: 'no-store',
      signal: AbortSignal.any?.([signal, AbortSignal.timeout(60_000)]) ?? signal,
    });
    if (response.status === 401) {
      window.dispatchEvent(new Event('archive-session-expired'));
      throw new ArchiveHttpError(401, '请重新登录归档账号');
    }
    if (response.status !== 206 || response.headers.get('Content-Range') !== 'bytes ' + offset + '-' + end + '/' + media.size) {
      throw new Error('媒体分段读取失败');
    }
    const bytes = await response.arrayBuffer();
    const expected = media.chunkHashes[Math.floor(offset / chunkSize)];
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const actual = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
    if (!expected || actual !== expected || bytes.byteLength !== end - offset + 1) throw new Error('媒体分段校验失败');
    signal.throwIfAborted();
    file = { offset: end + 1, size: media.size, chunkSize, contentType: media.contentType ?? 'application/octet-stream', filename: media.filename };
    const partKey = key + '/' + Math.floor(offset / chunkSize);
    try {
      await writeOffline([['chunks', partKey, new Blob([bytes])], ['files', key, file]]);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') throw error;
      await writeOffline([['chunks', partKey, bytes], ['files', key, file]]);
    }
    offset = file.offset;
  }
}

export async function webCopyBlob(hash: string, signal: AbortSignal) {
  const file = await readOffline<OfflineFile>('files', hash);
  if (!file || file.offset !== file.size) return undefined;
  const parts: BlobPart[] = [];
  for (let index = 0; index * file.chunkSize < file.size; index++) {
    signal.throwIfAborted();
    const part = await readOffline<Blob | ArrayBuffer>('chunks', hash + '/' + index);
    if (!part) return undefined;
    parts.push(part);
  }
  return new Blob(parts, { type: file.contentType });
}

export async function webCopyUrl(media: SyncMedia, chunkSize: number) {
  const file = await readOffline<OfflineFile>('files', media.sha256);
  if (file?.size !== media.size || file.offset !== media.size || file.chunkSize !== chunkSize) return '';
  return '/__offline-media/' + media.sha256;
}
