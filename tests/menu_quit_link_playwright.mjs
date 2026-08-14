// Keyboard/click quit confirmations open the farewell destination in an
// opener-isolated tab while the original Doom page keeps running.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const QUIT_LINK = 'https://x.com/mrdoob/status/2059803097367732614';
const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
}

let browser;
try {
  browser = await chromium.launch(launchOptions);

  async function runConfirmation(mode) {
    const context = await browser.newContext({ viewport: { width: 640, height: 400 } });
    await context.route(QUIT_LINK, (route) => route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>quit destination</title>',
    }));
    const errors = [];
    const page = await context.newPage();
    let extraPages = 0;
    context.on('page', (candidate) => {
      if (candidate !== page) extraPages++;
    });
    page.on('pageerror', (error) => errors.push(error.message));
    const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8092/');
    url.searchParams.set('-map', 'E1M1');
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() =>
      window.renderer !== undefined &&
      window.scene?.getObjectByName('level') !== undefined,
    { timeout: 30000 });
    await page.evaluate(async () => {
      const doomstat = await import('/src/doomstat.js');
      const loop = await import('/src/d_loop.js');
      for (let frame = 0; frame < 600; frame++) {
        if (doomstat.gamestate === 0 /*GS_LEVEL*/ && doomstat.gametic > 5 &&
            loop.D_DoomRafLoop.isRunning() === true) return;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      throw new Error('Doom did not enter a running level');
    });
    const doomUrl = page.url();

    // A generic confirmation remains click-protected; only Quit opts into a
    // click response.
    await page.evaluate(async () => {
      const menu = await import('/src/m_menu.js');
      window.__ordinaryPromptCalls = 0;
      menu.M_StartMessage('ordinary prompt', () => { window.__ordinaryPromptCalls++; }, true);
    });
    await page.mouse.click(320, 200);
    const ordinaryPrompt = await page.evaluate(async () => ({
      calls: window.__ordinaryPromptCalls,
      active: (await import('/src/doomstat.js')).menuactive,
    }));
    await page.keyboard.press('Escape');

    // Declining Quit must neither open a tab nor stop the original page.
    await page.keyboard.press('F10');
    await page.keyboard.press('n');
    await page.waitForTimeout(20);
    const declined = {
      pages: context.pages().length,
      extraPages,
      url: page.url(),
      canvasPresent: await page.evaluate(() => document.querySelector('#container canvas') !== null),
    };

    await page.evaluate(async () => {
      localStorage.removeItem('doom:defaults');
      (await import('/src/doomstat.js')).set_mouseSensitivity(9);
    });
    await page.keyboard.press('F10');
    const popupPromise = context.waitForEvent('page', { timeout: 5000 });
    if (mode === 'keyboard') await page.keyboard.press('y');
    else await page.mouse.click(320, 200);
    let popup;
    try {
      popup = await popupPromise;
    } catch (error) {
      const state = await page.evaluate(async () => ({
        menuactive: (await import('/src/doomstat.js')).menuactive,
        gametic: (await import('/src/doomstat.js')).gametic,
        loopRunning: (await import('/src/d_loop.js')).D_DoomRafLoop.isRunning(),
      }));
      throw new Error(`${mode} confirmation did not open a tab: ${JSON.stringify(state)}`, {
        cause: error,
      });
    }
    await popup.waitForLoadState('domcontentloaded');

    // A newly opened tab can background the game. Once the player returns,
    // the same renderer and Doom RAF must still be alive and advancing tics.
    await page.bringToFront();
    const running = await page.evaluate(async () => {
      const doomstat = await import('/src/doomstat.js');
      const loop = await import('/src/d_loop.js');
      const startTic = doomstat.gametic;
      for (let frame = 0; frame < 60 && doomstat.gametic === startTic; frame++) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      const liveRenderer = window.renderer;
      return {
        startTic,
        endTic: doomstat.gametic,
        gamestate: doomstat.gamestate,
        menuactive: doomstat.menuactive,
        loopRunning: loop.D_DoomRafLoop.isRunning(),
        canvasPresent: document.querySelector('#container canvas') !== null,
        rendererConnected: liveRenderer?.domElement?.isConnected === true,
        contextLost: liveRenderer === undefined ? null : liveRenderer.getContext().isContextLost(),
        defaultsSaved: localStorage.getItem('doom:defaults')?.includes(
          'mouse_sensitivity\t\t9',
        ) === true,
      };
    });

    const result = {
      mode,
      ordinaryPrompt,
      declined,
      doomUrl,
      originalUrl: page.url(),
      popupUrl: popup.url(),
      openerIsNull: await popup.evaluate(() => window.opener === null),
      running,
      extraPages,
      pages: context.pages().length,
      errors,
    };
    await context.close();
    return result;
  }

  const results = [
    await runConfirmation('keyboard'),
    await runConfirmation('click'),
  ];
  const failures = [];
  for (const result of results) {
    if (result.ordinaryPrompt.calls !== 0 || result.ordinaryPrompt.active !== true) {
      failures.push(`${result.mode} ordinary prompt: ${JSON.stringify(result.ordinaryPrompt)}`);
    }
    if (result.declined.pages !== 1 || result.declined.extraPages !== 0 ||
        result.declined.url !== result.doomUrl || result.declined.canvasPresent !== true) {
      failures.push(`${result.mode} decline: ${JSON.stringify(result.declined)}`);
    }
    if (result.popupUrl !== QUIT_LINK || result.openerIsNull !== true ||
        result.originalUrl !== result.doomUrl || result.extraPages !== 1 || result.pages !== 2) {
      failures.push(`${result.mode} popup: ${JSON.stringify(result)}`);
    }
    if (result.running.gamestate !== 0 || result.running.menuactive !== false ||
        result.running.loopRunning !== true || result.running.canvasPresent !== true ||
        result.running.rendererConnected !== true || result.running.contextLost !== false ||
        result.running.defaultsSaved !== true ||
        result.running.endTic <= result.running.startTic) {
      failures.push(`${result.mode} original game: ${JSON.stringify(result.running)}`);
    }
    if (result.errors.length !== 0) failures.push(`${result.mode} errors: ${result.errors.join('; ')}`);
  }
  if (failures.length !== 0) throw new Error(failures.join('\n'));
  console.log(JSON.stringify(results));
} finally {
  if (browser !== undefined) await browser.close();
}
