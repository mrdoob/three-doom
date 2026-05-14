// Ported from: linuxdoom-1.10/r_sky.c
// Sky texture rendering. We wrap the sky lump (SKY1 / SKY2 / SKY3) as a giant
// inside-out cylinder centred on the camera.

import * as THREE from 'three';
import { gamemode, gameepisode, gamemap } from './doomstat.js';
import { GameMode_t } from './doomdef.js';
import { R_CheckTextureNumForName, R_GetWallTexture } from './r_data.js';
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
  // Clone so the sky-specific UV transform doesn't bleed into walls that
  // share the SKY1 lump.
  const map = baseMap.clone();
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.ClampToEdgeWrapping;
  // The Doom sky lump represents a band around the horizon — row 0 is the
  // top edge of "sky" (above horizon), row 127 is the horizon line itself.
  // SphereGeometry UV: V=1 at the top pole (+Y), V=0 at the bottom (-Y).
  // We want: V=1 → image row 0 (light sky), V=0.5 → image row 127 (horizon).
  // image_v = 2*(1 - V) = 2 - 2*V.  In texture matrix form: repeat=(1,-2),
  // offset=(0,2). wrapT=ClampToEdge holds row 127 across the lower half.
  map.repeat.set(1, -2);
  map.offset.set(0, 2);
  map.needsUpdate = true;
  // Inside-out sphere. Large enough to enclose any reasonable map; pinned to
  // the camera so it's effectively infinite-distance.
  const radius = 4000;
  const geom = new THREE.SphereGeometry(radius, 32, 16);
  const mat = new THREE.MeshBasicMaterial({ map, side: THREE.BackSide, depthWrite: false, fog: false });
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
