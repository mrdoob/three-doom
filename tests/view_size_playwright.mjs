// Real E1M1 integration coverage for the Three.js viewport and Canvas border.
// Run against a static server rooted at the repository; Chromium is headless.

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
  console.error('view-size Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
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
    const viewModule = await import('/src/r_view.js');
    const video = await import('/src/i_video.js');
    const border = await import('/src/r_border.js');
    const wad = await import('/src/w_wad.js');
    const paletteModule = await import('/src/v_palette.js');
    const wipe = await import('/src/f_wipe.js');
    const doomstat = await import('/src/doomstat.js');
    const THREE = await import('three');
    const shader = await import('/src/r_shader.js');
    const lightLogic = await import('/src/r_light_logic.js');
    const spriteLogic = await import('/src/r_sprite_logic.js');
    const psprite = await import('/src/r_psprite.js');
    const { FRACUNIT } = await import('/src/m_fixed.js');
    const sky = await import('/src/r_sky.js');
    const planeRenderer = await import('/src/r_plane.js');
    const rData = await import('/src/r_data.js');
    const pSetup = await import('/src/p_setup.js');
    const doomdata = await import('/src/doomdata.js');
    const info = await import('/src/info.js');
    const overlay = document.getElementById('overlay');
    const overlayCtx = overlay.getContext('2d');

    for (let i = 0; i < 100 && wipe.wipe_isActive(); i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }

    const samePixel = (a, b) => a.every((value, index) => value === b[index]);
    const readOverlayLogical = (x, y) =>
      [...overlayCtx.getImageData(x * 3 + 1, y * 3 + 1, 1, 1).data];
    const sampleWebgl = (layout) => {
      video.I_RenderView(window.scene, window.camera);
      const gl = window.renderer.getContext();
      const pixel = new Uint8Array(4);
      const read = (x, y) => {
        gl.readPixels(Math.floor(x), Math.floor(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        return [...pixel];
      };
      const clear = read(0, 0);
      const colors = new Set();
      let changedFromClear = 0;
      for (let iy = 1; iy <= 7; iy++) {
        for (let ix = 1; ix <= 7; ix++) {
          const x = layout.viewX + layout.viewWidth * ix / 8;
          const y = layout.webglViewY + layout.viewHeight * iy / 8;
          const p = read(x, y);
          colors.add(p.join(','));
          if (!samePixel(p, clear)) changedFromClear++;
        }
      }
      const outside = [];
      const midX = layout.viewX + layout.viewWidth * 0.5;
      const midY = layout.webglViewY + layout.viewHeight * 0.5;
      if (layout.viewX >= 1) outside.push(read(layout.viewX - 1, midY));
      if (layout.viewX + layout.viewWidth < layout.canvasWidth) {
        outside.push(read(layout.viewX + layout.viewWidth, midY));
      }
      if (layout.webglViewY >= 1) outside.push(read(midX, layout.webglViewY - 1));
      if (layout.webglViewY + layout.viewHeight < layout.canvasHeight) {
        outside.push(read(midX, layout.webglViewY + layout.viewHeight));
      }
      return {
        clear,
        changedFromClear,
        uniqueInsideColors: colors.size,
        outsideMatchesClear: outside.every((p) => samePixel(p, clear)),
        outsideSamples: outside.length,
      };
    };

    const frames = {};
    for (const blocks of [3, 9, 10, 11]) {
      const view = viewModule.R_SetViewSize(blocks);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const layout = viewModule.R_CalculateCanvasView(overlay.width, overlay.height, view);
      frames[blocks] = {
        view,
        layout,
        cameraAspect: window.camera.aspect,
        cameraFov: window.camera.fov,
        overlay: {
          border: readOverlayLogical(10, 80),
          center: readOverlayLogical(160, 80),
          status: readOverlayLogical(10, 180),
        },
        webgl: sampleWebgl(layout),
      };
    }

    // Draw only the real Doom border assets into a native-size scratch canvas
    // so individual logical pixels can be compared with FLOOR7_2/PLAYPAL.
    const scratch = document.createElement('canvas');
    scratch.width = 320;
    scratch.height = 200;
    const scratchCtx = scratch.getContext('2d');
    scratchCtx.imageSmoothingEnabled = false;
    const borderView = viewModule.R_CalculateViewSize(3);
    const borderLayout = viewModule.R_CalculateCanvasView(320, 200, borderView);
    border.R_DrawViewBorder(scratchCtx, borderLayout, borderView, doomstat.gamemode);
    const flat = wad.W_CacheLumpName('FLOOR7_2', 0);
    const palette = paletteModule.V_GetActivePalette();
    const flatIndex = flat[10 * 64 + 10];
    const expectedFlat = [...palette.subarray(flatIndex * 4, flatIndex * 4 + 4)];
    const scratchPixel = (x, y) =>
      [...scratchCtx.getImageData(x, y, 1, 1).data];
    const borderPixels = {
      background: scratchPixel(10, 10),
      expectedFlat,
      leftBevel: scratchPixel(111, 84),
      viewInterior: scratchPixel(112, 84),
    };

    // Use the real shared Doom shaders, COLORMAP, and PLAYPAL in controlled
    // scenes so each normal-light pixel can be compared with the same source
    // index forced through the independently calculated reference row.
    const colormaps = wad.W_CacheLumpName('COLORMAP', 0);
    const rowPixel = (source, row) => {
      const mapped = colormaps[row * 256 + source] * 4;
      return [...palette.subarray(mapped, mapped + 4)];
    };
    let sourceIndex = -1;
    for (let index = 0; index < 256; index++) {
      const distinct = new Set();
      for (let row = 0; row <= 7; row++) distinct.add(rowPixel(index, row).join(','));
      if (distinct.size === 8) {
        sourceIndex = index;
        break;
      }
    }
    if (sourceIndex < 0) throw new Error('no PLAYPAL index distinguishes COLORMAP rows 0 through 7');

    const testTexture = shader.R_MakeIndexedTexture(
      Uint8Array.of(sourceIndex),
      Uint8Array.of(255),
      1,
      1,
    );
    const geometry = new THREE.PlaneGeometry(100, 100);
    const positions = geometry.getAttribute('position');
    const colors = new Float32Array(positions.count * 3);
    colors.fill(8);
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const wallMaterial = shader.R_MakeDoomMaterial(testTexture);
    const planeMaterial = shader.R_MakeDoomMaterial(testTexture, { plane: true });
    const spriteMaterial = shader.R_MakeDoomSpriteMaterial(testTexture);
    spriteMaterial.uniforms.sectorLight.value = 8;
    const wallScene = new THREE.Scene();
    const planeScene = new THREE.Scene();
    const spriteScene = new THREE.Scene();
    const wallMesh = new THREE.Mesh(geometry, wallMaterial);
    const planeMesh = new THREE.Mesh(geometry, planeMaterial);
    wallMesh.position.z = -40;
    planeMesh.position.z = -40;
    wallScene.add(wallMesh);
    planeScene.add(planeMesh);
    const spriteObject = new THREE.Sprite(spriteMaterial);
    spriteObject.position.z = -40;
    spriteObject.scale.set(100, 100, 1);
    spriteScene.add(spriteObject);
    const testCamera = new THREE.PerspectiveCamera(60, 1, 1, 1000);
    const gl = window.renderer.getContext();
    const glPixel = new Uint8Array(4);
    const readGl = (x, y) => {
      gl.readPixels(Math.floor(x), Math.floor(y), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, glPixel);
      return [...glPixel];
    };
    const renderScenePixel = (testScene, blocks, fixedRow = null) => {
      const view = viewModule.R_SetViewSize(blocks);
      shader.R_SetViewLighting(0, 0, view.scaledviewwidth);
      shader.fixedColormapUniform.value = fixedRow === null ? -1 : fixedRow;
      const layout = video.I_RenderView(testScene, testCamera);
      return readGl(
        layout.viewX + layout.viewWidth * 0.5,
        layout.webglViewY + layout.viewHeight * 0.5,
      );
    };

    const shaderLighting = {};
    for (const blocks of [9, 11]) {
      const width = viewModule.R_CalculateViewSize(blocks).scaledviewwidth;
      const wallRow = lightLogic.R_WallLightRow(8, 0, 40, width);
      const planeRow = lightLogic.R_PlaneLightRow(8, 0, 40);
      shaderLighting[blocks] = {
        wallRow,
        wallNormal: renderScenePixel(wallScene, blocks),
        wallFixed: renderScenePixel(wallScene, blocks, wallRow),
        wallBelow: renderScenePixel(wallScene, blocks, wallRow - 1),
        wallAbove: renderScenePixel(wallScene, blocks, wallRow + 1),
        spriteNormal: renderScenePixel(spriteScene, blocks),
        spriteFixed: renderScenePixel(spriteScene, blocks, wallRow),
        spriteBelow: renderScenePixel(spriteScene, blocks, wallRow - 1),
        spriteAbove: renderScenePixel(spriteScene, blocks, wallRow + 1),
        planeRow,
        planeNormal: renderScenePixel(planeScene, blocks),
        planeFixed: renderScenePixel(planeScene, blocks, planeRow),
        planeBelow: renderScenePixel(planeScene, blocks, planeRow - 1),
        planeAbove: renderScenePixel(planeScene, blocks, planeRow + 1),
      };
    }
    shaderLighting[9].legacyFullRow = renderScenePixel(wallScene, 9, 5);

    // Canvas psprites select the same width-specific last scalelight entry.
    const pspriteSource = {
      indices: Uint8Array.of(sourceIndex),
      alphas: Uint8Array.of(255),
      w: 1,
      h: 1,
      leftoffset: 0,
      topoffset: 0,
      canvases: new Map(),
    };
    const pspriteLighting = {};
    for (const blocks of [9, 11]) {
      const width = viewModule.R_CalculateViewSize(blocks).scaledviewwidth;
      const row = spriteLogic.R_PspriteColormapRow(false, 0, 0, 128, 0, width);
      const info = psprite.R_CreatePspriteCanvasInfo(pspriteSource, row, colormaps);
      pspriteLighting[blocks] = {
        row,
        pixel: [...info.canvas.getContext('2d').getImageData(0, 0, 1, 1).data],
        expectedIndex: colormaps[row * 256 + sourceIndex],
        expectedPixel: [...palette.subarray(
          colormaps[row * 256 + sourceIndex] * 4,
          colormaps[row * 256 + sourceIndex] * 4 + 4,
        )],
      };
    }

    // Exercise the actual R_DrawPlayerSprites call site with one live E1M1
    // weapon state at the source WEAPONTOP position. During startup the live
    // S_PISTOLUP sy moves from WEAPONBOTTOM to WEAPONTOP over several tics;
    // copying that transient coordinate can leave the patch correctly clipped
    // below b9 (or even b11) depending on headless frame timing. Canonical
    // ready coordinates keep this check focused on width-specific lighting.
    const player = doomstat.players[doomstat.consoleplayer];
    const livePsp = player.psprites.find((candidate) =>
      candidate?.state !== null && candidate?.state !== undefined &&
      candidate.state !== -1 && candidate.state !== 0 &&
      (info.states[candidate.state]?.frame & 0x8000) === 0
    );
    if (livePsp === undefined) throw new Error('E1M1 has no active non-fullbright weapon psprite');
    const pspriteFixture = {
      mo: { subsector: { sector: { lightlevel: 128 } } },
      powers: new Array(6).fill(0),
      psprites: [{ state: livePsp.state, sx: FRACUNIT, sy: 32 * FRACUNIT }],
      fixedcolormap: 0,
      extralight: 0,
    };
    const renderActualPsprite = (blocks, fixedcolormap) => {
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 200;
      pspriteFixture.fixedcolormap = fixedcolormap;
      psprite.R_DrawPlayerSprites(
        canvas.getContext('2d'),
        pspriteFixture,
        0, 0, 320, 200,
        viewModule.R_CalculateViewSize(blocks),
      );
      return canvas.getContext('2d').getImageData(0, 0, 320, 200).data;
    };
    const differingBytes = (a, b) => {
      let count = 0;
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
      return count;
    };
    const opaquePixels = (data) => {
      let count = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) count++;
      return count;
    };
    const actualB9 = renderActualPsprite(9, 0);
    const forcedB9 = renderActualPsprite(9, 2);
    const legacyB9 = renderActualPsprite(9, 5);
    const actualB11 = renderActualPsprite(11, 0);
    const forcedB11 = renderActualPsprite(11, 5);
    const reducedB11 = renderActualPsprite(11, 2);
    const pspriteDrawWiring = {
      state: livePsp.state,
      b9OpaquePixels: opaquePixels(actualB9),
      b9ExpectedDiffs: differingBytes(actualB9, forcedB9),
      b9LegacyDiffs: differingBytes(actualB9, legacyB9),
      b11OpaquePixels: opaquePixels(actualB11),
      b11ExpectedDiffs: differingBytes(actualB11, forcedB11),
      b11ReducedDiffs: differingBytes(actualB11, reducedB11),
    };

    // Reuse E1M1's real sky material on a controlled camera-facing portal,
    // replace only its cloned indexed map with a deterministic per-row
    // pattern, and compare reduced-view pixels against the corresponding
    // source rows from the same GL shader. The production level must contain
    // only bounded portal meshes, never an unmasked fullscreen sky object.
    let skyMesh = null;
    let skyPortalCount = 0;
    let skyDepthOccluder = null;
    let skyDepthOccluderCount = 0;
    let invalidSkyDepthOccluderCount = 0;
    let unmaskedSkyMeshCount = 0;
    let wrongSideSkyMeshCount = 0;
    window.scene.traverse((object) => {
      if (object.userData.doomSkyDepthOccluder === true) {
        skyDepthOccluder ??= object;
        skyDepthOccluderCount++;
        if (object.material.colorWrite !== false || object.material.depthTest !== true ||
            object.material.depthWrite !== true ||
            object.material.depthFunc !== THREE.LessEqualDepth ||
            object.renderOrder >= 0 ||
            object.parent?.userData.doomSkyPortal !== true ||
            object.geometry !== object.parent.geometry ||
            object.renderOrder <= object.parent.renderOrder) {
          invalidSkyDepthOccluderCount++;
        }
      }
      if (object.material?.uniforms?.skyViewHeight === undefined) return;
      if (skyMesh === null) skyMesh = object;
      if (object.userData.doomSkyPortal === true) skyPortalCount++;
      else unmaskedSkyMeshCount++;
      const expectedSide = object.userData.doomPlaneKind === 'floor' ?
        THREE.FrontSide : THREE.DoubleSide;
      if (object.material.side !== expectedSide) wrongSideSkyMeshCount++;
    });
    if (skyMesh === null) throw new Error('E1M1 sky shader mesh is missing');
    if (skyDepthOccluder === null) throw new Error('E1M1 sky depth occluder is missing');
    let seamMesh = null;
    window.scene.traverse((object) => {
      if (object.userData.doomSkyPortalKind === 'ceiling-seams') seamMesh = object;
    });
    const seamLines = pSetup.lines.filter((line) =>
      (line.flags & doomdata.ML_TWOSIDED) !== 0 &&
      line.frontsector !== null && line.backsector !== null &&
      line.frontsector.ceilingpic === doomstat.skyflatnum &&
      line.backsector.ceilingpic === doomstat.skyflatnum
    );
    let skySeamUpdate = null;
    if (seamMesh !== null && seamLines.length > 0) {
      const line = seamLines[0];
      const originalBackHeight = line.backsector.ceilingheight;
      const originalFrontHeight = line.frontsector.ceilingheight;
      const seamPositions = seamMesh.geometry.attributes.position;
      const original = [0, 1, 2, 3].map((index) =>
        seamPositions.getY(index)
      );
      const raisedHeight = line.frontsector.ceilingheight + 64 * FRACUNIT;
      line.backsector.ceilingheight = raisedHeight;
      planeRenderer.R_UpdateSectorPlanes(line.backsector);
      const expanded = [0, 1, 2, 3].map((index) =>
        seamPositions.getY(index)
      );
      line.backsector.ceilingheight = line.frontsector.ceilingheight;
      planeRenderer.R_UpdateSectorPlanes(line.backsector);
      const collapsed = [0, 1, 2, 3].map((index) =>
        seamPositions.getY(index)
      );
      line.backsector.ceilingheight = originalBackHeight;
      planeRenderer.R_UpdateSectorPlanes(line.backsector);
      skySeamUpdate = {
        candidates: seamMesh.userData.doomSkySeamCandidates,
        active: seamMesh.userData.doomSkySeamCount,
        original,
        expectedOriginal: [
          Math.min(originalFrontHeight, originalBackHeight) / FRACUNIT,
          Math.min(originalFrontHeight, originalBackHeight) / FRACUNIT,
          Math.max(originalFrontHeight, originalBackHeight) / FRACUNIT,
          Math.max(originalFrontHeight, originalBackHeight) / FRACUNIT,
        ],
        expanded,
        expectedExpanded: [
          line.frontsector.ceilingheight / FRACUNIT,
          line.frontsector.ceilingheight / FRACUNIT,
          raisedHeight / FRACUNIT,
          raisedHeight / FRACUNIT,
        ],
        collapsed,
        expectedCollapsed: new Array(4).fill(
          line.frontsector.ceilingheight / FRACUNIT,
        ),
      };
    }
    const skyTestScene = new THREE.Scene();
    const skyTestGeometry = new THREE.PlaneGeometry(100, 100);
    const skyTestMesh = new THREE.Mesh(skyTestGeometry, skyMesh.material);
    skyTestMesh.position.z = -40;
    skyTestMesh.renderOrder = -Infinity;
    skyTestMesh.frustumCulled = false;
    skyTestScene.add(skyTestMesh);
    const skyMap = skyMesh.material.uniforms.map.value;
    const skyData = skyMap.image.data;
    const originalSkyData = skyData.slice();
    const skyWidth = skyMap.image.width;
    const skyHeight = skyMap.image.height;
    for (let y = 0; y < skyHeight; y++) {
      for (let x = 0; x < skyWidth; x++) {
        const offset = (y * skyWidth + x) * 2;
        skyData[offset] = (y * 37 + 13) & 255;
        skyData[offset + 1] = 255;
      }
    }
    skyMap.needsUpdate = true;
    const readSkyLocalRow = (layout, localY) => readGl(
      layout.viewX + layout.viewWidth * 0.5,
      layout.canvasHeight - layout.viewY - (localY + 0.5) * layout.scale,
    );

    const expectedSkyPixel = (textureRow) => {
      const wrapped = ((textureRow % skyHeight) + skyHeight) % skyHeight;
      const source = (wrapped * 37 + 13) & 255;
      return rowPixel(source, 0);
    };

    const skyProjection = {};
    for (const blocks of [3, 9, 10, 11]) {
      const view = viewModule.R_SetViewSize(blocks);
      sky.R_UpdateSky();
      const layout = video.I_RenderView(skyTestScene, testCamera);
      const referenceStep = Math.trunc(65536 * 320 / view.viewwidth) >> view.detailshift;
      const referenceRow = (y) => Math.floor(
        (100 * 65536 + (y - Math.trunc(view.viewheight / 2)) * referenceStep) / 65536,
      );
      const firstRow = referenceRow(0);
      const lastRow = referenceRow(view.viewheight - 1);
      let firstMismatch = null;
      let mismatchCount = 0;
      let topPixel = null;
      let bottomPixel = null;
      for (let y = 0; y < view.viewheight; y++) {
        const textureRow = referenceRow(y);
        const actual = readSkyLocalRow(layout, y);
        const expected = expectedSkyPixel(textureRow);
        if (y === 0) topPixel = actual;
        if (y === view.viewheight - 1) bottomPixel = actual;
        if (!samePixel(actual, expected)) {
          mismatchCount++;
          if (firstMismatch === null) firstMismatch = { y, textureRow, actual, expected };
        }
      }
      skyProjection[blocks] = {
        firstRow,
        lastRow,
        topPixel,
        expectedTopPixel: expectedSkyPixel(firstRow),
        bottomPixel,
        expectedBottomPixel: expectedSkyPixel(lastRow),
        mismatchCount,
        firstMismatch,
        uniformViewHeight: skyMesh.material.uniforms.skyViewHeight.value,
        uniformRowScale: skyMesh.material.uniforms.skyRowScale.value,
        expectedRowScale: referenceStep / 65536,
      };
    }
    skyProjection.fullRowZero = skyProjection[11].topPixel;

    const stockSkyUniforms = {
      textureWidth: skyMesh.material.uniforms.skyTexWidth.value,
      columnPeriod: skyMesh.material.uniforms.skyColumnPeriod.value,
      expectedTextureWidth: skyWidth,
      expectedColumnPeriod: rData.texturewidthmask[sky.skytexture] + 1,
    };
    let skyIndexA = 0;
    let skyIndexB = 1;
    while (skyIndexB < 256 && samePixel(rowPixel(skyIndexA, 0), rowPixel(skyIndexB, 0))) {
      skyIndexB++;
    }
    if (skyIndexB === 256) throw new Error('PLAYPAL has no distinct sky test colors');
    const wideIndices = new Uint8Array(512);
    wideIndices.fill(skyIndexA, 0, 256);
    wideIndices.fill(skyIndexB, 256);
    const wideAlphas = new Uint8Array(512);
    wideAlphas.fill(255);
    const wideSkyMap = shader.R_MakeIndexedTexture(wideIndices, wideAlphas, 512, 1);
    const skyUniforms = skyMesh.material.uniforms;
    const originalHfovHalfTan = skyUniforms.hfovHalfTan.value;
    const originalViewangle = skyUniforms.viewangle.value;
    skyUniforms.map.value = wideSkyMap;
    skyUniforms.skyTexWidth.value = 512;
    skyUniforms.skyColumnPeriod.value = 512;
    skyUniforms.skyTexHeight.value = 1;
    skyUniforms.hfovHalfTan.value = 0;
    const horizontalColumns = [32.5, 288.5, 544.5];
    const horizontalPixels = [];
    for (const column of horizontalColumns) {
      skyUniforms.viewangle.value = column * Math.PI * 2 / 1024;
      const layout = video.I_RenderView(skyTestScene, testCamera);
      horizontalPixels.push(readGl(
        layout.viewX + layout.viewWidth * 0.5,
        layout.webglViewY + layout.viewHeight * 0.5,
      ));
    }
    const skyWidthProjection = {
      stockSkyUniforms,
      columns: horizontalColumns,
      pixels: horizontalPixels,
      expected: [rowPixel(skyIndexA, 0), rowPixel(skyIndexB, 0), rowPixel(skyIndexA, 0)],
    };
    skyUniforms.map.value = skyMap;
    skyUniforms.skyTexWidth.value = skyWidth;
    skyUniforms.skyColumnPeriod.value = rData.texturewidthmask[sky.skytexture] + 1;
    skyUniforms.skyTexHeight.value = skyHeight;
    skyUniforms.hfovHalfTan.value = originalHfovHalfTan;
    skyUniforms.viewangle.value = originalViewangle;
    wideSkyMap.dispose();

    skyData.set(originalSkyData);
    skyMap.needsUpdate = true;
    skyTestGeometry.dispose();

    // A bounded portal occupies only the left side and the right side is void.
    // Its color pass stays at infinite depth, while a paired colorless physical
    // pass hides retained geometry behind the terminal sky. Moving the same
    // red surface physically in front must make it visible again.
    const portalTexture = shader.R_MakeIndexedTexture(
      Uint8Array.of(sourceIndex), Uint8Array.of(255), 1, 1,
    );
    const originalPortalUniforms = {
      map: skyUniforms.map.value,
      texWidth: skyUniforms.skyTexWidth.value,
      columnPeriod: skyUniforms.skyColumnPeriod.value,
      texHeight: skyUniforms.skyTexHeight.value,
      hfovHalfTan: skyUniforms.hfovHalfTan.value,
    };
    skyUniforms.map.value = portalTexture;
    skyUniforms.skyTexWidth.value = 1;
    skyUniforms.skyColumnPeriod.value = 1;
    skyUniforms.skyTexHeight.value = 1;
    skyUniforms.hfovHalfTan.value = 0;
    const portalScene = new THREE.Scene();
    const portalGeometry = new THREE.PlaneGeometry(4, 4);
    const portalMesh = new THREE.Mesh(portalGeometry, skyMesh.material);
    portalMesh.position.set(-2.5, 0, -5);
    portalMesh.renderOrder = skyMesh.renderOrder;
    portalScene.add(portalMesh);
    const portalOccluder = new THREE.Mesh(portalGeometry, skyDepthOccluder.material);
    portalOccluder.position.copy(portalMesh.position);
    portalOccluder.renderOrder = skyDepthOccluder.renderOrder;
    portalScene.add(portalOccluder);
    const redGeometry = new THREE.PlaneGeometry(1, 1);
    const redMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const redMesh = new THREE.Mesh(redGeometry, redMaterial);
    redMesh.position.set(-4, -1.6, -8);
    portalScene.add(redMesh);
    viewModule.R_SetViewSize(9);
    const portalLayout = video.I_RenderView(portalScene, testCamera);
    const portalRead = (localX, localY) => readGl(
      portalLayout.viewX + portalLayout.viewWidth * localX,
      portalLayout.webglViewY + portalLayout.viewHeight * localY,
    );
    const behind = portalRead(0.25, 0.3);
    redMesh.position.set(-2, -0.8, -4);
    const frontLayout = video.I_RenderView(portalScene, testCamera);
    const front = readGl(
      frontLayout.viewX + frontLayout.viewWidth * 0.25,
      frontLayout.webglViewY + frontLayout.viewHeight * 0.3,
    );
    const skyPortalMask = {
      productionPortalCount: skyPortalCount,
      depthOccluderCount: skyDepthOccluderCount,
      invalidDepthOccluderCount: invalidSkyDepthOccluderCount,
      unmaskedSkyMeshCount,
      wrongSideSkyMeshCount,
      seamUpdate: skySeamUpdate,
      depthTest: skyMesh.material.depthTest,
      depthFunc: skyMesh.material.depthFunc,
      expectedDepthFunc: THREE.LessEqualDepth,
      depthWrite: skyMesh.material.depthWrite,
      clear: readGl(0, 0),
      expectedViewClear: [...palette.subarray(0, 4)],
      sky: portalRead(0.25, 0.7),
      expectedSky: rowPixel(sourceIndex, 0),
      void: portalRead(0.75, 0.7),
      behind,
      front,
      glError: gl.getError(),
      expectedGlError: gl.NO_ERROR,
    };
    skyUniforms.map.value = originalPortalUniforms.map;
    skyUniforms.skyTexWidth.value = originalPortalUniforms.texWidth;
    skyUniforms.skyColumnPeriod.value = originalPortalUniforms.columnPeriod;
    skyUniforms.skyTexHeight.value = originalPortalUniforms.texHeight;
    skyUniforms.hfovHalfTan.value = originalPortalUniforms.hfovHalfTan;
    portalTexture.dispose();
    portalGeometry.dispose();
    redGeometry.dispose();
    redMaterial.dispose();
    geometry.dispose();
    wallMaterial.dispose();
    planeMaterial.dispose();
    spriteMaterial.dispose();
    testTexture.dispose();

    viewModule.R_SetViewSize(9);
    shader.R_SetViewLighting(
      player?.extralight ?? 0,
      player?.fixedcolormap ?? 0,
      288,
    );
    sky.R_UpdateSky();

    // A custom-map surface beyond the port's old 16,384-unit far plane must
    // remain visible. Render with a clone of the production camera so this
    // checks both its configured range and WebGL clipping behavior.
    const farScene = new THREE.Scene();
    const farCamera = window.camera.clone();
    farCamera.position.set(0, 0, 0);
    farCamera.rotation.set(0, 0, 0);
    const farGeometry = new THREE.PlaneGeometry(2000, 2000);
    const farMaterial = new THREE.MeshBasicMaterial({ color: 0xff0000 });
    const farMesh = new THREE.Mesh(farGeometry, farMaterial);
    farMesh.position.z = -120000;
    farScene.add(farMesh);
    const farLayout = video.I_RenderView(farScene, farCamera);
    const farPlane = {
      near: farCamera.near,
      far: farCamera.far,
      clear: readGl(0, 0),
      surface: readGl(
        farLayout.viewX + farLayout.viewWidth * 0.5,
        farLayout.webglViewY + farLayout.viewHeight * 0.5,
      ),
    };
    farGeometry.dispose();
    farMaterial.dispose();
    return {
      frames, borderPixels, sourceIndex, shaderLighting,
      pspriteLighting, pspriteDrawWiring, skyProjection, skyWidthProjection,
      skyPortalMask,
      farPlane,
    };
  });

  const failures = [];
  const pixelsEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const expectedLayouts = {
    3: [336, 180, 288, 144, 276],
    9: [48, 36, 864, 432, 132],
    10: [0, 0, 960, 504, 96],
    11: [0, 0, 960, 600, 0],
  };
  for (const blocks of [3, 9, 10, 11]) {
    const frame = result.frames[blocks];
    const actual = [frame.layout.viewX, frame.layout.viewY, frame.layout.viewWidth,
      frame.layout.viewHeight, frame.layout.webglViewY];
    if (JSON.stringify(actual) !== JSON.stringify(expectedLayouts[blocks])) {
      failures.push(`screenblocks ${blocks} viewport ${JSON.stringify(actual)}`);
    }
    const expectedAspect = frame.view.scaledviewwidth / frame.view.viewheight;
    if (Math.abs(frame.cameraAspect - expectedAspect) > 1e-12) {
      failures.push(`screenblocks ${blocks} camera aspect ${frame.cameraAspect}`);
    }
    const horizontal = 2 * Math.atan(
      Math.tan(frame.cameraFov * Math.PI / 360) * frame.cameraAspect,
    ) * 180 / Math.PI;
    if (Math.abs(horizontal - 90) > 1e-10) {
      failures.push(`screenblocks ${blocks} horizontal FOV ${horizontal}`);
    }
    if (frame.webgl.changedFromClear === 0 || frame.webgl.uniqueInsideColors < 2) {
      failures.push(`screenblocks ${blocks} rendered no varied E1M1 pixels`);
    }
    if (frame.webgl.outsideSamples > 0 && !frame.webgl.outsideMatchesClear) {
      failures.push(`screenblocks ${blocks} leaked WebGL pixels outside its scissor`);
    }
  }
  const skyWidthProjection = result.skyWidthProjection;
  if (skyWidthProjection.stockSkyUniforms.textureWidth !==
      skyWidthProjection.stockSkyUniforms.expectedTextureWidth ||
      skyWidthProjection.stockSkyUniforms.columnPeriod !==
      skyWidthProjection.stockSkyUniforms.expectedColumnPeriod ||
      !skyWidthProjection.pixels.every((pixel, index) =>
        pixelsEqual(pixel, skyWidthProjection.expected[index]))) {
    failures.push(`variable-width sky mismatch: ${JSON.stringify(skyWidthProjection)}`);
  }
  const skyPortalMask = result.skyPortalMask;
  if (skyPortalMask.productionPortalCount === 0 ||
      skyPortalMask.unmaskedSkyMeshCount !== 0 ||
      skyPortalMask.depthOccluderCount !== skyPortalMask.productionPortalCount ||
      skyPortalMask.invalidDepthOccluderCount !== 0 ||
      skyPortalMask.wrongSideSkyMeshCount !== 0 ||
      skyPortalMask.seamUpdate === null ||
      skyPortalMask.seamUpdate.candidates !== 16 ||
      skyPortalMask.seamUpdate.active !== 8 ||
      !pixelsEqual(skyPortalMask.seamUpdate.original,
        skyPortalMask.seamUpdate.expectedOriginal) ||
      !pixelsEqual(skyPortalMask.seamUpdate.expanded,
        skyPortalMask.seamUpdate.expectedExpanded) ||
      !pixelsEqual(skyPortalMask.seamUpdate.collapsed,
        skyPortalMask.seamUpdate.expectedCollapsed) ||
      skyPortalMask.depthTest !== true ||
      skyPortalMask.depthFunc !== skyPortalMask.expectedDepthFunc ||
      skyPortalMask.depthWrite !== false ||
      !pixelsEqual(skyPortalMask.clear, [0, 0, 0, 255]) ||
      !pixelsEqual(skyPortalMask.sky, skyPortalMask.expectedSky) ||
      !pixelsEqual(skyPortalMask.void, skyPortalMask.expectedViewClear) ||
      !pixelsEqual(skyPortalMask.behind, skyPortalMask.expectedSky) ||
      !pixelsEqual(skyPortalMask.front, [255, 0, 0, 255]) ||
      skyPortalMask.glError !== skyPortalMask.expectedGlError) {
    failures.push(`sky portal masking mismatch: ${JSON.stringify(skyPortalMask)}`);
  }
  if (result.farPlane.near !== 1 || result.farPlane.far !== 131072 ||
      result.farPlane.surface[0] < 200 ||
      result.farPlane.surface[0] <= result.farPlane.surface[1] ||
      result.farPlane.surface[0] <= result.farPlane.surface[2] ||
      pixelsEqual(result.farPlane.surface, result.farPlane.clear)) {
    failures.push(`far-plane clipping mismatch: ${JSON.stringify(result.farPlane)}`);
  }

  for (const blocks of [3, 9]) {
    const overlay = result.frames[blocks].overlay;
    if (overlay.border[3] !== 255) failures.push(`screenblocks ${blocks} border is transparent`);
    if (overlay.center[3] !== 0) failures.push(`screenblocks ${blocks} view center is covered by overlay`);
    if (overlay.status[3] !== 255) failures.push(`screenblocks ${blocks} status bar is missing`);
  }
  if (result.frames[10].overlay.border[3] !== 0) failures.push('screenblocks 10 drew a border');
  if (result.frames[10].overlay.status[3] !== 255) failures.push('screenblocks 10 hid the status bar');
  if (result.frames[11].overlay.status[3] !== 0) failures.push('screenblocks 11 drew the status bar');
  if (JSON.stringify(result.borderPixels.background) !== JSON.stringify(result.borderPixels.expectedFlat)) {
    failures.push(`FLOOR7_2 pixel mismatch: ${JSON.stringify(result.borderPixels)}`);
  }
  if (result.borderPixels.leftBevel[3] !== 255 || result.borderPixels.viewInterior[3] !== 0) {
    failures.push(`BRDR_L/view transparency mismatch: ${JSON.stringify(result.borderPixels)}`);
  }
  if (result.shaderLighting[9].wallRow !== 2 || result.shaderLighting[11].wallRow !== 5) {
    failures.push(`width-specific shader rows mismatch: ${JSON.stringify(result.shaderLighting)}`);
  }
  for (const blocks of [9, 11]) {
    const lighting = result.shaderLighting[blocks];
    if (!pixelsEqual(lighting.wallNormal, lighting.wallFixed)) {
      failures.push(`screenblocks ${blocks} wall shader selected wrong row: ${JSON.stringify(lighting)}`);
    }
    if (pixelsEqual(lighting.wallNormal, lighting.wallBelow) ||
        pixelsEqual(lighting.wallNormal, lighting.wallAbove)) {
      failures.push(`screenblocks ${blocks} wall shader row is ambiguous: ${JSON.stringify(lighting)}`);
    }
    if (!pixelsEqual(lighting.spriteNormal, lighting.spriteFixed)) {
      failures.push(`screenblocks ${blocks} sprite shader selected wrong row: ${JSON.stringify(lighting)}`);
    }
    if (pixelsEqual(lighting.spriteNormal, lighting.spriteBelow) ||
        pixelsEqual(lighting.spriteNormal, lighting.spriteAbove)) {
      failures.push(`screenblocks ${blocks} sprite shader row is ambiguous: ${JSON.stringify(lighting)}`);
    }
    if (!pixelsEqual(lighting.planeNormal, lighting.planeFixed)) {
      failures.push(`screenblocks ${blocks} plane shader selected wrong row: ${JSON.stringify(lighting)}`);
    }
    if (pixelsEqual(lighting.planeNormal, lighting.planeBelow) ||
        pixelsEqual(lighting.planeNormal, lighting.planeAbove)) {
      failures.push(`screenblocks ${blocks} plane shader row is ambiguous: ${JSON.stringify(lighting)}`);
    }
    const psp = result.pspriteLighting[blocks];
    if (!pixelsEqual(psp.pixel, psp.expectedPixel)) {
      failures.push(`screenblocks ${blocks} psprite Canvas selected wrong row: ${JSON.stringify(psp)}`);
    }
  }
  if (result.pspriteLighting[9].row !== 2 || result.pspriteLighting[11].row !== 5) {
    failures.push(`width-specific psprite rows mismatch: ${JSON.stringify(result.pspriteLighting)}`);
  }
  if (result.pspriteDrawWiring.b9OpaquePixels === 0 ||
      result.pspriteDrawWiring.b11OpaquePixels === 0 ||
      result.pspriteDrawWiring.b9ExpectedDiffs !== 0 ||
      result.pspriteDrawWiring.b11ExpectedDiffs !== 0 ||
      result.pspriteDrawWiring.b9LegacyDiffs === 0 ||
      result.pspriteDrawWiring.b11ReducedDiffs === 0) {
    failures.push(`R_DrawPlayerSprites width wiring mismatch: ${JSON.stringify(result.pspriteDrawWiring)}`);
  }
  if (result.shaderLighting[9].planeRow !== result.shaderLighting[11].planeRow ||
      !pixelsEqual(result.shaderLighting[9].planeNormal, result.shaderLighting[11].planeNormal)) {
    failures.push(`plane zlight changed with view size: ${JSON.stringify(result.shaderLighting)}`);
  }
  if (pixelsEqual(result.shaderLighting[9].wallFixed, result.shaderLighting[9].legacyFullRow)) {
    failures.push('headless wall source index did not distinguish reduced row 2 from legacy row 5');
  }

  const expectedSkyRows = {
    3: [20, 176],
    9: [20, 178],
    10: [16, 183],
    11: [0, 199],
  };
  for (const blocks of [3, 9, 10, 11]) {
    const projected = result.skyProjection[blocks];
    if (JSON.stringify([projected.firstRow, projected.lastRow]) !==
        JSON.stringify(expectedSkyRows[blocks])) {
      failures.push(`screenblocks ${blocks} sky rows ${JSON.stringify(projected)}`);
    }
    if (!pixelsEqual(projected.topPixel, projected.expectedTopPixel) ||
        !pixelsEqual(projected.bottomPixel, projected.expectedBottomPixel)) {
      failures.push(`screenblocks ${blocks} sky shader sampled wrong rows: ${JSON.stringify(projected)}`);
    }
    if (projected.mismatchCount !== 0) {
      failures.push(`screenblocks ${blocks} sky shader row coverage mismatch: ${JSON.stringify(projected)}`);
    }
    if (projected.uniformViewHeight !== result.frames[blocks].view.viewheight ||
        Math.abs(projected.uniformRowScale - projected.expectedRowScale) > 1e-12) {
      failures.push(`screenblocks ${blocks} sky uniforms mismatch: ${JSON.stringify(projected)}`);
    }
  }
  if (pixelsEqual(result.skyProjection[9].topPixel, result.skyProjection.fullRowZero)) {
    failures.push('screenblocks 9 sky still starts from full-view source row 0');
  }
  if (pageErrors.length !== 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (failures.length !== 0) throw new Error(failures.join('\n'));
  console.log(JSON.stringify(result));
} finally {
  if (browser !== null) await browser.close();
  clearTimeout(watchdog);
}
