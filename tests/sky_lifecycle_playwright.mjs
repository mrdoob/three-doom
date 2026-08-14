// Focused lifecycle regression for direct sky rebuilds. Run against the
// repository's static server after the bundled IWAD has initialized.

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
const pageErrors = [];
const watchdog = setTimeout(() => {
  console.error('sky lifecycle Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8095/');
  url.searchParams.set('-map', 'E1M1');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    globalThis.scene?.getObjectByName('level') !== undefined &&
    globalThis.renderer?.info.render.frame > 3,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const dMain = await import('/src/d_main.js');
    const data = await import('/src/r_data.js');
    const rMain = await import('/src/r_main.js');
    const sky = await import('/src/r_sky.js');
    dMain.D_ShutdownDoomLoop();
    // Direct sky construction is valid only after the retained level releases
    // its material ownership, matching R_NewMap's production ordering.
    rMain.R_Shutdown();

    const materialList = (materials) => [
      materials.floor,
      materials.ceiling,
      materials.floorOccluder,
      materials.ceilingOccluder,
    ];
    const watchDisposal = (materials) => {
      const list = materialList(materials);
      const map = materials.ceiling.uniforms.map.value;
      const materialEvents = new Array(list.length).fill(0);
      let mapEvents = 0;
      list.forEach((material, index) => {
        material.addEventListener('dispose', () => materialEvents[index]++);
      });
      map.addEventListener('dispose', () => mapEvents++);
      return {
        list,
        materialEvents,
        get mapEvents() { return mapEvents; },
      };
    };

    const camera = globalThis.camera;
    const savedFov = camera.fov;
    const savedAspect = camera.aspect;
    const renamedTextures = [];
    try {
      // Make the expected horizontal projection distinct from the material's
      // 1.0 initializer. The values remain unchanged across both builds so
      // only a reset cache causes the second R_UpdateSky call to write it.
      camera.fov = 70;
      camera.aspect = 1.6;
      camera.updateProjectionMatrix();
      const expectedHalfTan = Math.tan(camera.fov * Math.PI / 360) * camera.aspect;

      const first = sky.R_BuildSky();
      if (first === null) throw new Error('initial sky rebuild failed');
      sky.R_UpdateSky();
      const firstHalfTan = first.ceiling.uniforms.hfovHalfTan.value;
      const firstDisposal = watchDisposal(first);

      let activeRebuildError = '';
      try {
        sky.R_BuildSky();
      } catch (error) {
        activeRebuildError = error.message;
      }
      const activeRebuildPreserved = {
        materialEvents: [...firstDisposal.materialEvents],
        mapEvents: firstDisposal.mapEvents,
      };
      const firstShutdown = sky.R_ShutdownSky();

      const second = sky.R_BuildSky();
      if (second === null) throw new Error('second sky rebuild failed');
      const secondBeforeUpdate = second.ceiling.uniforms.hfovHalfTan.value;
      sky.R_UpdateSky();
      const secondAfterUpdate = second.ceiling.uniforms.hfovHalfTan.value;
      const secondDisposal = watchDisposal(second);

      // Remove every texture with the selected sky name without disturbing
      // the texture/cache arrays. This deterministically exercises the
      // missing-sky lookup regardless of which IWAD supplies the fixture.
      const selectedName = data.textures[sky.skytexture].name;
      for (const texture of data.textures) {
        if (texture.name !== selectedName) continue;
        renamedTextures.push({ texture, name: texture.name });
        texture.name = '__MISSING_SKY__';
      }
      const secondShutdown = sky.R_ShutdownSky();
      const missing = sky.R_BuildSky();
      const missingTexture = sky.skytexture;
      const firstShutdownAfterMissing = sky.R_ShutdownSky();
      const secondShutdownAfterMissing = sky.R_ShutdownSky();

      for (const entry of renamedTextures) entry.texture.name = entry.name;
      renamedTextures.length = 0;

      const third = sky.R_BuildSky();
      if (third === null) throw new Error('sky did not recover after restoring its name');
      sky.R_UpdateSky();
      const thirdHalfTan = third.ceiling.uniforms.hfovHalfTan.value;
      const thirdDisposal = watchDisposal(third);
      const shutdownMaterials = sky.R_ShutdownSky();
      const repeatedShutdown = sky.R_ShutdownSky();

      return {
        expectedHalfTan,
        firstHalfTan,
        secondBeforeUpdate,
        secondAfterUpdate,
        thirdHalfTan,
        missingWasNull: missing === null,
        missingTexture,
        activeRebuildError,
        activeRebuildPreserved,
        firstShutdownCount: firstShutdown.length,
        secondShutdownCount: secondShutdown.length,
        firstDisposal: {
          materialEvents: firstDisposal.materialEvents,
          mapEvents: firstDisposal.mapEvents,
        },
        secondDisposal: {
          materialEvents: secondDisposal.materialEvents,
          mapEvents: secondDisposal.mapEvents,
        },
        thirdDisposal: {
          materialEvents: thirdDisposal.materialEvents,
          mapEvents: thirdDisposal.mapEvents,
        },
        shutdownAfterMissing: [
          firstShutdownAfterMissing.length,
          secondShutdownAfterMissing.length,
        ],
        shutdownReturnedCount: shutdownMaterials.length,
        shutdownReturnedAllBuilt: shutdownMaterials.every((material) =>
          thirdDisposal.list.includes(material)),
        shutdownReturnedUnique: new Set(shutdownMaterials).size,
        repeatedShutdownCount: repeatedShutdown.length,
      };
    } finally {
      for (const entry of renamedTextures) entry.texture.name = entry.name;
      sky.R_ShutdownSky();
      camera.fov = savedFov;
      camera.aspect = savedAspect;
      camera.updateProjectionMatrix();
    }
  });

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  const close = (actual, expected) => Math.abs(actual - expected) < 1e-12;
  assert(close(result.firstHalfTan, result.expectedHalfTan),
    `initial FOV update is incorrect: ${JSON.stringify(result)}`);
  assert(result.secondBeforeUpdate === 1 &&
         close(result.secondAfterUpdate, result.expectedHalfTan),
  `sky rebuild retained stale FOV/aspect cache state: ${JSON.stringify(result)}`);
  assert(close(result.thirdHalfTan, result.expectedHalfTan),
    `sky recovery projection is incorrect: ${JSON.stringify(result)}`);
  assert(result.missingWasNull && result.missingTexture === -1,
    `missing sky did not fail cleanly: ${JSON.stringify(result)}`);
  assert(result.activeRebuildError.includes('call R_ShutdownSky') &&
         result.activeRebuildPreserved.materialEvents.every((count) => count === 0) &&
         result.activeRebuildPreserved.mapEvents === 0 &&
         result.firstShutdownCount === 4 && result.secondShutdownCount === 4,
  `active rebuild did not preserve retained ownership: ${JSON.stringify(result)}`);
  assert(result.firstDisposal.materialEvents.every((count) => count === 1) &&
         result.firstDisposal.mapEvents === 1,
  `successful rebuild did not dispose the first sky once: ${JSON.stringify(result)}`);
  assert(result.secondDisposal.materialEvents.every((count) => count === 1) &&
         result.secondDisposal.mapEvents === 1,
  `missing-sky rebuild did not dispose the second sky once: ${JSON.stringify(result)}`);
  assert(result.shutdownAfterMissing.every((count) => count === 0),
    `missing-sky reset was not idempotent: ${JSON.stringify(result)}`);
  assert(result.shutdownReturnedCount === 4 &&
         result.shutdownReturnedUnique === 4 &&
         result.shutdownReturnedAllBuilt &&
         result.thirdDisposal.materialEvents.every((count) => count === 1) &&
         result.thirdDisposal.mapEvents === 1 &&
         result.repeatedShutdownCount === 0,
  `shutdown ownership/disposal contract changed: ${JSON.stringify(result)}`);

  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
