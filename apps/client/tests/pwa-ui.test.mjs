import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { createServer, preview } from 'vite';
import { startPwaFixture } from './pwa-server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const browserName = process.env.PWA_BROWSER === 'webkit' ? 'webkit' : 'chromium';
const browserType = browserName === 'webkit' ? webkit : chromium;
let fixture;
let vite;
let browser;
let origin;

async function launchBrowser() {
  try {
    return await browserType.launch();
  } catch (error) {
    throw new Error(`PWA ${browserName} failed to launch: ${error instanceof Error ? error.message : error}`);
  }
}

async function pageFor(t, { share = 'off', cobalt = true } = {}) {
  if (!fixture) fixture = await startPwaFixture();
  if (!vite) {
    vite = await createServer({
      root,
      server: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: fixture.origin, changeOrigin: true } } },
      logLevel: 'silent',
    });
    await vite.listen();
    origin = vite.resolvedUrls.local[0];
  }
  if (!browser) browser = await launchBrowser();
  fixture.setCobalt(cobalt);
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await context.addInitScript((mode) => {
    if (mode === 'off') {
      Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: undefined });
    }
    if (mode === 'on') {
      Object.defineProperty(navigator, 'share', { configurable: true, value: (data) => { window.__shared = data; return Promise.resolve(); } });
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: (data) => data?.url && !data.files });
    }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } });
  }, share);
  const page = await context.newPage();
  const errors = [];
  const captureError = (error) => {
    // WebKit may report caught loopback fetch failures as page errors during navigation.
    if (browserName === 'webkit' && /\/api\/.*due to access control checks/.test(error.message)) return;
    errors.push(error.message);
  };
  page.on('pageerror', captureError);
  t.after(async () => {
    page.off('pageerror', captureError);
    await context.close();
    if (errors.length) assert.deepEqual(errors, []);
  });
  await page.goto(origin);
  await page.locator('.native-navigation').waitFor();
  return page;
}

async function freshPage(t, options) {
  const page = await pageFor(t, options);
  fixture.reset();
  await page.reload();
  await page.locator('.native-navigation').waitFor();
  return page;
}

after(async () => {
  await browser?.close();
  await vite?.close();
  await fixture?.close();
});

test('PWA offers account controls without an Android folder picker and handles clipboard denial', async (t) => {
  const page = await freshPage(t);
  await page.getByRole('heading', { name: '保存一条新链接' }).waitFor();
  await page.getByText('仅下载公开帖子 · 服务器尚未启用 X 登录', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '登录 X', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '归档账号', exact: true }).count(), 1);
  assert.equal(await page.getByRole('button', { name: '更改下载位置', exact: true }).count(), 0);
  assert.match(await page.locator('.native-composer-note').innerText(), /仅下载公开帖子/);
  assert.doesNotMatch(await page.locator('.native-composer-note').innerText(), /已启用账号访问/);
  await page.getByRole('status', { name: '服务可用' }).waitFor();
  const before = fixture.postCount();
  await page.getByRole('button', { name: '粘贴链接', exact: true }).click();
  await page.locator('textarea').fill('https://x.com/mountain/status/4242');
  assert.equal(await page.locator('textarea').inputValue(), 'https://x.com/mountain/status/4242');
  const directory = await mkdtemp(join(tmpdir(), 'pwa-links-'));
  const file = join(directory, 'links.txt');
  await writeFile(file, 'https://x.com/mountain/status/4343\nhttps://x.com/mountain/status/4343\n');
  await page.locator('input[type=file]').setInputFiles(file);
  await page.getByText('已从 links.txt 读取 1 条链接').waitFor();
  assert.match(await page.locator('textarea').inputValue(), /4242/);
  assert.match(await page.locator('textarea').inputValue(), /4343/);
  await page.getByRole('button', { name: '开始下载', exact: true }).click();
  await page.getByText('新增 2 条').waitFor();
  await page.locator('textarea').fill('https://x.com/mountain/status/4242\nhttps://x.com/mountain/status/4343');
  await page.getByRole('button', { name: '开始下载', exact: true }).click();
  await page.getByText(/去重 2 条/).waitFor();
  assert.equal(fixture.postCount(), before + 2);
});

test('more than 200 links are refused before a request', async (t) => {
  const page = await freshPage(t);
  const links = Array.from({ length: 201 }, (_, index) => `https://x.com/mountain/status/${5000 + index}`).join('\n');
  await page.locator('textarea').fill(links);
  const before = fixture.requests.filter((request) => request.method === 'POST' && request.path === '/api/jobs').length;
  await page.getByRole('button', { name: '开始下载', exact: true }).click();
  await page.getByText('每批最多 200 条').waitFor();
  assert.equal(fixture.requests.filter((request) => request.method === 'POST' && request.path === '/api/jobs').length, before);
});

