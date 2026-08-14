// Real-WAD save/load lifecycle regression. Start a static server at the
// repository root, then run with:
//   NODE_PATH=/path/to/node_modules node tests/save_load_playwright.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
}

let browser = null;
const watchdog = setTimeout(() => {
  console.error('save/load Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);
const pageErrors = [];

try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8134/');
  url.searchParams.set('-map', 'E1M1');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    window.renderer !== undefined &&
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer.info.render.frame > 2,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const { gameaction_t } = await import('/src/d_event.js');
    const game = await import('/src/g_game.js');
    const loop = await import('/src/d_loop.js');
    const random = await import('/src/m_random.js');
    const pSetup = await import('/src/p_setup.js');
    const saveg = await import('/src/p_saveg.js');
    const rMain = await import('/src/r_main.js');
    const rSky = await import('/src/r_sky.js');
    const rThings = await import('/src/r_things.js');
    const video = await import('/src/i_video.js');
    loop.D_DoomRafLoop.stop();

    function drawRestoredLevel() {
      const player = doomstat.players[doomstat.displayplayer];
      rMain.R_SetupFrame(player);
      rThings.R_UpdateSprites();
      rSky.R_UpdateSky();
      video.I_RenderView(video.scene, video.camera);
    }

    function resources() {
      const roots = video.scene.children.filter((child) => child.name === 'level');
      const root = roots[0] ?? null;
      const geometries = new Set();
      const materials = new Set();
      let objects = 0;
      let sprites = 0;
      if (root !== null) {
        root.traverse((object) => {
          objects++;
          if (object.isSprite === true) sprites++;
          if (object.geometry != null) geometries.add(object.geometry);
          const values = Array.isArray(object.material) ? object.material : [object.material];
          for (const material of values) if (material != null) materials.add(material);
        });
      }
      return {
        roots: roots.length,
        objects,
        sprites,
        geometries: geometries.size,
        materials: materials.size,
        gpuGeometries: video.renderer.info.memory.geometries,
        gpuTextures: video.renderer.info.memory.textures,
      };
    }

    localStorage.removeItem('doom:save:0');
    localStorage.removeItem('doom:save:1');
    const player = doomstat.players[doomstat.consoleplayer];
    const sectorIndex = player.mo.subsector.sector.index;
    player.health = 73;
    player.mo.health = 73;
    pSetup.sectors[sectorIndex].lightlevel = 176;
    doomstat.set_leveltime(777);

    const rngBeforeSave = random._get_prndindex();
    const saved = saveg.P_SaveGame(0, 'LIFECYCLE');
    const rngAfterSave = random._get_prndindex();
    const blob = saveg.P_ReadSaveGame(0);
    const expectedSprites = blob === false ? -1 :
      blob.thinkers.filter((mobj) => (mobj.flags & 0x8) === 0).length;

    function mutateThenLoad() {
      const current = doomstat.players[doomstat.consoleplayer];
      current.health = 9;
      current.mo.health = 9;
      pSetup.sectors[sectorIndex].lightlevel = 0;
      doomstat.set_leveltime(3);
      game.G_LoadGame(0);
      game.G_Ticker();
      drawRestoredLevel();
      const restored = doomstat.players[doomstat.consoleplayer];
      return {
        health: restored.health,
        mobjHealth: restored.mo?.health,
        leveltime: doomstat.leveltime,
        lightlevel: pSetup.sectors[sectorIndex].lightlevel,
        rng: random._get_prndindex(),
        mapThingRegistrations: window.__mobjsByMapThing?.size,
        resources: resources(),
      };
    }

    const first = mutateThenLoad();
    const firstRoot = video.scene.getObjectByName('level');
    const second = mutateThenLoad();

    // A structurally valid same-count save with another map-content identity
    // must fail target-WAD preflight without touching this level.
    const replacement = blob.mapFingerprint.digest[0] === '0' ? '1' : '0';
    const wrongMap = {
      ...blob,
      mapFingerprint: {
        ...blob.mapFingerprint,
        digest: replacement + blob.mapFingerprint.digest.slice(1),
      },
    };
    localStorage.setItem('doom:save:1', JSON.stringify(wrongMap));
    const wrongMapParsed = saveg.P_ReadSaveGame(1) !== false;
    const rootBeforeRejectedLoad = video.scene.getObjectByName('level');
    const playerBeforeRejectedLoad = doomstat.players[doomstat.consoleplayer];
    const rejectedBefore = {
      health: playerBeforeRejectedLoad.health,
      leveltime: doomstat.leveltime,
      rng: random._get_prndindex(),
    };
    game.G_LoadGame(1);
    game.G_Ticker();
    const rejectedAfter = {
      health: doomstat.players[doomstat.consoleplayer].health,
      leveltime: doomstat.leveltime,
      rng: random._get_prndindex(),
      rootUnchanged: video.scene.getObjectByName('level') === rootBeforeRejectedLoad,
      actionConsumed: doomstat.gameaction === gameaction_t.ga_nothing,
    };

    localStorage.removeItem('doom:save:0');
    localStorage.removeItem('doom:save:1');
    return {
      saved,
      parsed: blob !== false,
      rngBeforeSave,
      rngAfterSave,
      expectedSprites,
      first,
      second,
      rootReplacedOnSecondLoad: video.scene.getObjectByName('level') !== firstRoot,
      wrongMapParsed,
      rejectedBefore,
      rejectedAfter,
    };
  });

  const failures = [];
  if (result.saved !== true || result.parsed !== true) {
    failures.push(`save/read failed: ${JSON.stringify(result)}`);
  }
  if (result.rngAfterSave !== result.rngBeforeSave) {
    failures.push(`saving consumed RNG: ${result.rngBeforeSave} -> ${result.rngAfterSave}`);
  }
  for (const [name, loaded] of [['first', result.first], ['second', result.second]]) {
    if (loaded.health !== 73 || loaded.mobjHealth !== 73 ||
        loaded.leveltime !== 777 || loaded.lightlevel !== 176) {
      failures.push(`${name} state mismatch: ${JSON.stringify(loaded)}`);
    }
    if (loaded.mapThingRegistrations !== 0) {
      failures.push(`${name} retained stale mapthing actors: ${loaded.mapThingRegistrations}`);
    }
    if (loaded.resources.roots !== 1 || loaded.resources.sprites !== result.expectedSprites) {
      failures.push(`${name} renderer registration mismatch: ${JSON.stringify(loaded.resources)}`);
    }
  }
  if (result.first.rng !== result.second.rng) {
    failures.push(`repeated load RNG drift: ${result.first.rng} != ${result.second.rng}`);
  }
  if (result.wrongMapParsed !== true) {
    failures.push('different map identity did not pass structural save validation');
  }
  if (JSON.stringify(result.first.resources) !== JSON.stringify(result.second.resources)) {
    failures.push(`repeated load resources drifted: ${JSON.stringify(result.first.resources)} != ${JSON.stringify(result.second.resources)}`);
  }
  if (result.rootReplacedOnSecondLoad !== true) {
    failures.push('second load reused the old level root');
  }
  if (result.rejectedAfter.rootUnchanged !== true ||
      result.rejectedAfter.actionConsumed !== true ||
      result.rejectedAfter.health !== result.rejectedBefore.health ||
      result.rejectedAfter.leveltime !== result.rejectedBefore.leveltime ||
      result.rejectedAfter.rng !== result.rejectedBefore.rng) {
    failures.push(`wrong-map preflight mutated state: ${JSON.stringify(result)}`);
  }
  if (pageErrors.length !== 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (failures.length !== 0) throw new Error(failures.join('\n'));
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
