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
    const matches = this.list().filter((job) => job.tweetId === tweetId && job.status !== 'canceled');
    return matches.find((job) => job.status === 'completed') ?? matches[0];
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

  async clearFailed(): Promise<number> {
    let count = 0;
    for (const [id, job] of this.jobs) {
      if (job.status === 'failed') {
        this.jobs.delete(id);
        count += 1;
      }
    }
    if (count) this.queueSave();
    await this.flush();
    return count;
  }

  async flush(): Promise<void> {
    await this.saveChain;
  }

  private queueSave(): void {
    const snapshot = JSON.stringify(this.list(), null, 2);
    this.saveChain = this.saveChain
      .catch(() => undefined)
      .then(async () => {
        const temporary = `${this.filePath}.tmp`;
        await fs.writeFile(temporary, snapshot, 'utf8');
        await fs.rename(temporary, this.filePath);
      });
  }
}
