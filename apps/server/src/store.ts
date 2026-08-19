import fs from 'node:fs/promises';
import path from 'node:path';
import type { DownloadJob } from './types.js';

export class JobStore {
  private jobs = new Map<string, DownloadJob>();
  readonly dataDir: string;
  readonly mediaDir: string;
  private readonly filePath: string;
  private saveChain = Promise.resolve();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.mediaDir = path.join(dataDir, 'media');
    this.filePath = path.join(dataDir, 'jobs.json');
  }

  async init(): Promise<void> {
    await fs.mkdir(this.mediaDir, { recursive: true });
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const jobs = JSON.parse(raw) as DownloadJob[];
      for (const job of jobs) {
        if (['resolving', 'downloading'].includes(job.status)) {
          job.status = 'queued';
          job.progress = 0;
          job.media = [];
        }
        this.jobs.set(job.id, job);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  list(): DownloadJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(id: string): DownloadJob | undefined {
    return this.jobs.get(id);
  }

  findByTweetId(tweetId: string): DownloadJob | undefined {
    return this.list().find((job) => job.tweetId === tweetId && job.status !== 'canceled');
  }

  set(job: DownloadJob): void {
    this.jobs.set(job.id, job);
    this.queueSave();
  }

  update(id: string, patch: Partial<DownloadJob>): DownloadJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    this.queueSave();
    return job;
  }

  async clearCompleted(): Promise<number> {
    let count = 0;
    const mediaDirectories: string[] = [];
    for (const [id, job] of this.jobs) {
      if (['completed', 'failed', 'canceled'].includes(job.status)) {
        this.jobs.delete(id);
        const mediaRoot = path.resolve(this.mediaDir);
        const directories = new Set(
          job.media
            .map((media) => {
              if (!media.localPath) return undefined;
              const directory = path.resolve(this.dataDir, path.dirname(media.localPath));
              return directory.startsWith(`${mediaRoot}${path.sep}`) ? directory : undefined;
            })
            .filter((directory): directory is string => Boolean(directory)),
        );
        if (!directories.size) directories.add(path.join(this.mediaDir, id));
        mediaDirectories.push(...directories);
        count += 1;
      }
    }
    this.queueSave();
    await Promise.all(mediaDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })));
    return count;
  }

  async flush(): Promise<void> {
    await this.saveChain;
  }

  private queueSave(): void {
    const snapshot = JSON.stringify(this.list(), null, 2);
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(() => fs.writeFile(this.filePath, snapshot, 'utf8'));
  }
}
