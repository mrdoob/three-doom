// Real E1M1 regression for retained walls leaking through terminal sky spans.
// Start a static server at the repository root, then run with Playwright.

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

const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected);
let browser = null;
const pageErrors = [];
const watchdog = setTimeout(() => {
  console.error('sky occlusion Playwright test exceeded 60 seconds');
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
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer?.info.render.frame > 3,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const dMain = await import('/src/d_main.js');
    const video = await import('/src/i_video.js');
    const view = await import('/src/r_view.js');
    const sky = await import('/src/r_sky.js');
    dMain.D_ShutdownDoomLoop();
    view.R_SetViewSize(9);

    // Playable E1M1 courtyard pose: walk north from spawn and look east
    // through the windows. Without physical sky depth, retained remote walls
    // around x=3072 overwrite the sky-height seam at y=-3648.
    window.camera.position.set(1056, 25, 3218);
    window.camera.rotation.order = 'YXZ';
    const angle = 0x08000000 / 0x100000000 * Math.PI * 2;
    window.camera.rotation.set(0, angle - Math.PI / 2, 0);
    sky.R_UpdateSky();

    const occluders = [];
    window.scene.getObjectByName('level').traverse((object) => {
      if (object.userData.doomSkyDepthOccluder === true) occluders.push(object);
    });
    const read = (layout, localX, localY) => {
      const gl = window.renderer.getContext();
      const pixel = new Uint8Array(4);
      gl.readPixels(
        layout.viewX + localX,
        layout.webglViewY + layout.viewHeight - 1 - localY,
        1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel,
      );
      return [...pixel];
    };
    const sample = (layout) => ({
      leakA: read(layout, 684, 204),
      leakB: read(layout, 700, 210),
      nearerWall: read(layout, 720, 220),
    });

    // Control: disabling only the new depth passes reproduces the reported
    // remote-wall leak while leaving every color-pass mesh unchanged.
    for (const occluder of occluders) occluder.visible = false;
    const without = sample(video.I_RenderView(window.scene, window.camera));
    for (const occluder of occluders) occluder.visible = true;
    const withOcclusion = sample(video.I_RenderView(window.scene, window.camera));
    const gl = window.renderer.getContext();
    return {
      occluderCount: occluders.length,
      invalidOccluders: occluders.filter((object) =>
        object.material.colorWrite !== false || object.material.depthTest !== true ||
        object.material.depthWrite !== true || object.renderOrder >= 0
      ).length,
      without,
      withOcclusion,
      glError: gl.getError(),
      expectedGlError: gl.NO_ERROR,
    };
  });

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  assert(result.occluderCount === 8 && result.invalidOccluders === 0,
    `production sky occluders are incomplete: ${JSON.stringify(result)}`);
  assert(same(result.without.leakA, [8, 8, 8, 255]) &&
         same(result.without.leakB, [1, 1, 1, 255]),
  `control did not reproduce the remote-wall leak: ${JSON.stringify(result)}`);
  assert(same(result.withOcclusion.leakA, [12, 12, 12, 255]) &&
         same(result.withOcclusion.leakB, [12, 12, 12, 255]),
  `sky terminal did not hide remote walls: ${JSON.stringify(result)}`);
  assert(same(result.without.nearerWall, [28, 28, 28, 255]) &&
         same(result.withOcclusion.nearerWall, result.without.nearerWall),
  `sky depth hid geometry in front of the terminal: ${JSON.stringify(result)}`);
  assert(result.glError === result.expectedGlError,
    `WebGL error after sky occlusion render: ${result.glError}`);

  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
