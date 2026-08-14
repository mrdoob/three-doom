// Browser startup failures must remain visible and actionable instead of
// surfacing as unhandled errors on an otherwise blank page.

import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let browser = null;
const watchdog = setTimeout(() => {
  console.error('startup error Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

async function runFailure(url, routeMissing = false) {
  const page = await browser.newPage({ viewport: { width: 720, height: 480 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  if (routeMissing) {
    await page.route('**/missing-startup-test.wad', (route) => route.fulfill({
      status: 404,
      contentType: 'text/plain',
      body: 'not found',
    }));
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const alert = page.locator('#doom-startup-error');
  await alert.waitFor({ state: 'visible', timeout: 10000 });
  const result = await alert.evaluate((element) => ({
    role: element.getAttribute('role'),
    live: element.getAttribute('aria-live'),
    atomic: element.getAttribute('aria-atomic'),
    labelledBy: element.getAttribute('aria-labelledby'),
    title: element.querySelector('h1')?.textContent,
    detail: element.querySelector('[data-startup-error-detail]')?.textContent,
    retry: element.querySelector('button')?.textContent,
    focused: document.activeElement === element,
    rendererCreated: globalThis.renderer !== undefined,
  }));
  await page.close();
  return { ...result, pageErrors };
}

async function runLateFailure(url) {
  const page = await browser.newPage({ viewport: { width: 720, height: 480 } });
  const pageErrors = [];
  let failedModuleRequests = 0;
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/src/f_wipe.js', (route) => {
    failedModuleRequests++;
    return route.fulfill({
      status: 500,
      contentType: 'text/javascript',
      body: 'throw new Error("route body must not evaluate")',
    });
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const alert = page.locator('#doom-startup-error');
  await alert.waitFor({ state: 'visible', timeout: 30000 });
  const beforeRetry = await page.evaluate(async () => ({
    detail: document.querySelector('[data-startup-error-detail]')?.textContent,
    rendererCreated: globalThis.renderer !== undefined,
    rafRunning: (await import('/src/d_loop.js')).D_DoomRafLoop.isRunning(),
  }));

  await page.keyboard.press('Tab');
  const tabTarget = await page.evaluate(() => ({
    tagName: document.activeElement?.tagName,
    text: document.activeElement?.textContent,
  }));
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
    page.keyboard.press('Enter'),
  ]);
  await alert.waitFor({ state: 'visible', timeout: 30000 });
  const afterRetry = await page.evaluate(() => ({
    focused: document.activeElement?.id === 'doom-startup-error',
    rendererCreated: globalThis.renderer !== undefined,
  }));
  await page.close();
  return { beforeRetry, tabTarget, afterRetry, failedModuleRequests, pageErrors };
}

try {
  browser = await chromium.launch(launchOptions);
  const baseUrl = process.env.DOOM_URL ?? 'http://127.0.0.1:8095/';
  const root = new URL(baseUrl);
  root.search = '';
  root.hash = '';
  const malformed = await runFailure(`${root.href}?-iwad=%`);
  const missing = await runFailure(
    `${root.href}?-iwad=missing-startup-test.wad`,
    true,
  );
  const late = await runLateFailure(`${root.href}?-map=E1M1`);

  const successPage = await browser.newPage({ viewport: { width: 720, height: 480 } });
  const successErrors = [];
  successPage.on('pageerror', (error) => successErrors.push(error.message));
  await successPage.goto(`${root.href}?-map=E1M1`, { waitUntil: 'domcontentloaded' });
  await successPage.waitForFunction(() =>
    globalThis.renderer !== undefined &&
    globalThis.scene?.getObjectByName('level') !== undefined &&
    globalThis.renderer.info.render.frame > 2,
  null, { timeout: 30000 });
  const successAlert = await successPage.locator('#doom-startup-error').count();
  await successPage.close();

  for (const [name, result] of [['malformed query', malformed], ['missing IWAD', missing]]) {
    assert(result.role === 'alert' && result.live === 'assertive' && result.atomic === 'true',
      `${name} diagnostic is not an accessible alert: ${JSON.stringify(result)}`);
    assert(result.labelledBy === 'doom-startup-error-title' &&
      result.title === 'DOOM failed to start' && result.retry === 'Retry',
    `${name} diagnostic is incomplete: ${JSON.stringify(result)}`);
    assert(result.focused, `${name} diagnostic did not receive focus`);
    assert(result.pageErrors.length === 0,
      `${name} produced unhandled page errors: ${result.pageErrors.join('; ')}`);
  }
  assert(malformed.detail?.includes('URI malformed'),
    `malformed query detail is unclear: ${JSON.stringify(malformed)}`);
  assert(!malformed.rendererCreated,
    `malformed query loaded the renderer: ${JSON.stringify(malformed)}`);
  assert(missing.detail?.includes('Failed to load missing-startup-test.wad: 404'),
    `missing IWAD detail is unclear: ${JSON.stringify(missing)}`);
  assert(!missing.rendererCreated,
    `missing IWAD loaded the renderer: ${JSON.stringify(missing)}`);
  assert(late.beforeRetry.rendererCreated && !late.beforeRetry.rafRunning &&
    late.beforeRetry.detail?.includes('/src/f_wipe.js'),
  `late startup failure escaped its boundary: ${JSON.stringify(late)}`);
  assert(late.tabTarget.tagName === 'BUTTON' && late.tabTarget.text === 'Retry',
    `late startup alert trapped keyboard navigation: ${JSON.stringify(late)}`);
  assert(late.failedModuleRequests >= 2 && late.afterRetry.focused &&
    late.afterRetry.rendererCreated && late.pageErrors.length === 0,
  `keyboard Retry did not reload into the diagnostic: ${JSON.stringify(late)}`);
  assert(successAlert === 0 && successErrors.length === 0,
    `successful startup regressed: alert=${successAlert}; errors=${successErrors.join('; ')}`);

  console.log(JSON.stringify({ malformed, missing, late, successAlert }));
} finally {
  if (browser !== null) await browser.close();
  clearTimeout(watchdog);
}
