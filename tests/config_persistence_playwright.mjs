// Headless localStorage round-trip for the registered Doom settings. Start a
// static server at the repository root, then run with:
//   NODE_PATH=/path/to/node_modules node tests/config_persistence_playwright.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
}

let browser = null;
const watchdog = setTimeout(() => {
  console.error('config persistence Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);
const pageErrors = [];

try {
  browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({ viewport: { width: 640, height: 400 } });
  const baseUrl = process.env.DOOM_URL ?? 'http://127.0.0.1:8095/';
  const url = new URL(baseUrl);
  url.searchParams.set('-map', 'E1M1');

  const openGame = async () => {
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(url.href, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() =>
      window.renderer !== undefined &&
      window.scene?.getObjectByName('level') !== undefined &&
      window.renderer.info.render.frame > 2,
    { timeout: 30000 });
    return page;
  };

  const first = await openGame();
  const initial = await first.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const hu = await import('/src/hu_stuff.js');
    const video = await import('/src/v_video.js');
    const view = await import('/src/r_view.js');
    return {
      mouseSensitivity: doomstat.mouseSensitivity,
      sfxVolume: doomstat.snd_SfxVolume,
      musicVolume: doomstat.snd_MusicVolume,
      sndChannels: doomstat.numChannels,
      showMessages: hu.showMessages,
      usegamma: video.usegamma,
      screenblocks: view.R_GetScreenblocks(),
      viewport: [doomstat.scaledviewwidth, doomstat.viewheight],
    };
  });
  const saved = await first.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const system = await import('/src/i_system.js');
    const hu = await import('/src/hu_stuff.js');
    const video = await import('/src/v_video.js');
    const view = await import('/src/r_view.js');
    doomstat.set_mouseSensitivity(8);
    doomstat.set_snd_SfxVolume(12);
    doomstat.set_snd_MusicVolume(3);
    doomstat.set_numChannels(6);
    hu.HU_SetShowMessages(0);
    video.set_usegamma(3);
    view.R_SetViewSize(11);
    system.I_Quit();
    return localStorage.getItem('doom:defaults');
  });
  await first.close();

  const second = await openGame();
  const reloaded = await second.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const hu = await import('/src/hu_stuff.js');
    const video = await import('/src/v_video.js');
    const view = await import('/src/r_view.js');
    const value = {
      mouseSensitivity: doomstat.mouseSensitivity,
      sfxVolume: doomstat.snd_SfxVolume,
      musicVolume: doomstat.snd_MusicVolume,
      sndChannels: doomstat.numChannels,
      showMessages: hu.showMessages,
      usegamma: video.usegamma,
      screenblocks: view.R_GetScreenblocks(),
      viewport: [doomstat.scaledviewwidth, doomstat.viewheight],
      defaults: localStorage.getItem('doom:defaults'),
    };
    localStorage.removeItem('doom:defaults');
    return value;
  });
  await second.close();

  const failures = [];
  if (initial.mouseSensitivity !== 5 || initial.sfxVolume !== 8 ||
      initial.musicVolume !== 8 || initial.sndChannels !== 3 || initial.showMessages !== true ||
      initial.usegamma !== 0 || initial.screenblocks !== 10 ||
      JSON.stringify(initial.viewport) !== '[320,168]') {
    failures.push(`browser defaults mismatch: ${JSON.stringify(initial)}`);
  }
  if (saved !== 'mouse_sensitivity\t\t8\nsfx_volume\t\t12\nmusic_volume\t\t3\nshow_messages\t\t0\nusegamma\t\t3\nscreenblocks\t\t11\nsnd_channels\t\t6') {
    failures.push(`quit save mismatch: ${JSON.stringify(saved)}`);
  }
  if (reloaded.mouseSensitivity !== 8 || reloaded.sfxVolume !== 12 ||
      reloaded.musicVolume !== 3 || reloaded.sndChannels !== 6 || reloaded.showMessages !== false ||
      reloaded.usegamma !== 3 ||
      reloaded.screenblocks !== 11 || JSON.stringify(reloaded.viewport) !== '[320,200]' ||
      reloaded.defaults !== saved) {
    failures.push(`reload mismatch: ${JSON.stringify(reloaded)}`);
  }
  if (pageErrors.length !== 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (failures.length !== 0) throw new Error(failures.join('\n'));
  console.log(JSON.stringify({ initial, saved, reloaded }));
} finally {
  if (browser !== null) await browser.close();
  clearTimeout(watchdog);
}
