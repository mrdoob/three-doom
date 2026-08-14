// Browser regression for r_bsp.c's solid-span semantics when a closed line's
// required wall tier is texture "-". A depth-only retained quad must block
// already-submitted geometry without coloring the missing-texture region.

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
  console.error('wall-terminal-occlusion Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8095/');
  url.searchParams.set('-map', 'E1M2');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    window.scene?.getObjectByName('terminal-occluders') !== undefined &&
    window.renderer?.info.render.frame > 3,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const dMain = await import('/src/d_main.js');
    const video = await import('/src/i_video.js');
    const view = await import('/src/r_view.js');
    const setup = await import('/src/p_setup.js');
    const walls = await import('/src/r_segs.js');
    dMain.D_ShutdownDoomLoop();
    view.R_SetViewSize(10);

    const source = window.scene.getObjectByName('terminal-occluders');
    const position = source.geometry.getAttribute('position');
    let targetBase = -1;
    for (let base = 0; base < position.count; base += 4) {
      const xs = [0, 1, 2, 3].map((i) => position.getX(base + i));
      const ys = [0, 1, 2, 3].map((i) => position.getY(base + i));
      const zs = [0, 1, 2, 3].map((i) => position.getZ(base + i));
      if (xs.every((x) => x === -2048) && Math.min(...ys) === 72 &&
          Math.max(...ys) === 80 && Math.min(...zs) === 320 &&
          Math.max(...zs) === 448) {
        targetBase = base;
        break;
      }
    }
    if (targetBase < 0) throw new Error('E1M2 line 574 side-1 terminal quad is missing');

    // Restrict the shared geometry to the exact stock closed portal under test.
    source.geometry.setDrawRange(targetBase / 4 * 6, 6);
    const occluder = new THREE.Mesh(source.geometry, source.material);
    occluder.renderOrder = source.renderOrder;
    occluder.frustumCulled = false;

    const scene = new THREE.Scene();
    scene.add(occluder);
    const red = new THREE.Mesh(
      new THREE.PlaneGeometry(160, 24),
      new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide }),
    );
    red.rotation.y = Math.PI / 2;
    red.position.set(-2100, 76, 384);
    scene.add(red);

    const camera = new THREE.PerspectiveCamera(60, 1, 1, 1000);
    camera.position.set(-1950, 76, 384);
    camera.lookAt(-2100, 76, 384);
    const gl = window.renderer.getContext();
    const pixel = new Uint8Array(4);
    const sample = () => {
      const layout = video.I_RenderView(scene, camera);
      gl.readPixels(
        Math.floor(layout.viewX + layout.viewWidth / 2),
        Math.floor(layout.webglViewY + layout.viewHeight / 2),
        1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel,
      );
      return [...pixel];
    };

    const closed = sample();
    const terminalCount = source.userData.doomTerminalOccluderCount;

    // Open the exact portal according to r_bsp.c, update its retained wall
    // contributions, and prove the formerly hidden red surface becomes visible.
    const line = setup.lines[574];
    const originalCeiling = line.frontsector.ceilingheight;
    line.frontsector.ceilingheight = 76 * 65536;
    walls.R_UpdateSectorWalls(line.frontsector);
    const open = sample();
    const openCount = source.userData.doomTerminalOccluderCount;

    // Restore production state and verify the same quad becomes terminal again.
    line.frontsector.ceilingheight = originalCeiling;
    walls.R_UpdateSectorWalls(line.frontsector);
    const reclosed = sample();
    const reclosedCount = source.userData.doomTerminalOccluderCount;

    return {
      targetBase,
      closed,
      open,
      reclosed,
      terminalCount,
      openCount,
      reclosedCount,
      candidateCount: source.userData.doomTerminalOccluderCandidates,
      material: {
        colorWrite: source.material.colorWrite,
        depthTest: source.material.depthTest,
        depthWrite: source.material.depthWrite,
        side: source.material.side,
      },
      renderOrder: source.renderOrder,
      glError: gl.getError(),
      noError: gl.NO_ERROR,
    };
  });

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  assert(result.candidateCount > result.terminalCount && result.terminalCount > 0,
    `terminal candidate accounting mismatch: ${JSON.stringify(result)}`);
  assert(result.openCount === result.terminalCount - 1 &&
         result.reclosedCount === result.terminalCount,
  `dynamic terminal count mismatch: ${JSON.stringify(result)}`);
  assert(result.closed[0] < 64 && result.reclosed[0] < 64,
    `depth-only closed portal exposed red geometry: ${JSON.stringify(result)}`);
  assert(result.open[0] > 200 && result.open[1] < 32 && result.open[2] < 32,
    `opening the portal did not expose the red control: ${JSON.stringify(result)}`);
  assert(result.material.colorWrite === false && result.material.depthTest === true &&
         result.material.depthWrite === true && result.material.side === 0,
  `terminal material state mismatch: ${JSON.stringify(result)}`);
  assert(result.renderOrder < -2,
    `terminal depth was not submitted before retained color: ${JSON.stringify(result)}`);
  assert(result.glError === result.noError,
    `WebGL error after terminal samples: ${result.glError}`);
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
