// Real-IWAD regression for r_data.c's next-lower-power-of-two column mask.
// Doom shareware's AASTINKY is declared 24 columns wide, but R_GetColumn can
// address only its first 16 columns. The cached repeating GPU texture must use
// that same 16-column physical period while retaining the 24-column metadata.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
}

let browser = null;
const pageErrors = [];
const watchdog = setTimeout(() => {
  console.error('wall texture period Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8095/');
  url.searchParams.set('-map', 'E1M1');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer?.info.render.frame > 2,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const data = await import('/src/r_data.js');
    const texnum = data.R_CheckTextureNumForName('AASTINKY');
    const definition = data.textures[texnum];
    const map = data.R_GetWallTexture(texnum);
    return {
      texnum,
      declaredWidth: definition?.width,
      height: definition?.height,
      columnPeriod: data.texturewidthmask[texnum] + 1,
      cachedWidth: map?.image?.width,
      cachedHeight: map?.image?.height,
      cachedBytes: map?.image?.data?.length,
    };
  });

  const failures = [];
  if (result.texnum !== 0 || result.declaredWidth !== 24 || result.height !== 72) {
    failures.push(`unexpected AASTINKY definition: ${JSON.stringify(result)}`);
  }
  if (result.columnPeriod !== 16 || result.cachedWidth !== 16 ||
      result.cachedHeight !== 72 || result.cachedBytes !== 16 * 72 * 2) {
    failures.push(`cached composite did not use masked period: ${JSON.stringify(result)}`);
  }
  if (pageErrors.length !== 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (failures.length !== 0) throw new Error(failures.join('\n'));
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
