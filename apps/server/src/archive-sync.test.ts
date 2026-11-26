import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import type { Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveMedia } from './cobalt.js';
import { createApp, type RunningApp } from './http-api.js';
import { fetchPostMetadata } from './metadata.js';
import type { DownloadJob } from './types.js';

vi.mock('./cobalt.js', () => ({ resolveMedia: vi.fn() }));
vi.mock('./metadata.js', () => ({ fetchPostMetadata: vi.fn() }));

const chunk = 2 * 1024 * 1024;
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const date = '2026-10-20T08:00:00.123Z';
const credentials = { username: 'test', password: 'local-test-archive-password' };
let dataDir: string;
let app: RunningApp;
let server: Server;
let url: string;

async function start() {
  app = await createApp({ dataDir, insecureLoopback: true, archiveUsername: credentials.username, archivePassword: credentials.password });
  server = app.app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing bound address');
  url = 'http://127.0.0.1:' + address.port;
}

async function stop() {
  const done = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  await done;
  await app.store.flush();
}

async function api(path: string, init: RequestInit = {}, token?: string) {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');
  if (token) headers.set('Authorization', 'Bearer ' + token);
  return fetch(url + '/api' + path, { ...init, headers });
}

async function login(name: string) {
  const response = await api('/account/login', {
    method: 'POST', body: JSON.stringify({ ...credentials, deviceName: name, bearer: true }),
  });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ token: string; device: { id: string } }>;
}

function addJob(tweetId: string, status: DownloadJob['status'] = 'completed'): DownloadJob {
  const sourceUrl = 'https://x.com/user/status/' + tweetId;
  const job: DownloadJob = { id: 'job-' + tweetId, tweetId, sourceUrl, canonicalUrl: sourceUrl,
    status, progress: status === 'completed' ? 100 : 0, media: [], attempts: 1, createdAt: date, updatedAt: date,
    completedAt: status === 'completed' ? date : undefined };
  app.store.set(job);
  return job;
}

async function put(token: string, bytes: Buffer, hash: string, offset: number, size: number) {
  return api('/import/media/' + hash + '?size=' + size + '&offset=' + offset,
    { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: new Uint8Array(bytes) }, token);
}

function importRequest(tweetId: string, contents: Buffer[], categories: string[], missing = 0) {
  const body = {
    tweetId, createdAt: date, completedAt: date, categories, unavailableMedia: missing,
    media: contents.map((bytes, index) => ({
      sha256: sha(bytes), size: bytes.length, filename: 'media-' + index + '.mp4', kind: 'video', contentType: 'video/mp4',
    })),
    metadata: { authorName: '作者', username: 'author', userId: '42', avatarUrl: '', text: '原帖', language: 'zh', publishedAt: date },
  };
  return { method: 'POST', body: JSON.stringify({ ...body, importRevision: sha(JSON.stringify(body)) }) };
}

