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

  const waitForGame = async (page) => {
    await page.waitForFunction(() =>
      window.renderer !== undefined &&
      window.scene?.getObjectByName('level') !== undefined &&
      window.renderer.info.render.frame > 2,
    { timeout: 30000 });
  };

  const openGame = async (gameUrl = url.href) => {
    const page = await context.newPage();
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.goto(gameUrl, { waitUntil: 'domcontentloaded' });
    await waitForGame(page);
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
  const beforeReload = await first.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
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
    return localStorage.getItem('doom:defaults');
  });
  await first.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(first);

  const reloaded = await first.evaluate(async () => {
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
    return value;
  });
  await first.close();

  const profileUrl = new URL(url);
  profileUrl.searchParams.set('-config', 'practice.cfg');
  const profile = await openGame(profileUrl.href);
  const profileInitial = await profile.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const video = await import('/src/v_video.js');
    return {
      mouseSensitivity: doomstat.mouseSensitivity,
      usegamma: video.usegamma,
      base: localStorage.getItem('doom:defaults'),
      named: localStorage.getItem('doom:defaults:practice.cfg'),
    };
  });
  await profile.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const video = await import('/src/v_video.js');
    doomstat.set_mouseSensitivity(4);
    video.set_usegamma(2);
  });
  await profile.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(profile);
  const profileReloaded = await profile.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const misc = await import('/src/m_misc.js');
    const video = await import('/src/v_video.js');
    const value = {
      mouseSensitivity: doomstat.mouseSensitivity,
      usegamma: video.usegamma,
      base: localStorage.getItem('doom:defaults'),
      named: localStorage.getItem('doom:defaults:practice.cfg'),
    };
    misc.M_StopDefaultsPersistence();
    localStorage.removeItem('doom:defaults');
    localStorage.removeItem('doom:defaults:practice.cfg');
    return value;
  });
  await profile.close();

  const failures = [];
  if (initial.mouseSensitivity !== 5 || initial.sfxVolume !== 8 ||
      initial.musicVolume !== 8 || initial.sndChannels !== 3 || initial.showMessages !== true ||
      initial.usegamma !== 0 || initial.screenblocks !== 10 ||
      JSON.stringify(initial.viewport) !== '[320,168]') {
    failures.push(`browser defaults mismatch: ${JSON.stringify(initial)}`);
  }
  if (beforeReload !== null) {
    failures.push(`settings saved before lifecycle event: ${JSON.stringify(beforeReload)}`);
  }
  if (reloaded.mouseSensitivity !== 8 || reloaded.sfxVolume !== 12 ||
      reloaded.musicVolume !== 3 || reloaded.sndChannels !== 6 || reloaded.showMessages !== false ||
      reloaded.usegamma !== 3 ||
      reloaded.screenblocks !== 11 || JSON.stringify(reloaded.viewport) !== '[320,200]' ||
      reloaded.defaults !== 'mouse_sensitivity\t\t8\nsfx_volume\t\t12\nmusic_volume\t\t3\nshow_messages\t\t0\nusegamma\t\t3\nscreenblocks\t\t11\nsnd_channels\t\t6') {
    failures.push(`reload mismatch: ${JSON.stringify(reloaded)}`);
  }
  if (profileInitial.mouseSensitivity !== 5 || profileInitial.usegamma !== 0 ||
      profileInitial.base !== reloaded.defaults || profileInitial.named !== null) {
    failures.push(`named profile was not isolated: ${JSON.stringify(profileInitial)}`);
  }
  if (profileReloaded.mouseSensitivity !== 4 || profileReloaded.usegamma !== 2 ||
      profileReloaded.base !== reloaded.defaults ||
      !profileReloaded.named?.startsWith('mouse_sensitivity\t\t4\n') ||
      !profileReloaded.named?.includes('\nusegamma\t\t2\n')) {
    failures.push(`named profile reload mismatch: ${JSON.stringify(profileReloaded)}`);
  }
  if (pageErrors.length !== 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (failures.length !== 0) throw new Error(failures.join('\n'));
  console.log(JSON.stringify({ initial, beforeReload, reloaded, profileInitial, profileReloaded }));
} finally {
  if (browser !== null) await browser.close();
  clearTimeout(watchdog);
}
