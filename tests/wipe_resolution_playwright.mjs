// Display-pixel regression for the melt transition. The ordinary wipe tests
// validate Doom's canonical 320x200 column model; this test additionally makes
// sure presenting that model does not reduce the browser's native resolution.
// Start a static server at the repository root, then run with:
//   NODE_PATH=/path/to/node_modules node tests/wipe_resolution_playwright.mjs

import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
}

let browser = null;
const pageErrors = [];
const watchdog = setTimeout(() => {
  console.error('wipe resolution Playwright test exceeded 90 seconds');
  process.exit(1);
}, 90000);

try {
  browser = await chromium.launch(launchOptions);
  const baseUrl = process.env.DOOM_URL ?? 'http://127.0.0.1:8095/';
  const results = [];

  // blocks 7 is a reduced 224x112 view surrounded by the Doom border;
  // blocks 11 is the complete 320x200 first-person view. Exercise both at
  // ordinary and high-density browser backing resolutions.
  for (const deviceScaleFactor of [1, 2]) {
    for (const screenblocks of [7, 11]) {
      const page = await browser.newPage({
        viewport: { width: 960, height: 600 },
        deviceScaleFactor,
      });
      const label = `DPR ${deviceScaleFactor}, blocks ${screenblocks}`;
      page.on('pageerror', (error) => pageErrors.push(`${label}: ${error.message}`));

      try {
        const url = new URL(baseUrl);
        url.searchParams.set('-map', 'E1M1');
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() =>
          window.renderer !== undefined &&
          window.scene?.getObjectByName('level') !== undefined &&
          window.renderer.info.render.frame > 2,
        { timeout: 30000 });

        const fixture = await page.evaluate(async (blocks) => {
          const THREE = await import('three');
          const doomstat = await import('/src/doomstat.js');
          const loop = await import('/src/d_loop.js');
          const video = await import('/src/i_video.js');
          const view = await import('/src/r_view.js');
          const wipe = await import('/src/f_wipe.js');
          const overlay = document.getElementById('overlay');
          const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
          const deadline = performance.now() + 30000;
          while (doomstat.gamestate !== 0 ||
                 doomstat.players[doomstat.consoleplayer]?.mo == null ||
                 loop.D_DoomRafLoop.isRunning() !== true ||
                 wipe.wipe_isActive() !== false) {
            if (performance.now() >= deadline) {
              throw new Error('E1M1 did not reach a stable displayed state');
            }
            await nextFrame();
          }

          // Freeze production drawing after startup, then feed the real video
          // and wipe paths a pattern containing one bit per physical pixel.
          // A 320x200 intermediate buffer cannot retain this pattern.
          loop.D_DoomRafLoop.stop();
          const selectedView = view.R_SetViewSize(blocks, 0);
          const testScene = new THREE.Scene();
          const testCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
          testCamera.position.z = 1;
          const material = new THREE.ShaderMaterial({
            depthTest: false,
            depthWrite: false,
            vertexShader: `
              void main() {
                gl_Position = vec4(position.xy, 0.0, 1.0);
              }
            `,
            fragmentShader: `
              void main() {
                float stripe = mod(floor(gl_FragCoord.x), 2.0);
                gl_FragColor = vec4(vec3(stripe), 1.0);
              }
            `,
          });
          testScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

          const overlayContext = overlay.getContext('2d');
          overlayContext.clearRect(0, 0, overlay.width, overlay.height);
          video.I_RenderView(testScene, testCamera);
          wipe.wipe_RecordScreen();

          // Retain only objects needed for the deterministic second half of
          // the fixture; each case owns a fresh page and WebGL context.
          window.__wipeResolutionFixture = { view, wipe };
          return {
            devicePixelRatio: window.devicePixelRatio,
            screenblocks: view.R_GetScreenblocks(),
            selectedView,
            layout: view.R_CalculateCanvasView(
              overlay.width,
              overlay.height,
              selectedView,
            ),
            overlaySize: [overlay.width, overlay.height],
            rendererSize: [window.renderer.domElement.width, window.renderer.domElement.height],
          };
        }, screenblocks);

        const sourceScreenshot = await page.screenshot();

        const activeAfterEightTics = await page.evaluate(() => {
          const { view, wipe } = window.__wipeResolutionFixture;
          const overlay = document.getElementById('overlay');
          const context = overlay.getContext('2d');

          wipe.wipe_StartScreen(0, 0, 320, 200);

          // A flat, dark-red destination makes any destination leakage easy to
          // classify without sharing either stripe luminance.
          const renderer = window.renderer;
          renderer.setRenderTarget(null);
          renderer.setScissorTest(false);
          renderer.setViewport(0, 0, overlay.width, overlay.height);
          renderer.setClearColor(0x800000, 1);
          renderer.clear(true, true, true);
          context.clearRect(0, 0, overlay.width, overlay.height);
          wipe.wipe_EndScreen(0, 0, 320, 200);

          // The fastest column advances 55 logical rows in eight melt tics.
          // It is therefore still sourced from the stripe frame at the sample
          // row used below, even in the 112-row-high reduced view.
          wipe.wipe_ScreenWipe(0, 0, 0, 320, 200, 8);
          const layout = view.R_CalculateCanvasView(overlay.width, overlay.height);
          context.imageSmoothingEnabled = false;
          wipe.wipe_Draw(
            context,
            layout.screenX,
            layout.screenY,
            layout.screenWidth,
            layout.screenHeight,
          );
          return wipe.wipe_isActive();
        });

        const middleScreenshot = await page.screenshot();
        const pixels = await page.evaluate(async ({ source, middle, layout, dpr }) => {
          async function decodeScreenshot(base64) {
            const response = await fetch(`data:image/png;base64,${base64}`);
            const image = await createImageBitmap(await response.blob());
            const canvas = document.createElement('canvas');
            canvas.width = image.width;
            canvas.height = image.height;
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);
            return {
              width: canvas.width,
              height: canvas.height,
              data: context.getImageData(0, 0, canvas.width, canvas.height).data,
            };
          }

          const sourceImage = await decodeScreenshot(source);
          const middleImage = await decodeScreenshot(middle);
          const y = Math.floor((layout.viewY + layout.viewHeight - 3) * dpr);
          const x0 = Math.ceil((layout.viewX + 4) * dpr);
          const x1 = Math.floor((layout.viewX + layout.viewWidth - 4) * dpr);

          function isLight(image, x) {
            const offset = (y * image.width + x) * 4;
            return image.data[offset] + image.data[offset + 1] + image.data[offset + 2] > 384;
          }

          let sourceFlips = 0;
          let middleFlips = 0;
          let matchingStripes = 0;
          let previousSource = null;
          let previousMiddle = null;
          for (let x = x0; x < x1; x++) {
            const sourceLight = isLight(sourceImage, x);
            const middleLight = isLight(middleImage, x);
            if (previousSource !== null && sourceLight !== previousSource) sourceFlips++;
            if (previousMiddle !== null && middleLight !== previousMiddle) middleFlips++;
            if (sourceLight === middleLight) matchingStripes++;
            previousSource = sourceLight;
            previousMiddle = middleLight;
          }

          const samples = x1 - x0;
          return {
            sourceSize: [sourceImage.width, sourceImage.height],
            middleSize: [middleImage.width, middleImage.height],
            sampleRow: y,
            samples,
            sourceFlipRatio: sourceFlips / (samples - 1),
            middleFlipRatio: middleFlips / (samples - 1),
            matchingStripeRatio: matchingStripes / samples,
          };
        }, {
          source: sourceScreenshot.toString('base64'),
          middle: middleScreenshot.toString('base64'),
          layout: fixture.layout,
          dpr: deviceScaleFactor,
        });

        const layerLifecycle = await page.evaluate(() => {
          const { wipe } = window.__wipeResolutionFixture;
          const overlay = document.getElementById('overlay');
          const layer = document.getElementById('doom-wipe');
          const before = layer === null ? null : {
            size: [layer.width, layer.height],
            displayed: layer.style.display,
            immediatelyBelowOverlay: layer.nextElementSibling === overlay,
          };
          wipe.wipe_Shutdown();
          return {
            before,
            removed: document.getElementById('doom-wipe') === null,
          };
        });

        results.push({
          label,
          requestedDpr: deviceScaleFactor,
          requestedBlocks: screenblocks,
          activeAfterEightTics,
          fixture,
          pixels,
          layerLifecycle,
        });
      } finally {
        await page.close();
      }
    }
  }

  const failures = [];
  for (const result of results) {
    const { label, requestedDpr: dpr, requestedBlocks: blocks, fixture, pixels } = result;
    const expectedDisplaySize = [960 * dpr, 600 * dpr];
    const expectedRendererSize = expectedDisplaySize;
    const expectedLogicalView = blocks === 7
      ? { scaledviewwidth: 224, viewheight: 112 }
      : { scaledviewwidth: 320, viewheight: 200 };

    if (fixture.devicePixelRatio !== dpr || fixture.screenblocks !== blocks) {
      failures.push(`${label} did not exercise the requested mode: ${JSON.stringify(result)}`);
    }
    if (fixture.selectedView.scaledviewwidth !== expectedLogicalView.scaledviewwidth ||
        fixture.selectedView.viewheight !== expectedLogicalView.viewheight) {
      failures.push(`${label} selected the wrong logical view: ${JSON.stringify(fixture.selectedView)}`);
    }
    if (JSON.stringify(fixture.rendererSize) !== JSON.stringify(expectedRendererSize) ||
        JSON.stringify(pixels.sourceSize) !== JSON.stringify(expectedDisplaySize) ||
        JSON.stringify(pixels.middleSize) !== JSON.stringify(expectedDisplaySize)) {
      failures.push(`${label} did not use native-resolution screenshots: ${JSON.stringify(result)}`);
    }
    if (result.activeAfterEightTics !== true) {
      failures.push(`${label} wipe ended before its eighth tic`);
    }
    if (result.layerLifecycle.before === null ||
        result.layerLifecycle.before.displayed !== 'block' ||
        result.layerLifecycle.before.immediatelyBelowOverlay !== true ||
        JSON.stringify(result.layerLifecycle.before.size) !== JSON.stringify(expectedRendererSize) ||
        result.layerLifecycle.removed !== true) {
      failures.push(`${label} wipe layer lifecycle mismatch: ${JSON.stringify(result.layerLifecycle)}`);
    }
    if (pixels.samples < 100 || pixels.sourceFlipRatio < 0.99) {
      failures.push(`${label} source fixture lacked physical-pixel detail: ${JSON.stringify(pixels)}`);
    }
    if (pixels.middleFlipRatio < 0.98) {
      failures.push(`${label} wipe reduced horizontal resolution: ${JSON.stringify(pixels)}`);
    }
    if (pixels.matchingStripeRatio < 0.98) {
      failures.push(`${label} wipe changed native source pixels: ${JSON.stringify(pixels)}`);
    }
  }
  if (results.length !== 4) failures.push(`expected four resolution cases, got ${results.length}`);
  if (pageErrors.length !== 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (failures.length !== 0) throw new Error(failures.join('\n'));
  console.log(JSON.stringify(results));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
