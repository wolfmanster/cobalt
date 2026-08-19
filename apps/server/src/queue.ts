import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchPostMetadata } from './metadata.js';
import { resolveMedia } from './cobalt.js';
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

export class DownloadQueue extends EventEmitter {
  private readonly pending: string[] = [];
  private readonly active = new Map<string, AbortController>();
  private readonly concurrency: number;

  constructor(private readonly store: JobStore) {
    super();
    this.concurrency = Math.max(1, Number(process.env.DOWNLOAD_CONCURRENCY ?? 2));
  }

  restore(): void {
    for (const job of this.store.list().reverse()) {
      if (job.status === 'queued') this.enqueue(job.id);
    }
  }

  enqueue(jobId: string): void {
    if (!this.pending.includes(jobId) && !this.active.has(jobId)) this.pending.push(jobId);
    this.emitChange();
    void this.pump();
  }

  cancel(jobId: string): boolean {
    const job = this.store.get(jobId);
    if (!job || ['completed', 'failed', 'canceled'].includes(job.status)) return false;
    const index = this.pending.indexOf(jobId);
    if (index >= 0) this.pending.splice(index, 1);
    this.active.get(jobId)?.abort();
    this.store.update(jobId, { status: 'canceled', error: undefined });
    this.emitChange();
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

  private async pump(): Promise<void> {
    while (this.active.size < this.concurrency && this.pending.length) {
      const jobId = this.pending.shift();
      if (!jobId) return;
      const controller = new AbortController();
      this.active.set(jobId, controller);
      void this.process(jobId, controller).finally(() => {
        this.active.delete(jobId);
        this.emitChange();
        void this.pump();
      });
    }
  }

  private async process(jobId: string, controller: AbortController): Promise<void> {
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
      if (!media.length) throw new Error('帖子中没有可下载的媒体');

      this.store.update(jobId, { metadata, media, status: 'downloading', progress: 12 });
      this.emitChange();

      for (let index = 0; index < media.length; index += 1) {
        await this.downloadMedia(job, media[index]!, index, media.length, controller.signal);
      }

      this.store.update(jobId, {
        status: 'completed',
        progress: 100,
        completedAt: new Date().toISOString(),
      });
      this.emitChange();
    } catch (error) {
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
  }

  private async downloadMedia(
    job: DownloadJob,
    media: MediaItem,
    index: number,
    mediaCount: number,
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
    media.contentType = contentType;
    media.totalBytes = total;

    const jobDir = path.join(this.store.mediaDir, job.id);
    await fsp.mkdir(jobDir, { recursive: true });
    const finalPath = path.join(jobDir, media.filename.replace(/[^a-zA-Z0-9._-]/g, '_'));
    const partialPath = `${finalPath}.part`;
    media.localPath = path.relative(this.store.dataDir, finalPath);

    let received = 0;
    let lastEmitted = 0;
    const tracker = new Transform({
      transform: (chunk: Buffer, _encoding, callback) => {
        received += chunk.length;
        media.downloadedBytes = received;
        const fraction = total ? Math.min(received / total, 0.99) : Math.min(received / (5 * 1024 * 1024), 0.9);
        job.progress = Math.round(12 + ((index + fraction) / mediaCount) * 87);
        const now = Date.now();
        if (now - lastEmitted > 180) {
          lastEmitted = now;
          this.store.update(job.id, { media: job.media, progress: job.progress });
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
      this.store.update(job.id, { media: job.media });
    } catch (error) {
      await fsp.rm(partialPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private emitChange(): void {
    this.emit('change', this.store.list());
  }
}
