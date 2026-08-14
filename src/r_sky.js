// Ported from: linuxdoom-1.10/r_sky.c + r_plane.c:395-419
//
// Vanilla draws the sky column-by-column into the screen buffer:
//   angle = (viewangle + xtoviewangle[x]) >> ANGLETOSKYSHIFT
//   dc_source = R_GetColumn(skytexture, angle)
//   dc_colormap = colormaps          // fullbright
//   dc_texturemid = 100*FRACUNIT
//   dc_iscale = pspriteiscale>>detailshift
// The sky is therefore a 2D overlay anchored to viewangle (slides
// horizontally) with a fixed vertical anchor at row 100 — it does NOT live
// in 3D space.
//
// We reproduce the sampling with a screen-space shader, but apply it only to
// the real subsector floor/ceiling polygons and sky-to-sky height seams built
// by r_plane.js. Their world-space footprints are projected at infinite
// depth, so closed ceilings and map voids cannot expose a global backdrop.

import * as THREE from 'three';
import { gamemode, gameepisode, gamemap } from './doomstat.js';
import { GameMode_t } from './doomdef.js';
import {
  R_CheckTextureNumForName, R_GetWallTexture, texturewidthmask,
} from './r_data.js';
import {
  paletteIndexCaptureUniform,
  R_GetColormapTexture,
  R_GetPaletteTexture,
  R_MakeSupportPlaneDepthMaterial,
} from './r_shader.js';
import { camera } from './i_video.js';
import { R_GetViewSize } from './r_view.js';
import { R_SkyRowStep, SKY_TEXTUREMID } from './r_sky_logic.js';
import { FRACUNIT } from './m_fixed.js';

export let skytexture = -1;
export let skytexturemid = 0;

let _skyMat = null;
let _skyFloorMat = null;
let _skyDepthMat = null;
let _skyFloorDepthMat = null;
// The cloned sky texture from R_GetWallTexture — held so the next R_BuildSky
// can dispose it. R_NewMap's _levelRoot teardown skips material.map.dispose()
// (wall textures are cache-owned), but this clone is owned solely by the sky,
// so without an explicit dispose it leaks one GPU texture per level load.
let _skyMap = null;
// Cache for R_UpdateSky's per-frame trig: hfovHalfTan only changes when
// camera.fov or camera.aspect change (resize / FOV slider).
let _cachedFov    = -1;
let _cachedAspect = -1;
let _hfovHalfTan  = 1;

// Clear every sky-owned GPU resource and all derived projection state.
// R_ShutdownSky owns disposal; R_BuildSky refuses to replace resources that
// may still be attached to r_main's retained level root.
function disposeAndResetSky() {
  const disposedMaterials = [
    _skyMat, _skyFloorMat, _skyDepthMat, _skyFloorDepthMat,
  ].filter((material) => material !== null);
  for (const material of disposedMaterials) material.dispose();
  if (_skyMap !== null) _skyMap.dispose();
  _skyMat = null;
  _skyFloorMat = null;
  _skyDepthMat = null;
  _skyFloorDepthMat = null;
  _skyMap = null;
  _cachedFov = -1;
  _cachedAspect = -1;
  _hfovHalfTan = 1;
  skytexture = -1;
  skytexturemid = 0;
  return disposedMaterials;
}

function hasActiveSkyResources() {
  return _skyMat !== null || _skyFloorMat !== null ||
    _skyDepthMat !== null || _skyFloorDepthMat !== null || _skyMap !== null;
}

export function R_ShutdownSky() {
  // r_main uses the returned identities to avoid disposing these materials a
  // second time while traversing the old level root.
  return disposeAndResetSky();
}

// Mirrors g_game.c:454-468.
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
  skytexturemid = SKY_TEXTUREMID;
}

// Vertex shader: project the portal geometry normally, while retaining its
// clip-space position so the fragment shader can recover screen coordinates.
// Passing the full clip vector (rather than pre-divided NDC) preserves linear
// screen coordinates under perspective-correct varying interpolation.
const SKY_VERT = /* glsl */ `
varying vec4 vClipPosition;
void main() {
  vClipPosition = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  // Keep only the portal's projected footprint. Its depth is forced to the
  // far plane, because Doom's sky visplane has no world-space height.
  gl_Position = vec4(vClipPosition.xy, vClipPosition.w, vClipPosition.w);
}
`;

