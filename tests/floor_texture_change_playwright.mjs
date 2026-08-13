import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const options = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  options.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
}

let browser;
try {
  browser = await chromium.launch(options);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8134/');
  url.searchParams.set('-map', 'E1M3');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer?.info.render.frame > 2,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const data = await import('/src/r_data.js');
    const doomstat = await import('/src/doomstat.js');
    const loop = await import('/src/d_loop.js');
    const plats = await import('/src/p_plats.js');
    const planeRenderer = await import('/src/r_plane.js');
    const setup = await import('/src/p_setup.js');
    loop.D_DoomRafLoop.stop();

    const line = setup.lines.find((candidate) =>
      candidate.special === 20 && candidate.tag === 27);
    const target = setup.sectors.find((sector) => sector.tag === line.tag);
    const floorGroup = window.scene.getObjectByName('floors');
    const meshes = floorGroup.children.filter((mesh) =>
      mesh.userData.doomSector === target &&
      mesh.userData.doomPlaneKind === 'floor');
    const before = {
      flat: target.floorpic,
      maps: meshes.map((mesh) => mesh.material.uniforms.map.value.uuid),
    };

    const activated = plats.EV_DoPlat(line, plats.raiseToNearestAndChange, 0);
    const expectedTexture = data.R_GetFlatTexture(target.floorpic);
    const after = {
      flat: target.floorpic,
      maps: meshes.map((mesh) => mesh.material.uniforms.map.value.uuid),
      expectedMap: expectedTexture.uuid,
    };

    // Also prove that moving the mesh between animation registries prevents a
    // later update for its old animated flat from overwriting the new map.
    const oldAnimated = data.R_FlatNumForName('NUKAGE1');
    const staticFlat = data.R_FlatNumForName('FLOOR0_1');
    const registryProbe = {
      material: { uniforms: { map: { value: data.R_GetFlatTexture(oldAnimated) } } },
    };
    data.R_RegisterFlatMesh(oldAnimated, registryProbe);
    const rebound = data.R_RebindFlatMesh(registryProbe, oldAnimated, staticFlat);
    const reboundMap = registryProbe.material.uniforms.map.value.uuid;
    data.R_AnimateTextures(8);
    const animatedMap = registryProbe.material.uniforms.map.value.uuid;

    // A runtime flat-to-sky change must gain the paired physical-depth pass,
    // and changing back must remove it before normal flat rendering resumes.
    const changedFlat = target.floorpic;
    target.floorpic = doomstat.skyflatnum;
    planeRenderer.R_UpdateSectorPlanes(target);
    const skyRebind = {
      portal: meshes[0].userData.doomSkyPortal,
      occluders: meshes[0].children.filter((child) =>
        child.userData.doomSkyDepthOccluder === true &&
        child.geometry === meshes[0].geometry
      ).length,
    };
    target.floorpic = changedFlat;
    planeRenderer.R_UpdateSectorPlanes(target);
    const flatRebind = {
      portal: meshes[0].userData.doomSkyPortal,
      occluders: meshes[0].children.filter((child) =>
        child.userData.doomSkyDepthOccluder === true
      ).length,
      map: meshes[0].material.uniforms.map.value.uuid,
      expectedMap: data.R_GetFlatTexture(changedFlat).uuid,
    };

    return {
      activated,
      meshCount: meshes.length,
      before,
      after,
      rebound,
      registryStayedRebound: reboundMap === animatedMap,
      skyRebind,
      flatRebind,
    };
  });

  const everyMapChanged = result.before.maps.every((uuid, index) =>
    uuid !== result.after.maps[index]);
  const everyMapMatches = result.after.maps.every((uuid) =>
    uuid === result.after.expectedMap);
  if (result.activated !== 1 || result.meshCount !== 1 ||
      result.before.flat === result.after.flat || everyMapChanged !== true ||
      everyMapMatches !== true || result.rebound !== true ||
      result.registryStayedRebound !== true ||
      result.skyRebind.portal !== true || result.skyRebind.occluders !== 1 ||
      result.flatRebind.portal !== false || result.flatRebind.occluders !== 0 ||
      result.flatRebind.map !== result.flatRebind.expectedMap) {
    throw new Error(`runtime floor texture mismatch: ${JSON.stringify(result)}`);
  }
  if (errors.length !== 0) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log(JSON.stringify(result));
} finally {
  if (browser !== undefined) await browser.close();
}
