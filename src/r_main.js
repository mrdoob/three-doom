// Ported from: linuxdoom-1.10/r_main.c
// View setup + R_RenderPlayerView. In the 3D port the camera matrix and
// scene are owned by i_video.js; R_RenderPlayerView only updates the camera
// to match the player and asks Three.js to render.

import * as THREE from 'three';
import { camera, renderer, scene, I_RenderView } from './i_video.js';
import { players, consoleplayer, viewangleoffset } from './doomstat.js';
import { ANG90 } from './tables.js';
import { R_BuildWalls, R_ShutdownWalls } from './r_segs.js';
import { R_BuildPlanes, R_ShutdownPlanes } from './r_plane.js';
import {
  R_BuildSpriteBillboards, R_PrecacheLevelSprites, R_SetSpriteTextureUploader,
  R_ShutdownThings, R_UpdateSprites, set_view as set_thing_view,
} from './r_things.js';
import { R_ClearMeshRegistry, R_PrecacheLevel } from './r_data.js';
import { R_PrecachePlayerSprites } from './r_psprite.js';
import { P_SwitchTexturePair } from './p_switch.js';
import { R_BuildSky, R_UpdateSky, R_ShutdownSky } from './r_sky.js';
import { R_PointInSubsector } from './r_bsp.js';
import { R_SetViewLighting } from './r_shader.js';
import { segs } from './p_setup.js';
import { ML_MAPPED } from './doomdata.js';
import { R_GetViewSize } from './r_view.js';
import { R_CreateSpriteDepthPass, spriteFloorPassUniform } from './r_sprite_depth.js';

let _levelRoot = null;

function disposeLevelRoot() {
  if (_levelRoot === null) {
    if (scene !== null) delete scene.userData.doomSpriteDepthPass;
    R_ShutdownSky();
    R_ShutdownThings();
    R_ShutdownWalls();
    R_ShutdownPlanes();
    R_ClearMeshRegistry();
    return 0;
  }
  const skyMaterials = R_ShutdownSky();
  if (scene !== null) {
    delete scene.userData.doomSpriteDepthPass;
    scene.remove(_levelRoot);
  }
  const disposedGeometries = new Set();
  const disposedMaterials = new Set();
  for (const material of skyMaterials) disposedMaterials.add(material);
  _levelRoot.traverse((o) => {
    if (o.geometry !== undefined && o.geometry !== null &&
        disposedGeometries.has(o.geometry) === false) {
      o.geometry.dispose();
      disposedGeometries.add(o.geometry);
    }
    if (o.material !== undefined && o.material !== null) {
      const materials = Array.isArray(o.material) ? o.material : [o.material];
      for (const material of materials) {
        if (disposedMaterials.has(material) === false) {
          material.dispose();
          disposedMaterials.add(material);
        }
      }
    }
  });
  _levelRoot.clear();
  _levelRoot = null;
  R_ShutdownThings();
  R_ShutdownWalls();
  R_ShutdownPlanes();
  R_ClearMeshRegistry();
  return disposedGeometries.size;
}

export function R_Shutdown() {
  return disposeLevelRoot();
}

// Called by g_game.js after P_SetupLevel.
export function R_NewMap() {
  if (_levelRoot !== null) {
    disposeLevelRoot();
  }
  const uploadTexture = renderer !== null && typeof renderer.initTexture === 'function'
    ? (texture) => renderer.initTexture(texture)
    : null;
  R_SetSpriteTextureUploader(uploadTexture);
  // This is the first point at which an optional save restore and corrupt-map
  // fallback have both completed. Warm the final world, thinker population,
  // and every weapon family before constructing anything the display loop can
  // visit. R_PrecacheLevel is idempotent after P_SetupLevel's native call.
  R_PrecacheLevel({ uploadTexture, switchTexturePair: P_SwitchTexturePair });
  R_PrecacheLevelSprites();
  R_PrecachePlayerSprites(players);

  _levelRoot = new THREE.Group();
  _levelRoot.name = 'level';
  scene.add(_levelRoot);
  const skyMaterials = R_BuildSky();
  R_BuildWalls(_levelRoot);
  R_BuildPlanes(_levelRoot, skyMaterials);
  const things = R_BuildSpriteBillboards(_levelRoot);
  scene.userData.doomSpriteDepthPass = R_CreateSpriteDepthPass(
    things, spriteFloorPassUniform,
  );
  // Bind each current billboard to an already-decoded texture, then upload
  // level-owned clones (notably the sky) and compile shader programs. Later
  // animation/rotation swaps therefore remain cache-only operations.
  R_UpdateSprites();
  if (uploadTexture !== null) {
    _levelRoot.traverse((object) => {
      if (object.material === undefined || object.material === null) return;
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) {
        const map = material.uniforms?.map?.value ?? material.map ?? null;
        if (map !== null && map !== undefined && map.isTexture === true) uploadTexture(map);
      }
    });
  }
  if (renderer !== null && typeof renderer.compile === 'function') renderer.compile(scene, camera);
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
  R_SetViewLighting(
    player.extralight,
    player.fixedcolormap,
    R_GetViewSize().scaledviewwidth,
  );
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

  // Fog-of-war for am_map: r_segs.c:398 sets ML_MAPPED on every linedef whose
  // seg is drawn during BSP traversal. The 3D port doesn't traverse, so as a
  // pragmatic approximation we mark the linedefs of the player's current
  // subsector each frame. The result is "rooms you've stood in" — coarser
  // than vanilla's frustum-cone but enough for the automap to hide unvisited
  // geometry instead of revealing the whole map.
  if (segs !== null) {
    const ss = R_PointInSubsector(mo.x, mo.y);
    if (ss !== undefined && ss !== null) {
      const first = ss.firstline;
      const n = ss.numlines;
      for (let i = 0; i < n; i++) {
        const sg = segs[first + i];
        if (sg !== undefined && sg.linedef !== null) {
          sg.linedef.flags |= ML_MAPPED;
        }
      }
    }
  }
}

// R_RenderPlayerView — sets up the camera, renders the scene.
export function R_RenderPlayerView(player) {
  R_SetupFrame(player);
  R_UpdateSky();
  I_RenderView(scene, camera);
}

export function R_Init() {
  // Geometry build happens lazily per-map in R_NewMap.
}
