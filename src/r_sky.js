// Ported from: linuxdoom-1.10/r_sky.c
// Sky texture rendering. We wrap the sky lump (SKY1 / SKY2 / SKY3) as a giant
// inside-out cylinder centred on the camera.

import * as THREE from 'three';
import { gamemode, gameepisode, gamemap } from './doomstat.js';
import { GameMode_t } from './doomdef.js';
import { R_CheckTextureNumForName, R_GetWallTexture } from './r_data.js';
import { R_MakeDoomMaterial } from './r_shader.js';
import { camera } from './i_video.js';

export let skytexture = -1;
export let skytexturemid = 0;

let _skyMesh = null;

// Mirrors g_game.c:454-468 (called from G_DoLoadLevel). Picks the sky texture
// by gamemap (commercial) or gameepisode (retail / registered / shareware).
export function R_InitSkyMap() {
  let name;
  if (gamemode === GameMode_t.commercial) {
    if (gamemap < 12)      name = 'SKY1';
    else if (gamemap < 21) name = 'SKY2';
    else                   name = 'SKY3';
  } else {
    if      (gameepisode === 1) name = 'SKY1';
    else if (gameepisode === 2) name = 'SKY2';
    else if (gameepisode === 3) name = 'SKY3';
    else                        name = 'SKY4';
  }
  skytexture = R_CheckTextureNumForName(name);
  skytexturemid = 100 << 16;
}

export function R_BuildSky(scene) {
  R_InitSkyMap();
  if (skytexture < 0) return null;
  const baseMap = R_GetWallTexture(skytexture);
  if (baseMap === null) return null;
  // Clone so the sky's wrapT override doesn't bleed into walls that share
  // the SKY1 lump (our wall path uses wrapT=RepeatWrapping). The clone is a
  // separate Texture instance with its own GPU upload; the indexed RG8
  // image data is shared by reference.
  const map = baseMap.clone();
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  map.needsUpdate = true;
  // Inside-out sphere. Large enough to enclose any reasonable map; pinned to
  // the camera so it's effectively infinite-distance.
  const radius = 4000;
  const geom = new THREE.SphereGeometry(radius, 32, 16);
  // Bake the sky UV transform into the geometry — our shader does not honour
  // texture.repeat/offset (those only apply to materials that read
  // texture.matrix). Doom sky lump: row 0 = zenith, row 127 = horizon.
  // SphereGeometry UV: V=1 at +Y (top), V=0.5 at equator, V=0 at -Y (bottom).
  // Mapping: image_v = 2*(1 - V). With wrapT=ClampToEdge, image_v > 1 is
  // pinned to the horizon row — so the lower half of the sphere shows the
  // horizon line repeated (matches vanilla, which never lets you see "under"
  // the sky band).
  const uvAttr = geom.getAttribute('uv');
  const uvArr = uvAttr.array;
  for (let i = 0; i < uvArr.length; i += 2) {
    uvArr[i + 1] = 2 - 2 * uvArr[i + 1];
  }
  uvAttr.needsUpdate = true;
  // r_plane.c:396-405 — sky is drawn full bright, no colormap shading.
  // Route through the Doom palette shader with fixedColormap=0 so palette
  // indices resolve correctly (the indexed RG8 texture is meaningless when
  // sampled as raw colour by MeshBasicMaterial).
  const mat = R_MakeDoomMaterial(map, {
    side: THREE.BackSide,
    fixedColormap: 0,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geom, mat);
  mesh.frustumCulled = false;
  mesh.renderOrder = -1;
  scene.add(mesh);
  _skyMesh = mesh;
  return mesh;
}

// Pin the sky to the camera so it never "approaches" — vanilla treats sky as
// infinitely distant.
export function R_UpdateSky() {
  if (_skyMesh === null) return;
  _skyMesh.position.copy(camera.position);
}
