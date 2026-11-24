import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { installNativeFixture } from './native-fixture.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
let server;
let browser;
let origin;

export async function nativePage(t, { width = 390, dark = false, fixture = {} } = {}) {
  if (!server) {
    await mkdir(fileURLToPath(new URL('../../../tmp/native-ui', import.meta.url)), { recursive: true });
    server = await createServer({ root, server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    origin = server.resolvedUrls.local[0];
    browser = await chromium.launch();
  }
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, colorScheme: dark ? 'dark' : 'light' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(installNativeFixture, fixture);
  t.after(async () => {
    await context.close();
    if (errors.length) assert.deepEqual(errors, [], 'No uncaught React or bridge errors');
  });
  await page.goto(origin);
  await page.locator('.native-navigation').waitFor();
  await page.waitForFunction(() => window.__nativeFixture.calls.some((call) => call.method === 'listJobs'));
  return page;
}

export async function nativeBack(page) {
  assert.equal(await page.evaluate(() => window.__cobaltGoBack()), true);
}

export async function closeNativeTests() {
  await browser?.close();
  await server?.close();
  browser = undefined;
  server = undefined;
  origin = undefined;
}
