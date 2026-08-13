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
// COLORMAP lookup. View-space depth gives the same projected wall scale and
// plane z-distance indices that vanilla used to select its integer LUTs. The
// current scaledviewwidth is a shared uniform because scalelight (unlike
// zlight) is rebuilt whenever the view-size slider changes.

import * as THREE from 'three';
import {
  LIGHTLEVELS, MAXLIGHTSCALE, MAXLIGHTZ, NUMCOLORMAPS, DISTMAP,
  LIGHT_PROJECTION, REFERENCE_SCREENWIDTH,
} from './r_light_logic.js';

// Singletons — built lazily from the WAD's PLAYPAL + COLORMAP lumps.
let _paletteTex = null;
let _colormapTex = null;
let _playpalRGBA = null;
let _paletteIndex = 0;

// PLAYPAL has 14 palettes (256 RGB each); palette selection changes the
// shared upload so every indexed world material resolves through the exact
// damage, pickup, or radiation-suit palette selected by st_stuff.c.
function _selectedPalette(playpalRGBA) {
  const start = _paletteIndex * 256 * 4;
  return playpalRGBA.slice(start, start + 256 * 4);
}

function _buildPaletteTexture(playpalRGBA) {
  // Modern Three.js dropped RGBFormat; use RGBA with alpha=255. playpal_rgba
  // already has alpha=255 in the 14×256×4 layout.
  const rgba = _selectedPalette(playpalRGBA);
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
  R_SetPlaypal(playpal_rgba);
  if (_colormapTex === null) _colormapTex = _buildColormapTexture(colormaps);
}

export function R_SetPlaypal(playpalRGBA) {
  _playpalRGBA = playpalRGBA;
  if (_paletteTex === null) {
    _paletteTex = _buildPaletteTexture(_playpalRGBA);
    return;
  }
  _paletteTex.image.data.set(_selectedPalette(_playpalRGBA));
  _paletteTex.needsUpdate = true;
}

export function R_SetPaletteIndex(index) {
  _paletteIndex = Number.isInteger(index) && index >= 0 && index < 14 ? index : 0;
  if (_paletteTex === null || _playpalRGBA === null) return;
  _paletteTex.image.data.set(_selectedPalette(_playpalRGBA));
  _paletteTex.needsUpdate = true;
}

// Exposed so the sky shader can reuse the same GPU uploads instead of
// rebuilding identical palette / colormap textures.
export function R_GetPaletteTexture()  { return _paletteTex; }
export function R_GetColormapTexture() { return _colormapTex; }