async function merge(token: string, tweetId: string, contents: Buffer[], categories: string[], missing = 0) {
  const result = await api('/import/posts', importRequest(tweetId, contents, categories, missing), token);
  expect(result.status).toBe(200);
  return result.json() as Promise<{ id: string }>;
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cobalt-sync-test-'));
  await start();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await stop();
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('shared archive HTTP API', () => {
  it('protects the archive, import, media and stream, and revokes individual devices across restarts', async () => {
    for (const path of ['/jobs', '/sync', '/events', '/jobs/none/media/id', '/posts', '/x-session', '/import/media/' + sha('x') + '?size=1']) {
      expect((await api(path)).status).toBe(401);
    }
    const browser = await api('/account/login', { method: 'POST', body: JSON.stringify({ ...credentials, deviceName: 'PWA' }) });
    expect(browser.headers.get('set-cookie')).toContain('HttpOnly');
    expect(browser.headers.get('set-cookie')).toContain('SameSite=Strict');
    const cookie = browser.headers.get('set-cookie')!.split(';')[0]!;
    expect((await api('/sync', { headers: { cookie } })).status).toBe(200);
    const android = await login('Android');
    const other = await login('Phone 2');
    await stop();
    await start();
    expect((await api('/account', {}, android.token)).status).toBe(200);
    expect((await api('/history/failed', { method: 'DELETE', headers: { cookie, Origin: 'https://example.test' } })).status).toBe(403);
    expect((await api('/account/sessions/' + android.device.id, { method: 'DELETE' }, other.token)).status).toBe(200);
    expect((await api('/sync', {}, android.token)).status).toBe(401);
    expect((await api('/sync', {}, other.token)).status).toBe(200);
  });

  it('resumes an original upload, unions categories and media, and publishes a consistent versioned manifest', async () => {
    const android = await login('Android');
    const iphone = await login('iPhone');
    const shared = Buffer.from('original PWA media');
    const samePost = addJob('111');
    const oldFile = path.join(dataDir, 'media', 'legacy-name.mp4');
    await fs.writeFile(oldFile, shared);
    app.store.update(samePost.id, { media: [{
      id: 'old', localPath: 'media/legacy-name.mp4', kind: 'video', filename: 'legacy-name.mp4',
      downloadedBytes: shared.length, sourceUrl: '',
    }] });
    const pwaCategory = await app.categories.create('PWA');
    await app.categories.updateAssignments(['111'], [pwaCategory.id]);

    const first = await (await api('/sync', {}, iphone.token)).json();
    expect(first.posts[0].media[0].sha256).toBe(sha(shared));
    expect(await (await api('/import/media/' + sha(shared) + '?size=' + shared.length, {}, android.token)).json())
      .toEqual({ offset: shared.length, complete: true });

    const variant = Buffer.alloc(chunk + 123, 62);
    const hash = sha(variant);
    const firstChunk = await put(android.token, variant.subarray(0, chunk), hash, 0, variant.length);
    expect(await firstChunk.json()).toEqual({ offset: chunk, complete: false });
    await stop();
    await start();
    expect(await (await api('/import/media/' + hash + '?size=' + variant.length, {}, android.token)).json())
      .toEqual({ offset: chunk, complete: false });
    const lastChunk = await put(android.token, variant.subarray(chunk), hash, chunk, variant.length);
    expect(await lastChunk.json()).toEqual({ offset: variant.length, complete: true });
    expect((await put(android.token, Buffer.from('bad hash'), sha('not this'), 0, 8)).status).toBe(422);
    expect((await merge(android.token, '111', [shared, variant], ['Android', 'pwa'])).id).toBe(samePost.id);
    await merge(android.token, '111', [shared, variant], ['Android', 'pwa']);
    await merge(android.token, '222', [variant], [], 1);
    const empty = await api('/import/categories', { method: 'POST', body: JSON.stringify({ categories: ['空分类'] }) }, android.token);
    expect(empty.status).toBe(200);

    const page = await (await api('/sync?limit=1', {}, iphone.token)).json();
    expect(page.version).not.toBe(first.version);
    expect(page.posts.map((post: { tweetId: string }) => post.tweetId)).toEqual(['111']);
    expect(page.categories.map((item: { name: string }) => item.name)).toEqual(['PWA', 'Android', '空分类']);
    expect(page.posts[0].categoryIds).toHaveLength(2);
    expect(page.posts[0].media.map((file: { sha256: string }) => file.sha256)).toEqual([sha(shared), hash]);
    expect(page.posts[0].media[1].chunkHashes).toEqual([sha(variant.subarray(0, chunk)), sha(variant.subarray(chunk))]);
    const end = await (await api('/sync?offset=' + page.nextOffset + '&version=' + page.version, {}, android.token)).json();
    expect(end.posts[0]).toMatchObject({ tweetId: '222', unavailableMedia: 1, completedAt: date, metadata: { authorName: '作者' } });
    expect(end.nextOffset).toBeNull();
    expect(await (await api('/sync?known=' + page.version, {}, iphone.token)).json()).toEqual({ unchanged: true, version: page.version });
    expect((await api('/sync?offset=1&version=' + first.version, {}, iphone.token)).status).toBe(409);
    const media = page.posts[0].media[1].previewUrl.slice('/api'.length);
    const fetched = await api(media, { headers: { Range: 'bytes=' + chunk + '-' } }, iphone.token);
    expect(fetched.status).toBe(206);
    expect(Buffer.from(await fetched.arrayBuffer())).toEqual(variant.subarray(chunk));
    expect(await fs.readFile(oldFile)).toEqual(shared);
  });

  it('clears failed rows only and notifies the other device', async () => {
    addJob('1');
    addJob('2', 'failed');
    addJob('3', 'canceled');
    addJob('4', 'downloading');
    const category = await app.categories.create('收藏');
    await app.categories.updateAssignments(['1'], [category.id]);
    const android = await login('Android');
    const iphone = await login('iPhone');
    const events = await api('/events', {}, iphone.token);
    const reader = events.body!.getReader();
    await reader.read();
    try {
      expect(await (await api('/history/failed', { method: 'DELETE' }, android.token)).json()).toEqual({ removed: 1 });
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('"updated":true');
      const history = await (await api('/jobs', {}, iphone.token)).json();
      expect(history.jobs.map((item: DownloadJob) => item.status).sort()).toEqual(['canceled', 'completed', 'downloading']);
      expect(app.categories.assignmentsFor(['1'])).toEqual({ '1': [category.id] });
    } finally { await reader.cancel(); }
  });

  it('publishes an imported post only after persistence and survives a concurrent retry and restart', async () => {
    const { token } = await login('Android');
    const bytes = Buffer.from('durable original');
    expect((await put(token, bytes, sha(bytes), 0, bytes.length)).status).toBe(200);
    const input = importRequest('501', [bytes], []);
    const temporary = path.join(dataDir, 'jobs.json.tmp');
    await fs.mkdir(temporary);
    try {
      expect((await api('/import/posts', input, token)).status).toBe(500);
      const failed = await (await api('/sync', {}, token)).json();
      expect(failed.posts).toEqual([]);
    } finally { await fs.rmdir(temporary); }

    const retries = await Promise.all([api('/import/posts', input, token), api('/import/posts', input, token)]);
    expect(retries.map((reply) => reply.status)).toEqual([200, 200]);
    const imported = await retries[0]!.json();
    expect(await retries[1]!.json()).toEqual(imported);
    await stop();
    await start();
    const restored = await (await api('/sync', {}, token)).json();
    expect(restored.posts).toMatchObject([{ id: imported.id, tweetId: '501', media: [{ sha256: sha(bytes) }] }]);
  });

  it('credits verified originals against missing counts from incomplete imports', async () => {
    const { token } = await login('Android');
    const files = ['first', 'second', 'third'].map((text) => Buffer.from(text));
    for (const bytes of files) expect((await put(token, bytes, sha(bytes), 0, bytes.length)).status).toBe(200);

    await merge(token, '502', files.slice(0, 2), []);
    await merge(token, '502', [], [], 2);
    await merge(token, '503', files.slice(0, 1), [], 2);
    await merge(token, '503', files.slice(0, 2), [], 1);
    const partial = await (await api('/sync', {}, token)).json();
    expect(partial.posts.map((post: DownloadJob) => [post.tweetId, post.media.length, post.unavailableMedia]))
      .toEqual([['502', 2, 0], ['503', 2, 1]]);

    await merge(token, '503', files.slice(2), []);
    const complete = await (await api('/sync', {}, token)).json();
    expect(complete.posts.map((post: DownloadJob) => [post.tweetId, post.media.length, post.unavailableMedia]))
      .toEqual([['502', 2, 0], ['503', 3, 0]]);
  });

  it('recovers missing originals through submission and retry while keeping the existing archive', async () => {
    const { token } = await login('Android');
    const importedTweet = '1990000000000000504';
    const staleTweet = '1990000000000000505';
    const imported = await merge(token, importedTweet, [], ['旧分类'], 1);
    const stale = addJob(staleTweet);
    app.store.update(stale.id, { media: [{ id: 'lost', kind: 'image', filename: 'lost.png', sourceUrl: '',
      downloadedBytes: 3, size: 3, localPath: 'media/lost.png' }] });
    const originalFetch = globalThis.fetch;
    const bytes = Buffer.from('recovered');
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => input.toString().startsWith('https://media.example/')
      ? Promise.resolve(new Response(bytes, { headers: { 'content-type': 'image/png', 'content-length': String(bytes.length) } }))
      : originalFetch(input, init));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(fetchPostMetadata).mockImplementation(async () => {
      await gate;
      return { authorName: '作者', username: 'author', userId: '42', avatarUrl: '', text: '原帖', language: 'zh', publishedAt: date };
    });
    vi.mocked(resolveMedia).mockImplementation(async (_url, tweetId) => [{ id: 'original', kind: 'image', filename: 'original.png',
      sourceUrl: 'https://media.example/' + tweetId, downloadedBytes: 0 }]);

    const submission = { method: 'POST', body: JSON.stringify({ urls: ['https://x.com/i/status/' + importedTweet] }) };
    try {
      const submitted = await (await api('/jobs', submission, token)).json();
      expect(submitted.created).toMatchObject([{ tweetId: importedTweet, status: 'resolving' }]);
      const repeated = await (await api('/jobs', submission, token)).json();
      expect(repeated.duplicates).toMatchObject([{ id: submitted.created[0].id }]);
      expect((await api('/jobs/' + imported.id + '/retry', { method: 'POST' }, token)).status).toBe(409);
      const retry = await api('/jobs/' + stale.id + '/retry', { method: 'POST' }, token);
      expect(retry.status).toBe(200);
      expect(await retry.json()).toMatchObject({ tweetId: staleTweet, status: 'resolving' });
      expect(app.store.get(imported.id)?.status).toBe('completed');
      expect(app.store.get(stale.id)?.status).toBe('completed');
    } finally { release(); }

    await vi.waitFor(async () => {
      const manifest = await (await api('/sync', {}, token)).json();
      expect(manifest.posts).toMatchObject([importedTweet, staleTweet].map((tweetId) => ({ tweetId, unavailableMedia: 0, media: [{ sha256: sha(bytes) }] })));
      expect(manifest.posts[0].categoryIds).toHaveLength(1);
    });
    const complete = await (await api('/jobs', submission, token)).json();
    expect(complete.created).toEqual([]);
    expect(complete.duplicates).toHaveLength(1);
  });
});
