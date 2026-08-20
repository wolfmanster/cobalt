import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchPostMetadata } from './metadata.js';
import { resolveMedia } from './cobalt.js';
import { buildAuthorFolder, buildMediaFilename, buildPostFolder } from './media-paths.js';
import type { DownloadJob, MediaItem } from './types.js';
import { JobStore } from './store.js';

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

function concurrency(name: string, fallback: number): number {
  const configured = Number(process.env[name]);
  return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : fallback;
}

export class DownloadQueue extends EventEmitter {
  private readonly pendingResolve: string[] = [];
  private readonly pendingDownload: string[] = [];
  private readonly resolving = new Set<string>();
  private readonly downloading = new Set<string>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly resolveConcurrency: number;
  private readonly downloadConcurrency: number;
  private readonly mediaDownloadConcurrency: number;

  constructor(private readonly store: JobStore) {
    super();
    this.resolveConcurrency = concurrency('RESOLVE_CONCURRENCY', 4);
    this.downloadConcurrency = concurrency('DOWNLOAD_CONCURRENCY', 2);
    this.mediaDownloadConcurrency = concurrency('MEDIA_DOWNLOAD_CONCURRENCY', 2);
  }

  restore(): void {
    for (const job of this.store.list().reverse()) {
      if (job.status === 'queued') this.enqueue(job.id);
    }
  }

  enqueue(jobId: string): void {
    if (!this.isKnown(jobId)) this.pendingResolve.push(jobId);
    this.emitChange();
    this.pumpResolve();
  }

  cancel(jobId: string): boolean {
    const job = this.store.get(jobId);
    if (!job || ['completed', 'failed', 'canceled'].includes(job.status)) return false;
    this.removePending(this.pendingResolve, jobId);
    this.removePending(this.pendingDownload, jobId);
    this.controllers.get(jobId)?.abort(new Error('任务已取消'));
    this.store.update(jobId, { status: 'canceled', error: undefined });
    if (!this.resolving.has(jobId) && !this.downloading.has(jobId)) this.controllers.delete(jobId);
    this.emitChange();
    this.pumpResolve();
    this.pumpDownload();
    return true;
  }

  retry(jobId: string): boolean {
    const job = this.store.get(jobId);
    if (!job || !['failed', 'canceled'].includes(job.status)) return false;
    this.store.update(jobId, {
      status: 'queued',
      progress: 0,
      error: undefined,
      media: [],
      completedAt: undefined,
    });
    this.enqueue(jobId);
    return true;
  }

  private isKnown(jobId: string): boolean {
    return this.pendingResolve.includes(jobId)
      || this.pendingDownload.includes(jobId)
      || this.resolving.has(jobId)
      || this.downloading.has(jobId);
  }

  private removePending(queue: string[], jobId: string): void {
    const index = queue.indexOf(jobId);
    if (index >= 0) queue.splice(index, 1);
  }

  private pumpResolve(): void {
    while (this.resolving.size < this.resolveConcurrency && this.pendingResolve.length) {
      const jobId = this.pendingResolve.shift();
      if (!jobId || this.store.get(jobId)?.status !== 'queued') continue;
      const controller = new AbortController();
      this.controllers.set(jobId, controller);
      this.resolving.add(jobId);
      void this.resolveJob(jobId, controller).finally(() => {
        this.resolving.delete(jobId);
        if (!this.pendingDownload.includes(jobId) && !this.downloading.has(jobId)) this.controllers.delete(jobId);
        this.emitChange();
        this.pumpResolve();
        this.pumpDownload();
      });
    }
  }

  private pumpDownload(): void {
    while (this.downloading.size < this.downloadConcurrency && this.pendingDownload.length) {
      const jobId = this.pendingDownload.shift();
      const controller = jobId ? this.controllers.get(jobId) : undefined;
      if (!jobId || !controller || controller.signal.aborted || this.store.get(jobId)?.status !== 'downloading') continue;
      this.downloading.add(jobId);
      void this.downloadJob(jobId, controller).finally(() => {
        this.downloading.delete(jobId);
        this.controllers.delete(jobId);
        this.emitChange();
        this.pumpDownload();
      });
    }
  }

  private async resolveJob(jobId: string, controller: AbortController): Promise<void> {
    const job = this.store.get(jobId);
    if (!job) return;

    try {
      this.store.update(jobId, {
        status: 'resolving',
        progress: 4,
        error: undefined,
        attempts: job.attempts + 1,
      });
      this.emitChange();

      const [metadata, media] = await Promise.all([
        fetchPostMetadata(job.tweetId, controller.signal),
        resolveMedia(job.canonicalUrl, job.tweetId, controller.signal),
      ]);
      controller.signal.throwIfAborted();
      if (!media.length) throw new Error('帖子中没有可下载的媒体');

      this.store.update(jobId, { metadata, media, status: 'downloading', progress: 12 });
      this.pendingDownload.push(jobId);
      this.emitChange();
    } catch (error) {
      this.finishWithError(jobId, controller, error);
    }
  }