// Fragment shader: replicates vanilla's sky column/row math.
const SKY_FRAG = /* glsl */ `
precision highp float;

uniform sampler2D map;          // RG8 indexed sky (R=palette index)
uniform sampler2D palette;      // 256×1 RGBA
uniform sampler2D colormap;     // 256×34 R8
uniform float viewangle;        // radians (Doom convention: 0 = +X, increases CCW)
uniform float hfovHalfTan;      // tan(horizontal FOV / 2) — = tan(vfov/2)*aspect
uniform float skyTexWidth;      // physical composite width in pixels
uniform float skyColumnPeriod;  // texturewidthmask[skytexture] + 1
uniform float skyTexHeight;     // sky texture height in pixels (typically 128)
uniform float skyTextureMid;    // skytexturemid in texture rows (100)
uniform float skyRowScale;      // (pspriteiscale>>detailshift) / FRACUNIT
uniform float skyViewHeight;    // current logical viewheight
uniform bool paletteIndexCapture;

varying vec4 vClipPosition;

void main() {
  vec2 sc = vClipPosition.xy / vClipPosition.w;

  // Horizontal — same perspective relationship vanilla bakes into
  // xtoviewangle[x] = atan((centerx - x) * iprojection): the per-column
  // angular offset from the optical axis. We compute it directly per fragment.
  float angleOff = atan(sc.x * hfovHalfTan);
  // Doom angle convention: turning right (clockwise from above) DECREASES
  // angle; a fragment on the right (sc.x > 0) corresponds to a smaller world
  // angle than the camera's. So world angle = viewangle - angleOff.
  float angle = viewangle - angleOff;

  // Vanilla first narrows the unsigned BAM angle to 1024 virtual columns,
  // then R_GetColumn applies the texture's next-lower-power-of-two mask.
  // Keep the 1024 wrap distinct: textures wider than 1024 still restart after
  // one turn, while non-power-of-two textures leave their final columns unused.
  const float TWO_PI = 6.283185307179586;
  const float SKY_COLUMNS_PER_TURN = 1024.0;
  float angularColumn = floor(angle / TWO_PI * SKY_COLUMNS_PER_TURN);
  angularColumn = mod(
    mod(angularColumn, SKY_COLUMNS_PER_TURN) + SKY_COLUMNS_PER_TURN,
    SKY_COLUMNS_PER_TURN
  );
  float textureColumn = mod(angularColumn, skyColumnPeriod);
  float skyU = (textureColumn + 0.5) / skyTexWidth;

  // Vertical — R_DrawColumn starts each local view row at:
  //   skytexturemid + (y-centery) * (pspriteiscale>>detailshift)
  // Reduced views therefore crop a scaled slice of the sky texture rather
  // than stretching source rows 0..199 into every viewport.
  float screenY = floor((1.0 - (sc.y * 0.5 + 0.5)) * skyViewHeight);
  float texRow = floor(
    skyTextureMid + (screenY - floor(skyViewHeight * 0.5)) * skyRowScale
  );
  float wrappedRow = mod(mod(texRow, skyTexHeight) + skyTexHeight, skyTexHeight);
  float skyV = wrappedRow / skyTexHeight;

  // Indexed sample → palette → fullbright (r_plane.c:404 dc_colormap =
  // colormaps[0]).
  float palIdx = texture2D(map, vec2(skyU, skyV)).r;
  float remap = texture2D(colormap, vec2(palIdx, 0.5 / 34.0)).r;
  if (paletteIndexCapture) {
    gl_FragColor = vec4(remap, 0.0, 0.0, 1.0);
  } else {
    vec3 rgb = texture2D(palette, vec2(remap, 0.5)).rgb;
    gl_FragColor = vec4(rgb, 1.0);
  }
}
`;

