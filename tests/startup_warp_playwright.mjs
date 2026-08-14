// Real browser regression for command-line map autostart. The startup path
// must enter through G_InitNew before G_DoLoadLevel so native gameplay flags
// affect the very first map rather than only later New Game transitions.

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
  console.error('startup warp Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8095/');
  url.search = '?-map=E1M1&-fast&-respawn&-nomonsters';
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer?.info.render.frame > 2,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const info = await import('/src/info.js');
    const { FRACUNIT } = await import('/src/m_fixed.js');

    return {
      usergame: doomstat.usergame,
      gamestate: doomstat.gamestate,
      episode: doomstat.gameepisode,
      map: doomstat.gamemap,
      skill: doomstat.gameskill,
      respawnparm: doomstat.respawnparm,
      respawnmonsters: doomstat.respawnmonsters,
      fastparm: doomstat.fastparm,
      nomonsters: doomstat.nomonsters,
      language: doomstat.language,
      projectileSpeeds: {
        bruiser: info.mobjinfo[info.MT_BRUISERSHOT].speed / FRACUNIT,
        head: info.mobjinfo[info.MT_HEADSHOT].speed / FRACUNIT,
        troop: info.mobjinfo[info.MT_TROOPSHOT].speed / FRACUNIT,
      },
    };
  });

  const failures = [];
  if (result.usergame !== true) failures.push('autostart did not mark a user game');
  if (result.gamestate !== 0 || result.episode !== 1 || result.map !== 1 || result.skill !== 2) {
    failures.push(`wrong startup target: ${JSON.stringify(result)}`);
  }
  if (!result.respawnparm || !result.respawnmonsters) {
    failures.push(`-respawn was not applied by G_InitNew: ${JSON.stringify(result)}`);
  }
  if (!result.fastparm ||
      result.projectileSpeeds.bruiser !== 20 ||
      result.projectileSpeeds.head !== 20 ||
      result.projectileSpeeds.troop !== 20) {
    failures.push(`-fast was not applied by G_InitNew: ${JSON.stringify(result.projectileSpeeds)}`);
  }
  if (!result.nomonsters) failures.push('-nomonsters was cleared during autostart');
  if (result.language !== 0) failures.push(`ordinary IWAD did not reset English: ${result.language}`);
  if (pageErrors.length !== 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (failures.length !== 0) throw new Error(failures.join('\n'));

  console.log(JSON.stringify(result));
} finally {
  if (browser !== null) await browser.close();
  clearTimeout(watchdog);
}