export function R_ShutdownShader() {
  if (_paletteTex !== null) _paletteTex.dispose();
  if (_colormapTex !== null) _colormapTex.dispose();
  _paletteTex = null;
  _colormapTex = null;
  _playpalRGBA = null;
  _paletteIndex = 0;
  extralightUniform.value = 0;
  fixedColormapUniform.value = -1;
  scaledViewWidthUniform.value = REFERENCE_SCREENWIDTH;
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

// Per-view lighting is shared by every world material. R_SetupFrame updates
// these once before rendering, just as vanilla sets its renderer globals.
export const extralightUniform = { value: 0 };
export const fixedColormapUniform = { value: -1 };
export const scaledViewWidthUniform = { value: REFERENCE_SCREENWIDTH };

export function R_SetViewLighting(
  extralight,
  fixedColormap,
  scaledViewWidth = REFERENCE_SCREENWIDTH,
) {
  extralightUniform.value = extralight;
  // player.fixedcolormap uses 0 as "disabled"; shader -1 selects normal
  // distance lighting, while positive values are literal COLORMAP rows.
  fixedColormapUniform.value = fixedColormap === 0 ? -1 : fixedColormap;
  scaledViewWidthUniform.value = Math.max(1, scaledViewWidth | 0);
}

// Sector-light range: vanilla snaps the 0..255 sector.lightlevel to one of
// 16 buckets (>> LIGHTSEGSHIFT). Vertex colour carries that signed bucket so
// wall contrast survives until extralight is added and the result is clamped.

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

// Fragment shader applies vanilla's two distinct integer light-table paths.
// Walls and masked midtextures select scalelight[light][rw_scale >> 12];
// planes select zlight[light][distance >> LIGHTZSHIFT].  With the port's
// current 90-degree projection these indices can be derived from
// perpendicular view depth. Final colour is
// paletteTex[colormapTex[texIdx, row]].
//
// `masked` materials enable the alpha-discard branch for grates / fences.
const FRAG_SHADER = /* glsl */ `
uniform sampler2D map;
uniform sampler2D palette;
uniform sampler2D colormap;
uniform float extralight;
uniform float fixedColormap;     // -1 = use shading, >=0 = force this row (invuln=32)
uniform float scaledViewWidth;   // R_ExecuteSetViewSize's scaledviewwidth
uniform bool masked;
uniform bool planeLighting;

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
    float lightIdx = floor(clamp(vColor.r + extralight, 0.0, ${LIGHTLEVELS - 1}.0));
    float startMap = (${LIGHTLEVELS - 1}.0 - lightIdx) * 4.0;

    if (planeLighting) {
      // R_MapPlane: index = distance >> LIGHTZSHIFT.  2^20 fixed-point
      // units are 16 world units.  R_InitLightTables then computes
      // scale = (SCREENWIDTH/2)/(index+1), and level = startMap-scale/DISTMAP.
      float zIndex = min(floor(max(vViewDepth, 0.0) / 16.0), ${MAXLIGHTZ - 1}.0);
      float zScale = floor(${LIGHT_PROJECTION}.0 / (zIndex + 1.0));
      row = clamp(startMap - floor(zScale / ${DISTMAP}.0), 0.0, ${NUMCOLORMAPS - 1}.0);
    } else {
      // R_RenderSegLoop/R_RenderMaskedSegRange: projection is current
      // viewwidth/2, and R_ExecuteSetViewSize rebuilds scalelight with the
      // SCREENWIDTH/scaledviewwidth attenuation factor.
      float scaleIndex = min(
        floor((scaledViewWidth * 8.0) / max(vViewDepth, 0.0000152587890625)),
        ${MAXLIGHTSCALE - 1}.0
      );
      float attenuation = floor(
        floor(scaleIndex * ${REFERENCE_SCREENWIDTH}.0 / scaledViewWidth) / ${DISTMAP}.0
      );
      row = clamp(startMap - attenuation, 0.0, ${NUMCOLORMAPS - 1}.0);
    }
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
// `fixedColormap=0` forces the fullbright row (sky path: r_plane.c:396-405
// "Sky is allways drawn full bright, no colormaps needed").
export function R_MakeDoomMaterial(map, { masked = false, plane = false, side = THREE.FrontSide, fixedColormap = -1, depthWrite = true } = {}) {
  if (_paletteTex === null || _colormapTex === null) {
    throw new Error('R_MakeDoomMaterial called before R_ShaderInit');
  }
  return new THREE.ShaderMaterial({
    uniforms: {
      map:           { value: map },
      palette:       { value: _paletteTex },
      colormap:      { value: _colormapTex },
      extralight:    extralightUniform,
      fixedColormap: fixedColormap >= 0 ? { value: fixedColormap } : fixedColormapUniform,
      scaledViewWidth: scaledViewWidthUniform,
      masked:        { value: masked },
      planeLighting: { value: plane },
    },
    vertexShader:   VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    vertexColors:   true,
    side,
    transparent:    false,
    depthWrite,
  });
}

// THREE.Sprite uses a shared unit quad and expands it in view space. This is
// the world-size branch of the r184 SpriteMaterial vertex transform, kept here
// so indexed Doom sprites retain billboard rotation, perspective attenuation,
// and Sprite.center patch origins while using a custom COLORMAP shader.
const SPRITE_VERT_SHADER = /* glsl */ `
uniform float rotation;
uniform vec2 center;

varying vec2 vUv;
varying float vViewDepth;

void main() {
  vUv = uv;

  vec4 mvPosition = modelViewMatrix[3];
  vec2 scale = vec2(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz));
  vec2 alignedPosition = (position.xy - (center - vec2(0.5))) * scale;
  vec2 rotatedPosition;
  rotatedPosition.x = cos(rotation) * alignedPosition.x - sin(rotation) * alignedPosition.y;
  rotatedPosition.y = sin(rotation) * alignedPosition.x + cos(rotation) * alignedPosition.y;
  mvPosition.xy += rotatedPosition;

  vViewDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}
