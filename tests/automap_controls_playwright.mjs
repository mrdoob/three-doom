// Real E1M1 automap input/draw check. Start a static server at the repository
// root and set DOOM_URL; Chromium is launched headlessly only.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
}

let browser = null;
const watchdog = setTimeout(() => {
  console.error('automap controls Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);
const pageErrors = [];

try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8127/');
  url.searchParams.set('-map', 'E1M1');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    window.renderer !== undefined &&
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer.info.render.frame > 2,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const automap = await import('/src/am_map.js');
    const doomstat = await import('/src/doomstat.js');
    const keyboard = await import('/src/d_keyboard.js');
    const loop = await import('/src/d_loop.js');
    const menu = await import('/src/m_menu.js');
    const palette = await import('/src/v_palette.js');
    const setup = await import('/src/p_setup.js');
    const mapData = await import('/src/doomdata.js');
    const bsp = await import('/src/r_bsp.js');

    menu.M_ClearMenus();
    doomstat.set_gamestate(0 /*GS_LEVEL*/);
    doomstat.set_demoplayback(false);
    doomstat.set_netgame(false);
    if (doomstat.automapactive === true) automap.AM_Stop();
    while (menu.getScreenblocks() < 11) menu.M_SizeDisplay(1);
    const fullscreenStatusBeforeMap = menu.isStatusBarVisible();

    // The retained renderer has no native R_StoreWallRange call, so
    // R_SetupFrame runs a visibility-only BSP/solid-column walk for ML_MAPPED.
    // At the E1M1 start this must discover walls through the open north-facing
    // portals, not merely the five edges of the leaf containing the player.
    const initialPlayer = doomstat.players[doomstat.consoleplayer];
    const currentSubsector = bsp.R_PointInSubsector(
      initialPlayer.mo.x,
      initialPlayer.mo.y,
    );
    const currentLines = new Set();
    for (let i = 0; i < currentSubsector.numlines; i++) {
      currentLines.add(setup.segs[currentSubsector.firstline + i].linedef);
    }
    const mappedBeforeMap = setup.lines.filter(
      (line) => (line.flags & mapData.ML_MAPPED) !== 0,
    );
    const mappedOutsideCurrentSubsector = mappedBeforeMap.filter(
      (line) => !currentLines.has(line),
    ).length;

    const key = (type, code, value) => document.dispatchEvent(new KeyboardEvent(type, {
      code,
      key: value,
      bubbles: true,
      cancelable: true,
    }));
    const waitFor = async (predicate) => {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      return false;
    };

    // Observe the production D_Display call, not a synthetic rectangle.
    const layoutRects = [];
    const proto = CanvasRenderingContext2D.prototype;
    const originalFillRect = proto.fillRect;
    const originalDrawImage = proto.drawImage;
    let mapStatusDraws = 0;
    proto.fillRect = function (...args) {
      if ((new Error().stack ?? '').includes('/src/am_map') &&
          args[2] > 100 && args[3] > 100) {
        layoutRects.push(args.slice(0, 4));
      }
      return originalFillRect.apply(this, args);
    };
    proto.drawImage = function (...args) {
      if ((new Error().stack ?? '').includes('/src/st_stuff')) mapStatusDraws++;
      return originalDrawImage.apply(this, args);
    };
    key('keydown', 'Tab', 'Tab');
    key('keyup', 'Tab', 'Tab');
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    proto.fillRect = originalFillRect;
    proto.drawImage = originalDrawImage;
    const layoutRect = layoutRects.at(-1);
    const fullscreenStatusOnMap = menu.isStatusBarVisible();

    // R_SetupFrame marks the current subsector. Once the map is active, the
    // first-person setup/render path must be dormant just like R_RenderPlayerView
    // in d_main.c. Clear every mark and prove two display frames add none.
    for (const line of setup.lines) line.flags &= ~mapData.ML_MAPPED;
    const rendererFramesBeforeMapIdle = window.renderer.info.render.frame;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const rendererFramesDuringMapIdle =
      window.renderer.info.render.frame - rendererFramesBeforeMapIdle;
    const mappedWhileMapOpen = setup.lines.filter(
      (line) => (line.flags & mapData.ML_MAPPED) !== 0,
    ).length;

    // Own the 35 Hz updates from here so held keys advance a known tic count.
    loop.D_DoomRafLoop.stop();
    const player = doomstat.players[doomstat.consoleplayer];
    // Exercise the loaded map's full range rather than relying on which few
    // subsector lines R_SetupFrame happened to mark before the loop stopped.
    for (const line of setup.lines) line.flags |= mapData.ML_MAPPED;
    const commandPlayer = { cmd: {} };
    const sample = () => {
      keyboard.D_KeyboardInput.buildCmd(commandPlayer);
      return { ...commandPlayer.cmd };
    };

    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 600;
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = palette.V_PaletteCSS(6 * 16 + 8);
    const gridStyle = ctx.strokeStyle;
    const originals = {
      beginPath: ctx.beginPath.bind(ctx),
      moveTo: ctx.moveTo.bind(ctx),
      lineTo: ctx.lineTo.bind(ctx),
      closePath: ctx.closePath.bind(ctx),
      stroke: ctx.stroke.bind(ctx),
      drawImage: ctx.drawImage.bind(ctx),
    };

    const capture = () => {
      const paths = [];
      const markPatches = [];
      let path = [];
      ctx.beginPath = function () { path = []; return originals.beginPath(); };
      ctx.moveTo = function (x, y) { path.push(['m', x, y]); return originals.moveTo(x, y); };
      ctx.lineTo = function (x, y) { path.push(['l', x, y]); return originals.lineTo(x, y); };
      ctx.closePath = function () { path.push(['z']); return originals.closePath(); };
      ctx.stroke = function () {
        paths.push({ style: this.strokeStyle, path: structuredClone(path) });
        return originals.stroke();
      };
      ctx.drawImage = function (image, ...args) {
        markPatches.push({ source: [image.width, image.height], args: structuredClone(args) });
        return originals.drawImage(image, ...args);
      };
      automap.AM_Drawer(ctx, 0, 0, 960, 504);
      const geometry = paths
        .filter((entry) => entry.style !== gridStyle)
        .map((entry) => entry.path.map((point) => point.map((value) =>
          typeof value === 'number' ? Math.round(value * 1000) / 1000 : value)));
      return {
        gridStrokes: paths.filter((entry) => entry.style === gridStyle).length,
        geometry,
        markPatches,
      };
    };

    const initialDraw = capture();
    const spillPixels = ctx.getImageData(0, 505, 960, 95).data;
    let spillAlpha = 0;
    for (let i = 3; i < spillPixels.length; i += 4) spillAlpha += spillPixels[i];

    // A follow-mode arrow first reaches gamekeydown. If F disables follow
    // while it is still held, an auto-repeat becomes automap-owned but must
    // not erase that earlier gameplay state; only the real keyup clears it.
    key('keydown', 'ArrowRight', 'ArrowRight');
    const followedArrow = sample();
    key('keydown', 'KeyF', 'f');
    key('keyup', 'KeyF', 'f');
    const followOffReady = await waitFor(() => player.message === 'Follow Mode OFF');
    key('keydown', 'ArrowRight', 'ArrowRight');
    const repeatedHeldArrow = sample();
    key('keyup', 'ArrowRight', 'ArrowRight');
    const repeatedArrowRelease = sample();

    // A genuinely new press in free-pan mode belongs only to the automap.
    key('keydown', 'ArrowRight', 'ArrowRight');
    const panningArrow = sample();
    const beforePan = capture();
    automap.AM_Ticker();
    const afterPan = capture();
    key('keyup', 'ArrowRight', 'ArrowRight');

    // '=' installs a multiplier; AM_Ticker applies it once per held tic and
    // the filtering keyup restores the identity multiplier.
    key('keydown', 'Equal', '=');
    automap.AM_Ticker();
    const zoomOnce = capture();
    automap.AM_Ticker();
    const zoomTwice = capture();
    key('keyup', 'Equal', '=');
    automap.AM_Ticker();
    const zoomReleased = capture();

    // 0 saves the current free-map window, shows the whole loaded E1M1 bound,
    // then restores the exact saved window on the second press.
    const beforeBig = capture();
    key('keydown', 'Digit0', '0');
    key('keyup', 'Digit0', '0');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const big = capture();
    key('keydown', 'Digit0', '0');
    key('keyup', 'Digit0', '0');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const restored = capture();

    // Grid starts disabled, toggles with G, and is an actual distinct draw
    // pass. Mark/clear messages use the strings already ported from d_englsh.
    key('keydown', 'KeyG', 'g');
    key('keyup', 'KeyG', 'g');
    const gridOnReady = await waitFor(() => player.message === 'Grid ON');
    const gridOn = capture();
    key('keydown', 'KeyG', 'g');
    key('keyup', 'KeyG', 'g');
    const gridOffReady = await waitFor(() => player.message === 'Grid OFF');
    const gridOff = capture();
    key('keydown', 'KeyM', 'm');
    key('keyup', 'KeyM', 'm');
    const markReady = await waitFor(() => player.message === 'Marked Spot 0');
    const marked = capture();
    key('keydown', 'KeyC', 'c');
    key('keyup', 'KeyC', 'c');
    const clearReady = await waitFor(() => player.message === 'All Marks Cleared');
    const cleared = capture();

    key('keydown', 'Tab', 'Tab');
    key('keyup', 'Tab', 'Tab');
    return {
      layoutRect,
      fullscreenStatusBeforeMap,
      fullscreenStatusOnMap,
      mapStatusDraws,
      mappedBeforeMap: mappedBeforeMap.length,
      mappedOutsideCurrentSubsector,
      rendererFramesDuringMapIdle,
      mappedWhileMapOpen,
      initialGridStrokes: initialDraw.gridStrokes,
      spillAlpha,
      geometryPaths: initialDraw.geometry.length,
      followedArrow,
      followOffReady,
      repeatedHeldArrow,
      repeatedArrowRelease,
      panningArrow,
      panChanged: JSON.stringify(beforePan.geometry) !== JSON.stringify(afterPan.geometry),
      zoomChangedEachTic:
        JSON.stringify(afterPan.geometry) !== JSON.stringify(zoomOnce.geometry) &&
        JSON.stringify(zoomOnce.geometry) !== JSON.stringify(zoomTwice.geometry),
      zoomStoppedOnRelease:
        JSON.stringify(zoomTwice.geometry) === JSON.stringify(zoomReleased.geometry),
      bigChanged: JSON.stringify(beforeBig.geometry) !== JSON.stringify(big.geometry),
      bigRestored: JSON.stringify(beforeBig.geometry) === JSON.stringify(restored.geometry),
      gridOnReady,
      gridOffReady,
      gridOnStrokes: gridOn.gridStrokes,
      gridOffStrokes: gridOff.gridStrokes,
      markReady,
      clearReady,
      markedPatches: marked.markPatches,
      clearedPatches: cleared.markPatches,
      mapClosed: doomstat.automapactive === false,
    };
  });

  const failures = [];
  console.log(JSON.stringify(result));
  if (JSON.stringify(result.layoutRect) !== JSON.stringify([0, 0, 960, 504])) {
    failures.push(`automap layout: ${JSON.stringify(result.layoutRect)}`);
  }
  if (result.fullscreenStatusBeforeMap !== false ||
      result.fullscreenStatusOnMap !== true || result.mapStatusDraws === 0) {
    failures.push(`fullscreen automap did not force STBAR: ${JSON.stringify({
      before: result.fullscreenStatusBeforeMap,
      onMap: result.fullscreenStatusOnMap,
      draws: result.mapStatusDraws,
    })}`);
  }
  if (result.mappedBeforeMap !== 31 || result.mappedOutsideCurrentSubsector !== 31) {
    failures.push(`visibility BSP discovery mismatch: ${JSON.stringify({
      mapped: result.mappedBeforeMap,
      outside: result.mappedOutsideCurrentSubsector,
    })}`);
  }
  if (result.rendererFramesDuringMapIdle !== 0 || result.mappedWhileMapOpen !== 0) {
    failures.push(`map-open first-person work continued: ${JSON.stringify({
      renders: result.rendererFramesDuringMapIdle,
      mapped: result.mappedWhileMapOpen,
    })}`);
  }
  if (result.initialGridStrokes !== 0) failures.push('grid drew before G enabled it');
  if (result.spillAlpha !== 0) failures.push(`automap spilled below its clipped window: ${result.spillAlpha}`);
  if (result.geometryPaths < 2) failures.push(`E1M1 wall geometry was not exercised: ${result.geometryPaths}`);
  if (result.followedArrow.angleturn === 0) failures.push('follow-mode arrow did not filter to gameplay');
  if (!result.followOffReady) failures.push('F did not publish the follow-off message');
  if (result.repeatedHeldArrow.angleturn === 0) failures.push('consumed auto-repeat erased a held gameplay key');
  if (result.repeatedArrowRelease.angleturn !== 0) failures.push('real keyup did not clear repeated held arrow');
  if (result.panningArrow.angleturn !== 0) failures.push('free-map arrow leaked into gameplay turning');
  if (!result.panChanged) failures.push('held arrow did not change the drawn map on AM_Ticker');
  if (!result.zoomChangedEachTic) failures.push('held = did not zoom on each AM_Ticker');
  if (!result.zoomStoppedOnRelease) failures.push('= keyup did not stop zooming');
  if (!result.bigChanged || !result.bigRestored) failures.push('0 did not save/show-all/restore E1M1');
  if (!result.gridOnReady || result.gridOnStrokes !== 1) failures.push('G did not enable the grid draw pass');
  if (!result.gridOffReady || result.gridOffStrokes !== 0) failures.push('second G did not disable grid drawing');
  if (!result.markReady || !result.clearReady) failures.push('mark/clear messages were not published');
  if (result.markedPatches.length !== 1 || result.clearedPatches.length !== 0 ||
      JSON.stringify(result.markedPatches[0]?.source) !== JSON.stringify([3, 5])) {
    failures.push(`marks did not use the AMMNUM0 WAD patch: ${JSON.stringify({
      marked: result.markedPatches,
      cleared: result.clearedPatches,
    })}`);
  }
  if (!result.mapClosed) failures.push('Tab did not close the automap');
  if (pageErrors.length !== 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (failures.length !== 0) throw new Error(failures.join('\n'));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