  private async downloadJob(jobId: string, controller: AbortController): Promise<void> {
    const job = this.store.get(jobId);
    if (!job) return;

    try {
      await this.downloadMediaInParallel(job, controller.signal);
      controller.signal.throwIfAborted();
      this.store.update(jobId, {
        status: 'completed',
        progress: 100,
        completedAt: new Date().toISOString(),
      });
      this.emitChange();
    } catch (error) {
      this.finishWithError(jobId, controller, error);
    }
  }

  private async downloadMediaInParallel(job: DownloadJob, signal: AbortSignal): Promise<void> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });

    let nextIndex = 0;
    let firstError: unknown;
    const worker = async () => {
      while (!controller.signal.aborted) {
        const index = nextIndex;
        nextIndex += 1;
        const media = job.media[index];
        if (!media) return;
        try {
          await this.downloadMedia(job, media, index, controller.signal);
        } catch (error) {
          if (firstError === undefined) firstError = error;
          controller.abort(error);
          return;
        }
      }
    };

    try {
      const workerCount = Math.min(this.mediaDownloadConcurrency, job.media.length);
      await Promise.all(Array.from({ length: workerCount }, worker));
    } finally {
      signal.removeEventListener('abort', abort);
    }
    if (firstError !== undefined) throw firstError;
    signal.throwIfAborted();
  }

  private finishWithError(jobId: string, controller: AbortController, error: unknown): void {
    if (controller.signal.aborted) {
      if (this.store.get(jobId)?.status !== 'canceled') this.store.update(jobId, { status: 'canceled' });
    } else {
      this.store.update(jobId, {
        status: 'failed',
        error: error instanceof Error ? error.message : '未知错误',
      });
    }
    this.emitChange();
  }

  private progressFor(job: DownloadJob): number {
    if (!job.media.length) return 12;
    const completedFraction = job.media.reduce((sum, item) => {
      if (item.size !== undefined && item.downloadedBytes >= item.size) return sum + 1;
      if (item.totalBytes) return sum + Math.min(item.downloadedBytes / item.totalBytes, 0.99);
      return sum + Math.min(item.downloadedBytes / (5 * 1024 * 1024), 0.9);
    }, 0);
    return Math.round(12 + (completedFraction / job.media.length) * 87);
  }

  private async downloadMedia(
    job: DownloadJob,
    media: MediaItem,
    index: number,
    signal: AbortSignal,
  ): Promise<void> {
    const headers: Record<string, string> = { 'user-agent': 'x-media-archive/0.1' };
    if (process.env.COBALT_API_KEY && media.sourceUrl.startsWith(process.env.COBALT_URL ?? 'http://127.0.0.1:9000')) {
      headers.authorization = `Api-Key ${process.env.COBALT_API_KEY}`;
    }
    const response = await fetch(media.sourceUrl, { headers, redirect: 'follow', signal });
    if (!response.ok || !response.body) throw new Error(`媒体下载失败（HTTP ${response.status}）`);

    const contentType = response.headers.get('content-type')?.split(';')[0] ?? undefined;
    const total = Number(response.headers.get('content-length') ?? response.headers.get('estimated-content-length')) || undefined;
    if (contentType && EXTENSIONS[contentType]) {
      media.filename = media.filename.replace(/\.[a-z0-9]+$/i, `.${EXTENSIONS[contentType]}`);
    }
    media.filename = buildMediaFilename(media, index);
    media.contentType = contentType;
    media.totalBytes = total;

    const metadata = job.metadata;
    const authorFolder = metadata
      ? buildAuthorFolder(metadata, job.tweetId)
      : job.tweetId;
    const postFolder = buildPostFolder(metadata, job.tweetId);
    const jobDir = path.join(this.store.mediaDir, authorFolder, postFolder);
    await fsp.mkdir(jobDir, { recursive: true });
    const finalPath = path.join(jobDir, media.filename);
    const partialPath = `${finalPath}.part`;
    media.localPath = path.relative(this.store.dataDir, finalPath);

    let received = 0;
    let lastEmitted = 0;
    const tracker = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length;
        media.downloadedBytes = received;
        const now = Date.now();
        if (now - lastEmitted > 180) {
          lastEmitted = now;
          this.store.update(job.id, { media: job.media, progress: this.progressFor(job) });
          this.emitChange();
        }
        callback(null, chunk);
      },
    });

    try {
      await pipeline(Readable.fromWeb(response.body as never), tracker, fs.createWriteStream(partialPath), { signal });
      await fsp.rename(partialPath, finalPath);
      media.size = received;
      media.downloadedBytes = received;
      this.store.update(job.id, { media: job.media, progress: this.progressFor(job) });
      this.emitChange();
    } catch (error) {
      await fsp.rm(partialPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private emitChange(): void {
    this.emit('change', this.store.list());
  }
}
