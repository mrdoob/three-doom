// Browser integration for exact indexed MF_SHADOW / psprite fuzz capture.
// Start a static server at the repository root and set DOOM_URL if needed.

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
const pageErrors = [];
const watchdog = setTimeout(() => {
  console.error('fuzz-effect Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({
    viewport: { width: 640, height: 400 },
    deviceScaleFactor: 2,
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8099/');
  url.searchParams.set('-map', 'E1M1');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer?.info.render.frame > 3,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const dMain = await import('/src/d_main.js');
    const doomstat = await import('/src/doomstat.js');
    const fuzz = await import('/src/r_fuzz.js');
    const info = await import('/src/info.js');
    const psprite = await import('/src/r_psprite.js');
    const renderData = await import('/src/r_data.js');
    const shader = await import('/src/r_shader.js');
    const video = await import('/src/i_video.js');
    const view = await import('/src/r_view.js');
    const paletteModule = await import('/src/v_palette.js');
    dMain.D_ShutdownDoomLoop();

    const originalView = view.R_GetViewSize();
    const originalBlocks = view.R_GetScreenblocks();
    const resources = [];
    let activePalette = paletteModule.V_GetActivePalette();
    const maps = renderData.colormaps;
    const pixelAt = (indices, x, y) => indices[y * 320 + x];
    const disposeObject = (object) => {
      object.parent?.remove(object);
      object.material?.uniforms?.map?.value?.dispose?.();
      object.material?.dispose?.();
    };
    const makeSprite = (index, { shadow = false } = {}) => {
      const texture = shader.R_MakeIndexedTexture(
        new Uint8Array([index]), new Uint8Array([255]), 1, 1,
      );
      const material = shader.R_MakeDoomSpriteMaterial(texture);
      material.uniforms.fullbright.value = true;
      material.uniforms.shadow.value = shadow;
      const sprite = new THREE.Sprite(material);
      material.uniforms.center.value = sprite.center;
      sprite.userData.doomFuzz = shadow;
      resources.push(sprite);
      return sprite;
    };
    const capture = (scene, camera, phase = 0) => {
      fuzz.R_SetFuzzPhase(phase);
      fuzz.R_RequestPspriteFuzzCapture(true);
      video.I_RenderView(scene, camera);
      const indices = fuzz.R_GetPspriteFuzzCapture();
      if (indices === null) throw new Error('requested psprite capture was not published');
      return Uint8Array.from(indices);
    };

    try {
      // Exercise every production indexed shader (walls, planes, sprites,
      // sky) under the shared capture uniform before using controlled scenes.
      fuzz.R_RequestPspriteFuzzCapture(true);
      video.I_RenderView(window.scene, window.camera);
      const productionCapture = fuzz.R_GetPspriteFuzzCapture();
      let productionNonzero = 0;
      for (const index of productionCapture ?? []) if (index !== 0) productionNonzero++;

      view.R_SetViewSize(11, 0);
      shader.R_SetViewLighting(0, 0, 320);
      const testScene = new THREE.Scene();
      const testCamera = new THREE.PerspectiveCamera(90, 1.6, 0.1, 100);
      testCamera.position.set(0, 0, 0);
      testCamera.lookAt(0, 0, -1);
      testCamera.updateMatrixWorld();

      // Find a real stock PLAYPAL collision after the renderer's standard
      // sRGB framebuffer encoding whose row-0 output indices remain distinct.
      // RGB recovery necessarily loses this distinction; indexed capture must
      // preserve the authored indices on either side of the collision.
      const screenByte = (value) => {
        const linear = value / 255;
        const encoded = linear <= 0.0031308
          ? 12.92 * linear
          : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
        return Math.max(0, Math.min(255, Math.round(encoded * 255)));
      };
      let collision = null;
      let collisionPalette = -1;
      for (let paletteIndex = 0; paletteIndex < 14 && collision === null; paletteIndex++) {
        const candidatePalette = paletteModule.V_GetPalette(paletteIndex);
        const firstByRgb = new Map();
        for (let index = 0; index < 256 && collision === null; index++) {
          const offset = index * 4;
          const key = `${screenByte(candidatePalette[offset])},${screenByte(candidatePalette[offset + 1])},${screenByte(candidatePalette[offset + 2])}`;
          const first = firstByRgb.get(key);
          if (first !== undefined && maps[first] !== maps[index]) {
            collision = [first, index];
            collisionPalette = paletteIndex;
          } else if (first === undefined) {
            firstByRgb.set(key, index);
          }
        }
      }
      if (collision === null) throw new Error('stock PLAYPAL exposed no useful RGB collision');
      video.I_SetPaletteIndex(collisionPalette);
      activePalette = paletteModule.V_GetActivePalette();

      const left = makeSprite(collision[0]);
      left.position.set(-1, 0, -2);
      left.scale.set(1.9, 5, 1);
      const right = makeSprite(collision[1]);
      right.position.set(1, 0, -2);
      right.scale.set(1.9, 5, 1);
      testScene.add(left, right);
      const collisionCapture = capture(testScene, testCamera);
      const collisionResult = {
        source: collision,
        palette: collisionPalette,
        displayedRgbEqual:
          screenByte(activePalette[collision[0] * 4]) === screenByte(activePalette[collision[1] * 4]) &&
          screenByte(activePalette[collision[0] * 4 + 1]) === screenByte(activePalette[collision[1] * 4 + 1]) &&
          screenByte(activePalette[collision[0] * 4 + 2]) === screenByte(activePalette[collision[1] * 4 + 2]),
        left: pixelAt(collisionCapture, 80, 100),
        right: pixelAt(collisionCapture, 240, 100),
        expectedLeft: maps[collision[0]],
        expectedRight: maps[collision[1]],
      };
      disposeObject(left);
      disposeObject(right);

      // A marked spectre entirely outside the camera frustum must not allocate
      // a per-frame prepass. The ordinary background remains a normal sprite.
      const backgroundIndex = 77;
      const background = makeSprite(backgroundIndex);
      background.position.set(0, 0, -3);
      background.scale.set(20, 20, 1);
      const spectre = makeSprite(5, { shadow: true });
      spectre.position.set(100, 0, -2);
      spectre.scale.set(1.2, 1.2, 1);
      testScene.add(background, spectre);
      fuzz.R_RequestPspriteFuzzCapture(false);
      const beforeOffscreen = video.I_GetFuzzCaptureStats();
      video.I_RenderView(testScene, testCamera);
      const offscreenStats = video.I_GetFuzzCaptureStats();
      const offscreen = {
        worldFuzzSprites: offscreenStats.lastWorldFuzzSprites,
        indexPasses: offscreenStats.lastIndexPasses,
        cumulativeDelta: offscreenStats.indexPasses - beforeOffscreen.indexPasses,
      };

      // Bring it into the view. World fuzz needs one base index pass. When an
      // invisible psprite also requests the screen, a second composed pass
      // must include the already-fuzzed spectre before CPU psprite sampling.
      spectre.position.set(0, 0, -2);
      spectre.updateMatrixWorld(true);
      fuzz.R_RequestPspriteFuzzCapture(false);
      video.I_RenderView(testScene, testCamera);
      const worldStats = video.I_GetFuzzCaptureStats();

      const coexistCapture = capture(testScene, testCamera, 0);
      const coexistStats = video.I_GetFuzzCaptureStats();
      const baseRemap = maps[backgroundIndex];
      const expectedFuzzIndex = maps[6 * 256 + baseRemap];
      const coexistence = {
        worldOnlyPasses: worldStats.lastIndexPasses,
        passes: coexistStats.lastIndexPasses,
        composed: coexistStats.lastComposedCapture,
        center: pixelAt(coexistCapture, 160, 100),
        expectedCenter: expectedFuzzIndex,
        spectreVisible: spectre.visible,
        captureUniformRestored: shader.paletteIndexCaptureUniform.value === false,
        renderTargetRestored: window.renderer.getRenderTarget() === null,
      };

      // CPU psprite fuzz consumes exact indices. Seed it with the second stock
      // RGB-collision index; at least the first-pass row-6 colour must survive,
      // which an RGB->palette-first reverse map cannot guarantee.
      const localPlayer = doomstat.players[doomstat.consoleplayer];
      const invisiblePlayer = {
        ...localPlayer,
        powers: [0, 0, 129, 0, 0, 0],
        psprites: [
          { state: info.S_PISTOL, sx: 65536, sy: 32 * 65536 },
          { state: 0, sx: 0, sy: 0 },
        ],
      };
      const collisionBackground = new Uint8Array(320 * 200).fill(collision[1]);
      fuzz.R_SetFuzzPhase(0);
      const pspriteCanvas = document.createElement('canvas');
      pspriteCanvas.width = 320;
      pspriteCanvas.height = 200;
      const pspriteContext = pspriteCanvas.getContext('2d', { willReadFrequently: true });
      psprite.R_DrawPlayerSprites(
        pspriteContext, invisiblePlayer, 0, 0, 320, 200,
        view.R_GetViewSize(), collisionBackground,
      );
      const pspritePixels = pspriteContext.getImageData(0, 0, 320, 200).data;
      const firstMapped = maps[6 * 256 + collision[1]];
      const expectedRgb = Array.from(activePalette.subarray(firstMapped * 4, firstMapped * 4 + 3));
      let pspriteOpaque = 0;
      let exactCollisionMappedPixels = 0;
      for (let offset = 0; offset < pspritePixels.length; offset += 4) {
        if (pspritePixels[offset + 3] === 0) continue;
        pspriteOpaque++;
        if (pspritePixels[offset] === expectedRgb[0] &&
            pspritePixels[offset + 1] === expectedRgb[1] &&
            pspritePixels[offset + 2] === expectedRgb[2]) exactCollisionMappedPixels++;
      }

      // A reduced logical view at DPR=2 still owns a 224x112 index target,
      // not a device-pixel or full-window target. Outside the logical view is
      // the mandated clear index 0.
      spectre.visible = false;
      const reducedView = view.R_SetViewSize(7, 0);
      const reducedCapture = capture(testScene, testCamera);
      const reducedStats = video.I_GetFuzzCaptureStats();
      const reducedCenterX = reducedView.viewwindowx + (reducedView.scaledviewwidth >> 1);
      const reducedCenterY = reducedView.viewwindowy + (reducedView.viewheight >> 1);
      const reduced = {
        devicePixelRatio: window.devicePixelRatio,
        targetWidth: reducedStats.lastTargetWidth,
        targetHeight: reducedStats.lastTargetHeight,
        expectedWidth: reducedView.scaledviewwidth,
        expectedHeight: reducedView.viewheight,
        center: pixelAt(reducedCapture, reducedCenterX, reducedCenterY),
        expectedCenter: baseRemap,
        outsideTopLeft: pixelAt(reducedCapture, 0, 0),
        passes: reducedStats.lastIndexPasses,
      };

      const glError = window.renderer.getContext().getError();
      const programCount = window.renderer.info.programs?.length ?? 0;
      for (const object of resources) disposeObject(object);
      view.R_SetViewSize(originalBlocks, originalView.detailshift);
      const shutdown = await video.I_ShutdownGraphics();
      return {
        productionNonzero,
        collision: collisionResult,
        offscreen,
        worldStats: {
          sprites: worldStats.lastWorldFuzzSprites,
          passes: worldStats.lastIndexPasses,
        },
        coexistence,
        psprite: { opaque: pspriteOpaque, exactCollisionMappedPixels, expectedRgb },
        reduced,
        glError,
        programCount,
        shutdown: {
          contextLost: shutdown.contextLost,
          globalsReleased: window.renderer === undefined && window.scene === undefined,
        },
      };
    } finally {
      for (const object of resources) disposeObject(object);
      if (window.renderer !== undefined) view.R_SetViewSize(originalBlocks, originalView.detailshift);
    }
  });

  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join('; ')}`);
  assert(result.productionNonzero > 100, 'production indexed capture was empty');
  assert(result.collision.displayedRgbEqual, 'fixture is not a real stock PLAYPAL collision');
  assert(result.collision.left === result.collision.expectedLeft,
    `left collision index changed: ${JSON.stringify(result.collision)}`);
  assert(result.collision.right === result.collision.expectedRight,
    `right collision index changed: ${JSON.stringify(result.collision)}`);
  assert(result.collision.left !== result.collision.right,
    `colliding RGB entries collapsed: ${JSON.stringify(result.collision)}`);
  assert(result.offscreen.worldFuzzSprites === 0 && result.offscreen.indexPasses === 0 &&
    result.offscreen.cumulativeDelta === 0,
  `offscreen spectre triggered capture: ${JSON.stringify(result.offscreen)}`);
  assert(result.worldStats.sprites === 1 && result.worldStats.passes === 1,
    `visible world fuzz capture mismatch: ${JSON.stringify(result.worldStats)}`);
  assert(result.coexistence.passes === 2 && result.coexistence.composed === true,
    `coexistence did not compose two indexed passes: ${JSON.stringify(result.coexistence)}`);
  assert(result.coexistence.center === result.coexistence.expectedCenter,
    `composed capture omitted world fuzz: ${JSON.stringify(result.coexistence)}`);
  assert(result.coexistence.spectreVisible && result.coexistence.captureUniformRestored &&
    result.coexistence.renderTargetRestored,
  `capture leaked renderer/material state: ${JSON.stringify(result.coexistence)}`);
  assert(result.psprite.opaque > 100, 'partial-invisibility psprite drew no useful mask');
  assert(result.psprite.exactCollisionMappedPixels > 0,
    `CPU fuzz lost exact collision index: ${JSON.stringify(result.psprite)}`);
  assert(result.reduced.devicePixelRatio === 2,
    `DPR fixture changed: ${JSON.stringify(result.reduced)}`);
  assert(result.reduced.targetWidth === result.reduced.expectedWidth &&
    result.reduced.targetHeight === result.reduced.expectedHeight,
  `capture target is not logical-view-sized: ${JSON.stringify(result.reduced)}`);
  assert(result.reduced.center === result.reduced.expectedCenter &&
    result.reduced.outsideTopLeft === 0 && result.reduced.passes === 1,
  `reduced capture indices mismatch: ${JSON.stringify(result.reduced)}`);
  assert(result.glError === 0, `WebGL error ${result.glError}`);
  assert(result.programCount > 0, 'indexed shaders did not compile');
  assert(result.shutdown.contextLost === true, 'fuzz target shutdown did not lose WebGL context');
  assert(result.shutdown.globalsReleased === true, 'renderer globals survived shutdown');
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
