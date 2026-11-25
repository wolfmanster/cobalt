import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type RunningApp } from './http-api.js';
import { CategoryStore } from './categories.js';
import { JobStore } from './store.js';
import type { DownloadJob } from './types.js';

const archiveUsername = 'test';
const archivePassword = 'archive-fixture-password';
const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function legacyJob(): DownloadJob & { avatarPath: string } {
  return {
    id: 'job-old',
    tweetId: '1800000000000000001',
    sourceUrl: 'https://x.com/archive/status/1800000000000000001',
    canonicalUrl: 'https://x.com/i/status/1800000000000000001',
    status: 'completed',
    progress: 100,
    metadata: {
      authorName: '山间来信',
      username: 'mountain',
      userId: '42',
      avatarUrl: 'https://cdn.example/avatar.jpg',
      text: '旧档',
      language: 'zh',
      publishedAt: '2026-09-01T00:00:00.000Z',
    },
    media: [{
      id: 'media-1',
      kind: 'image',
      filename: '1-pic.jpg',
      downloadedBytes: 4,
      sourceUrl: 'https://cdn.example/1.jpg',
      localPath: 'media/job-old/1-pic.jpg',
    }],
    attempts: 1,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
    completedAt: '2026-09-01T01:00:00.000Z',
    avatarPath: 'legacy/avatar.jpg',
  };
}

async function listen(running: RunningApp) {
  const server = running.app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  servers.push({
    close: () => new Promise((resolve) => server.close(() => resolve())),
  });
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/account/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: archiveUsername, password: archivePassword, deviceName: 'Test' }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  return (route: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    headers.set('Cookie', cookie);
    return fetch(base + route, { ...init, headers });
  };
}

