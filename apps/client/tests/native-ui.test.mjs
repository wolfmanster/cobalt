import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installNativeFixture } from './native-fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const artifacts = fileURLToPath(new URL('../../../tmp/native-ui', import.meta.url));
let server;
let browser;
let origin;
before(async () => {
  await mkdir(artifacts, { recursive: true });
  server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); await server?.close(); });

async function nativePage(t, { width = 390, dark = false, fixture = {} } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await context.addInitScript(installNativeFixture, fixture);
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'No uncaught React or bridge errors'); });
  await page.goto(origin);
  await page.locator('.native-navigation').waitFor();
  await page.waitForFunction(() => window.__nativeFixture.calls.some((call) => call.method === 'listJobs'));
  return page;
}
async function assertNoOverflow(page) {
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Page must fit the viewport');
}
async function nativeBack(page) { assert.equal(await page.evaluate(() => window.__cobaltGoBack()), true); }
async function waitForMediaAlignment(page, index) {
  await page.waitForFunction((selected) => {
    const card = document.querySelector('.history-post-list .job-card');
    const viewport = card.querySelector('.media-viewport');
    const tile = card.querySelectorAll('.media-tile')[selected];
    const inset = Number.parseFloat(getComputedStyle(card.querySelector('.media-carousel')).getPropertyValue('--media-inset'));
    return Math.abs(tile.getBoundingClientRect().left - viewport.getBoundingClientRect().left - inset) < 2;
  }, index, { timeout: 5000 });
}

