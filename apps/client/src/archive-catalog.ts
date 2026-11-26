import { LocalArchive, type TweetCategory } from './nativeArchive';
import { archiveSessionKey, isNativeAndroid, remoteOrigin } from './platform';
import { ArchiveHttpError, remoteRequest } from './archive-transport';
import { readOffline, writeOffline } from './offline-db';
import { webCopy, webCopyUrl } from './web-offline-media';
import { offlineMediaWorkerReady } from './pwa-register';
import type { DownloadJob, MediaItem } from './types';

export type SyncMedia = MediaItem & { size: number; sha256: string; chunkHashes: string[] };
export type SyncPost = DownloadJob & { version: string; categoryIds: string[]; media: SyncMedia[] };
export type ArchiveCatalog = { version: string; posts: SyncPost[]; categories: Omit<TweetCategory, 'tweetCount'>[]; chunkSize: number };
type Page = { version: string; posts?: SyncPost[]; categories?: ArchiveCatalog['categories']; chunkSize?: number; nextOffset?: number | null; unchanged?: boolean };

const key = 'catalog:' + remoteOrigin;
let catalog: ArchiveCatalog | undefined;
let persistedVersion: string | undefined;
let loading: Promise<ArchiveCatalog | undefined> | undefined;
const copies = new Map<string, string>();
const byTweet = new Map<string, SyncPost>();

export function catalogChanged() { window.dispatchEvent(new Event('archive-catalog-changed')); }

function useCatalog(value: ArchiveCatalog | undefined) {
  catalog = value;
  byTweet.clear();
  for (const post of catalog?.posts ?? []) byTweet.set(post.tweetId, post);
}

export async function localCatalog() {
  if (!isNativeAndroid && !localStorage.getItem(archiveSessionKey)) return undefined;
  if (!loading) {
    const pending = (isNativeAndroid
      ? LocalArchive.loadCatalog({ origin: remoteOrigin }).then(({ catalog }) => catalog)
      : readOffline<ArchiveCatalog>('state', key)).then((saved) => {
      if (loading === pending && !catalog) {
        persistedVersion = saved?.version;
        useCatalog(saved);
      }
      return catalog;
    }).catch(() => undefined);
    loading = pending;
  }
  await loading;
  return catalog;
}

export function resetArchiveCatalog() {
  loading = undefined;
  persistedVersion = undefined;
  copies.clear();
  useCatalog(undefined);
}

export async function pullCatalog(signal: AbortSignal) {
  await localCatalog();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const known = persistedVersion;
      const first = await remoteRequest<Page>('/api/sync?known=' + (known ?? ''), { signal });
      if (first.unchanged && catalog) return catalog;
      if (!first.posts || !first.categories || !first.chunkSize) throw new Error('服务器同步清单无效');
      const updated: ArchiveCatalog = { version: first.version, posts: first.posts, categories: first.categories, chunkSize: first.chunkSize };
      let offset = first.nextOffset;
      while (offset != null) {
        signal.throwIfAborted();
        const page = await remoteRequest<Page>('/api/sync?offset=' + offset + '&version=' + first.version, { signal });
        if (!page.posts || (page.nextOffset != null && page.nextOffset <= offset)) throw new Error('服务器同步清单无效');
        updated.posts.push(...page.posts);
        offset = page.nextOffset;
      }
      signal.throwIfAborted();
      // Keep the downloaded manifest usable online even when the storage quota is exhausted.
      useCatalog(updated);
      try {
        if (isNativeAndroid) await LocalArchive.saveCatalog({ origin: remoteOrigin, catalog: updated });
        else await writeOffline([['state', key, updated]], signal);
        signal.throwIfAborted();
        persistedVersion = updated.version;
      }
      catch (error) { catalogChanged(); throw error; }
      catalogChanged();
      return updated;
    } catch (error) {
      if (!(error instanceof ArchiveHttpError) || error.status !== 409) throw error;
    }
  }
  throw new Error('归档正在更新，即将重新同步');
}

export function withLocalCopies(job: DownloadJob): DownloadJob {
  if (job.status !== 'completed') return job;
  const post = byTweet.get(job.tweetId);
  const source = post ?? job;
  return {
    ...source, archived: true,
    media: source.media.map((media) => {
      const local = media.sha256 && copies.get(media.sha256);
      if (!local) return isNativeAndroid ? { ...media, previewUrl: '', downloadUrl: '' } : media;
      const previewUrl = isNativeAndroid ? window.location.origin + '/__archive-android-media/' + media.sha256 + '?server=' + encodeURIComponent(remoteOrigin) : local;
      return { ...media, offlineReady: true, previewUrl, downloadUrl: isNativeAndroid ? local : local + '?download=1' };
    }),
  };
}

export function mediaWork(snapshot: ArchiveCatalog) {
  const items = new Map<string, { post: SyncPost; media: SyncMedia }>();
  for (const post of snapshot.posts) for (const media of post.media) items.set(media.sha256, { post, media });
  return [...items.values()];
}

export async function checkCopies(snapshot: ArchiveCatalog, signal: AbortSignal) {
  let changed = false;
  const work = mediaWork(snapshot);
  const native = isNativeAndroid
    ? await LocalArchive.findCopies({ origin: remoteOrigin, hashes: work.map(({ media }) => media.sha256) })
    : undefined;
  for (const { media } of work) {
    const local = native ? native.copies[media.sha256]
      : offlineMediaWorkerReady() ? await webCopyUrl(media, snapshot.chunkSize) : '';
    signal.throwIfAborted();
    if ((copies.get(media.sha256) ?? '') === (local ?? '')) continue;
    if (local) copies.set(media.sha256, local);
    else copies.delete(media.sha256);
    changed = true;
  }
  if (changed) catalogChanged();
}

export async function saveCopy(post: SyncPost, media: SyncMedia, chunkSize: number, signal: AbortSignal) {
  if (isNativeAndroid) {
    const { uri } = await LocalArchive.saveCopy({ origin: remoteOrigin, media, tweetId: post.tweetId, metadata: post.metadata, chunkSize });
    signal.throwIfAborted();
    copies.set(media.sha256, uri);
  } else {
    await webCopy(media, chunkSize, signal);
    const local = offlineMediaWorkerReady() && await webCopyUrl(media, chunkSize);
    signal.throwIfAborted();
    if (local) copies.set(media.sha256, local);
  }
  catalogChanged();
}

export const copyReady = (media: SyncMedia) => copies.has(media.sha256);
