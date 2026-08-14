// Production hot-path regression for retained automap discovery. Run against
// the repository static server with the bundled IWAD initialized on E1M1.

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
  console.error('automap visibility cache Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8095/');
  url.searchParams.set('-map', 'E1M1');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer?.info.render.frame > 3,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const bsp = await import('/src/r_bsp.js');
    const dMain = await import('/src/d_main.js');
    const doomstat = await import('/src/doomstat.js');
    const mapData = await import('/src/doomdata.js');
    const rMain = await import('/src/r_main.js');
    const setup = await import('/src/p_setup.js');
    const view = await import('/src/r_view.js');
    dMain.D_ShutdownDoomLoop();

    const player = doomstat.players[doomstat.displayplayer];
    const savedLeveltime = doomstat.leveltime;
    const savedBlocks = view.R_GetScreenblocks();
    const movingSeg = setup.segs.find((seg) =>
      seg.frontsector !== null && seg.backsector !== null);
    if (movingSeg === undefined) throw new Error('E1M1 has no moving-sector fixture');
    const movingSector = movingSeg.backsector;
    const savedCeilingHeight = movingSector.ceilingheight;
    const mapped = () => setup.lines
      .map((line, index) => (line.flags & mapData.ML_MAPPED) !== 0 ? index : -1)
      .filter((index) => index >= 0);
    const clearMapped = () => {
      for (const line of setup.lines) line.flags &= ~mapData.ML_MAPPED;
    };
    const currentVisibility = (observer) => {
      const currentView = view.R_GetViewSize();
      return bsp.R_VisibleLinedefs(
        observer.mo.x,
        observer.mo.y,
        (observer.mo.angle + doomstat.viewangleoffset) >>> 0,
        currentView.viewwidth,
        doomstat.leveltime,
        observer,
      );
    };
    const sentinel = () => ({ flags: 0 });

    try {
      bsp.R_ResetVisibleLinedefs();
      clearMapped();
      rMain.R_SetupFrame(player);
      const firstMapped = mapped();
      const retained = currentVisibility(player);

      // A cache hit must still return the retained result so clearing the
      // cumulative flags externally and rendering again restores exactly the
      // same ML_MAPPED set without another BSP walk.
      const repeatedSentinel = sentinel();
      retained.add(repeatedSentinel);
      clearMapped();
      rMain.R_SetupFrame(player);
      const repeatedMapped = mapped();
      const repeatedHit = retained.has(repeatedSentinel) &&
        (repeatedSentinel.flags & mapData.ML_MAPPED) !== 0;

      // Sector movers run inside P_Ticker before leveltime advances. Bumping
      // that production token therefore represents a complete new sector
      // state, even while the observer itself remains stationary.
      const simulationSentinel = sentinel();
      retained.add(simulationSentinel);
      movingSector.ceilingheight = savedCeilingHeight - 65536;
      doomstat.set_leveltime(savedLeveltime + 1);
      clearMapped();
      rMain.R_SetupFrame(player);
      const simulationInvalidated = !retained.has(simulationSentinel);
      movingSector.ceilingheight = savedCeilingHeight;

      // Keep the new simulation state fixed and change only logical view width.
      const viewSentinel = sentinel();
      retained.add(viewSentinel);
      const changedBlocks = savedBlocks === 3 ? 4 : savedBlocks - 1;
      view.R_SetViewSize(changedBlocks);
      clearMapped();
      rMain.R_SetupFrame(player);
      const viewMapped = mapped();
      const viewInvalidated = !retained.has(viewSentinel);

      // A spy target is part of the cache identity even when a synthetic peer
      // happens to occupy the exact same fixed-point view.
      const spy = {
        ...player,
        powers: [...player.powers],
        mo: { ...player.mo },
      };
      const spySentinel = sentinel();
      retained.add(spySentinel);
      clearMapped();
      rMain.R_SetupFrame(spy);
      const spyMapped = mapped();
      const spyInvalidated = !retained.has(spySentinel);

      // Return to the original observer so the key immediately before map
      // teardown matches the key after rebuilding the same loaded arrays.
      const observerSentinel = sentinel();
      retained.add(observerSentinel);
      clearMapped();
      rMain.R_SetupFrame(player);
      const observerInvalidated = !retained.has(observerSentinel);
      const mapSentinel = sentinel();
      retained.add(mapSentinel);
      rMain.R_NewMap();
      const mapRebuildCleared = !retained.has(mapSentinel);
      clearMapped();
      rMain.R_SetupFrame(player);
      const rebuiltMapped = mapped();

      return {
        firstMappedCount: firstMapped.length,
        repeatedMatches: JSON.stringify(repeatedMapped) === JSON.stringify(firstMapped),
        spyMatches: JSON.stringify(spyMapped) === JSON.stringify(viewMapped),
        rebuiltMatches: JSON.stringify(rebuiltMapped) === JSON.stringify(viewMapped),
        repeatedHit,
        simulationInvalidated,
        viewInvalidated,
        spyInvalidated,
        observerInvalidated,
        mapRebuildCleared,
      };
    } finally {
      movingSector.ceilingheight = savedCeilingHeight;
      doomstat.set_leveltime(savedLeveltime);
      view.R_SetViewSize(savedBlocks);
    }
  });

  const failures = [];
  if (result.firstMappedCount <= 0) {
    failures.push(`initial discovery was empty: ${JSON.stringify(result)}`);
  }
  if (result.repeatedMatches !== true || result.repeatedHit !== true) {
    failures.push(`unchanged RAF did not reuse discovery: ${JSON.stringify(result)}`);
  }
  if (result.simulationInvalidated !== true || result.viewInvalidated !== true ||
      result.spyInvalidated !== true || result.observerInvalidated !== true ||
      result.mapRebuildCleared !== true) {
    failures.push(`cache invalidation key is incomplete: ${JSON.stringify(result)}`);
  }
  if (result.spyMatches !== true || result.rebuiltMatches !== true) {
    failures.push(`cached ML_MAPPED behavior changed: ${JSON.stringify(result)}`);
  }
  if (pageErrors.length !== 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (failures.length !== 0) throw new Error(failures.join('\n'));
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
