// Ported from: linuxdoom-1.10/r_main.c (scalelight / colormap setup) and
// linuxdoom-1.10/r_draw.c (R_DrawColumn's colormap lookup).
//
// Vanilla Doom does its per-pixel shading by sampling a 256x32 COLORMAP
// remap table indexed by (palette_idx, light_row). The light row is
// derived per wall column from the sector's lightlevel plus a distance-
// driven attenuation (r_main.c: scalelight table).
//
// The 3D port keeps wall / flat / sprite textures as 8-bit palette indices
// (R8) plus a 1-bit alpha mask (G8), and a fragment shader reproduces the
// COLORMAP lookup. View-space depth stands in for vanilla's per-column
// rw_scale-based j index — they're proportional in a perspective camera.

import * as THREE from 'three';

// Singletons — built lazily from the WAD's PLAYPAL + COLORMAP lumps.
let _paletteTex = null;
let _colormapTex = null;

// PLAYPAL has 14 palettes (256 RGB each); pal 0 is the normal one.
// PLAYPAL palette swaps for damage / pickup / radsuit are handled at the
// overlay level (I_RenderTint in i_video.js) and don't change this texture.
function _buildPaletteTexture(playpal_rgba) {
  // Modern Three.js dropped RGBFormat; use RGBA with alpha=255. playpal_rgba
  // already has alpha=255 in the 14×256×4 layout, so slice the first palette.
  const rgba = playpal_rgba.slice(0, 256 * 4);
  const tex = new THREE.DataTexture(rgba, 256, 1, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.needsUpdate = true;
  return tex;
}

// COLORMAP: 34 rows × 256 bytes. Rows 0..31 are the distance-shaded
// remaps (row 0 = full bright, row 31 = fully dark). Row 32 is the
// invulnerability remap (negative); row 33 is unused. We expose all 34
// rows so the shader can pick the invuln row when needed.
function _buildColormapTexture(colormaps) {
  const rows = 34;
  const tex = new THREE.DataTexture(colormaps, 256, rows, THREE.RedFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.internalFormat = 'R8';
  tex.needsUpdate = true;
  return tex;
}

// One-time init from r_data.js's loaded PLAYPAL / COLORMAP.
export function R_ShaderInit(playpal_rgba, colormaps) {
  if (_paletteTex === null) _paletteTex = _buildPaletteTexture(playpal_rgba);
  if (_colormapTex === null) _colormapTex = _buildColormapTexture(colormaps);
}

// Build the (R8 index, R8 alpha) data texture from a Uint8Array of palette
// indices and a matching Uint8Array of alphas (0 = transparent, 255 = opaque).
// Returns a THREE.DataTexture using RG8 storage so the shader can sample
// both bands in one tap.
export function R_MakeIndexedTexture(indices, alphas, w, h) {
  const rg = new Uint8Array(w * h * 2);
  for (let i = 0; i < w * h; i++) {
    rg[i * 2 + 0] = indices[i];
    rg[i * 2 + 1] = alphas[i];
  }
  const tex = new THREE.DataTexture(rg, w, h, THREE.RGFormat);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.flipY = false;
  tex.internalFormat = 'RG8';
  tex.needsUpdate = true;
  return tex;
}

// extralight is a shared uniform (weapon flash / light-amp visor add a
// brightness boost across all geometry). Updated from p_user.P_PlayerThink.
export const extralightUniform = { value: 0 };

// Sector-light range: vanilla snaps the 0..255 sector.lightlevel to one of
// 16 buckets (>> LIGHTSEGSHIFT). We pass the snapped index directly via
// vertex colour so each sector gets a consistent bucket regardless of
// per-vertex interpolation.

const VERT_SHADER = /* glsl */ `
varying vec2 vUv;
varying vec3 vColor;
varying float vViewDepth;

void main() {
  vUv = uv;
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

// Fragment shader applies the vanilla scalelight formula:
//   startMap = (15 - lightIdx) * 4
//   row      = clamp(startMap + distMap - extralight, 0, 31)
// distMap stands in for vanilla's j (the screen-scale index). We pick a
// per-unit scale that matches vanilla's perceived fall-off in a typical
// Doom room. Final colour is paletteTex[colormapTex[texIdx, row]].
//
// `masked` materials enable the alpha-discard branch for grates / fences.
const FRAG_SHADER = /* glsl */ `
uniform sampler2D map;
uniform sampler2D palette;
uniform sampler2D colormap;
uniform float extralight;
uniform float fixedColormap;     // -1 = use shading, >=0 = force this row (invuln=32)
uniform bool masked;

varying vec2 vUv;
varying vec3 vColor;
varying float vViewDepth;

void main() {
  vec2 texel = texture2D(map, vUv).rg;
  float palIdx = texel.r;         // 0..1 from R8
  float alpha  = texel.g;         // 0..1 from G8

  if (masked && alpha < 0.5) discard;

  float row;
  if (fixedColormap >= 0.0) {
    // Invuln / light-amp visor: shader sees a fixed colormap row.
    row = fixedColormap;
  } else {
    // r_main.c R_InitLightTables — startMap is vanilla's *far-distance*
    // darkness for the sector. Close is brighter by up to MAXLIGHTSCALE/4
    // (≈ 12 rows). Vanilla:
    //   level = startMap - j/4           // j=0 (far) → startMap; j=47 (close) → startMap-11.75
    // We replace `-j/4` with `(distMap - 12)`, where distMap saturates to
    // ~12 at far range. Same min/max behaviour, sign-flipped to match our
    // "depth grows with distance" sense.
    float lightIdx = floor(vColor.r * 15.0 + 0.001);   // 0..15
    float startMap = (15.0 - lightIdx) * 4.0;          // 0..60 (vanilla far-end darkness)
    float distMap  = clamp(vViewDepth * (12.0 / 1024.0), 0.0, 12.0);
    row = clamp(startMap + distMap - 12.0 - extralight * 8.0, 0.0, 31.0);
  }

  // Sample the colormap remap: x = palIdx, y = row/(rows-1) for 34 rows.
  float remap = texture2D(colormap, vec2(palIdx, (row + 0.5) / 34.0)).r;
  // Final RGB from the palette.
  vec3 rgb = texture2D(palette, vec2(remap, 0.5)).rgb;
  gl_FragColor = vec4(rgb, 1.0);
}
`;

// Material factory. `map` is the RG8 indexed texture from R_MakeIndexedTexture.
// `masked=true` enables alphaTest discard for grates/fences.
export function R_MakeDoomMaterial(map, { masked = false, side = THREE.FrontSide } = {}) {
  if (_paletteTex === null || _colormapTex === null) {
    throw new Error('R_MakeDoomMaterial called before R_ShaderInit');
  }
  return new THREE.ShaderMaterial({
    uniforms: {
      map:           { value: map },
      palette:       { value: _paletteTex },
      colormap:      { value: _colormapTex },
      extralight:    extralightUniform,
      fixedColormap: { value: -1.0 },
      masked:        { value: masked },
    },
    vertexShader:   VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    vertexColors:   true,
    side,
    transparent:    false,
    depthWrite:     true,
  });
}
