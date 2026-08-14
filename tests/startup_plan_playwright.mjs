// Browser integration for native Doom startup arguments. The bundled IWAD is
// noncommercial, so `-warp` must consume separate episode and map values.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
}

let browser = null;
const watchdog = setTimeout(() => {
  console.error('startup plan Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

async function runCase(query) {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8095/');
  url.search = query;
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer?.info.render.frame > 2,
  { timeout: 30000 });
  const result = await page.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    return {
      startskill: doomstat.startskill,
      startepisode: doomstat.startepisode,
      startmap: doomstat.startmap,
      autostart: doomstat.autostart,
      gameskill: doomstat.gameskill,
      gameepisode: doomstat.gameepisode,
      gamemap: doomstat.gamemap,
      usergame: doomstat.usergame,
    };
  });
  await page.close();
  return { ...result, pageErrors };
}

try {
  browser = await chromium.launch(launchOptions);
  const nativeWarp = await runCase('?-skill=4&-episode=1&-warp=1&2');
  const episodeOnly = await runCase('?-skill=1&-episode=1');

  const failures = [];
  const expectedWarp = {
    startskill: 3, startepisode: 1, startmap: 2, autostart: true,
    gameskill: 3, gameepisode: 1, gamemap: 2, usergame: true,
  };
  for (const [key, expected] of Object.entries(expectedWarp)) {
    if (nativeWarp[key] !== expected) {
      failures.push(`native warp ${key}: expected ${expected}, got ${nativeWarp[key]}`);
    }
  }
  const expectedEpisode = {
    startskill: 0, startepisode: 1, startmap: 1, autostart: true,
    gameskill: 0, gameepisode: 1, gamemap: 1, usergame: true,
  };
  for (const [key, expected] of Object.entries(expectedEpisode)) {
    if (episodeOnly[key] !== expected) {
      failures.push(`episode startup ${key}: expected ${expected}, got ${episodeOnly[key]}`);
    }
  }
  if (nativeWarp.pageErrors.length !== 0 || episodeOnly.pageErrors.length !== 0) {
    failures.push(`page errors: ${[...nativeWarp.pageErrors, ...episodeOnly.pageErrors].join('; ')}`);
  }
  if (failures.length !== 0) throw new Error(failures.join('\n'));

  console.log(JSON.stringify({ nativeWarp, episodeOnly }));
} finally {
  if (browser !== null) await browser.close();
  clearTimeout(watchdog);
}
