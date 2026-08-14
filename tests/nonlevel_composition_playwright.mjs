// Headless 16:9 coverage for page/screenshot composition after leaving a
// level. A bright retained-scene sentinel makes stale Three.js rendering
// visible in the transparent bars around Doom's centered 320x200 page.

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
  console.error('non-level composition Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const baseUrl = process.env.DOOM_URL ?? 'http://127.0.0.1:8095/';
  const url = new URL(baseUrl);
  url.searchParams.set('-map', 'E1M1');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    window.renderer !== undefined &&
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer.info.render.frame > 2,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const THREE = await import('three');
    const dMain = await import('/src/d_main.js');
    const doomstat = await import('/src/doomstat.js');
    const wipe = await import('/src/f_wipe.js');
    const overlay = document.getElementById('overlay');

    // Always wins if the retained level scene is accidentally rendered.
    const sentinel = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: 'void main(){gl_Position=vec4(position.xy,0.0,1.0);}',
        fragmentShader: 'void main(){gl_FragColor=vec4(1.0,0.0,1.0,1.0);}',
        depthTest: false,
        depthWrite: false,
      }),
    );
    sentinel.frustumCulled = false;
    sentinel.renderOrder = Infinity;
    window.scene.add(sentinel);

    dMain.D_StartTitle();
    for (let i = 0; i < 180 &&
         (doomstat.gamestate !== 3 || wipe.wipe_isActive()); i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    if (doomstat.gamestate !== 3) throw new Error('title screen did not start');
    if (wipe.wipe_isActive()) throw new Error('title-screen wipe did not finish');

    const gl = window.renderer.getContext();
    const pixel = new Uint8Array(4);
    const readWebgl = (x, y) => {
      gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      return [...pixel];
    };
    // Dirty the non-level buffer after the state transition, then require
    // subsequent D_Display title frames to actively clear it.
    window.renderer.render(window.scene, window.camera);
    const rawRetainedControl = readWebgl(24, 270);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const overlayCtx = overlay.getContext('2d');
    const title = {
      retainedLevel: window.scene.getObjectByName('level') !== undefined,
      webglLeftBar: readWebgl(24, 270),
      overlayLeftBar: [...overlayCtx.getImageData(24, 270, 1, 1).data],
      overlayPage: [...overlayCtx.getImageData(480, 270, 1, 1).data],
      rawRetainedControl,
    };
    // Dirty it again: captureScreenshot itself must clear it before composing.
    window.renderer.render(window.scene, window.camera);
    title.screenshotDirtyControl = readWebgl(24, 270);

    const screenshot = await new Promise((resolve, reject) => {
      const proto = HTMLCanvasElement.prototype;
      const originalToBlob = proto.toBlob;
      const timeout = setTimeout(() => {
        proto.toBlob = originalToBlob;
        reject(new Error('screenshot canvas was not composed'));
      }, 5000);
      proto.toBlob = function (callback, type, quality) {
        if (this !== overlay && this !== window.renderer.domElement &&
            this.width === window.renderer.domElement.width &&
            this.height === window.renderer.domElement.height) {
          clearTimeout(timeout);
          proto.toBlob = originalToBlob;
          const ctx = this.getContext('2d');
          resolve({
            leftBar: [...ctx.getImageData(24, 270, 1, 1).data],
            page: [...ctx.getImageData(480, 270, 1, 1).data],
          });
          callback(null);
          return;
        }
        return originalToBlob.call(this, callback, type, quality);
      };
      window.dispatchEvent(new Event('doom:screenshot'));
    });

    window.scene.remove(sentinel);
    sentinel.geometry.dispose();
    sentinel.material.dispose();
    return { title, screenshot };
  });

  const failures = [];
  const isClearBlack = (pixel) =>
    pixel[0] <= 2 && pixel[1] <= 2 && pixel[2] <= 2 && pixel[3] === 255;
  if (!result.title.retainedLevel) failures.push('level scene was not retained for the transition check');
  if (!isClearBlack(result.title.webglLeftBar)) {
    failures.push(`title WebGL bar rendered retained scene: ${JSON.stringify(result.title)}`);
  }
  if (result.title.rawRetainedControl[0] < 250 || result.title.rawRetainedControl[2] < 250) {
    failures.push(`retained-scene control did not cover the 16:9 bar: ${JSON.stringify(result.title)}`);
  }
  if (result.title.screenshotDirtyControl[0] < 250 || result.title.screenshotDirtyControl[2] < 250) {
    failures.push(`screenshot control did not dirty the 16:9 bar: ${JSON.stringify(result.title)}`);
  }
  if (result.title.overlayLeftBar[3] !== 0 || result.title.overlayPage[3] !== 255) {
    failures.push(`title page was not centered at 320:200: ${JSON.stringify(result.title)}`);
  }
  if (!isClearBlack(result.screenshot.leftBar) || result.screenshot.page[3] !== 255) {
    failures.push(`non-level screenshot retained stale world pixels: ${JSON.stringify(result.screenshot)}`);
  }
  if (pageErrors.length !== 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (failures.length !== 0) throw new Error(failures.join('\n'));
  console.log(JSON.stringify(result));
} finally {
  if (browser !== null) await browser.close();
  clearTimeout(watchdog);
}
