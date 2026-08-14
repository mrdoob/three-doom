// Real composed-frame and timing checks for D_Display's melt lifecycle.
// Start a static server at the repository root, then run with:
//   NODE_PATH=/path/to/node_modules node tests/wipe_transition_playwright.mjs

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
  console.error('wipe transition Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

try {
  browser = await chromium.launch(launchOptions);
  // Exact 3x integer scaling makes the 320x200 melt pixels observable without
  // interpolation while still exercising the real responsive compositor.
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const baseUrl = process.env.DOOM_URL ?? 'http://127.0.0.1:8096/';
  const url = new URL(baseUrl);
  url.searchParams.set('-map', 'E1M1');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    window.renderer !== undefined &&
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer.info.render.frame > 2,
  { timeout: 30000 });
  await page.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const wipe = await import('/src/f_wipe.js');
    const loop = await import('/src/d_loop.js');
    const deadline = performance.now() + 30000;
    while (doomstat.gamestate !== 0 ||
           doomstat.players[doomstat.consoleplayer]?.mo == null ||
           doomstat.gametic <= 5 ||
           loop.D_DoomRafLoop.isRunning() !== true ||
           wipe.wipe_isActive() !== false) {
      if (performance.now() >= deadline) throw new Error('E1M1 did not reach a stable displayed state');
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
  });

  const result = await page.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const finale = await import('/src/f_finale.js');
    const wipe = await import('/src/f_wipe.js');
    const { I_GetTime } = await import('/src/i_system.js');
    const { I_RenderView } = await import('/src/i_video.js');
    const { R_CalculateCanvasView } = await import('/src/r_view.js');
    const overlay = document.getElementById('overlay');

    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    async function waitUntil(predicate, timeoutMs = 5000) {
      const deadline = performance.now() + timeoutMs;
      while (!predicate()) {
        if (performance.now() >= deadline) throw new Error('timed out waiting for wipe state');
        await nextFrame();
      }
    }

    function logicalCanvas() {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 200;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      return { canvas, ctx };
    }

    function drawPresented(ctx, layout) {
      const rendererCanvas = window.renderer.domElement;
      const sx = rendererCanvas.width / overlay.width;
      const sy = rendererCanvas.height / overlay.height;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 320, 200);
      ctx.drawImage(
        rendererCanvas,
        layout.screenX * sx,
        layout.screenY * sy,
        layout.screenWidth * sx,
        layout.screenHeight * sy,
        0,
        0,
        320,
        200,
      );
      const wipeLayer = document.getElementById('doom-wipe');
      if (wipeLayer !== null && wipeLayer.style.display !== 'none') {
        ctx.drawImage(
          wipeLayer,
          layout.screenX * sx,
          layout.screenY * sy,
          layout.screenWidth * sx,
          layout.screenHeight * sy,
          0,
          0,
          320,
          200,
        );
      }
      ctx.drawImage(
        overlay,
        layout.screenX,
        layout.screenY,
        layout.screenWidth,
        layout.screenHeight,
        0,
        0,
        320,
        200,
      );
    }

    function readOverlay() {
      const { ctx } = logicalCanvas();
      const layout = R_CalculateCanvasView(overlay.width, overlay.height);
      drawPresented(ctx, layout);
      return ctx.getImageData(0, 0, 320, 200).data;
    }

    function readComposed() {
      // Read the WebGL buffer immediately after rendering, then apply the
      // actual transparent UI layer in DOM stacking order.
      I_RenderView(window.scene, window.camera);
      const { ctx } = logicalCanvas();
      const layout = R_CalculateCanvasView(overlay.width, overlay.height);
      drawPresented(ctx, layout);
      return ctx.getImageData(0, 0, 320, 200).data;
    }

    function differentPixels(a, b) {
      let changed = 0;
      for (let p = 0; p < 320 * 200; p++) {
        const i = p * 4;
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
          changed++;
        }
      }
      return changed;
    }

    // Validate the presented pixels against f_wipe.c's two-pixel column model:
    // destination above y is the end frame; below y it is the start frame
    // shifted down by y. Sampling every other row keeps this inexpensive.
    function analyseMelt(start, middle, end) {
      const offsets = [];
      let totalRatio = 0;
      let worstRatio = 1;
      for (let column = 0; column < 160; column++) {
        let bestOffset = 0;
        let bestMatches = -1;
        let comparisons = 0;
        for (let offset = 0; offset <= 200; offset++) {
          let matches = 0;
          let count = 0;
          for (let y = 0; y < 200; y += 2) {
            for (let half = 0; half < 2; half++) {
              const x = column * 2 + half;
              const actual = (y * 320 + x) * 4;
              const expectedY = y < offset ? y : y - offset;
              const expectedFrame = y < offset ? end : start;
              const expected = (expectedY * 320 + x) * 4;
              count++;
              if (middle[actual] === expectedFrame[expected] &&
                  middle[actual + 1] === expectedFrame[expected + 1] &&
                  middle[actual + 2] === expectedFrame[expected + 2]) {
                matches++;
              }
            }
          }
          if (matches > bestMatches) {
            bestMatches = matches;
            bestOffset = offset;
            comparisons = count;
          }
        }
        const ratio = bestMatches / comparisons;
        offsets.push(bestOffset);
        totalRatio += ratio;
        worstRatio = Math.min(worstRatio, ratio);
      }
      return {
        averageRatio: totalRatio / offsets.length,
        worstRatio,
        minOffset: Math.min(...offsets),
        maxOffset: Math.max(...offsets),
        distinctOffsets: new Set(offsets).size,
      };
    }

    function hashPixels(data) {
      let hash = 2166136261;
      for (let i = 0; i < data.length; i += 17) {
        hash ^= data[i];
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(16).padStart(8, '0');
    }

    async function runTransition(name, trigger) {
      const start = readComposed();
      // Make the expected start authoritative immediately before changing the
      // state; this is also the normal end-of-D_Display recording path.
      wipe.wipe_RecordScreen();
      const stateBefore = doomstat.gamestate;
      trigger();
      const forcedState = doomstat.wipegamestate;
      await waitUntil(() => wipe.wipe_isActive());
      const activeTic = I_GetTime();
      await waitUntil(() => !wipe.wipe_isActive() || I_GetTime() - activeTic >= 8);
      if (!wipe.wipe_isActive()) throw new Error(`${name} wipe ended before its eighth tic`);
      const middle = readOverlay();
      await waitUntil(() => !wipe.wipe_isActive());
      const elapsedTics = I_GetTime() - activeTic;
      const end = readOverlay();
      return {
        name,
        stateBefore,
        stateAfter: doomstat.gamestate,
        forcedState,
        elapsedTics,
        changedPixels: differentPixels(start, end),
        middleChangedFromStart: differentPixels(start, middle),
        middleChangedFromEnd: differentPixels(middle, end),
        melt: analyseMelt(start, middle, end),
        hashes: {
          start: hashPixels(start),
          middle: hashPixels(middle),
          end: hashPixels(end),
        },
      };
    }

    const levelToFinale = await runTransition('E1M1-to-finale', () => {
      finale.F_StartFinale();
    });

    const textToArt = await runTransition('finale-text-to-art', () => {
      // E1TEXT's threshold is below 10,000 tics; once stage 1 is entered,
      // further calls leave it there while preserving the forced -1 state.
      for (let i = 0; i < 10000; i++) finale.F_Ticker();
    });

    const finaleToCast = await runTransition('MAP30-cast', () => {
      // doom1.wad lacks MAP30/BOSSBACK, but F_StartCast is the exact MAP30
      // transition entry point and still exercises its same-GS_FINALE wipe.
      finale.F_StartCast();
    });

    return {
      levelName: window.scene.getObjectByName('level')?.name ?? null,
      transitions: [levelToFinale, textToArt, finaleToCast],
    };
  });

  // Verify the retained canonical screen is cropped from a 16:9, high-DPI
  // compositor and melted only inside its centered logical 320x200 rectangle.
  const widePage = await browser.newPage({
    viewport: { width: 960, height: 540 },
    deviceScaleFactor: 2,
  });
  widePage.on('pageerror', (error) => pageErrors.push(error.message));
  await widePage.goto(url.href, { waitUntil: 'domcontentloaded' });
  await widePage.waitForFunction(() =>
    window.renderer !== undefined &&
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer.info.render.frame > 2,
  { timeout: 30000 });
  const wideViewportCoverage = await widePage.evaluate(async () => {
    const doomstat = await import('/src/doomstat.js');
    const finale = await import('/src/f_finale.js');
    const wipe = await import('/src/f_wipe.js');
    const { I_GetTime } = await import('/src/i_system.js');
    const { I_RenderView } = await import('/src/i_video.js');
    const { R_CalculateCanvasView } = await import('/src/r_view.js');
    const overlay = document.getElementById('overlay');
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

    async function waitUntil(predicate, message, timeoutMs = 30000) {
      const deadline = performance.now() + timeoutMs;
      while (!predicate()) {
        if (performance.now() >= deadline) throw new Error(message);
        await nextFrame();
      }
    }

    function logicalCanvas() {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 200;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      return { canvas, ctx };
    }

    function drawLogicalPresentation(ctx, layout) {
      const rendererCanvas = window.renderer.domElement;
      const sx = rendererCanvas.width / overlay.width;
      const sy = rendererCanvas.height / overlay.height;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, 320, 200);
      ctx.drawImage(
        rendererCanvas,
        layout.screenX * sx,
        layout.screenY * sy,
        layout.screenWidth * sx,
        layout.screenHeight * sy,
        0,
        0,
        320,
        200,
      );
      const wipeLayer = document.getElementById('doom-wipe');
      if (wipeLayer !== null && wipeLayer.style.display !== 'none') {
        ctx.drawImage(
          wipeLayer,
          layout.screenX * sx,
          layout.screenY * sy,
          layout.screenWidth * sx,
          layout.screenHeight * sy,
          0,
          0,
          320,
          200,
        );
      }
      ctx.drawImage(
        overlay,
        layout.screenX,
        layout.screenY,
        layout.screenWidth,
        layout.screenHeight,
        0,
        0,
        320,
        200,
      );
    }

    function readLogicalOverlay() {
      const layout = R_CalculateCanvasView(overlay.width, overlay.height);
      const { ctx } = logicalCanvas();
      drawLogicalPresentation(ctx, layout);
      return ctx.getImageData(0, 0, 320, 200).data;
    }

    function readLogicalComposed() {
      I_RenderView(window.scene, window.camera);
      const layout = R_CalculateCanvasView(overlay.width, overlay.height);
      const { ctx } = logicalCanvas();
      drawLogicalPresentation(ctx, layout);
      return ctx.getImageData(0, 0, 320, 200).data;
    }

    function analyseMelt(start, middle, end) {
      let totalRatio = 0;
      let worstRatio = 1;
      const offsets = [];
      for (let column = 0; column < 160; column++) {
        let bestMatches = -1;
        let bestOffset = 0;
        let comparisons = 0;
        for (let offset = 0; offset <= 200; offset++) {
          let matches = 0;
          let count = 0;
          for (let y = 0; y < 200; y += 2) {
            for (let half = 0; half < 2; half++) {
              const x = column * 2 + half;
              const actual = (y * 320 + x) * 4;
              const expectedFrame = y < offset ? end : start;
              const expectedY = y < offset ? y : y - offset;
              const expected = (expectedY * 320 + x) * 4;
              count++;
              if (middle[actual] === expectedFrame[expected] &&
                  middle[actual + 1] === expectedFrame[expected + 1] &&
                  middle[actual + 2] === expectedFrame[expected + 2]) {
                matches++;
              }
            }
          }
          if (matches > bestMatches) {
            bestMatches = matches;
            bestOffset = offset;
            comparisons = count;
          }
        }
        const ratio = bestMatches / comparisons;
        offsets.push(bestOffset);
        totalRatio += ratio;
        worstRatio = Math.min(worstRatio, ratio);
      }
      return {
        averageRatio: totalRatio / offsets.length,
        worstRatio,
        minOffset: Math.min(...offsets),
        maxOffset: Math.max(...offsets),
        distinctOffsets: new Set(offsets).size,
      };
    }

    await waitUntil(
      () => doomstat.gamestate === 0 &&
        doomstat.players[doomstat.consoleplayer]?.mo != null &&
        wipe.wipe_isActive() === false,
      '16:9 E1M1 did not become stable',
    );

    const start = readLogicalComposed();
    wipe.wipe_RecordScreen();
    finale.F_StartFinale();
    await waitUntil(() => wipe.wipe_isActive(), '16:9 finale wipe never began');
    const activeTic = I_GetTime();
    await waitUntil(
      () => !wipe.wipe_isActive() || I_GetTime() - activeTic >= 8,
      '16:9 wipe did not advance',
    );
    if (!wipe.wipe_isActive()) throw new Error('16:9 wipe ended before its eighth tic');

    const middle = readLogicalOverlay();
    const layout = R_CalculateCanvasView(overlay.width, overlay.height);
    const ctx = overlay.getContext('2d');
    const wipeLayer = document.getElementById('doom-wipe');
    const wipeCtx = wipeLayer.getContext('2d');
    const wipeScaleX = wipeLayer.width / overlay.width;
    const wipeScaleY = wipeLayer.height / overlay.height;
    const middleY = Math.floor(layout.screenY + layout.screenHeight / 2);
    const wipeMiddleY = Math.floor(middleY * wipeScaleY);
    const leftBar = wipeCtx.getImageData(1, wipeMiddleY, 1, 1).data;
    const rightBar = wipeCtx.getImageData(wipeLayer.width - 2, wipeMiddleY, 1, 1).data;
    const logicalLeft = wipeCtx.getImageData(
      Math.floor(layout.screenX * wipeScaleX),
      wipeMiddleY,
      1,
      1,
    ).data;
    const logicalRight = wipeCtx.getImageData(
      Math.ceil((layout.screenX + layout.screenWidth) * wipeScaleX) - 1,
      wipeMiddleY,
      1,
      1,
    ).data;

    await waitUntil(() => wipe.wipe_isActive() === false, '16:9 wipe never finished');
    const end = readLogicalOverlay();
    const finalLeftBar = ctx.getImageData(1, middleY, 1, 1).data;
    const finalRightBar = ctx.getImageData(overlay.width - 2, middleY, 1, 1).data;
    const rendererCanvas = window.renderer.domElement;
    return {
      dpr: window.devicePixelRatio,
      rendererScaleX: rendererCanvas.width / overlay.width,
      rendererScaleY: rendererCanvas.height / overlay.height,
      screen: {
        x: layout.screenX,
        y: layout.screenY,
        width: layout.screenWidth,
        height: layout.screenHeight,
      },
      leftBar: Array.from(leftBar),
      rightBar: Array.from(rightBar),
      finalLeftBar: Array.from(finalLeftBar),
      finalRightBar: Array.from(finalRightBar),
      logicalLeftAlpha: logicalLeft[3],
      logicalRightAlpha: logicalRight[3],
      melt: analyseMelt(start, middle, end),
    };
  });
  await widePage.close();
  result.wideViewportCoverage = wideViewportCoverage;

  const failures = [];
  if (result.levelName !== 'level') failures.push(`E1M1 world was not loaded: ${result.levelName}`);
  for (const transition of result.transitions) {
    if (transition.elapsedTics < 25 || transition.elapsedTics > 60) {
      failures.push(`${transition.name} duration was ${transition.elapsedTics} tics`);
    }
    if (transition.changedPixels < 5000) {
      failures.push(`${transition.name} destination changed only ${transition.changedPixels} pixels`);
    }
    if (transition.middleChangedFromStart < 100 || transition.middleChangedFromEnd < 100) {
      failures.push(`${transition.name} did not expose a genuine intermediate frame`);
    }
    if (transition.melt.averageRatio < 0.995 || transition.melt.worstRatio < 0.95) {
      failures.push(`${transition.name} pixels do not follow the melt model: ${JSON.stringify(transition.melt)}`);
    }
    if (transition.melt.maxOffset < 7 || transition.melt.distinctOffsets < 4) {
      failures.push(`${transition.name} columns did not advance independently: ${JSON.stringify(transition.melt)}`);
    }
  }
  if (result.transitions[0].stateBefore !== 0 || result.transitions[0].stateAfter !== 2) {
    failures.push(`E1M1/finale state transition mismatch: ${JSON.stringify(result.transitions[0])}`);
  }
  if (result.transitions[1].stateBefore !== 2 || result.transitions[1].stateAfter !== 2 ||
      result.transitions[1].forcedState !== -1) {
    failures.push(`text-to-art did not force a same-state wipe: ${JSON.stringify(result.transitions[1])}`);
  }
  if (result.transitions[2].stateBefore !== 2 || result.transitions[2].stateAfter !== 2 ||
      result.transitions[2].forcedState !== -1) {
    failures.push(`MAP30 cast did not force a same-state wipe: ${JSON.stringify(result.transitions[2])}`);
  }
  if (wideViewportCoverage.dpr !== 2 ||
      wideViewportCoverage.rendererScaleX !== 2 ||
      wideViewportCoverage.rendererScaleY !== 2) {
    failures.push(`16:9 wipe did not exercise DPR 2 capture: ${JSON.stringify(wideViewportCoverage)}`);
  }
  if (wideViewportCoverage.leftBar[3] !== 0 ||
      wideViewportCoverage.rightBar[3] !== 0 ||
      wideViewportCoverage.finalLeftBar[3] !== 255 ||
      wideViewportCoverage.finalRightBar[3] !== 255 ||
      wideViewportCoverage.logicalLeftAlpha !== 255 ||
      wideViewportCoverage.logicalRightAlpha !== 255) {
    failures.push(`16:9 wipe escaped or missed the logical screen: ${JSON.stringify(wideViewportCoverage)}`);
  }
  // The 16:9 logical rectangle is 2.7 CSS pixels per Doom row. Sampling its
  // DPR-2 backing image back to 320x200 crosses fractional pixel centers, so
  // allow a small resampling tolerance while retaining a strong model check.
  if (wideViewportCoverage.melt.averageRatio < 0.97 ||
      wideViewportCoverage.melt.worstRatio < 0.85 ||
      wideViewportCoverage.melt.maxOffset < 7 ||
      wideViewportCoverage.melt.distinctOffsets < 4) {
    failures.push(`16:9 DPR 2 pixels do not follow the melt model: ${JSON.stringify(wideViewportCoverage)}`);
  }
  if (pageErrors.length !== 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (failures.length !== 0) throw new Error(failures.join('\n'));
  console.log(JSON.stringify(result));
} finally {
  if (browser !== null) await browser.close();
  clearTimeout(watchdog);
}
