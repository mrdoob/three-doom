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
import {
  R_SPRITE_PASS_FULL,
  spriteFloorPassUniform,
} from './r_sprite_depth.js';

// Singletons — built lazily from the WAD's PLAYPAL + COLORMAP lumps.
let _paletteTex = null;
let _colormapTex = null;
let _playpalRGBA = null;
let _paletteIndex = 0;

// Shared by every world-sprite material. i_video supplies a background-only
// render of the current view immediately before submitting MF_SHADOW sprites.
export const spriteFuzzMapUniform = { value: null };
export const spriteFuzzReadyUniform = { value: false };
export const spriteFuzzScreenSizeUniform = { value: new THREE.Vector2(1, 1) };
export const spriteFuzzViewHeightUniform = { value: 200 };
export const spriteFuzzPhaseUniform = { value: 0 };
// Hidden index renders share this exact object across walls, planes, sprites,
// and sky. When enabled each indexed shader writes its post-COLORMAP palette
// index into red instead of resolving that index to RGB.
export const paletteIndexCaptureUniform = { value: false };

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
  if (_colormapTex === null) _colormapTex = _buildColormapTexture(colormaps);
  R_SetPlaypal(playpal_rgba);
}

export function R_SetPlaypal(playpalRGBA) {
  _playpalRGBA = playpalRGBA;
  if (_paletteTex === null) {
    _paletteTex = _buildPaletteTexture(_playpalRGBA);
  } else {
    _paletteTex.image.data.set(_selectedPalette(_playpalRGBA));
    _paletteTex.needsUpdate = true;
  }
}

export function R_SetPaletteIndex(index) {
  const selected = Number.isInteger(index) && index >= 0 && index < 14 ? index : 0;
  if (selected === _paletteIndex) return;
  _paletteIndex = selected;
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
  spriteFloorPassUniform.value = R_SPRITE_PASS_FULL;
  spriteFloorViewportUniform.value.set(0, 0, 1, 1);
  spriteFuzzMapUniform.value = null;
  spriteFuzzReadyUniform.value = false;
  spriteFuzzScreenSizeUniform.value.set(1, 1);
  spriteFuzzViewHeightUniform.value = 200;
  spriteFuzzPhaseUniform.value = 0;
  paletteIndexCaptureUniform.value = false;
}

