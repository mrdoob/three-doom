// Ported from: linuxdoom-1.10/r_main.c
// View setup + R_RenderPlayerView. In the 3D port the camera matrix and
// scene are owned by i_video.js; R_RenderPlayerView only updates the camera
// to match the player and asks Three.js to render.

import * as THREE from 'three';
import { camera, scene, renderer } from './i_video.js';
import { players, consoleplayer, viewangleoffset } from './doomstat.js';
import { ANG90 } from './tables.js';
import { R_BuildWalls } from './r_segs.js';
import { R_BuildPlanes } from './r_plane.js';
import { R_BuildSpriteBillboards, R_ClearSpriteCache, set_view as set_thing_view } from './r_things.js';
import { R_BuildSky, R_UpdateSky } from './r_sky.js';

let _levelRoot = null;

// Called by g_game.js after P_SetupLevel.
export function R_NewMap() {
  if (_levelRoot !== null) {
    scene.remove(_levelRoot);
    _levelRoot.traverse((o) => {
      if (o.geometry !== undefined && o.geometry !== null) o.geometry.dispose();
      if (o.material !== undefined && o.material !== null) {
        // Skip o.material.map.dispose(): wall textures are shared via
        // r_data.js's composite cache and sprite textures via the sprite cache.
        // The cache owns the lifetime; disposing here would dangling-reference.
        o.material.dispose();
      }
    });
    // Sprite textures are cached per-lump in r_things.js. Clear so the next map
    // rebuilds them (they're keyed on lump index which spans the whole WAD).
    R_ClearSpriteCache();
  }
  _levelRoot = new THREE.Group();
  _levelRoot.name = 'level';
  scene.add(_levelRoot);
  R_BuildSky(_levelRoot);
  R_BuildWalls(_levelRoot);
  R_BuildPlanes(_levelRoot);
  R_BuildSpriteBillboards(_levelRoot);
  return _levelRoot;
}

// Convert Doom BAM angle (32-bit unsigned) to radians.
function bamToRad(bam) {
  return (bam >>> 0) / 0x100000000 * Math.PI * 2;
}

// Update Three.js camera from the player.
export function R_SetupFrame(player) {
  if (player === null || player.mo === null) return;
  const mo = player.mo;
  // Update view origin (used by sprite rotation pick in r_things.js).
  set_thing_view(mo.x, mo.y);
  // Doom -> Three.js: (mo.x, viewz, -mo.y). player.viewz is absolute world z.
  const x = mo.x / 65536;
  const y = mo.y / 65536;
  const z = player.viewz / 65536;
  camera.position.set(x, z, -y);
  // Doom BAM: angle 0 = east (+X), 90° = north (+Y). Three.js camera looks
  // down -Z at rotation 0; rotating around Y by -π/2 looks toward +X.
  const ang = bamToRad((mo.angle + viewangleoffset) >>> 0);
  camera.rotation.order = 'YXZ';
  camera.rotation.set(0, ang - Math.PI / 2, 0);
}

// R_RenderPlayerView — sets up the camera, renders the scene.
export function R_RenderPlayerView(player) {
  R_SetupFrame(player);
  R_UpdateSky();
  renderer.render(scene, camera);
}

export function R_Init() {
  // Geometry build happens lazily per-map in R_NewMap.
}