describe('category persistence', () => {
  it('starts from a legacy jobs array without rewriting it or inventing categories', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veo-archive-'));
    const jobsPath = path.join(dataDir, 'jobs.json');
    const original = `${JSON.stringify([legacyJob()], null, 2)}\n`;
    await fs.writeFile(jobsPath, original);
    const categories = new CategoryStore(dataDir);
    await categories.init();
    const store = new JobStore(dataDir);
    await store.init();
    expect(await fs.readFile(jobsPath, 'utf8')).toBe(original);
    expect(Array.isArray(JSON.parse(original))).toBe(true);
    await expect(fs.access(path.join(dataDir, 'categories.json'))).rejects.toThrow();
    expect(categories.getSnapshot().categories).toEqual([]);

    const running = await createApp({ dataDir, archiveUsername, archivePassword, insecureLoopback: true, clientDist: path.join(dataDir, 'no-client') });
    expect(await fs.readFile(jobsPath, 'utf8')).toBe(original);
    const request = await listen(running);
    const listed = await request(`/api/tweet-categories`);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    expect(await listed.json()).toEqual({ categories: [], allTotal: 1, uncategorizedTotal: 1 });
    const posts = await request(`/api/posts`);
    const body = await posts.json() as { jobs: Array<{ tweetId: string; avatarPath?: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.jobs[0]?.tweetId).toBe('1800000000000000001');
    expect(body.jobs[0]?.avatarPath).toBeUndefined();
    expect(posts.headers.get('content-type')).toContain('application/json');
  });

  it('rejects a damaged category file and leaves jobs.json untouched', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veo-archive-'));
    const jobsPath = path.join(dataDir, 'jobs.json');
    const original = '[]\n';
    await fs.writeFile(jobsPath, original);
    const categoryPath = path.join(dataDir, 'categories.json');
    await fs.writeFile(categoryPath, '{');
    const categories = new CategoryStore(dataDir);
    await expect(categories.init()).rejects.toThrow(categoryPath);
    expect(await fs.readFile(jobsPath, 'utf8')).toBe(original);
    await expect(createApp({ dataDir, archiveUsername, archivePassword, insecureLoopback: true, clientDist: path.join(dataDir, 'no-client') })).rejects.toThrow(categoryPath);
    expect(await fs.readFile(jobsPath, 'utf8')).toBe(original);
  });

  it('persists categories across restart, keeps media when a category is deleted, and retains assignments when failed records are cleared', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'veo-archive-'));
    const running = await createApp({ dataDir, archiveUsername, archivePassword, insecureLoopback: true, clientDist: path.join(dataDir, 'no-client') });
    const request = await listen(running);
    const changes: string[] = [];
    running.queue.on('change', () => changes.push('change'));
    const created = await request(`/api/tweet-categories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: ' 旅行 ' }) });
    expect(created.status).toBe(201);
    const category = await created.json() as { id: string; name: string; normalizedName?: string; tweetCount: number };
    expect(category).toMatchObject({ name: '旅行', tweetCount: 0 });
    expect(category.normalizedName).toBeUndefined();
    const duplicate = await request(`/api/tweet-categories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '旅行' }) });
    expect(await duplicate.json()).toEqual({ error: '分类名已存在' });
    const tooLong = await request(`/api/tweet-categories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '名'.repeat(31) }) });
    expect(await tooLong.json()).toEqual({ error: '分类名需为 1–30 个字符' });

    const mediaPath = path.join(dataDir, 'media', 'job-old', '1-pic.jpg');
    await fs.mkdir(path.dirname(mediaPath), { recursive: true });
    await fs.writeFile(mediaPath, 'jpeg');
    const stored = legacyJob();
    running.store.set(stored);
    await running.store.flush();
    const jobsBefore = await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8');
    expect(Array.isArray(JSON.parse(jobsBefore))).toBe(true);

    const other = await (await request(`/api/tweet-categories`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '城市' }) })).json() as { id: string };
    await Promise.all([
      request(`/api/tweet-categories/assignments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tweetIds: [stored.tweetId], addCategoryIds: [category.id], removeCategoryIds: [] }) }),
      request(`/api/tweet-categories/assignments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tweetIds: [stored.tweetId], addCategoryIds: [other.id], removeCategoryIds: [] }) }),
    ]);
    expect(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8')).toBe(jobsBefore);
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, 'categories.json'), 'utf8')) as { assignments: Array<{ categoryId: string }> };
    expect(saved.assignments.map((assignment) => assignment.categoryId).sort()).toEqual([category.id, other.id].sort());

    const reloaded = new CategoryStore(dataDir);
    await reloaded.init();
    expect(reloaded.getSnapshot().categories.map((item) => item.name).sort()).toEqual(['城市', '旅行']);

    const removed = await request(`/api/tweet-categories/${encodeURIComponent(category.id)}`, { method: 'DELETE' });
    expect(await removed.json()).toEqual({ deleted: true });
    expect(await fs.readFile(mediaPath, 'utf8')).toBe('jpeg');
    const afterDelete = await (await request(`/api/tweet-categories`)).json() as { categories: Array<{ name: string }>; uncategorizedTotal: number };
    expect(afterDelete.categories.map((item) => item.name)).toEqual(['城市']);
    expect(afterDelete.uncategorizedTotal).toBe(0);

    const missing = await request(`/api/tweet-categories/missing`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '没有' }) });
    expect(await missing.json()).toEqual({ error: '分类不存在' });
    const refreshed = await request(`/api/tweet-categories/assignments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tweetIds: [stored.tweetId], addCategoryIds: ['missing'], removeCategoryIds: [] }) });
    expect(await refreshed.json()).toEqual({ error: '分类已不存在，请刷新后重试' });
    const emptySelection = await request(`/api/tweet-categories/assignments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tweetIds: ['  '], addCategoryIds: [], removeCategoryIds: [] }) });
    expect(await emptySelection.json()).toEqual({ error: '请选择至少一条推文' });

    running.store.set({ ...stored, id: 'job-failed', tweetId: '43', status: 'failed', media: [] });
    const cleared = await request(`/api/history/failed`, { method: 'DELETE' });
    expect(await cleared.json()).toEqual({ removed: 1 });
    expect(await fs.readFile(mediaPath, 'utf8')).toBe('jpeg');
    expect(running.store.list().map((job) => job.id)).toEqual([stored.id]);
    const afterClear = JSON.parse(await fs.readFile(path.join(dataDir, 'categories.json'), 'utf8')) as { categories: Array<{ name: string }>; assignments: unknown[] };
    expect(afterClear.categories.map((item) => item.name)).toEqual(['城市']);
    expect(afterClear.assignments).toEqual([{ tweetId: stored.tweetId, categoryId: other.id }]);
    expect(Array.isArray(JSON.parse(await fs.readFile(path.join(dataDir, 'jobs.json'), 'utf8')))).toBe(true);
    expect(changes.length).toBeGreaterThan(0);
  });
});