test('home renders at phone and tablet widths, with a system-following dark theme', async (t) => {
  for (const width of [320, 390, 430, 768]) {
    const page = await nativePage(t, { width });
    await page.getByRole('heading', { name: '保存一条新链接' }).waitFor();
    await assertNoOverflow(page);
    assert.equal(await page.locator('.native-page.is-current').count(), 1);
    assert.equal(await page.locator('.native-navigation button').count(), 4);
    assert.equal(await page.getByRole('button', { name: '开始下载', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).paddingBottom), '0px');
    assert.equal(await page.locator('.input-count:visible').count(), 1);
    if (width === 390) await page.screenshot({ path: `${artifacts}/home-light.png`, fullPage: true });
  }
  const dark = await nativePage(t, { dark: true });
  assert.equal(await dark.locator('.app-shell').evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(16, 24, 33)');
  await assertNoOverflow(dark);
  await dark.screenshot({ path: `${artifacts}/home-dark.png`, fullPage: true });
});

test('clipboard, link submission, cancellation, and retry retain their bridge actions', async (t) => {
  const page = await nativePage(t);
  await page.getByRole('button', { name: '粘贴链接', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea').value.includes('1234567890'));
  await page.getByRole('button', { name: '开始下载', exact: true }).click();
  await page.waitForFunction(() => window.__nativeFixture.calls.some((call) => call.method === 'createJobs'));
  assert.equal(await page.locator('textarea').inputValue(), '');
  await page.getByRole('button', { name: '取消', exact: true }).first().click();
  await page.waitForFunction(() => window.__nativeFixture.calls.some((call) => call.method === 'cancelJob'));
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.getByRole('button', { name: '重试', exact: true }).first().click();
  await page.waitForFunction(() => window.__nativeFixture.calls.some((call) => call.method === 'retryJob'));
});

test('search retains its query and native back closes author detail before returning home', async (t) => {
  const page = await nativePage(t);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('searchbox').fill('山间');
  await page.locator('.archive-author:visible').waitFor();
  await page.getByRole('button', { name: '首页', exact: true }).click();
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  assert.equal(await page.getByRole('searchbox').inputValue(), '山间');
  await page.locator('.archive-author:visible').click();
  await page.locator('.archive-detail-screen:visible').waitFor();
  await nativeBack(page);
  assert.equal(await page.locator('.archive-detail-screen:visible').count(), 0);
  assert.equal(await page.locator('.native-search-page.is-current').count(), 1);
  await nativeBack(page);
  assert.equal(await page.locator('.native-navigation button[aria-current="page"]').innerText(), '首页');
});

test('history pagination, natural media proportions, dots, fullscreen swipes, and scroll restoration', async (t) => {
  const page = await nativePage(t);
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.locator('.history-post-list .media-tile img').first().waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.history-post-list .job-card:first-child .media-tile img')].every((image) => image.complete && image.naturalWidth > 0));
  await assertNoOverflow(page);
  const sizes = await page.locator('.history-post-list .job-card').first().locator('.media-tile').evaluateAll((elements) => elements.map((element) => ({ width: element.clientWidth, height: element.clientHeight })));
  assert.equal(new Set(sizes.map((size) => size.height)).size, 1);
  assert.ok(sizes[1].width > sizes[0].width, 'Landscape media should be wider than portrait media');
  await page.getByRole('button', { name: '下一页', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.history-pagination')?.textContent.includes('第 2 / 2 页'));
  await page.getByRole('button', { name: '上一页', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.history-pagination')?.textContent.includes('第 1 / 2 页'));
  await page.locator('.history-post-list .job-card').first().getByRole('button', { name: '查看第 2个文件，共 4个文件', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.history-post-list .media-counter')?.textContent === '2 / 4');
  await waitForMediaAlignment(page, 1);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: `${artifacts}/history-light.png` });
  const preview = page.locator('.history-post-list .media-open-preview').nth(1);
  await preview.scrollIntoViewIfNeeded();
  const beforeScroll = await page.evaluate(() => window.scrollY);
  await preview.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
  await dialog.getByRole('button', { name: '查看第 3个媒体，共 4个媒体', exact: true }).click();
  assert.equal(await page.locator('.history-media-viewer-header > span').first().innerText(), '3 / 4');
  await dialog.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientX: 200, clientY: 350 }] });
  await dialog.dispatchEvent('touchmove', { touches: [{ identifier: 1, clientX: 100, clientY: 350 }] });
  await dialog.dispatchEvent('touchend', { changedTouches: [{ identifier: 1, clientX: 100, clientY: 350 }] });
  await page.waitForFunction(() => document.querySelector('.history-media-viewer-header > span')?.textContent === '4 / 4');
  await nativeBack(page);
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.locator('.native-navigation button[aria-current="page"]').innerText(), '历史');
  assert.ok(Math.abs(await page.evaluate(() => window.scrollY) - beforeScroll) <= 1);
  assert.equal(await page.evaluate(() => document.body.style.overflow), '');
});

test('1, 2, 7, and 8 media keep per-post dot navigation within a narrow viewport', async (t) => {
  for (const mediaCount of [1, 2, 7, 8]) {
    const page = await nativePage(t, { width: 320, fixture: { mediaCount } });
    await page.getByRole('button', { name: '历史', exact: true }).click();
    const card = page.locator('.history-post-list .job-card').first();
    await card.locator('img').first().waitFor();
    await assertNoOverflow(page);
    assert.equal(await card.locator('.media-pagination button').count(), mediaCount === 1 ? 0 : Math.min(7, mediaCount));
    if (mediaCount === 1) continue;
    await card.locator('.media-pagination button').last().click();
    await page.waitForFunction((expected) => document.querySelector('.history-post-list .media-counter')?.textContent === `${Math.min(7, expected)} / ${expected}`, mediaCount, { timeout: 5000 }).catch(async (error) => {
      const layout = await card.evaluate((element) => ({
        counter: element.querySelector('.media-counter')?.textContent,
        scrollLeft: element.querySelector('.media-viewport').scrollLeft,
        width: element.querySelector('.media-viewport').clientWidth,
        tiles: [...element.querySelectorAll('.media-tile')].map((tile) => ({ left: tile.offsetLeft, width: tile.clientWidth })),
      }));
      throw new Error(`Media count ${mediaCount}: ${JSON.stringify(layout)}`, { cause: error });
    });
    if (mediaCount === 8) {
      await card.locator('.media-pagination button').last().click();
      await page.waitForFunction(() => document.querySelector('.history-post-list .media-counter')?.textContent === '8 / 8', undefined, { timeout: 5000 });
      // The landscape tile is wider than the viewport; its leading edge is aligned,
      // rather than scrolling to the far end of the image.
      await waitForMediaAlignment(page, 7);
    }
    await assertNoOverflow(page);
  }
  const dark = await nativePage(t, { dark: true });
  await dark.getByRole('button', { name: '历史', exact: true }).click();
  await dark.locator('.history-post-list .job-card').first().waitFor();
  await dark.screenshot({ path: `${artifacts}/history-dark.png` });
});

test('folder, login, and destructive confirmation close before navigation; clearing requires confirmation', async (t) => {
  const page = await nativePage(t, { fixture: { configured: false } });
  await page.getByRole('button', { name: '更改下载位置', exact: true }).click();
  await page.getByRole('textbox', { name: 'Download /', exact: true }).fill('收藏/摄影');
  await page.getByRole('button', { name: '保存位置', exact: true }).click();
  await page.waitForFunction(() => window.__nativeFixture.calls.some((call) => call.method === 'setDownloadPath'));
  await page.getByRole('button', { name: '登录 X', exact: true }).click();
  await page.getByRole('button', { name: '打开 X 登录', exact: true }).click();
  await page.getByRole('button', { name: '管理 X 登录', exact: true }).waitFor();
  await page.getByRole('button', { name: '历史', exact: true }).click();
  await page.getByRole('button', { name: '清除', exact: true }).click();
  await nativeBack(page);
  await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('alertdialog').count(), 0);
  assert.equal(await page.evaluate(() => window.__nativeFixture.calls.some((call) => call.method === 'clearHistory')), false);
  await page.getByRole('button', { name: '清除', exact: true }).click();
  await page.getByRole('button', { name: '清除历史', exact: true }).click();
  await page.getByRole('heading', { name: '这里还很安静' }).waitFor();
  assert.equal(await page.evaluate(() => window.__nativeFixture.calls.filter((call) => call.method === 'clearHistory').length), 1);
});

test('empty and offline states fit the narrow screen', async (t) => {
  const page = await nativePage(t, { width: 320, fixture: { empty: true, offline: true } });
  await page.getByRole('heading', { name: '准备好开始下载' }).waitFor();
  await page.getByText('本地服务暂不可用，请稍后重试').waitFor();
  await assertNoOverflow(page);
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByRole('searchbox').fill('不存在的作者');
  await page.getByText('没有匹配的推文', { exact: true }).waitFor();
  await assertNoOverflow(page);
});