export function R_SetSpriteFuzzFrame(texture, screenWidth, screenHeight, viewHeight, phase) {
  spriteFuzzMapUniform.value = texture;
  spriteFuzzReadyUniform.value = texture !== null && texture !== undefined;
  spriteFuzzScreenSizeUniform.value.set(
    Math.max(1, screenWidth), Math.max(1, screenHeight),
  );
  spriteFuzzViewHeightUniform.value = Math.max(1, viewHeight | 0);
  spriteFuzzPhaseUniform.value = phase;
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
export const spriteFloorViewportUniform = { value: new THREE.Vector4(0, 0, 1, 1) };

// gl_FragCoord is expressed in physical framebuffer pixels. Three.js keeps
// that exact current viewport internally (including devicePixelRatio), so a
// shared material hook can update every plane/sprite without allocating in
// the display loop or relying on the Canvas layout implementation.
function updateSpriteFloorViewport(renderer) {
  renderer.getCurrentViewport(spriteFloorViewportUniform.value);
}

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
#ifdef DOOM_PLANE_DEPTH
varying float vPlaneHeight;
#endif

void main() {
  vUv = uv;
  vColor = color;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewDepth = -mv.z;
#ifdef DOOM_PLANE_DEPTH
  vPlaneHeight = (modelMatrix * vec4(position, 1.0)).y;
#endif
  gl_Position = projectionMatrix * mv;
}
`;

// Both physical floor fragments and below-floor sprite fragments call this
// exact function. Producing the same quantized depth is what makes EqualDepth
// an ownership test for the sprite's supporting floor, without a tolerance
// that could admit a different step or wall.
const SUPPORT_PLANE_DEPTH_GLSL = /* glsl */ `
uniform mat4 projectionMatrix;
uniform vec4 doomViewport;

float doomSupportPlaneDepth(float height) {
  vec2 ndc = ((gl_FragCoord.xy - doomViewport.xy) / doomViewport.zw) * 2.0 - 1.0;
  vec3 ray = vec3(
    ndc.x / projectionMatrix[0][0],
    ndc.y / projectionMatrix[1][1],
    -1.0
  );
  vec3 planeNormal = mat3(viewMatrix) * vec3(0.0, 1.0, 0.0);
  vec3 planePoint = (viewMatrix * vec4(0.0, height, 0.0, 1.0)).xyz;
  float denominator = dot(planeNormal, ray);
  float scale = dot(planeNormal, planePoint) / denominator;
  vec4 clipPosition = projectionMatrix * vec4(scale * ray, 1.0);
  return clipPosition.z / clipPosition.w * 0.5 + 0.5;
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
uniform bool paletteIndexCapture;

#ifdef DOOM_PLANE_DEPTH
${SUPPORT_PLANE_DEPTH_GLSL}
varying float vPlaneHeight;
#endif

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
  if (paletteIndexCapture) {
    gl_FragColor = vec4(remap, 0.0, 0.0, 1.0);
  } else {
    // Final RGB from the palette.
    vec3 rgb = texture2D(palette, vec2(remap, 0.5)).rgb;
    gl_FragColor = vec4(rgb, 1.0);
  }
#ifdef DOOM_PLANE_DEPTH
  gl_FragDepth = doomSupportPlaneDepth(vPlaneHeight);
#endif
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
  const material = new THREE.ShaderMaterial({
    uniforms: {
      map:           { value: map },
      palette:       { value: _paletteTex },
      colormap:      { value: _colormapTex },
      extralight:    extralightUniform,
      fixedColormap: fixedColormap >= 0 ? { value: fixedColormap } : fixedColormapUniform,
      scaledViewWidth: scaledViewWidthUniform,
      masked:        { value: masked },
      planeLighting: { value: plane },
      paletteIndexCapture: paletteIndexCaptureUniform,
      doomViewport:  spriteFloorViewportUniform,
    },
    defines: plane ? { DOOM_PLANE_DEPTH: '' } : {},
    vertexShader:   VERT_SHADER,
    fragmentShader: FRAG_SHADER,
    vertexColors:   true,
    side,
    transparent:    false,
    depthWrite,
  });
  if (plane) material.onBeforeRender = updateSpriteFloorViewport;
  return material;
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
uniform sampler2D fuzzMap;
uniform bool fuzzReady;
uniform vec2 fuzzScreenSize;
uniform float fuzzViewHeight;
uniform float fuzzPhase;
uniform bool paletteIndexCapture;
uniform int floorPass;
uniform float floorCutoff;
uniform float floorHeight;

${SUPPORT_PLANE_DEPTH_GLSL}

varying vec2 vUv;
varying float vViewDepth;

float doomFuzzOffset(float index) {
  // Negative entries in linuxdoom's exact 50-step fuzzoffset table. All
  // other entries sample the following framebuffer row.
  if (
    index == 1.0 || index == 3.0 || index == 6.0 || index == 9.0 ||
    index == 13.0 || index == 17.0 || index == 18.0 || index == 19.0 ||
    index == 20.0 || index == 22.0 || index == 23.0 || index == 28.0 ||
    index == 30.0 || index == 33.0 || index == 34.0 || index == 37.0 ||
    index == 38.0 || index == 39.0 || index == 40.0 || index == 45.0 ||
    index == 48.0
  ) return -1.0;
  return 1.0;
}

void main() {
  // Split the source patch at its physical support plane. The ordinary pass
  // keeps the body; the repair pass keeps only the authored rows below it.
  if (floorPass == 1 && vUv.y < floorCutoff) discard;
  if (floorPass == 2 && vUv.y >= floorCutoff) discard;

  vec2 texel = texture2D(map, vUv).rg;
  float alpha = texel.g * opacity;
  if (alpha < alphaCutoff) discard;

  // In the repair pass, EqualDepth accepts only a pixel whose retained world
  // depth belongs to the actor's own floor plane. A nearer step or wall has a
  // different stored depth and continues to clip the sprite.
  gl_FragDepth = floorPass == 2
    ? doomSupportPlaneDepth(floorHeight)
    : gl_FragCoord.z;

  if (shadow) {
    if (fuzzReady) {
      vec2 logicalScale = vec2(
        doomViewport.z / scaledViewWidth,
        doomViewport.w / fuzzViewHeight
      );
      vec2 localPixel = floor((gl_FragCoord.xy - doomViewport.xy) / logicalScale);
      // Vanilla protects the first/last view rows before reading a neighbour.
      if (localPixel.y < 1.0 || localPixel.y >= fuzzViewHeight - 1.0) discard;
      float topOriginY = fuzzViewHeight - 1.0 - localPixel.y;
      float sequence = mod(
        fuzzPhase + localPixel.x * fuzzViewHeight + topOriginY,
        50.0
      );
      float direction = doomFuzzOffset(sequence);
      // The hidden target is exactly one texel per logical Doom view pixel.
      // +SCREENWIDTH is one row down in the top-origin framebuffer, hence
      // subtracting direction in this bottom-origin texture coordinate.
      vec2 samplePixel = clamp(
        localPixel + vec2(0.5, 0.5 - direction),
        vec2(0.5),
        fuzzScreenSize - vec2(0.5)
      );
      float neighbourIndex = texture2D(fuzzMap, samplePixel / fuzzScreenSize).r;
      float mappedIndex = texture2D(
        colormap, vec2(neighbourIndex, (6.0 + 0.5) / 34.0)
      ).r;
      if (paletteIndexCapture) {
        gl_FragColor = vec4(mappedIndex, 0.0, 0.0, 1.0);
      } else {
        vec3 fuzzRgb = texture2D(palette, vec2(mappedIndex, 0.5)).rgb;
        gl_FragColor = vec4(fuzzRgb, 1.0);
      }
      return;
    }
    // Direct material diagnostics do not have i_video's background prepass.
    // Retain a defined opaque fallback; production MF_SHADOW objects always
    // take the framebuffer-sampling branch above.
    if (paletteIndexCapture) {
      gl_FragColor = vec4(shadowPaletteIndex, 0.0, 0.0, 1.0);
    } else {
      vec3 shadowRgb = texture2D(palette, vec2(shadowPaletteIndex, 0.5)).rgb;
      gl_FragColor = vec4(shadowRgb, 1.0);
    }
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
  if (paletteIndexCapture) {
    gl_FragColor = vec4(remap, 0.0, 0.0, 1.0);
  } else {
    vec3 rgb = texture2D(palette, vec2(remap, 0.5)).rgb;
    gl_FragColor = vec4(rgb, alpha);
  }
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
      fuzzMap:       spriteFuzzMapUniform,
      fuzzReady:     spriteFuzzReadyUniform,
      fuzzScreenSize: spriteFuzzScreenSizeUniform,
      fuzzViewHeight: spriteFuzzViewHeightUniform,
      fuzzPhase:     spriteFuzzPhaseUniform,
      paletteIndexCapture: paletteIndexCaptureUniform,
      floorPass:     spriteFloorPassUniform,
      floorCutoff:   { value: 0 },
      floorHeight:   { value: 0 },
      doomViewport:  spriteFloorViewportUniform,
      center:        { value: new THREE.Vector2(0.5, 0.5) },
      rotation:      { value: 0 },
    },
    vertexShader: SPRITE_VERT_SHADER,
    fragmentShader: SPRITE_FRAG_SHADER,
    transparent: true,
    // Preserve world occlusion at authored patch coordinates. The production
    // floor-overhang pass changes depthFunc only around its second submission.
    depthTest: true,
    depthWrite: true,
  });
  material.onBeforeRender = updateSpriteFloorViewport;
  // Sprite.raycast reads material.rotation even for a custom material.
  material.rotation = 0;
  return material;
}
