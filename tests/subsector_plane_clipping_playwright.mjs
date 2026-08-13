// Real E1M1 regression for floor/ceiling geometry leaking through map void.
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

let browser = null;
const pageErrors = [];
const watchdog = setTimeout(() => {
  console.error('subsector plane clipping Playwright test exceeded 60 seconds');
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
    window.scene?.getObjectByName('floors') !== undefined &&
    window.scene?.getObjectByName('ceilings') !== undefined,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const dMain = await import('/src/d_main.js');
    const pSetup = await import('/src/p_setup.js');
    dMain.D_ShutdownDoomLoop();

    const authoredX = pSetup.vertexes.map((vertex) => vertex.x / 65536);
    const authoredY = pSetup.vertexes.map((vertex) => vertex.y / 65536);
    const bounds = {
      minX: Math.min(...authoredX),
      maxX: Math.max(...authoredX),
      minY: Math.min(...authoredY),
      maxY: Math.max(...authoredY),
    };

    const pointInTriangle = (px, pz, ax, az, bx, bz, cx, cz) => {
      const cross = (x1, z1, x2, z2) => x1 * z2 - z1 * x2;
      const ab = cross(bx - ax, bz - az, px - ax, pz - az);
      const bc = cross(cx - bx, cz - bz, px - bx, pz - bz);
      const ca = cross(ax - cx, az - cz, px - cx, pz - cz);
      return (ab >= 0 && bc >= 0 && ca >= 0) || (ab <= 0 && bc <= 0 && ca <= 0);
    };

    const auditGroup = (name) => {
      const group = window.scene.getObjectByName(name);
      let area = 0;
      let triangleCount = 0;
      let vertexCount = 0;
      let outsideAuthoredBounds = 0;
      let voidSampleCovered = false;
      // This point lies in BSP leaf 104's padded cell, south of the actual
      // 64x32 sector polygon. The old builder incorrectly covered it with
      // sector 40's floor and ceiling all the way to the map seed boundary.
      const voidX = 1056;
      const voidZ = 4000; // Three Z is negative Doom Y.

      for (const mesh of group.children) {
        const position = mesh.geometry.attributes.position;
        const index = mesh.geometry.index;
        vertexCount += position.count;
        for (let i = 0; i < position.count; i++) {
          const x = position.getX(i);
          const y = -position.getZ(i);
          if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) {
            outsideAuthoredBounds++;
          }
        }
        for (let i = 0; i < index.count; i += 3) {
          const a = index.getX(i);
          const b = index.getX(i + 1);
          const c = index.getX(i + 2);
          const ax = position.getX(a), az = position.getZ(a);
          const bx = position.getX(b), bz = position.getZ(b);
          const cx = position.getX(c), cz = position.getZ(c);
          area += Math.abs((bx - ax) * (cz - az) - (bz - az) * (cx - ax)) / 2;
          triangleCount++;
          if (pointInTriangle(voidX, voidZ, ax, az, bx, bz, cx, cz)) {
            voidSampleCovered = true;
          }
        }
      }
      return { area, triangleCount, vertexCount, outsideAuthoredBounds, voidSampleCovered };
    };

    return {
      floors: auditGroup('floors'),
      ceilings: auditGroup('ceilings'),
      bounds,
      subsectors: pSetup.numsubsectors,
    };
  });

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  assert(result.subsectors === 237, `unexpected E1M1 subsector count: ${result.subsectors}`);
  for (const [name, audit] of Object.entries({ floors: result.floors, ceilings: result.ceilings })) {
    assert(Math.abs(audit.area - 4448546.422744727) < 0.25,
      `${name} retained phantom BSP-cell area: ${audit.area}`);
    assert(audit.triangleCount === 459 && audit.vertexCount === 933,
      `${name} topology mismatch: ${JSON.stringify(audit)}`);
    assert(audit.outsideAuthoredBounds === 0,
      `${name} reached beyond authored map bounds: ${JSON.stringify(audit)}`);
    assert(audit.voidSampleCovered === false,
      `${name} still covers the known leaf-104 void sample`);
  }

  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
