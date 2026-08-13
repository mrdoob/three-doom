// PLAYPAL affects Doom's complete 320x200 framebuffer, including its textured
// view border, but must not tint browser-only letterbox pixels outside it.

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

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let browser = null;
const pageErrors = [];
const watchdog = setTimeout(() => {
  console.error('palette border Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

try {
  browser = await chromium.launch(launchOptions);
  // Wider than Doom's 8:5 display, leaving real browser-only bars at left/right.
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8095/');
  url.searchParams.set('-map', 'E1M1');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer?.info.render.frame > 3,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const border = await import('/src/r_border.js');
    const dMain = await import('/src/d_main.js');
    const doomstat = await import('/src/doomstat.js');
    const palette = await import('/src/v_palette.js');
    const video = await import('/src/i_video.js');
    const view = await import('/src/r_view.js');
    const wad = await import('/src/w_wad.js');
    dMain.D_ShutdownDoomLoop();

    const currentView = view.R_SetViewSize(9);
    const overlay = document.getElementById('overlay');
    const layout = view.R_CalculateCanvasView(
      overlay.width, overlay.height, currentView,
    );
    const gl = window.renderer.getContext();
    const readGl = (x, y) => {
      const pixel = new Uint8Array(4);
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return [...pixel];
    };

    const scratch = document.createElement('canvas');
    scratch.width = 320;
    scratch.height = 200;
    const ctx = scratch.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    const nativeLayout = view.R_CalculateCanvasView(320, 200, currentView);
    const flat = wad.W_CacheLumpName('FLOOR7_2', 0);
    const flatIndex = flat[10 * 64 + 10];

    const sample = (paletteIndex) => {
      video.I_SetPaletteIndex(paletteIndex);
      video.I_RenderView(window.scene, window.camera);
      ctx.clearRect(0, 0, scratch.width, scratch.height);
      border.R_DrawViewBorder(ctx, nativeLayout, currentView, doomstat.gamemode);
      const selected = palette.V_GetPalette(paletteIndex);
      const offset = flatIndex * 4;
      return {
        browserLetterbox: readGl(5, Math.floor(layout.canvasHeight / 2)),
        doomBorder: [...ctx.getImageData(10, 10, 1, 1).data],
        expectedDoomBorder: [...selected.subarray(offset, offset + 4)],
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        rootBackground: getComputedStyle(document.documentElement).backgroundColor,
      };
    };

    const samples = {
      base: sample(0),
      damage: sample(8),
      bonus: sample(9),
    };
    video.I_SetPaletteIndex(0);
    return {
      screenX: layout.screenX,
      glError: gl.getError(),
      expectedGlError: gl.NO_ERROR,
      samples,
    };
  });

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  assert(result.screenX > 5, `test viewport has no browser letterbox: ${JSON.stringify(result)}`);
  for (const [name, sample] of Object.entries(result.samples)) {
    assert(same(sample.browserLetterbox, [0, 0, 0, 255]),
      `${name} tinted the browser letterbox: ${JSON.stringify(result)}`);
    assert(same(sample.doomBorder, sample.expectedDoomBorder),
      `${name} did not palette-shift Doom's view border: ${JSON.stringify(result)}`);
    assert(sample.bodyBackground === 'rgb(0, 0, 0)' &&
           sample.rootBackground === 'rgb(0, 0, 0)',
    `${name} tinted the host page: ${JSON.stringify(result)}`);
  }
  assert(!same(result.samples.base.doomBorder, result.samples.damage.doomBorder) &&
         !same(result.samples.base.doomBorder, result.samples.bonus.doomBorder),
  `damage/bonus palettes did not change Doom's border: ${JSON.stringify(result)}`);
  assert(result.glError === result.expectedGlError,
    `WebGL error after palette samples: ${result.glError}`);

  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