export function R_BuildSky() {
  if (hasActiveSkyResources()) {
    throw new Error('R_BuildSky: call R_ShutdownSky before rebuilding');
  }
  // Reset projection and public identifiers before lookup. This is a no-op
  // for GPU ownership because the active-resource guard above has passed.
  disposeAndResetSky();
  R_InitSkyMap();
  if (skytexture < 0) {
    disposeAndResetSky();
    return null;
  }
  const baseMap = R_GetWallTexture(skytexture);
  if (baseMap === null) {
    disposeAndResetSky();
    return null;
  }

  // Clone keeps sky state isolated from any wall that happens to share the
  // SKY1 lump (we don't change wrap settings here, but the clone is cheap
  // and future-proofs against shader changes).
  const map = baseMap.clone();
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.needsUpdate = true;

  _skyMap = map;

  _skyMat = new THREE.ShaderMaterial({
    uniforms: {
      map:          { value: map },
      palette:      { value: R_GetPaletteTexture() },
      colormap:     { value: R_GetColormapTexture() },
      viewangle:    { value: 0 },
      hfovHalfTan:  { value: 1.0 },
      skyTexWidth:  { value: map.image.width },
      skyColumnPeriod: { value: texturewidthmask[skytexture] + 1 },
      skyTexHeight: { value: map.image.height },
      skyTextureMid: { value: skytexturemid / FRACUNIT },
      skyRowScale:  { value: 1.0 },
      skyViewHeight: { value: 200.0 },
      paletteIndexCapture: paletteIndexCaptureUniform,
    },
    vertexShader:   SKY_VERT,
    fragmentShader: SKY_FRAG,
    side:           THREE.DoubleSide,
    // Sky color is an infinite far-depth fill, not a texture painted on a
    // physical ceiling. r_plane pairs it with a colorless physical-depth
    // occluder so geometry in front can overwrite it while retained geometry
    // behind the terminal sky portal remains hidden like Doom's BSP spans.
    depthTest:      true,
    depthFunc:      THREE.LessEqualDepth,
    depthWrite:     false,
  });
  // r_bsp.c only creates a floor visplane below the eye, so a sky floor keeps
  // its upward-facing winding. Sky ceilings have a deliberate below-eye
  // exception and their height seams can be approached from either side.
  _skyFloorMat = _skyMat.clone();
  _skyFloorMat.uniforms = _skyMat.uniforms;
  _skyFloorMat.side = THREE.FrontSide;
  _skyFloorMat.needsUpdate = true;

  _skyDepthMat = new THREE.MeshBasicMaterial({
    colorWrite: false,
    depthTest: true,
    depthFunc: THREE.LessEqualDepth,
    depthWrite: true,
    side: THREE.DoubleSide,
  });
  // Floors participate in the sprite-overhang EqualDepth repair, so their
  // colorless sky occluder must write the same analytical support-plane depth
  // as ordinary floor shaders. Ceiling caps and vertical sky seams do not;
  // keep their hardware depth path above so seams retain their full shape.
  _skyFloorDepthMat = R_MakeSupportPlaneDepthMaterial({
    side: THREE.FrontSide,
  });
  return {
    floor: _skyFloorMat,
    ceiling: _skyMat,
    floorOccluder: _skyFloorDepthMat,
    ceilingOccluder: _skyDepthMat,
  };
}

// Update per-frame uniforms. Called after R_SetupFrame, so the camera matrix
// already reflects the player's view direction.
export function R_UpdateSky() {
  if (_skyMat === null) return;
  // Doom BAM angle in radians. r_main.js set camera.rotation.y = doom_angle - π/2,
  // so doom_angle = rotation.y + π/2.
  _skyMat.uniforms.viewangle.value = camera.rotation.y + Math.PI / 2;
  // hfov derived from camera vfov + aspect: hfov = 2 * atan(tan(vfov/2) * aspect).
  // Only changes on resize / FOV change, so cache and skip the trig per frame.
  if (camera.fov !== _cachedFov || camera.aspect !== _cachedAspect) {
    const vfovRad = camera.fov * Math.PI / 180;
    _hfovHalfTan  = Math.tan(vfovRad / 2) * camera.aspect;
    _cachedFov    = camera.fov;
    _cachedAspect = camera.aspect;
    _skyMat.uniforms.hfovHalfTan.value = _hfovHalfTan;
  }
  const view = R_GetViewSize();
  _skyMat.uniforms.skyTextureMid.value = skytexturemid / FRACUNIT;
  _skyMat.uniforms.skyRowScale.value =
    R_SkyRowStep(view.viewwidth, view.detailshift) / FRACUNIT;
  _skyMat.uniforms.skyViewHeight.value = view.viewheight;
}