test('cancel and retry survive a closed page because the fixture keeps moving', async (t) => {
  const page = await freshPage(t);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '取消', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.locator('.history-post-list .job-card').first().getByRole('button', { name: '重试', exact: true }).click();
  await page.getByRole('button', { name: '首页', exact: true }).click();
  const progress = page.locator('.native-page.is-current .progress-copy strong');
  await progress.waitFor();
  const seen = await progress.innerText();
  await page.close();
  await new Promise((resolve) => setTimeout(resolve, 700));
  const reopened = await pageFor(t);
  await reopened.getByRole('button', { name: '首页', exact: true }).click();
  await reopened.waitForFunction((previous) => {
    const value = document.querySelector('.native-page.is-current .progress-copy strong')?.textContent ?? '';
    return value.length > 0 && value !== previous;
  }, seen);
});

test('search, author pagination, fullscreen swipe, and scroll restoration', async (t) => {
  const page = await freshPage(t);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  const search = page.getByRole('searchbox', { name: '搜索作者和推文内容' });
  await search.fill('湖面');
  await page.getByRole('region', { name: '搜索' }).getByText('湖面的风').waitFor();
  await search.fill('山间');
  const authorButton = page.getByRole('region', { name: '搜索' }).getByRole('button', { name: /山间来信/ }).first();
  await authorButton.waitFor();
  await authorButton.scrollIntoViewIfNeeded();
  await authorButton.click();
  const detail = page.getByRole('region', { name: '山间来信的已下载推文' });
  await detail.waitFor();
  await detail.getByRole('navigation', { name: '浏览结果分页' }).getByRole('button', { name: '下一页' }).click();
  await detail.getByText('第 2 / 2 页').waitFor();
  assert.equal(await search.inputValue(), '山间');
  await page.getByRole('button', { name: '返回作者列表', exact: true }).click();
  assert.equal(await search.inputValue(), '山间');
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.locator('.history-post-list .job-card').first().waitFor();
  const scrolled = await page.evaluate(() => {
    const root = document.documentElement;
    root.style.scrollBehavior = 'auto';
    const max = Math.max(0, root.scrollHeight - window.innerHeight);
    const target = Math.min(320, max);
    window.scrollTo({ top: target, left: 0, behavior: 'instant' });
    return { y: window.scrollY, target, max, height: root.scrollHeight, inner: window.innerHeight };
  });
  assert.ok(scrolled.y >= 80, `history did not scroll: ${JSON.stringify(scrolled)}`);
  const opener = page.locator('.history-post-list .job-card').first().getByRole('button', { name: '预览 1-pic.jpg', exact: true });
  await opener.scrollIntoViewIfNeeded();
  const beforeScroll = await opener.evaluate((element) => {
    const y = window.scrollY;
    element.click();
    return y;
  });
  assert.ok(beforeScroll >= 80, `scrollY ${beforeScroll} was not down the history list`);
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(await dialog.locator('.history-media-viewer-header > span').first().innerText(), '1 / 3');
  await dialog.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: 280, clientY: 360 }] });
  await dialog.dispatchEvent('touchmove', { touches: [{ identifier: 1, clientX: 40, clientY: 360 }] });
  await dialog.dispatchEvent('touchend', { changedTouches: [{ identifier: 1, clientX: 40, clientY: 360 }] });
  await page.waitForFunction(() => document.querySelector('.history-media-viewer-header > span')?.textContent === '2 / 3');
  await dialog.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: 280, clientY: 360 }] });
  await dialog.dispatchEvent('touchmove', { touches: [{ identifier: 1, clientX: 40, clientY: 360 }] });
  await dialog.dispatchEvent('touchend', { changedTouches: [{ identifier: 1, clientX: 40, clientY: 360 }] });
  await page.waitForFunction(() => document.querySelector('.history-media-viewer-header > span')?.textContent === '3 / 3');
  const video = dialog.locator('video');
  await video.waitFor();
  assert.match(await video.getAttribute('src') ?? '', /\/api\/jobs\/gallery\/media\/pic-3$/);
  await page.goBack();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('searchbox', { name: '搜索作者和推文内容' }).count(), 0);
  await page.waitForFunction((expected) => Math.abs(window.scrollY - expected) <= 1, beforeScroll);
});

