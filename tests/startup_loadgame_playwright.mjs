// Browser integration for -loadgame startup precedence and atomic fallback.

import { createRequire } from 'node:module';

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
  console.error('startup loadgame Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const base = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8095/');

  const saveUrl = new URL(base);
  saveUrl.search = '?-map=E1M1';
  await page.goto(saveUrl.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.scene?.getObjectByName('level') !== undefined &&
    window.renderer?.info.render.frame > 2,
  null, { timeout: 30000 });
  const saved = await page.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const game = await import('/src/g_game.js');
    const player = doomstat.players[doomstat.consoleplayer];
    player.health = 37;
    player.mo.health = 37;
    game.G_SaveGame(0, 'STARTUP LOAD');
    game.G_Ticker();
    return localStorage.getItem('doom:save:0') !== null;
  });
  assert(saved, 'failed to create startup save fixture');

  // A valid load owns startup ahead of the otherwise valid E1M2 autostart.
  const loadUrl = new URL(base);
  loadUrl.search = '?-loadgame=0&-map=E1M2&-skill=5';
  await page.goto(loadUrl.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.scene?.getObjectByName('level') !== undefined &&
    window.renderer?.info.render.frame > 2,
  null, { timeout: 30000 });
  const loaded = await page.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const event = await import('/src/d_event.js');
    const player = doomstat.players[doomstat.consoleplayer];
    return {
      episode: doomstat.gameepisode,
      map: doomstat.gamemap,
      skill: doomstat.gameskill,
      health: player.health,
      mobjHealth: player.mo.health,
      leveltime: doomstat.leveltime,
      usergame: doomstat.usergame,
      gameaction: event.gameaction,
    };
  });

  // Corrupt data must lose no live state because startup has none yet; it
  // explicitly falls back to the title and must not run the competing map.
  await page.evaluate(() => {
    localStorage.setItem('doom:save:5', '{corrupt');
  });
  const corruptUrl = new URL(base);
  corruptUrl.search = '?-loadgame=5&-map=E1M2';
  await page.goto(corruptUrl.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.renderer !== undefined,
    null, { timeout: 30000 });
  await page.waitForTimeout(300);
  const corrupt = await page.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const event = await import('/src/d_event.js');
    return {
      gamestate: doomstat.gamestate,
      usergame: doomstat.usergame,
      gameaction: event.gameaction,
      hasLevel: window.scene?.getObjectByName('level') !== undefined,
    };
  });

  assert(loaded.episode === 1 && loaded.map === 1 && loaded.skill === 2,
    `startup save lost precedence: ${JSON.stringify(loaded)}`);
  assert(loaded.health === 37 && loaded.mobjHealth === 37 && loaded.usergame,
    `startup save state did not restore: ${JSON.stringify(loaded)}`);
  assert(loaded.gameaction === 0,
    `startup load action was not consumed: ${JSON.stringify(loaded)}`);
  assert(corrupt.gamestate === 3 && !corrupt.usergame && !corrupt.hasLevel &&
    corrupt.gameaction === 0,
  `corrupt startup save did not fall back atomically: ${JSON.stringify(corrupt)}`);
  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);

  await page.evaluate(() => {
    localStorage.removeItem('doom:save:0');
    localStorage.removeItem('doom:save:5');
  });
  console.log(JSON.stringify({ loaded, corrupt }));
} finally {
  if (browser !== null) await browser.close();
  clearTimeout(watchdog);
}
