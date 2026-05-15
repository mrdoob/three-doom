// Ported from: linuxdoom-1.10/r_sky.c + r_plane.c:395-419
//
// Vanilla draws the sky column-by-column into the screen buffer:
//   angle = (viewangle + xtoviewangle[x]) >> ANGLETOSKYSHIFT
//   dc_source = R_GetColumn(skytexture, angle)
//   dc_colormap = colormaps          // fullbright
//   dc_texturemid = 100*FRACUNIT
//   dc_iscale = pspriteiscale        // 1 sky-row per screen-row at 320x200
// The sky is therefore a 2D overlay anchored to viewangle (slides
// horizontally) with a fixed vertical anchor at row 100 — it does NOT live
// in 3D space.
//
// We reproduce that with an NDC fullscreen quad whose fragment shader runs
// the same angle-to-column and screen_y-to-row math as vanilla. The quad has
// renderOrder = -Infinity + depthTest/depthWrite off, so it's painted first
// and the world over-draws it. r_plane.js does not emit floor/ceiling
// geometry for sky-flat sectors, so wherever vanilla would have drawn sky,
// the quad shows through.

import * as THREE from 'three';
import { gamemode, gameepisode, gamemap } from './doomstat.js';
import { GameMode_t } from './doomdef.js';
import { R_CheckTextureNumForName, R_GetWallTexture, playpal_rgba, colormaps } from './r_data.js';
import { camera } from './i_video.js';

export let skytexture = -1;
export let skytexturemid = 0;

let _skyMat = null;
let _paletteTex = null;
let _colormapTex = null;

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
  skytexturemid = 100 << 16;
}

// Vertex shader: pass-through NDC. PlaneGeometry(2,2) already spans
// [-1,1]×[-1,1] in object space; we ignore camera matrices and emit it
// straight to clip space at the far plane (z=1) so depth-tested world
// geometry always wins.
const SKY_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 1.0, 1.0);
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
uniform float skyTexHeight;     // sky texture height in pixels (typically 128)

varying vec2 vUv;

void main() {
  vec2 sc = vUv * 2.0 - 1.0;     // centred screen coords in [-1, 1]

  // Horizontal — same perspective relationship vanilla bakes into
  // xtoviewangle[x] = atan((centerx - x) * iprojection): the per-column
  // angular offset from the optical axis. We compute it directly per fragment.
  float angleOff = atan(sc.x * hfovHalfTan);
  // Doom angle convention: turning right (clockwise from above) DECREASES
  // angle; a fragment on the right (sc.x > 0) corresponds to a smaller world
  // angle than the camera's. So world angle = viewangle - angleOff.
  float angle = viewangle - angleOff;

  // Vanilla: column = (angle >> ANGLETOSKYSHIFT) & 0xFF. ANGLETOSKYSHIFT=22
  // maps a 32-bit BAM turn (2π rad) to 1024 columns; a 256-col sky texture
  // therefore wraps 4 times per turn → one full wrap per π/2 rad. wrapS =
  // RepeatWrapping on the texture handles the modulo.
  float skyU = angle / 1.5707963267948966;

  // Vertical — vanilla column drawer:
  //   texRow = (dc_texturemid + (y - centery) * dc_iscale) >> 16
  // with centery=100, dc_texturemid=100<<16, dc_iscale=FRACUNIT — i.e.
  // texRow = doom_screen_y, where doom_screen_y runs 0 (top) to 199 (bottom).
  // The mapping is independent of canvas size: 200 sky-rows always cover the
  // full canvas height. The upper half of the canvas shows texture rows 0..100
  // exactly like vanilla.
  float texRow = (1.0 - vUv.y) * 200.0;
  float skyV = mod(texRow, skyTexHeight) / skyTexHeight;

  // Indexed sample → palette → fullbright (r_plane.c:404 dc_colormap =
  // colormaps[0]).
  float palIdx = texture2D(map, vec2(skyU, skyV)).r;
  float remap = texture2D(colormap, vec2(palIdx, 0.5 / 34.0)).r;
  vec3 rgb = texture2D(palette, vec2(remap, 0.5)).rgb;
  gl_FragColor = vec4(rgb, 1.0);
}
`;

function _buildPaletteTexture() {
  const rgba = playpal_rgba.slice(0, 256 * 4);
  const tex = new THREE.DataTexture(rgba, 256, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

function _buildColormapTexture() {
  const tex = new THREE.DataTexture(colormaps, 256, 34, THREE.RedFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.internalFormat = 'R8';
  tex.needsUpdate = true;
  return tex;
}

export function R_BuildSky(levelRoot) {
  R_InitSkyMap();
  if (skytexture < 0) return null;
  const baseMap = R_GetWallTexture(skytexture);
  if (baseMap === null) return null;

  // Clone keeps sky state isolated from any wall that happens to share the
  // SKY1 lump (we don't change wrap settings here, but the clone is cheap
  // and future-proofs against shader changes).
  const map = baseMap.clone();
  map.wrapS = THREE.RepeatWrapping;
  map.wrapT = THREE.RepeatWrapping;
  map.needsUpdate = true;

  if (_paletteTex === null)  _paletteTex  = _buildPaletteTexture();
  if (_colormapTex === null) _colormapTex = _buildColormapTexture();

  _skyMat = new THREE.ShaderMaterial({
    uniforms: {
      map:          { value: map },
      palette:      { value: _paletteTex },
      colormap:     { value: _colormapTex },
      viewangle:    { value: 0 },
      hfovHalfTan:  { value: 1.0 },
      skyTexHeight: { value: map.image.height },
    },
    vertexShader:   SKY_VERT,
    fragmentShader: SKY_FRAG,
    depthTest:      false,
    depthWrite:     false,
  });

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), _skyMat);
  quad.frustumCulled = false;
  // -Infinity ensures the sky is the very first thing drawn — three.js renders
  // opaque objects in ascending renderOrder, falling back to material/state
  // sort within equal-renderOrder groups.
  quad.renderOrder = -Infinity;
  levelRoot.add(quad);
  return quad;
}

// Update per-frame uniforms. Called after R_SetupFrame, so the camera matrix
// already reflects the player's view direction.
export function R_UpdateSky() {
  if (_skyMat === null) return;
  // Doom BAM angle in radians. r_main.js set camera.rotation.y = doom_angle - π/2,
  // so doom_angle = rotation.y + π/2.
  _skyMat.uniforms.viewangle.value = camera.rotation.y + Math.PI / 2;
  // hfov derived from camera vfov + aspect: hfov = 2 * atan(tan(vfov/2) * aspect).
  // We store tan(hfov/2) = tan(vfov/2) * aspect — exactly the value the shader
  // multiplies by sc.x.
  const vfovRad = camera.fov * Math.PI / 180;
  _skyMat.uniforms.hfovHalfTan.value = Math.tan(vfovRad / 2) * camera.aspect;
}
