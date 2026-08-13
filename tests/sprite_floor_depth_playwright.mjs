// Browser regression for Doom's masked-object draw order. Stock imp/item
// patches contain opaque rows below thing->z; floors must not depth-clip those
// rows, while a nearer wall must still occlude the sprite.

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
  console.error('sprite-floor-depth Playwright test exceeded 60 seconds');
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
    const THREE = await import('three');
    const dMain = await import('/src/d_main.js');
    const video = await import('/src/i_video.js');
    const view = await import('/src/r_view.js');
    const depth = await import('/src/r_sprite_depth.js');
    dMain.D_ShutdownDoomLoop();
    view.R_SetViewSize(11);

    const production = window.scene.getObjectByName('level');
    const productionThings = production.getObjectByName('things');
    const productionWalls = production.getObjectByName('walls');
    const productionSkyOccluders = [];
    production.traverse((object) => {
      if (object.userData.doomSkyDepthOccluder === true) {
        productionSkyOccluders.push(object);
      }
    });

    const scene = new THREE.Scene();
    const level = new THREE.Group();
    level.name = 'level';
    scene.add(level);

    const floors = new THREE.Group();
    floors.name = 'floors';
    const floorMaterial = new THREE.MeshBasicMaterial({
      color: 0x00ff00,
      side: THREE.DoubleSide,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = -20;
    floors.add(floor);
    level.add(floors);

    const walls = new THREE.Group();
    walls.name = 'walls';
    const wallMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(3, 12), wallMaterial);
    wall.position.set(2, 3, -10);
    depth.R_MarkSpriteOccluder(wall);
    walls.add(wall);
    level.add(walls);

    const things = new THREE.Group();
    things.name = 'things';
    const spriteMaterial = new THREE.SpriteMaterial({
      color: 0xff0000,
      depthTest: true,
      depthWrite: true,
    });
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.position.set(0, 3, -20);
    sprite.scale.set(8, 8, 1);
    depth.R_MarkWorldSprite(sprite);
    things.add(sprite);
    level.add(things);

    const camera = new THREE.PerspectiveCamera(60, 1, 1, 1000);
    camera.position.set(0, 6, 10);
    const gl = window.renderer.getContext();
    const pixel = new Uint8Array(4);
    const read = (layout, x, y) => {
      gl.readPixels(
        Math.floor(layout.viewX + x),
        Math.floor(layout.webglViewY + y),
        1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel,
      );
      return [...pixel];
    };
    const samples = (layout) => ({
      void: read(layout, 100, 500),
      // The sprite extends below the y=0 floor anchor here.
      foot: read(layout, 450, 195),
      body: read(layout, 450, 225),
      // The blue wall is physically nearer than the sprite on its right side.
      behindWall: read(layout, 525, 225),
    });

    delete scene.userData.doomSpriteDepthPass;
    const singlePass = samples(video.I_RenderView(scene, camera));

    const oldAutoClear = window.renderer.autoClear;
    const oldCameraMask = camera.layers.mask;
    scene.userData.doomSpriteDepthPass = depth.R_CreateSpriteDepthPass(things, walls);
    const splitPass = samples(video.I_RenderView(scene, camera));

    const stateRestored = {
      autoClear: window.renderer.autoClear === oldAutoClear,
      cameraMask: camera.layers.mask === oldCameraMask,
      wallColorWrite: wallMaterial.colorWrite,
      thingsVisible: things.visible,
    };
    const productionLayers = {
      markedLevel: window.scene.userData.doomSpriteDepthPass?.things === productionThings,
      spriteCount: productionThings.children.length,
      sprites: productionThings.children.every((object) =>
        object.layers.isEnabled(depth.R_WORLD_SPRITE_LAYER)),
      wallCount: productionWalls.children.length,
      walls: productionWalls.children.every((object) =>
        object.layers.isEnabled(depth.R_SPRITE_OCCLUDER_LAYER)),
      skyCount: productionSkyOccluders.length,
      sky: productionSkyOccluders.every((object) =>
        object.layers.isEnabled(depth.R_SPRITE_OCCLUDER_LAYER)),
    };

    floor.geometry.dispose();
    floorMaterial.dispose();
    wall.geometry.dispose();
    wallMaterial.dispose();
    spriteMaterial.dispose();
    return {
      singlePass,
      splitPass,
      stateRestored,
      productionLayers,
      glError: gl.getError(),
      expectedGlError: gl.NO_ERROR,
    };
  });

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  assert(same(result.singlePass.foot, [0, 255, 0, 255]),
    `control floor did not clip the below-anchor rows: ${JSON.stringify(result)}`);
  assert(same(result.singlePass.body, [255, 0, 0, 255]),
    `control sprite body was not visible: ${JSON.stringify(result)}`);
  assert(same(result.splitPass.foot, [255, 0, 0, 255]),
    `split pass did not restore below-anchor sprite rows: ${JSON.stringify(result)}`);
  assert(same(result.splitPass.body, [255, 0, 0, 255]),
    `split pass lost the sprite body: ${JSON.stringify(result)}`);
  assert(same(result.singlePass.behindWall, [0, 0, 255, 255]) &&
         same(result.splitPass.behindWall, [0, 0, 255, 255]),
  `near wall stopped occluding the sprite: ${JSON.stringify(result)}`);
  assert(same(result.splitPass.void, result.singlePass.void),
    `split pass changed the scissored PLAYPAL clear: ${JSON.stringify(result)}`);
  assert(Object.values(result.stateRestored).every(Boolean),
    `split render leaked Three.js state: ${JSON.stringify(result)}`);
  assert(result.productionLayers.markedLevel &&
         result.productionLayers.spriteCount > 0 && result.productionLayers.sprites &&
         result.productionLayers.wallCount > 0 && result.productionLayers.walls &&
         result.productionLayers.skyCount > 0 && result.productionLayers.sky,
  `production objects lack split-pass layers: ${JSON.stringify(result)}`);
  assert(result.glError === result.expectedGlError,
    `WebGL error after sprite-depth render: ${result.glError}`);

  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
