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
  console.error('runtime wall texture period Playwright test exceeded 60 seconds');
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
    window.renderer?.info.render.frame > 2,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const data = await import('/src/r_data.js');
    const loop = await import('/src/d_loop.js');
    const segs = await import('/src/r_segs.js');
    const setup = await import('/src/p_setup.js');
    const switches = await import('/src/p_switch.js');
    loop.D_DoomRafLoop.stop();

    // Find two adjacent real IWAD textures with different native column-mask
    // periods, then register a lightweight retained-wall probe as a two-frame
    // animation. R_AnimateTextures must update both its map and U scale.
    let pair = null;
    for (let start = 0; start + 1 < data.textures.length; start++) {
      const firstPeriod = data.texturewidthmask[start] + 1;
      const secondPeriod = data.texturewidthmask[start + 1] + 1;
      if (firstPeriod !== secondPeriod) {
        pair = {
          start,
          end: start + 1,
          startName: data.textures[start].name,
          endName: data.textures[start + 1].name,
          startPeriod: firstPeriod,
          endPeriod: secondPeriod,
        };
        break;
      }
    }
    if (pair === null) throw new Error('IWAD has no adjacent mixed-period textures');

    const animationProbe = {
      material: {
        uniforms: {
          map: { value: data.R_GetWallTexture(pair.start) },
          wallTextureUScale: { value: -1 },
        },
      },
      userData: {},
      geometry: { sentinel: 'animation geometry' },
    };
    const animationGeometry = animationProbe.geometry;
    data.R_RegisterWallMesh(pair.start, animationProbe);
    data.R_AddAnim(true, pair.startName, pair.endName, 8);

    // p_spec.c's phase includes the source texture index. Pick the tic bucket
    // that maps the first frame to the second, then the bucket that maps back.
    const targetT = pair.start % 2 === 0 ? 1 : 0;
    data.R_AnimateTextures(targetT * 8);
    const animated = {
      mapMatches: animationProbe.material.uniforms.map.value ===
        data.R_GetWallTexture(pair.end),
      scale: animationProbe.material.uniforms.wallTextureUScale.value,
      geometryUnchanged: animationProbe.geometry === animationGeometry,
    };
    const baseT = pair.start % 2;
    data.R_AnimateTextures(baseT * 8);
    const animationReset = {
      mapMatches: animationProbe.material.uniforms.map.value ===
        data.R_GetWallTexture(pair.start),
      scale: animationProbe.material.uniforms.wallTextureUScale.value,
      geometryUnchanged: animationProbe.geometry === animationGeometry,
    };

    // Exercise an actual private switch-wall bucket from E1M1. Use the mixed-
    // period animation source as its temporary target so the test does not
    // depend on stock switch pairs happening to have different dimensions.
    const wallGroup = window.scene.getObjectByName('walls');
    const wallMeshes = wallGroup.children.filter((mesh) =>
      mesh.material?.uniforms?.map !== undefined);
    let switchResult = null;
    for (const line of setup.lines) {
      const side = setup.sides[line.sidenum[0]];
      if (side === undefined) continue;
      const slots = [
        [switches.top, side.toptexture],
        [switches.middle, side.midtexture],
        [switches.bottom, side.bottomtexture],
      ];
      for (const [slot, source] of slots) {
        if (!switches.P_IsSwitchTexture(source)) continue;
        const sourcePeriod = data.texturewidthmask[source] + 1;
        const target = pair.startPeriod === sourcePeriod ? pair.end : pair.start;
        const targetPeriod = data.texturewidthmask[target] + 1;
        if (targetPeriod === sourcePeriod) continue;

        const beforeMaps = wallMeshes.map((mesh) =>
          mesh.material.uniforms.map.value);
        const beforeGeometry = wallMeshes.map((mesh) => mesh.geometry);
        segs.R_SetSwitchTexture(line, slot, target);
        const changed = [];
        for (let i = 0; i < wallMeshes.length; i++) {
          if (wallMeshes[i].material.uniforms.map.value !== beforeMaps[i]) changed.push(i);
        }
        if (changed.length === 0) continue;

        const changedMesh = wallMeshes[changed[0]];
        const changedIndex = changed[0];
        const targetMap = data.R_GetWallTexture(target);
        switchResult = {
          source,
          target,
          sourcePeriod,
          targetPeriod,
          changedCount: changed.length,
          mapMatches: changedMesh.material.uniforms.map.value === targetMap,
          scale: changedMesh.material.uniforms.wallTextureUScale.value,
          basePeriod: changedMesh.userData.doomWallBaseColumnPeriod,
          geometryUnchanged: changedMesh.geometry === beforeGeometry[changedIndex],
          shaderUsesScale: changedMesh.material.vertexShader.includes(
            'uv.x * wallTextureUScale'
          ),
        };
        window.renderer.render(window.scene, window.camera);
        segs.R_SetSwitchTexture(line, slot, source);
        switchResult.resetMapMatches =
          changedMesh.material.uniforms.map.value === beforeMaps[changedIndex];
        switchResult.resetScale =
          changedMesh.material.uniforms.wallTextureUScale.value;
        switchResult.resetGeometryUnchanged =
          changedMesh.geometry === beforeGeometry[changedIndex];
        break;
      }
      if (switchResult !== null) break;
    }

    return { pair, animated, animationReset, switchResult };
  });

  const failures = [];
  const expectedAnimationScale = result.pair.startPeriod / result.pair.endPeriod;
  if (result.animated.mapMatches !== true ||
      result.animated.scale !== expectedAnimationScale ||
      result.animated.geometryUnchanged !== true) {
    failures.push(`animation did not adopt frame period: ${JSON.stringify(result)}`);
  }
  if (result.animationReset.mapMatches !== true ||
      result.animationReset.scale !== 1 ||
      result.animationReset.geometryUnchanged !== true) {
    failures.push(`animation did not restore base period: ${JSON.stringify(result)}`);
  }
  if (result.switchResult === null) {
    failures.push('E1M1 did not expose a rendered switch-wall bucket');
  } else {
    const expectedSwitchScale = result.switchResult.sourcePeriod /
      result.switchResult.targetPeriod;
    if (result.switchResult.changedCount !== 1 ||
        result.switchResult.mapMatches !== true ||
        result.switchResult.scale !== expectedSwitchScale ||
        result.switchResult.basePeriod !== result.switchResult.sourcePeriod ||
        result.switchResult.geometryUnchanged !== true ||
        result.switchResult.shaderUsesScale !== true ||
        result.switchResult.resetMapMatches !== true ||
        result.switchResult.resetScale !== 1 ||
        result.switchResult.resetGeometryUnchanged !== true) {
      failures.push(`switch did not adopt frame period: ${JSON.stringify(result)}`);
    }
  }
  if (pageErrors.length !== 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (failures.length !== 0) throw new Error(failures.join('\n'));
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== null) await browser.close();
}
