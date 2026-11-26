import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { once } from 'node:events';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, webkit } from 'playwright';
import { createApp } from '../../server/dist/http-api.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const stamp = '2026-11-25T09:00:00.000Z';
const secret = 'test-local-storage-archive-password';

test('PWA resumes downloads, handles storage exhaustion and seeks during offline playback', { timeout: 60_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cobalt-pwa-'));
  const fixture = path.join(root, 'fixture.mp4');
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=1280x720:rate=30', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', fixture]);
  const bytes = await fs.readFile(fixture);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  let app, server, port, blocked = true, videoRanges = [];
  async function start() {
    app = await createApp({ dataDir: root, insecureLoopback: true, archiveUsername: 'test', archivePassword: secret });
    server = createServer((request, response) => {
      const range = request.headers.range;
      if (request.url === '/api/jobs/video/media/video' && range && /^bytes=\d+-\d+$/.test(range)) {
        videoRanges.push(range);
        if (blocked && !range.startsWith('bytes=0-')) {
          response.writeHead(503).end();
          return;
        }
      }
      app.app(request, response);
    });
    server.listen(port ?? 0, '127.0.0.1');
    await once(server, 'listening');
    port = server.address().port;
  }
  async function stop() {
    if (!server) return;
    await app.store.flush();
    const done = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await done;
    server = undefined;
  }
  async function post(id, tweetId, buffer, filename, type) {
    const sourceUrl = 'https://x.com/i/status/' + tweetId;
    const media = [{ id, filename, kind: type.startsWith('image') ? 'image' : 'video', contentType: type, sourceUrl: '',
      downloadedBytes: buffer.length, size: buffer.length, localPath: 'media/' + filename }];
    await fs.writeFile(path.join(root, 'media', filename), buffer);
    app.store.set({ id, tweetId, sourceUrl, canonicalUrl: sourceUrl, status: 'completed', progress: 100, media, attempts: 1,
      createdAt: stamp, updatedAt: stamp, completedAt: stamp,
      metadata: { authorName: 'Archive test', username: 'archive_test', userId: '1', avatarUrl: '', text: id,
        language: 'en', publishedAt: stamp } });
    app.queue.emit('change');
  }
  function history(page) { return page.getByRole('button', { name: '历史', exact: true }).click(); }

  try {
    await start();
    await post('picture', '901', png, 'offline-picture.png', 'image/png');
    await post('video', '902', bytes, 'offline-video.mp4', 'video/mp4');
    await context.addInitScript(() => {
      const put = IDBObjectStore.prototype.put;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === 'chunks' && window.__simulateFullStorage) throw new DOMException('Simulated full storage', 'QuotaExceededError');
        return put.apply(this, args);
      };
    });
    let page = await context.newPage();
    await page.goto('http://localhost:' + port);
    await page.getByLabel('账号', { exact: true }).fill('test');
    await page.getByLabel('密码', { exact: true }).fill(secret);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByText('个文件 · 将自动重试', { exact: false }).waitFor({ timeout: 20_000 });
    const partial = await page.evaluate((hash) => new Promise((resolve, reject) => {
      const request = indexedDB.open('cobalt-offline-archive', 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const get = db.transaction('files').objectStore('files').get(hash);
        get.onsuccess = () => { db.close(); resolve(get.result?.offset); };
      };
    }), hash);
    assert.equal(partial, 2097152);
    await history(page);
    await page.locator('.job-card').filter({ hasText: 'video' }).getByText('本机副本待补齐').waitFor();
    await context.setOffline(true);
    await page.close();
    await stop();
    await start();
    blocked = false;
    videoRanges = [];

    await context.setOffline(false);
    page = await context.newPage();
    await page.goto('http://localhost:' + port);
    await history(page);
    await page.locator('.job-card').filter({ hasText: 'video' }).getByText('本机可离线播放').waitFor({ timeout: 25_000 });
    assert.match(videoRanges[0], /^bytes=2097152-/);
    await page.evaluate(() => { window.__simulateFullStorage = true; });
    const secondImage = Buffer.concat([png, Buffer.from([0])]);
    await post('picture2', '903', secondImage, 'quota-picture.png', 'image/png');
    await page.getByText('本机空间不足 · 已暂停 · 剩余 1 个文件', { exact: true }).waitFor({ timeout: 15_000 });
    await page.evaluate(() => {
      window.__simulateFullStorage = false;
      window.dispatchEvent(new Event('online'));
    });
    await page.locator('.job-card').filter({ hasText: 'picture2' }).getByText('本机可离线播放').waitFor({ timeout: 20_000 });
    await context.setOffline(true);
    await page.close();

    page = await context.newPage();
    await page.goto('http://localhost:' + port);
    await history(page);
    await page.getByText('本机可离线播放').first().waitFor();
    await page.getByRole('button', { name: '预览 quota-picture.png', exact: true }).click();
    await page.waitForFunction(() => {
      const active = document.querySelector('.history-media-viewer-slide:not([aria-hidden]) img');
      return active?.naturalWidth === 1;
    });
    await page.getByRole('button', { name: '返回历史记录', exact: true }).click();
    await page.getByRole('button', { name: '预览 offline-video.mp4', exact: true }).click();
    const part = await page.evaluate(async (hash) => {
      const response = await fetch('/__offline-media/' + hash, { headers: { Range: 'bytes=2097100-2097200' } });
      return { status: response.status, range: response.headers.get('Content-Range'), data: Array.from(new Uint8Array(await response.arrayBuffer())) };
    }, hash);
    assert.equal(part.status, 206);
    assert.equal(part.range, 'bytes 2097100-2097200/' + bytes.length);
    assert.deepEqual(part.data, Array.from(bytes.subarray(2097100, 2097201)));

    const result = await page.evaluate(async () => {
      const video = document.querySelector('.history-media-viewer-slide:not([aria-hidden]) video');
      video.muted = true;
      if (!(video.readyState >= 1)) await Promise.race([
        new Promise((resolve, reject) => {
          video.addEventListener('loadedmetadata', resolve, { once: true });
          video.addEventListener('error', () => reject(new Error('video error ' + video.error?.code)), { once: true });
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('video metadata timeout')), 8000)),
      ]);
      const seek = new Promise((resolve, reject) => {
        video.addEventListener('seeked', resolve, { once: true });
        setTimeout(() => reject(new Error('video seek timeout')), 8000);
      });
      video.currentTime = 5;
      await seek;
      await video.play();
      video.pause();
      return video.currentTime;
    });
    assert.ok(result >= 5 && result < 6, result);
  } finally {
    await browser.close();
    await stop();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('remote revocation and logout erase offline media and sign out another tab', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cobalt-pwa-revoked-'));
  let browser, server;
  try {
    const app = await createApp({ dataDir: root, insecureLoopback: true, archiveUsername: 'test', archivePassword: secret });
    const hash = createHash('sha256').update(png).digest('hex');
    const sourceUrl = 'https://x.com/i/status/1990000000000000910';
    await fs.writeFile(path.join(root, 'media', 'revoked.png'), png);
    app.store.set({ id: 'revoked', tweetId: '1990000000000000910', sourceUrl, canonicalUrl: sourceUrl,
      status: 'completed', progress: 100, attempts: 1, createdAt: stamp, updatedAt: stamp, completedAt: stamp,
      media: [{ id: 'image', kind: 'image', filename: 'revoked.png', contentType: 'image/png', sourceUrl: '',
        downloadedBytes: png.length, size: png.length, localPath: 'media/revoked.png' }] });
    await app.store.flush();
    server = app.app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = 'http://localhost:' + server.address().port;
    browser = await (process.env.PWA_BROWSER === 'webkit' ? webkit : chromium).launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(origin);
    await page.getByLabel('账号', { exact: true }).fill('test');
    await page.getByLabel('密码', { exact: true }).fill(secret);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '历史', exact: true }).click();
    await page.getByText('本机可离线播放', { exact: true }).waitFor();

    const anotherTab = await context.newPage();
    await anotherTab.goto(origin);
    await anotherTab.getByRole('button', { name: '历史', exact: true }).waitFor();
    await anotherTab.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    const media = '/__offline-media/' + hash;
    const cached = await anotherTab.evaluate(async (url) => {
      const response = await fetch(url);
      return [response.status, response.headers.get('content-type')];
    }, media);
    assert.deepEqual(cached, [200, 'image/png']);
    const device = await page.evaluate(() => localStorage.getItem('archive-device:'));
    assert.ok(device);
    const admin = await fetch(origin + '/api/account/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'test', password: secret, deviceName: 'Other device', bearer: true }) });
    assert.equal(admin.status, 200);
    const { token } = await admin.json();
    assert.equal((await fetch(origin + '/api/account/sessions/' + device, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + token },
    })).status, 200);

    const unauthorized = page.waitForResponse((response) => response.url() === origin + '/api/account' && response.status() === 401);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await unauthorized;
    for (const tab of [page, anotherTab]) await tab.getByRole('button', { name: '登录', exact: true }).waitFor();
    await anotherTab.waitForFunction(async (url) => (await fetch(url)).status === 404, media);
    await context.setOffline(true);
    if (process.env.PWA_BROWSER !== 'webkit') assert.equal(await anotherTab.evaluate(async (url) => (await fetch(url)).status, media), 404);
    const counts = await anotherTab.evaluate(() => new Promise((resolve, reject) => {
      const opening = indexedDB.open('cobalt-offline-archive', 1);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const db = opening.result;
        const stores = ['state', 'files', 'chunks'];
        const transaction = db.transaction(stores);
        const requests = stores.map((store) => transaction.objectStore(store).count());
        transaction.oncomplete = () => { db.close(); resolve(requests.map((request) => request.result)); };
        transaction.onabort = () => { db.close(); reject(transaction.error); };
      };
    }));
    assert.deepEqual(counts, [0, 0, 0]);

    await context.setOffline(false);
    await page.getByLabel('密码', { exact: true }).fill(secret);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('button', { name: '历史', exact: true }).click();
    await page.getByText('本机可离线播放', { exact: true }).waitFor();
    await page.getByRole('button', { name: '首页', exact: true }).click();
    await page.getByRole('button', { name: '归档账号', exact: true }).click();
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await page.getByRole('button', { name: '登录', exact: true }).waitFor();
    await page.waitForFunction(async (url) => (await fetch(url)).status === 404, media);
  } finally {
    await browser?.close();
    if (server) {
      const done = new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
      await done;
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
