// Browser startup regression for native-style `-file one.wad two.wad` overlay
// loading. Synthetic PWADs prove fetch/override order, while standalone patch
// lumps prove modified-game sprite replacement against the bundled IWAD.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
}

function makePwad(name, bytes) {
  const payload = Buffer.from(bytes);
  const out = Buffer.alloc(12 + payload.length + 16);
  out.write('PWAD', 0, 'ascii');
  out.writeInt32LE(1, 4);
  out.writeInt32LE(12 + payload.length, 8);
  payload.copy(out, 12);
  out.writeInt32LE(12, 12 + payload.length);
  out.writeInt32LE(payload.length, 16 + payload.length);
  out.write(name.slice(0, 8).toUpperCase(), 20 + payload.length, 'ascii');
  return out;
}

function makePatch(paletteIndex) {
  // Valid 1x1 Doom patch: header + one column offset + one post + terminator.
  const out = Buffer.alloc(18);
  out.writeInt16LE(1, 0);  // width
  out.writeInt16LE(1, 2);  // height
  out.writeInt16LE(0, 4);  // left offset
  out.writeInt16LE(1, 6);  // top offset
  out.writeInt32LE(12, 8); // column data offset
  out[12] = 0;             // top delta
  out[13] = 1;             // post length
  out[14] = 0;             // unused leading byte
  out[15] = paletteIndex;
  out[16] = 0;             // unused trailing byte
  out[17] = 0xff;          // end of column
  return out;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let browser = null;
const pageErrors = [];
const watchdog = setTimeout(() => {
  console.error('file overlay Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  // Exercise optional fetch rejection (not merely a non-OK HTTP response): a
  // missing overlay must not prevent the later files from loading.
  await page.route('**/missing.wad', (route) => route.abort('connectionrefused'));
  await page.route('**/first%20overlay.wad', (route) => route.fulfill({
    status: 200,
    contentType: 'application/octet-stream',
    body: makePwad('PWAUDIT', [1, 2, 3]),
  }));
  await page.route('**/last.wad?v=1', (route) => route.fulfill({
    status: 200,
    contentType: 'application/octet-stream',
    body: makePwad('PWAUDIT', [9, 8, 7, 6]),
  }));
  await page.route('**/TROOA1.lmp', (route) => route.fulfill({
    status: 200,
    contentType: 'application/octet-stream',
    body: makePatch(201),
  }));
  await page.route('**/TROOA2A8.lmp', (route) => route.fulfill({
    status: 200,
    contentType: 'application/octet-stream',
    body: makePatch(202),
  }));

  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8095/');
  url.search = '?-file=missing.wad&first%20overlay.wad&last.wad%3Fv%3D1&TROOA1.lmp&TROOA2A8.lmp&-map=E1M1';
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer?.info.render.frame > 2,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const wad = await import('/src/w_wad.js');
    const doomstat = await import('/src/doomstat.js');
    const rData = await import('/src/r_data.js');
    const rThings = await import('/src/r_things.js');
    const info = await import('/src/info.js');
    const lump = wad.W_CacheLumpName('PWAUDIT', 0);
    const impFrameA = rThings.sprites[info.SPR_TROO].spriteframes[0];
    const absoluteSpriteLumps = impFrameA.lump.map(
      (relative) => rData.firstspritelump + relative,
    );
    return {
      modifiedgame: doomstat.modifiedgame,
      bytes: [...lump],
      finalSources: wad.lumpinfo.slice(-4).map((entry) => entry.name),
      spriteRange: [rData.firstspritelump, rData.lastspritelump],
      spriteOverrides: {
        rotation1: absoluteSpriteLumps[0],
        rotation2: absoluteSpriteLumps[1],
        rotation8: absoluteSpriteLumps[7],
        expected1: wad.W_GetNumForName('TROOA1'),
        expected2And8: wad.W_GetNumForName('TROOA2A8'),
        flip2: impFrameA.flip[1],
        flip8: impFrameA.flip[7],
      },
    };
  });

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  assert(result.modifiedgame === true, `modifiedgame not set: ${JSON.stringify(result)}`);
  assert(JSON.stringify(result.bytes) === JSON.stringify([9, 8, 7, 6]),
    `later PWAD did not override earlier lump: ${JSON.stringify(result)}`);
  assert(JSON.stringify(result.finalSources) === JSON.stringify([
    'PWAUDIT', 'PWAUDIT', 'TROOA1', 'TROOA2A8',
  ]),
    `overlay directory order mismatch: ${JSON.stringify(result)}`);
  const sprites = result.spriteOverrides;
  assert(sprites.expected1 > result.spriteRange[1] &&
    sprites.expected2And8 > result.spriteRange[1],
  `sprite fixtures were not standalone lumps: ${JSON.stringify(result)}`);
  assert(sprites.rotation1 === sprites.expected1,
    `standalone rotation 1 did not override IWAD sprite: ${JSON.stringify(result)}`);
  assert(sprites.rotation2 === sprites.expected2And8 &&
    sprites.rotation8 === sprites.expected2And8,
  `combined sprite aliases did not share the standalone replacement: ${JSON.stringify(result)}`);
  assert(sprites.flip2 === 0 && sprites.flip8 === 1,
    `combined sprite alias flip flags changed: ${JSON.stringify(result)}`);
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