`;

// r_things.c:R_ProjectSprite chooses sprite colormaps in this order:
// MF_SHADOW, fixedcolormap, FF_FULLBRIGHT, then sector/distance lighting.
// The normal-light branch reconstructs the current projection scale index and
// the width-specific scalelight entry built by R_ExecuteSetViewSize.
const SPRITE_FRAG_SHADER = /* glsl */ `
uniform sampler2D map;
uniform sampler2D palette;
uniform sampler2D colormap;
uniform float sectorLight;
uniform float extralight;
uniform float fixedColormap;
uniform float scaledViewWidth;
uniform bool fullbright;
uniform bool shadow;
uniform float playerTranslation;
uniform float opacity;
uniform float alphaCutoff;
uniform float shadowPaletteIndex;

varying vec2 vUv;
varying float vViewDepth;

void main() {
  vec2 texel = texture2D(map, vUv).rg;
  float alpha = texel.g * opacity;
  if (alpha < alphaCutoff) discard;

  if (shadow) {
    vec3 shadowRgb = texture2D(palette, vec2(shadowPaletteIndex, 0.5)).rgb;
    gl_FragColor = vec4(shadowRgb, alpha);
    return;
  }

  float row;
  if (fixedColormap >= 0.0) {
    row = fixedColormap;
  } else if (fullbright) {
    row = 0.0;
  } else {
    float lightIdx = clamp(sectorLight + extralight, 0.0, 15.0);
    float startMap = (15.0 - lightIdx) * 4.0;
    float scaleIndex = min(floor((scaledViewWidth * 8.0) / max(vViewDepth, 1.0)), 47.0);
    float attenuation = floor(
      floor(scaleIndex * ${REFERENCE_SCREENWIDTH}.0 / scaledViewWidth) / ${DISTMAP}.0
    );
    row = clamp(startMap - attenuation, 0.0, 31.0);
  }

  float sourceIndex = floor(texel.r * 255.0 + 0.5);
  if (playerTranslation > 0.5 && sourceIndex >= 112.0 && sourceIndex <= 127.0) {
    // r_draw.c's translationtables: player 2 green->gray (0x60), player 3
    // green->brown (0x40), player 4 green->red (0x20). Translation precedes
    // COLORMAP, matching R_DrawTranslatedColumn.
    float rampBase = playerTranslation < 1.5
      ? 96.0
      : (playerTranslation < 2.5 ? 64.0 : 32.0);
    sourceIndex = rampBase + (sourceIndex - 112.0);
  }
  float palIdx = sourceIndex / 255.0;
  float remap = texture2D(colormap, vec2(palIdx, (row + 0.5) / 34.0)).r;
  vec3 rgb = texture2D(palette, vec2(remap, 0.5)).rgb;
  gl_FragColor = vec4(rgb, alpha);
}
`;

export function R_MakeDoomSpriteMaterial(map, { alphaCutoff = 0.5, shadowPaletteIndex = 5 } = {}) {
  if (_paletteTex === null || _colormapTex === null) {
    throw new Error('R_MakeDoomSpriteMaterial called before R_ShaderInit');
  }
  const material = new THREE.ShaderMaterial({
    uniforms: {
      map:           { value: map },
      palette:       { value: _paletteTex },
      colormap:      { value: _colormapTex },
      sectorLight:   { value: 15 },
      extralight:    extralightUniform,
      fixedColormap: fixedColormapUniform,
      scaledViewWidth: scaledViewWidthUniform,
      fullbright:    { value: false },
      shadow:        { value: false },
      playerTranslation: { value: 0 },
      opacity:       { value: 1 },
      alphaCutoff:   { value: alphaCutoff },
      shadowPaletteIndex: { value: shadowPaletteIndex / 255 },
      center:        { value: new THREE.Vector2(0.5, 0.5) },
      rotation:      { value: 0 },
    },
    vertexShader: SPRITE_VERT_SHADER,
    fragmentShader: SPRITE_FRAG_SHADER,
    transparent: true,
    // Preserve world occlusion at authored patch coordinates. The production
    // masked-object pass rebuilds depth from wall silhouettes only, matching
    // Doom's drawseg clipping without letting floor planes cut off the patch.
    depthTest: true,
    depthWrite: true,
  });
  // Sprite.raycast reads material.rotation even for a custom material.
  material.rotation = 0;
  return material;
}
