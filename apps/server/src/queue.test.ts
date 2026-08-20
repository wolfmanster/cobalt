import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveMedia } from './cobalt.js';
import { fetchPostMetadata } from './metadata.js';
import { DownloadQueue } from './queue.js';
import { JobStore } from './store.js';
import type { DownloadJob, MediaItem, PostMetadata } from './types.js';

vi.mock('./cobalt.js', () => ({ resolveMedia: vi.fn() }));
vi.mock('./metadata.js', () => ({ fetchPostMetadata: vi.fn() }));

const metadata: PostMetadata = {
  authorName: 'Example',
  username: 'example',
  userId: '42',
  avatarUrl: '',
  text: 'parallel test',
  language: 'zh',
  publishedAt: '2026-01-01T00:00:00.000Z',
};

function job(index: number): DownloadJob {
  const now = new Date(2026, 0, index + 1).toISOString();
  return {
    id: `job-${index}`,
    tweetId: `${1000 + index}`,
    sourceUrl: `https://x.com/example/status/${1000 + index}`,
    canonicalUrl: `https://x.com/i/status/${1000 + index}`,
    status: 'queued',
    progress: 0,
    media: [],
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
}

async function waitUntil(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('等待队列状态超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('DownloadQueue parallel pipeline', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete process.env.RESOLVE_CONCURRENCY;
    delete process.env.DOWNLOAD_CONCURRENCY;
    delete process.env.MEDIA_DOWNLOAD_CONCURRENCY;
  });

  it('keeps resolving queued posts while downloading media in parallel', async () => {
    process.env.RESOLVE_CONCURRENCY = '2';
    process.env.DOWNLOAD_CONCURRENCY = '1';
    process.env.MEDIA_DOWNLOAD_CONCURRENCY = '2';

    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veo-parallel-'));
    const store = new JobStore(dataDir);
    await store.init();
    const queue = new DownloadQueue(store);
    const jobs = [job(0), job(1), job(2)];
    jobs.forEach((item) => store.set(item));

    vi.mocked(fetchPostMetadata).mockResolvedValue(metadata);
    vi.mocked(resolveMedia).mockImplementation(async (_url, tweetId) => [0, 1].map((position): MediaItem => ({
      id: `${tweetId}-media-${position}`,
      kind: 'image',
      filename: `${tweetId}-${position}.jpg`,
      downloadedBytes: 0,
      sourceUrl: `https://media.example/${tweetId}/${position}.jpg`,
    })));

    let releaseDownloads = () => undefined;
    const downloadGate = new Promise<void>((resolve) => { releaseDownloads = resolve; });
    let activeDownloads = 0;
    let maxActiveDownloads = 0;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        activeDownloads += 1;
        maxActiveDownloads = Math.max(maxActiveDownloads, activeDownloads);
        await downloadGate;
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
        activeDownloads -= 1;
      },
    }), {
      headers: { 'content-type': 'image/jpeg', 'content-length': '3' },
    })));

    jobs.forEach((item) => queue.enqueue(item.id));
    await waitUntil(() => store.list().every((item) => item.status === 'downloading') && maxActiveDownloads === 2);

    expect(maxActiveDownloads).toBe(2);
    expect(resolveMedia).toHaveBeenCalledTimes(3);

    releaseDownloads();
    await waitUntil(() => store.list().every((item) => item.status === 'completed'));
    expect(store.list().every((item) => item.progress === 100)).toBe(true);

    await store.flush();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
});
