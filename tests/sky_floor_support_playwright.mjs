// Synthetic regression for F_SKY1 floors participating in the retained
// sprite-overhang EqualDepth pass. Run against the repository's static server.

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
  console.error('sky-floor-support Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

try {
  browser = await chromium.launch(launchOptions);
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
    const sky = await import('/src/r_sky.js');
    dMain.D_ShutdownDoomLoop();
    view.R_SetViewSize(10);

    // Rebuild once so this fixture tests the actual floor/ceiling occluders
    // returned to r_plane, not a stand-alone approximation of them.
    const skyMaterials = sky.R_BuildSky();
    if (skyMaterials === null) throw new Error('E1M1 sky materials are unavailable');
    const skyMaterialList = [
      skyMaterials.floor,
      skyMaterials.ceiling,
      skyMaterials.floorOccluder,
      skyMaterials.ceilingOccluder,
    ];
    const materialContract = {
      uniqueMaterials: new Set(skyMaterialList).size,
      floorIsAnalytical: skyMaterials.floorOccluder.isShaderMaterial === true &&
        skyMaterials.floorOccluder.uniforms?.doomViewport ===
          shader.spriteFloorViewportUniform,
      floorSide: skyMaterials.floorOccluder.side,
      ceilingIsHardware: skyMaterials.ceilingOccluder.isMeshBasicMaterial === true &&
        skyMaterials.ceilingOccluder.isShaderMaterial !== true,
      ceilingSide: skyMaterials.ceilingOccluder.side,
      floorDepthFunc: skyMaterials.floorOccluder.depthFunc,
      ceilingDepthFunc: skyMaterials.ceilingOccluder.depthFunc,
      expectedDepthFunc: THREE.LessEqualDepth,
      floorColorWrite: skyMaterials.floorOccluder.colorWrite,
      ceilingColorWrite: skyMaterials.ceilingOccluder.colorWrite,
      floorDepthTest: skyMaterials.floorOccluder.depthTest,
      ceilingDepthTest: skyMaterials.ceilingOccluder.depthTest,
      floorDepthWrite: skyMaterials.floorOccluder.depthWrite,
      ceilingDepthWrite: skyMaterials.ceilingOccluder.depthWrite,
    };

    const horizontalGeometry = (x1, x2, z1, z2) => {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute([
        x1, 0, z1,
        x2, 0, z1,
        x2, 0, z2,
        x1, 0, z2,
      ], 3));
      // Upward-facing winding, matching r_plane's floor geometry.
      geometry.setIndex([0, 2, 1, 0, 3, 2]);
      return geometry;
    };

    const scene = new THREE.Scene();
    const supportGeometry = horizontalGeometry(-40, 40, -60, 20);
    // The ceiling occluder is the old hardware-depth implementation and acts
    // as the control before swapping in the production sky-floor material.
    const support = new THREE.Mesh(
      supportGeometry, skyMaterials.ceilingOccluder,
    );
    support.renderOrder = -1;
    scene.add(support);

    const raisedGeometry = horizontalGeometry(-20, -1.5, -30, 10);
    const raisedMaterial = new THREE.MeshBasicMaterial({ color: 0x00ff00 });
    const raisedFloor = new THREE.Mesh(raisedGeometry, raisedMaterial);
    raisedFloor.position.y = 2;
    scene.add(raisedFloor);

    const wallGeometry = new THREE.PlaneGeometry(3, 12);
    const wallMaterial = new THREE.MeshBasicMaterial({ color: 0x0000ff });
    const wall = new THREE.Mesh(wallGeometry, wallMaterial);
    wall.position.set(2, 3, -10);
    scene.add(wall);

    const things = new THREE.Group();
    const spriteTexture = shader.R_MakeIndexedTexture(
      Uint8Array.of(176), Uint8Array.of(255), 1, 1,
    );
    spriteTexture.magFilter = THREE.NearestFilter;
    spriteTexture.minFilter = THREE.NearestFilter;
    const spriteMaterial = shader.R_MakeDoomSpriteMaterial(spriteTexture);
    spriteMaterial.uniforms.floorCutoff.value = 0.5;
    spriteMaterial.uniforms.floorHeight.value = 0;
    const sprite = new THREE.Sprite(spriteMaterial);
    sprite.position.set(0, 3, -20);
    sprite.scale.set(8, 8, 1);
    depth.R_MarkWorldSprite(sprite);
    things.add(sprite);
    scene.add(things);
    scene.userData.doomSpriteDepthPass = depth.R_CreateSpriteDepthPass(
      things, spriteMaterial.uniforms.floorPass,
    );

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
    const samples = (layout) => ({
      // The lower half of the patch is authored below its y=0 support plane.
      overhang: read(layout, 480, 148),
      body: read(layout, 480, 220),
      // These two surfaces are physically nearer than the actor.
      behindRaisedFloor: read(layout, 430, 148),
      behindWall: read(layout, 525, 190),
    });

    const hardwareDepth = samples(video.I_RenderView(scene, camera));
    support.material = skyMaterials.floorOccluder;
    const analyticalDepth = samples(video.I_RenderView(scene, camera));

    const disposalEvents = new Array(skyMaterialList.length).fill(0);
    skyMaterialList.forEach((material, index) => {
      material.addEventListener('dispose', () => disposalEvents[index]++);
    });
    const shutdownMaterials = sky.R_ShutdownSky();
    const lifecycle = {
      returnedCount: shutdownMaterials.length,
      returnedAllBuilt: shutdownMaterials.every((material) =>
        skyMaterialList.includes(material)),
      uniqueReturned: new Set(shutdownMaterials).size,
      disposalEvents,
    };

    supportGeometry.dispose();
    raisedGeometry.dispose();
    raisedMaterial.dispose();
    wallGeometry.dispose();
    wallMaterial.dispose();
    spriteMaterial.dispose();
    spriteTexture.dispose();
    return {
      materialContract,
      hardwareDepth,
      analyticalDepth,
      lifecycle,
      deviceScaleFactor: dpr,
      glError: gl.getError(),
      expectedGlError: gl.NO_ERROR,
      expectedFloorSide: THREE.FrontSide,
      expectedCeilingSide: THREE.DoubleSide,
    };
  });

  assert(pageErrors.length === 0, `page errors: ${pageErrors.join('; ')}`);
  assert(result.deviceScaleFactor === 2,
    `DPR-2 coverage did not run: ${JSON.stringify(result)}`);
  const contract = result.materialContract;
  assert(contract.uniqueMaterials === 4 && contract.floorIsAnalytical &&
         contract.floorSide === result.expectedFloorSide &&
         contract.ceilingIsHardware &&
         contract.ceilingSide === result.expectedCeilingSide &&
         contract.floorDepthFunc === contract.expectedDepthFunc &&
         contract.ceilingDepthFunc === contract.expectedDepthFunc &&
         contract.floorColorWrite === false && contract.ceilingColorWrite === false &&
         contract.floorDepthTest === true && contract.ceilingDepthTest === true &&
         contract.floorDepthWrite === true && contract.ceilingDepthWrite === true,
  `sky material split is incorrect: ${JSON.stringify(result)}`);
  assert(!same(result.hardwareDepth.overhang, result.hardwareDepth.body),
    `hardware-depth control did not clip the overhang: ${JSON.stringify(result)}`);
  assert(same(result.analyticalDepth.overhang, result.analyticalDepth.body),
    `analytical sky-floor depth did not restore the overhang: ${JSON.stringify(result)}`);
  assert(same(result.analyticalDepth.body, result.hardwareDepth.body),
    `sky-floor depth changed the ordinary sprite body: ${JSON.stringify(result)}`);
  assert(same(result.analyticalDepth.behindRaisedFloor,
              result.hardwareDepth.behindRaisedFloor) &&
         same(result.analyticalDepth.behindRaisedFloor, [0, 255, 0, 255]),
  `nearer raised floor stopped occluding: ${JSON.stringify(result)}`);
  assert(same(result.hardwareDepth.behindWall, [0, 0, 255, 255]) &&
         same(result.analyticalDepth.behindWall,
              result.hardwareDepth.behindWall),
  `nearer wall stopped occluding: ${JSON.stringify(result)}`);
  assert(result.lifecycle.returnedCount === 4 &&
         result.lifecycle.uniqueReturned === 4 &&
         result.lifecycle.returnedAllBuilt &&
         result.lifecycle.disposalEvents.every((count) => count === 1),
  `sky lifecycle did not dispose four materials: ${JSON.stringify(result)}`);
  assert(result.glError === result.expectedGlError,
    `WebGL error after sky-floor support render: ${result.glError}`);

  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
