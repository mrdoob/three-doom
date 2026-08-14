// Browser integration for -playdemo / -timedemo startup routing, including
// external single-lump override and IWAD demo fallback.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
}

function makeDemo() {
  const bytes = Buffer.alloc(13 + 4000 * 4 + 1);
  bytes.set([
    109, // Doom 1.9
    3,   // Ultra-Violence
    1, 1,
    0,   // deathmatch
    1,   // respawn
    1,   // fast
    0,   // nomonsters
    0,   // console player
    1, 0, 0, 0,
  ]);
  bytes[bytes.length - 1] = 0x80;
  return bytes;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let browser = null;
const watchdog = setTimeout(() => {
  console.error('startup demo Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

async function runCase(query, routeExternal) {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  const pageErrors = [];
  const consoleMessages = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => consoleMessages.push(message.text()));
  if (routeExternal) {
    await page.route('**/DEMO1.lmp', (route) => route.fulfill({
      status: 200,
      contentType: 'application/octet-stream',
      body: makeDemo(),
    }));
  }
  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8095/');
  url.search = query;
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  try {
    await page.waitForFunction(() => window.renderer !== undefined &&
      window.scene?.getObjectByName('level') !== undefined,
    { timeout: 10000 });
  } catch (error) {
    const diagnostic = await page.evaluate(async () => {
      const doomstat = await import('/src/doomstat.js');
      const event = await import('/src/d_event.js');
      const wad = await import('/src/w_wad.js');
      const demo1 = wad.W_CheckNumForName('DEMO1');
      return {
        gamestate: doomstat.gamestate,
        gameaction: event.gameaction,
        demoplayback: doomstat.demoplayback,
        singledemo: doomstat.singledemo,
        timingdemo: doomstat.timingdemo,
        demo1,
        demo1Length: demo1 < 0 ? -1 : wad.W_LumpLength(demo1),
        demo1Head: demo1 < 0 ? [] : [...wad.W_CacheLumpNum(demo1, 0).slice(0, 16)],
      };
    });
    throw new Error(`${error.message}; state=${JSON.stringify(diagnostic)}; ` +
      `pageErrors=${pageErrors.join('; ')}; console=${consoleMessages.join(' | ')}`);
  }
  await page.waitForFunction(async () => {
    const doomstat = await import('/src/doomstat.js');
    return doomstat.demoplayback === true;
  }, null, { timeout: 10000 });
  const result = await page.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const wad = await import('/src/w_wad.js');
    return {
      demoplayback: doomstat.demoplayback,
      singledemo: doomstat.singledemo,
      timingdemo: doomstat.timingdemo,
      singletics: doomstat.singletics,
      usergame: doomstat.usergame,
      modifiedgame: doomstat.modifiedgame,
      skill: doomstat.gameskill,
      map: doomstat.gamemap,
      respawnparm: doomstat.respawnparm,
      fastparm: doomstat.fastparm,
      demo1Lump: wad.W_CheckNumForName('DEMO1'),
      demo1IsTail: wad.W_CheckNumForName('DEMO1') === wad.lumpinfo.length - 1,
      tailNames: wad.lumpinfo.slice(-2).map((entry) => entry.name),
    };
  });
  await page.close();
  return { ...result, pageErrors };
}

async function runInvalidCase() {
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/DEMO1.lmp', (route) => route.fulfill({
    status: 200,
    contentType: 'application/octet-stream',
    // Valid v1.9 header and one complete command, deliberately without the
    // required marker. Startup must reject it before entering the RAF loop.
    body: Buffer.from([109, 2, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3, 4]),
  }));
  const expected = 'Demo DEMO1 is invalid: stream has no end marker';
  const startupError = page.waitForEvent('console', {
    predicate: (message) => message.text().includes(expected),
    timeout: 10000,
  });
  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8095/');
  url.search = '?-playdemo=DEMO1';
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  const message = await startupError;
  const lifecycle = await page.evaluate(async () => ({
    rendererCreated: window.renderer !== undefined,
    rafRunning: (await import('/src/d_loop.js')).D_DoomRafLoop.isRunning(),
  }));
  await page.close();
  return { message: message.text(), pageErrors, expected, lifecycle };
}

try {
  browser = await chromium.launch(launchOptions);
  const precedence = await runCase(
    '?-timedemo=DEMO1&-playdemo=DEMO1&-loadgame=0&-map=E1M2',
    true,
  );
  const fallback = await runCase('?-timedemo=DEMO1&-map=E1M2', false);
  const invalid = await runInvalidCase();

  assert(precedence.demoplayback && precedence.singledemo,
    `external playdemo did not start: ${JSON.stringify(precedence)}`);
  assert(!precedence.timingdemo && !precedence.singletics,
    `playdemo did not beat timedemo: ${JSON.stringify(precedence)}`);
  assert(!precedence.usergame && !precedence.modifiedgame && precedence.demo1IsTail,
    `external demo ownership is wrong: ${JSON.stringify(precedence)}`);
  assert(precedence.skill === 3 && precedence.map === 1 &&
    precedence.respawnparm && precedence.fastparm,
  `external demo header did not override map startup: ${JSON.stringify(precedence)}`);
  assert(fallback.demoplayback && fallback.timingdemo && fallback.singletics,
    `IWAD timedemo fallback did not start: ${JSON.stringify(fallback)}`);
  assert(!fallback.singledemo && !fallback.usergame && !fallback.modifiedgame &&
    fallback.demo1Lump >= 0 && !fallback.demo1IsTail,
  `IWAD timedemo flags are wrong: ${JSON.stringify(fallback)}`);
  assert(precedence.pageErrors.length === 0 && fallback.pageErrors.length === 0,
    `page errors: ${[...precedence.pageErrors, ...fallback.pageErrors].join('; ')}`);
  assert(invalid.message.includes(invalid.expected) && invalid.pageErrors.length === 0 &&
    !invalid.lifecycle.rendererCreated && !invalid.lifecycle.rafRunning,
    `malformed startup demo was not rejected cleanly: ${JSON.stringify(invalid)}`);

  console.log(JSON.stringify({ precedence, fallback, invalid }));
} finally {
  if (browser !== null) await browser.close();
  clearTimeout(watchdog);
}
