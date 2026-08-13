// Browser regression for Doom's masked-object draw order. Stock imp/item
// patches contain opaque rows below thing->z; those rows overlap only the
// actor's supporting floor, while an unrelated floor or wall still clips.

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
  // Retina-scale coverage matters because gl_FragCoord uses physical pixels
  // while the Doom view layout is expressed in logical Canvas pixels.
  const page = await browser.newPage({
    viewport: { width: 960, height: 600 },
    deviceScaleFactor: 2,
  });
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
    const shader = await import('/src/r_shader.js');
    dMain.D_ShutdownDoomLoop();
    view.R_SetViewSize(10);

    const production = window.scene.getObjectByName('level');
    const productionThings = production.getObjectByName('things');

    const scene = new THREE.Scene();
    const level = new THREE.Group();
    level.name = 'level';
    scene.add(level);

    const floors = new THREE.Group();
    floors.name = 'floors';
    const floorTexture = shader.R_MakeIndexedTexture(
      Uint8Array.of(112), Uint8Array.of(255), 1, 1,
    );
    floorTexture.magFilter = THREE.NearestFilter;
    floorTexture.minFilter = THREE.NearestFilter;
    const floorMaterial = shader.R_MakeDoomMaterial(floorTexture, {
      plane: true,
      side: THREE.DoubleSide,
      fixedColormap: 0,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), floorMaterial);
    floor.rotation.x = -Math.PI / 2;
    floor.position.z = -20;
    floors.add(floor);
    // A raised floor covers only the left side of the sprite projection. It
    // is an unrelated foreground surface, so even the overhang repair must
    // leave it in front (the E1M1 armor-staircase failure in miniature).
    const raisedFloor = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), floorMaterial);
    raisedFloor.rotation.x = -Math.PI / 2;
    raisedFloor.position.set(-25, 2, -10);
    floors.add(raisedFloor);
    level.add(floors);

    const walls = new THREE.Group();
    walls.name = 'walls';
    const wallMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff });
    const wall = new THREE.Mesh(new THREE.PlaneGeometry(3, 12), wallMaterial);
    wall.position.set(2, 3, -10);
    walls.add(wall);
    level.add(walls);

    const things = new THREE.Group();
    things.name = 'things';
    const spriteTexture = shader.R_MakeIndexedTexture(
      Uint8Array.of(176), Uint8Array.of(255), 1, 1,
    );
    spriteTexture.magFilter = THREE.NearestFilter;
    spriteTexture.minFilter = THREE.NearestFilter;
    const spriteMaterial = shader.R_MakeDoomSpriteMaterial(spriteTexture);
    spriteMaterial.uniforms.floorCutoff.value = 0.5;
    spriteMaterial.uniforms.floorHeight.value = 0;
    const floorPass = spriteMaterial.uniforms.floorPass;
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
    const dpr = window.devicePixelRatio;
    const read = (layout, x, y) => {
      gl.readPixels(
        Math.floor((layout.viewX + x) * dpr),
        Math.floor((layout.webglViewY + y) * dpr),
        1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel,
      );
      return [...pixel];
    };
    const readTopRegion = (layout, x, y, width, height) => {
      const physicalWidth = Math.floor(width * dpr);
      const physicalHeight = Math.floor(height * dpr);
      const pixels = new Uint8Array(physicalWidth * physicalHeight * 4);
      gl.readPixels(
        Math.floor((layout.viewX + x) * dpr),
        Math.floor((layout.webglViewY + layout.viewHeight - y - height) * dpr),
        physicalWidth, physicalHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels,
      );
      return pixels;
    };
    const changedBytes = (a, b) => {
      let changed = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed++;
      return changed;
    };
    const samples = (layout) => ({
      void: read(layout, 100, 500),
      // The sprite extends below the y=0 floor anchor here.
      foot: read(layout, 450, 148),
      body: read(layout, 450, 190),
      behindRaisedFloor: read(layout, 375, 148),
      // The blue wall is physically nearer than the sprite on its right side.
      behindWall: read(layout, 525, 190),
    });

    delete scene.userData.doomSpriteDepthPass;
    const singlePass = samples(video.I_RenderView(scene, camera));

    const oldAutoClear = window.renderer.autoClear;
    const oldCameraMask = camera.layers.mask;
    const oldSpriteDepthFunc = spriteMaterial.depthFunc;
    scene.userData.doomSpriteDepthPass = depth.R_CreateSpriteDepthPass(
      things, floorPass,
    );
    const splitPass = samples(video.I_RenderView(scene, camera));

    // Real E1M1 regression: after taking the first green armor, looking back
    // east across the raised stairs used to reveal two complete BON1 bottles.
    // The first narrow patch still left their four below-origin source rows as
    // detached blue slivers. Compare production with an ordinary single pass:
    // the unrelated height-104 stair floor must win in both cases.
    window.camera.position.set(-224, 169, 3232);
    window.camera.rotation.order = 'YXZ';
    window.camera.rotation.set(0, -Math.PI / 2, 0);
    const productionPass = window.scene.userData.doomSpriteDepthPass;
    delete window.scene.userData.doomSpriteDepthPass;
    const armorControlLayout = video.I_RenderView(window.scene, window.camera);
    const armorControl = {
      leftBody: read(armorControlLayout, 354, 504 - 1 - 478),
      leftBase: read(armorControlLayout, 354, 504 - 1 - 484),
      rightBody: read(armorControlLayout, 604, 504 - 1 - 478),
      rightBase: read(armorControlLayout, 604, 504 - 1 - 484),
    };
    const armorControlLeftRegion = readTopRegion(
      armorControlLayout, 344, 462, 24, 30,
    );
    const armorControlRightRegion = readTopRegion(
      armorControlLayout, 594, 462, 24, 30,
    );
    window.scene.userData.doomSpriteDepthPass = productionPass;
    const armorFixedLayout = video.I_RenderView(window.scene, window.camera);
    const armorFixed = {
      leftBody: read(armorFixedLayout, 354, 504 - 1 - 478),
      leftBase: read(armorFixedLayout, 354, 504 - 1 - 484),
      rightBody: read(armorFixedLayout, 604, 504 - 1 - 478),
      rightBase: read(armorFixedLayout, 604, 504 - 1 - 484),
    };
    const armorRegionChangedBytes = {
      left: changedBytes(armorControlLeftRegion, readTopRegion(
        armorFixedLayout, 344, 462, 24, 30,
      )),
      right: changedBytes(armorControlRightRegion, readTopRegion(
        armorFixedLayout, 594, 462, 24, 30,
      )),
    };

    const stateRestored = {
      autoClear: window.renderer.autoClear === oldAutoClear,
      cameraMask: camera.layers.mask === oldCameraMask,
      wallColorWrite: wallMaterial.colorWrite,
      thingsVisible: things.visible,
      floorPass: floorPass.value === depth.R_SPRITE_PASS_FULL,
      spriteDepthFunc: spriteMaterial.depthFunc === oldSpriteDepthFunc,
    };
    const productionLayers = {
      markedLevel: window.scene.userData.doomSpriteDepthPass?.things === productionThings,
      spriteCount: productionThings.children.length,
      sprites: productionThings.children.every((object) =>
        object.layers.isEnabled(depth.R_WORLD_SPRITE_LAYER)),
    };

    floor.geometry.dispose();
    raisedFloor.geometry.dispose();
    floorMaterial.dispose();
    floorTexture.dispose();
    wall.geometry.dispose();
    wallMaterial.dispose();
    spriteMaterial.dispose();
    spriteTexture.dispose();
    return {
      singlePass,
      splitPass,
      stateRestored,
      productionLayers,
      armorControl,
      armorFixed,
      armorRegionChangedBytes,
      deviceScaleFactor: dpr,
      glError: gl.getError(),
      expectedGlError: gl.NO_ERROR,
    };
  });

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  assert(result.deviceScaleFactor === 2,
    `physical-pixel viewport coverage did not run: ${JSON.stringify(result)}`);
  assert(!same(result.singlePass.foot, result.singlePass.body),
    `control floor did not clip the below-anchor rows: ${JSON.stringify(result)}`);
  assert(!same(result.singlePass.body, [0, 255, 0, 255]),
    `control sprite body was not visible: ${JSON.stringify(result)}`);
  assert(same(result.splitPass.foot, result.singlePass.body),
    `split pass did not restore below-anchor sprite rows: ${JSON.stringify(result)}`);
  assert(same(result.splitPass.body, result.singlePass.body),
    `split pass lost the sprite body: ${JSON.stringify(result)}`);
  assert(same(result.singlePass.behindWall, [0, 0, 255, 255]) &&
         same(result.splitPass.behindWall, [0, 0, 255, 255]),
  `near wall stopped occluding the sprite: ${JSON.stringify(result)}`);
  assert(same(result.splitPass.behindRaisedFloor, result.singlePass.behindRaisedFloor) &&
         !same(result.splitPass.behindRaisedFloor, result.splitPass.body),
  `unrelated raised floor stopped clipping the sprite: ${JSON.stringify(result)}`);
  assert(same(result.splitPass.void, result.singlePass.void),
    `split pass changed the scissored PLAYPAL clear: ${JSON.stringify(result)}`);
  assert(Object.values(result.stateRestored).every(Boolean),
    `split render leaked Three.js state: ${JSON.stringify(result)}`);
  assert(result.productionLayers.markedLevel &&
         result.productionLayers.spriteCount > 0 && result.productionLayers.sprites,
  `production objects lack split-pass layers: ${JSON.stringify(result)}`);
  assert(same(result.armorFixed.leftBody, result.armorControl.leftBody) &&
         same(result.armorFixed.leftBase, result.armorControl.leftBase) &&
         same(result.armorFixed.rightBody, result.armorControl.rightBody) &&
         same(result.armorFixed.rightBase, result.armorControl.rightBase),
  `foreground stair floor stopped clipping the distant bottles: ${JSON.stringify(result)}`);
  assert(result.armorRegionChangedBytes.left === 0 &&
         result.armorRegionChangedBytes.right === 0,
  `armor-stair bottle regions changed: ${JSON.stringify(result)}`);
  assert(result.glError === result.expectedGlError,
    `WebGL error after sprite-depth render: ${result.glError}`);

  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