test('categories survive reload and clearing failures preserves archived posts', async (t) => {
  const page = await freshPage(t);
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.getByRole('tab', { name: '分类', exact: true }).click();
  await page.getByRole('button', { name: '新建分类', exact: true }).click();
  await page.getByRole('textbox', { name: '分类名' }).fill('旅行');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '重命名分类 旅行', exact: true }).waitFor();
  await page.getByRole('button', { name: '重命名分类 旅行', exact: true }).click();
  await page.getByRole('textbox', { name: '分类名' }).fill('旅途');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByRole('button', { name: '选择推文', exact: true }).click();
  await page.getByRole('button', { name: '选择', exact: true }).first().click();
  await page.getByRole('button', { name: '批量分类', exact: true }).click();
  await page.getByRole('checkbox', { name: /旅途/ }).check();
  await page.getByRole('button', { name: '保存分类', exact: true }).click();
  const categoryTab = page.getByRole('tab', { name: /旅途/ });
  await page.waitForFunction(() => [...document.querySelectorAll('[role="tab"]')].some((tab) => /旅途/.test(tab.textContent ?? '') && /1/.test(tab.textContent ?? '')));
  assert.match(await categoryTab.innerText(), /1/);
  await page.reload();
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.getByRole('tab', { name: '分类', exact: true }).click();
  await page.getByRole('tab', { name: /旅途/ }).waitFor();
  await page.getByRole('region', { name: '历史' }).getByText('湖面的风').waitFor();
  await page.getByRole('button', { name: '删除分类 旅途', exact: true }).click();
  await page.getByRole('button', { name: '删除分类', exact: true }).click();
  await page.getByRole('region', { name: '历史' }).getByText('湖面的风').waitFor();
  await page.waitForFunction(() => ![...document.querySelectorAll('[role="tab"]')].some((tab) => (tab.textContent ?? '').includes('旅途')));
  await page.getByRole('tab', { name: '全部推文', exact: true }).click();
  await page.getByText('网络中断', { exact: true }).waitFor();
  await page.getByRole('button', { name: '清除失败记录', exact: true }).click();
  const dialog = page.getByRole('alertdialog');
  await dialog.getByRole('button', { name: '清除失败记录', exact: true }).click();
  await page.getByText('已清除 1 条失败记录').waitFor();
  await page.getByRole('region', { name: '历史' }).getByText('湖面的风').waitFor();
  await page.getByText('网络中断', { exact: true }).waitFor({ state: 'hidden' });
});

test('save uses downloadUrl and share does not read the file body', async (t) => {
  const hidden = await freshPage(t, { share: 'off' });
  await hidden.getByRole('button', { name: '历史', exact: true }).click();
  const save = hidden.locator('a[download="1-pic.jpg"]').first();
  await save.waitFor();
  const href = await save.getAttribute('href');
  assert.match(href, /\/api\/jobs\/gallery\/media\/pic-1\?download=1$/);
  assert.equal(await hidden.getByRole('button', { name: '分享', exact: true }).count(), 0);
  const response = await hidden.request.get(new URL(href, hidden.url()).toString(), { headers: { Range: 'bytes=0-3' } });
  assert.equal(response.status(), 206);
  assert.match(response.headers()['content-disposition'], /filename="1-pic.jpg"/);
  assert.equal(response.headers()['content-length'], '4');
  const shown = await pageFor(t, { share: 'on' });
  await shown.getByRole('button', { name: '历史', exact: true }).click();
  const before = fixture.requests.filter((request) => request.path.includes('download=1')).length;
  await shown.getByRole('button', { name: '分享', exact: true }).first().click();
  await shown.waitForFunction(() => window.__shared?.url?.includes('/api/jobs/gallery/media/'));
  const shared = await shown.evaluate(() => window.__shared);
  assert.equal(shared.files, undefined);
  assert.equal(fixture.requests.filter((request) => request.path.includes('download=1')).length, before);
});

test('production preview registers a service worker and leaves API responses uncached', async () => {
  if (!fixture) fixture = await startPwaFixture();
  const previewServer = await preview({
    root,
    preview: { host: '127.0.0.1', port: 0, proxy: { '/api': { target: fixture.origin, changeOrigin: true } } },
  });
  const previewOrigin = previewServer.resolvedUrls?.local?.[0] ?? `http://127.0.0.1:${previewServer.httpServer.address().port}/`;
  if (!browser) browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await page.goto(previewOrigin);
    await page.locator('.native-navigation').waitFor();
    await page.waitForFunction(async () => (await navigator.serviceWorker.getRegistrations()).length > 0);
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker.controller);
    await page.evaluate(async () => {
      await Promise.all(['/api/jobs', '/api/jobs/gallery/media/pic-1', '/api/jobs/gallery/media/pic-1?download=1'].map(async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`${url}: ${response.status}`);
        await response.arrayBuffer();
      }));
    });
    const cached = await page.evaluate(async () => {
      const urls = [];
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) urls.push(request.url);
      }
      return urls;
    });
    assert.equal(cached.some((url) => url.includes('/api/jobs') || url.includes('/api/events') || url.includes('/media/')), false);
  } finally {
    await context.close();
    await previewServer.close();
  }
});
