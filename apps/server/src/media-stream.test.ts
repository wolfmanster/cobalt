import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type RunningApp } from './http-api.js';
import { contentDispositionAttachment, parseByteRange } from './media-stream.js';
import type { DownloadJob, MediaItem } from './types.js';

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function media(patch: Partial<MediaItem> & Pick<MediaItem, 'id' | 'filename'>): MediaItem {
  return {
    kind: 'image',
    downloadedBytes: 10,
    sourceUrl: 'https://cdn.example/file',
    localPath: `media/job/${patch.filename}`,
    ...patch,
  };
}

function job(patch: Partial<DownloadJob> & Pick<DownloadJob, 'id' | 'media'>): DownloadJob {
  return {
    tweetId: patch.id,
    sourceUrl: 'https://x.com/a/status/1',
    canonicalUrl: 'https://x.com/i/status/1',
    status: 'completed',
    progress: 100,
    attempts: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    completedAt: '2026-09-01T01:00:00.000Z',
    ...patch,
  };
}

async function listen(running: RunningApp) {
  const server = running.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  servers.push({ close: () => new Promise((resolve) => server.close(() => resolve())) });
  return `http://127.0.0.1:${address.port}`;
}

describe('media stream', () => {
  it('parses a single byte range and rejects an unsatisfiable one', () => {
    expect(parseByteRange(undefined, 10)).toBeNull();
    expect(parseByteRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3 });
    expect(parseByteRange('bytes=8-', 10)).toEqual({ start: 8, end: 9 });
    expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseByteRange('bytes=0-99', 10)).toEqual({ start: 0, end: 9 });
    expect(parseByteRange('bytes=10-12', 10)).toBe('unsatisfiable');
    expect(parseByteRange('bytes=0-1,2-3', 10)).toBe('unsatisfiable');
  });

  it('strips header injection from the download filename', () => {
    const header = contentDispositionAttachment('1-pic.jpg"\r\nX-Evil: 1');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header).toContain('filename="1-pic.jpgX-Evil: 1"');
    expect(header).toContain("filename*=UTF-8''1-pic.jpgX-Evil%3A%201");
    const unicode = contentDispositionAttachment('湖面.mp4');
    expect(unicode).toContain('filename="__.mp4"');
    expect(unicode).toContain(`filename*=UTF-8''${encodeURIComponent('湖面.mp4')}`);
  });

  it('streams 200, 206, and 416 without reading the whole file into a buffer first', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'media-stream-'));
    const bytes = Buffer.from('0123456789abcdef');
    await fs.mkdir(path.join(dataDir, 'media', 'job'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'media', 'job', '1-pic.jpg'), bytes);
    await fs.writeFile(path.join(dataDir, 'media', 'job', '2-vdo.mp4'), bytes);
    await fs.writeFile(path.join(dataDir, 'media', 'job', '3-pic.gif'), bytes);
    await fs.writeFile(path.join(dataDir, 'secret.txt'), Buffer.from('secret'));
    const jobs = [
      job({
        id: 'job',
        media: [
          media({ id: 'pic', filename: '1-pic.jpg"\r\nX-Evil: 1', contentType: 'image/jpeg', localPath: 'media/job/1-pic.jpg' }),
          media({ id: 'vdo', filename: '2-vdo.mp4', kind: 'video', contentType: undefined, localPath: 'media/job/2-vdo.mp4' }),
          media({ id: 'gif', filename: '3-pic.gif', kind: 'gif', contentType: undefined, localPath: 'media/job/3-pic.gif' }),
          media({ id: 'escape', filename: 'secret.txt', localPath: '../secret.txt' }),
        ],
      }),
      job({ id: 'partial', status: 'failed', progress: 10, completedAt: undefined, media: [media({ id: 'pic', filename: '1-pic.jpg', localPath: 'media/job/1-pic.jpg' })] }),
    ];
    await fs.writeFile(path.join(dataDir, 'jobs.json'), JSON.stringify(jobs));
    const running = await createApp({ dataDir, clientDist: path.join(dataDir, 'missing-dist') });
    const base = await listen(running);
    const source = await fs.readFile(new URL('../src/media-stream.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/\breadFile\b/);

    const full = await fetch(`${base}/api/jobs/job/media/pic`);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-type')).toBe('image/jpeg');
    expect(full.headers.get('content-length')).toBe(String(bytes.length));
    expect(full.headers.get('content-disposition')).toBeNull();
    expect(Buffer.from(await full.arrayBuffer())).toEqual(bytes);

    const slice = await fetch(`${base}/api/jobs/job/media/vdo`, { headers: { Range: 'bytes=2-5' } });
    expect(slice.status).toBe(206);
    expect(slice.headers.get('content-type')).toBe('video/mp4');
    expect(slice.headers.get('content-range')).toBe(`bytes 2-5/${bytes.length}`);
    expect(slice.headers.get('content-length')).toBe('4');
    expect(Buffer.from(await slice.arrayBuffer())).toEqual(bytes.subarray(2, 6));

    const openEnded = await fetch(`${base}/api/jobs/job/media/vdo`, { headers: { Range: 'bytes=14-' } });
    expect(openEnded.status).toBe(206);
    expect(openEnded.headers.get('content-length')).toBe('2');
    expect(Buffer.from(await openEnded.arrayBuffer())).toEqual(bytes.subarray(14));

    const missing = await fetch(`${base}/api/jobs/job/media/vdo`, { headers: { Range: 'bytes=40-50' } });
    expect(missing.status).toBe(416);
    expect(missing.headers.get('content-range')).toBe(`bytes */${bytes.length}`);

    const download = await fetch(`${base}/api/jobs/job/media/pic?download=1`);
    const disposition = download.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('attachment;')).toBe(true);
    expect(disposition).not.toMatch(/[\r\n]/);
    expect(disposition).toContain('filename="1-pic.jpgX-Evil: 1"');
    expect(disposition).toContain('filename*=UTF-8\'\'');

    const gif = await fetch(`${base}/api/jobs/job/media/gif`);
    expect(gif.status).toBe(200);
    expect(gif.headers.get('content-type')).toBe('image/gif');

    expect((await fetch(`${base}/api/jobs/partial/media/pic`)).status).toBe(404);
    expect((await fetch(`${base}/api/jobs/job/media/escape`)).status).toBe(404);
    expect(await fs.readFile(path.join(dataDir, 'secret.txt'), 'utf8')).toBe('secret');
  });
});
