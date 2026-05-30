// Ported from: linuxdoom-1.10/r_data.c
// Preparation of textures/flats/sprites for rendering.
// In the 3D port we build a single RGBA THREE.DataTexture per resolved name
// at level load time (R_PrecacheLevel) rather than caching paletted columns.

import * as THREE from 'three';
import { W_CheckNumForName, W_GetNumForName, W_CacheLumpName, W_CacheLumpNum, W_LumpLength } from './w_wad.js';
import { I_Error } from './i_system.js';
import { FRACBITS } from './m_fixed.js';
import { patch_t } from './v_video.js';
import { R_MakeIndexedTexture, R_ShaderInit } from './r_shader.js';

// ---------- Lump ranges ----------
export let firstflat = 0, lastflat = 0, numflats = 0;
export let firstpatch = 0, lastpatch = 0, numpatches = 0;
export let firstspritelump = 0, lastspritelump = 0, numspritelumps = 0;

// ---------- Textures ----------
// Internal struct: { name, width, height, patchcount, patches: [{originx, originy, patchLump}] }
export let numtextures = 0;
export let textures    = null;
export let texturewidthmask = null;
export let textureheight    = null;
export let texturetranslation = null;
export let flattranslation    = null;

// ---------- Sprites ----------
export let spritewidth     = null;
export let spriteoffset    = null;
export let spritetopoffset = null;

// ---------- Colormaps ----------
export let colormaps = null; // Uint8Array, 34 rows × 256 entries
// 14 palettes × 256 RGBA bytes, populated by R_InitData.
export let playpal_rgba = null;

// ---------- Three.js cached resources (built lazily) ----------
const _flatTextureCache    = new Map(); // flatnum -> THREE.DataTexture
const _textureTextureCache = new Map(); // texturenum -> THREE.DataTexture

// ---------- R_FlatNumForName ----------
export function R_FlatNumForName(name) {
  if (name.length === 0 || name.charCodeAt(0) === 0) return 0;
  const i = W_CheckNumForName(name);
  if (i === -1) I_Error('R_FlatNumForName: ' + name + ' not found');
  return i - firstflat;
}

// ---------- R_CheckTextureNumForName / R_TextureNumForName ----------
export function R_CheckTextureNumForName(name) {
  if (name.length === 0 || name.charAt(0) === '-') return 0;
  for (let i = 0; i < numtextures; i++) {
    if (textures[i].name === name) return i;
  }
  return -1;
}
export function R_TextureNumForName(name) {
  const i = R_CheckTextureNumForName(name);
  if (i === -1) I_Error('R_TextureNumForName: ' + name + ' not found');
  return i;
}

function readName8(bytes, offset) {
  let s = '';
  for (let i = 0; i < 8; i++) {
    const b = bytes[offset + i];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s.toUpperCase();
}

// ---------- R_InitTextures ----------
export function R_InitTextures() {
  // PNAMES: list of patch lump names referenced by textures.
  const names = W_CacheLumpName('PNAMES', 0);
  const nview = new DataView(names.buffer, names.byteOffset, names.byteLength);
  const nummappatches = nview.getInt32(0, true);
  const patchlookup = new Int32Array(nummappatches);
  for (let i = 0; i < nummappatches; i++) {
    patchlookup[i] = W_CheckNumForName(readName8(names, 4 + i * 8));
  }

  // TEXTURE1, optionally TEXTURE2.
  function readTextureLump(lumpName) {
    const lump = W_CacheLumpName(lumpName, 0);
    const view = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
    const count = view.getInt32(0, true);
    const out = [];
    for (let i = 0; i < count; i++) {
      const off = view.getInt32(4 + i * 4, true);
      // maptexture_t at `off`:
      //   char name[8], short masked(unused), short width, short height,
      //   long columndirectory(unused), short patchcount, mappatch_t patches[]
      const name       = readName8(lump, off);
      const width      = view.getInt16(off + 12, true);
      const height     = view.getInt16(off + 14, true);
      const patchcount = view.getInt16(off + 20, true);
      const patches = new Array(patchcount);
      for (let p = 0; p < patchcount; p++) {
        const poff = off + 22 + p * 10;
        const originx = view.getInt16(poff + 0, true);
        const originy = view.getInt16(poff + 2, true);
        const pnum    = view.getInt16(poff + 4, true);
        const lumpNum = patchlookup[pnum];
        if (lumpNum === -1) I_Error('R_InitTextures: Missing patch in texture ' + name);
        patches[p] = { originx, originy, patchLump: lumpNum };
      }
      out.push({ name, width, height, patchcount, patches });
    }
    return out;
  }

  const tex1 = readTextureLump('TEXTURE1');
  let tex2 = [];
  if (W_CheckNumForName('TEXTURE2') !== -1) tex2 = readTextureLump('TEXTURE2');
  textures = tex1.concat(tex2);
  numtextures = textures.length;
  texturewidthmask = new Int32Array(numtextures);
  textureheight    = new Int32Array(numtextures);
  for (let i = 0; i < numtextures; i++) {
    let j = 1;
    while (j * 2 <= textures[i].width) j <<= 1;
    texturewidthmask[i] = j - 1;
    textureheight[i] = textures[i].height << FRACBITS;
  }
  // Animation translation tables (identity by default).
  texturetranslation = new Int32Array(numtextures + 1);
  for (let i = 0; i < numtextures; i++) texturetranslation[i] = i;
}

// ---------- R_InitFlats ----------
export function R_InitFlats() {
  firstflat = W_GetNumForName('F_START') + 1;
  lastflat  = W_GetNumForName('F_END')   - 1;
  numflats  = lastflat - firstflat + 1;
  flattranslation = new Int32Array(numflats + 1);
  for (let i = 0; i < numflats; i++) flattranslation[i] = i;
}

// ---------- R_InitSpriteLumps ----------
export function R_InitSpriteLumps() {
  firstspritelump = W_GetNumForName('S_START') + 1;
  lastspritelump  = W_GetNumForName('S_END')   - 1;
  numspritelumps  = lastspritelump - firstspritelump + 1;
  spritewidth     = new Int32Array(numspritelumps);
  spriteoffset    = new Int32Array(numspritelumps);
  spritetopoffset = new Int32Array(numspritelumps);
  for (let i = 0; i < numspritelumps; i++) {
    const bytes = W_CacheLumpNum(firstspritelump + i, 0);
    const p = patch_t(bytes);
    spritewidth[i]     = p.width     << FRACBITS;
    spriteoffset[i]    = p.leftoffset << FRACBITS;
    spritetopoffset[i] = p.topoffset  << FRACBITS;
  }
}

// ---------- R_InitColormaps ----------
export function R_InitColormaps() {
  const lump = W_GetNumForName('COLORMAP');
  colormaps = new Uint8Array(W_LumpLength(lump));
  colormaps.set(W_CacheLumpNum(lump, 0));
}

// ---------- R_InitData ----------
export function R_InitData() {
  // Build palette RGBA once.
  const pal = W_CacheLumpName('PLAYPAL', 0);
  playpal_rgba = new Uint8Array(14 * 256 * 4);
  for (let p = 0; p < 14; p++) {
    for (let i = 0; i < 256; i++) {
      playpal_rgba[p * 1024 + i * 4 + 0] = pal[p * 768 + i * 3 + 0];
      playpal_rgba[p * 1024 + i * 4 + 1] = pal[p * 768 + i * 3 + 1];
      playpal_rgba[p * 1024 + i * 4 + 2] = pal[p * 768 + i * 3 + 2];
      playpal_rgba[p * 1024 + i * 4 + 3] = 255;
    }
  }
  R_InitTextures();
  R_InitFlats();
  R_InitSpriteLumps();
  R_InitColormaps();
  // Palette + COLORMAP textures are built once and shared by every wall /
  // flat ShaderMaterial. Sprites still use pre-decoded RGBA via THREE.Sprite.
  R_ShaderInit(playpal_rgba, colormaps);
}

// ---------- Composite texture builder (column posts -> RGBA) ----------
//
// Vanilla R_GenerateComposite (r_data.c:228) composites patches column-by-column
// into a paletted block. Columns covered by a single patch are accessed directly
// (R_GetColumn returns a pointer into the patch lump). Either way, gaps between
// posts are never written, which is what makes a "masked" texture (used as a
// two-sided midtexture via R_DrawMaskedColumn / R_RenderMaskedSegRange) show
// the world behind it.
//
// In the 3D port we bake the composite straight into RGBA, leaving un-painted
// pixels at alpha=0. r_segs.js then routes midtextures on two-sided linedefs
// into a separate bucket whose material uses alphaTest — the GL equivalent of
// vanilla's masked column path.
//
// Buffers are emitted as (indices, alphas) — kept as palette indices so the
// fragment shader can apply COLORMAP remap and palette lookup at sample time.
// R_MakeIndexedTexture packs them into an RG8 texture.
function buildTextureIndexed(texnum) {
  const t = textures[texnum];
  const w = t.width, h = t.height;
  const indices = new Uint8Array(w * h);
  const alphas  = new Uint8Array(w * h); // zero-initialised: alpha=0 = transparent
  for (const pp of t.patches) {
    const bytes = W_CacheLumpNum(pp.patchLump, 0);
    const p = patch_t(bytes);
    for (let col = 0; col < p.width; col++) {
      const tx = pp.originx + col;
      if (tx < 0 || tx >= w) continue;
      let colptr = p.columnofs(col);
      while (bytes[colptr] !== 0xff) {
        const topdelta = bytes[colptr];
        const length   = bytes[colptr + 1];
        const srcStart = colptr + 3;
        for (let i = 0; i < length; i++) {
          const ty = pp.originy + topdelta + i;
          if (ty < 0 || ty >= h) continue;
          const dst = ty * w + tx;
          indices[dst] = bytes[srcStart + i];
          alphas[dst]  = 255;
        }
        colptr += length + 4;
      }
    }
  }
  return { indices, alphas, w, h };
}

function buildFlatIndexed(flatnum) {
  const lumpnum = firstflat + flattranslation[flatnum];
  const bytes = W_CacheLumpNum(lumpnum, 0);
  // 64x64 paletted, always opaque.
  const indices = new Uint8Array(64 * 64);
  const alphas  = new Uint8Array(64 * 64);
  for (let i = 0; i < 64 * 64; i++) {
    indices[i] = bytes[i];
    alphas[i]  = 255;
  }
  return { indices, alphas, w: 64, h: 64 };
}

function makeIndexedTexture({ indices, alphas, w, h }) {
  return R_MakeIndexedTexture(indices, alphas, w, h);
}

export function R_GetFlatTexture(flatnum) {
  if (flatnum < 0 || flatnum >= numflats) return null;
  let tex = _flatTextureCache.get(flatnum);
  if (tex === undefined) {
    tex = makeIndexedTexture(buildFlatIndexed(flatnum));
    _flatTextureCache.set(flatnum, tex);
  }
  return tex;
}

export function R_GetWallTexture(texnum) {
  // Texture index 0 is a valid TEXTURE1 entry; the NoTexture marker is
  // already converted to 0 inside R_CheckTextureNumForName so callers handle
  // it separately. Only -1 means "missing/lookup failed".
  if (texnum < 0 || texnum >= numtextures) return null;
  let tex = _textureTextureCache.get(texnum);
  if (tex === undefined) {
    tex = makeIndexedTexture(buildTextureIndexed(texnum));
    _textureTextureCache.set(texnum, tex);
  }
  return tex;
}

// ---------- R_PrecacheLevel ----------
// In the 3D port this is a no-op — we lazily build Three.js textures on demand
// when geometry is constructed.
export function R_PrecacheLevel() {}

// ---------- Animated textures (P_InitPicAnims hook) ----------
// p_spec.c defines a list of (start, end, speed, isTexture) — each animation
// slot cycles every `speed` tics. Here we expose a per-frame mechanism for
// the play sim's P_UpdateSpecials to call, swapping the .map of all meshes
// using that texture/flat to the current frame's DataTexture.

const _animatedTextures = []; // { isTexture, start, end, speed }
const _meshesByTexnum   = new Map(); // texnum -> Set<mesh>
const _meshesByFlatnum  = new Map(); // flatnum -> Set<mesh>

export function R_RegisterWallMesh(texnum, mesh) {
  let s = _meshesByTexnum.get(texnum);
  if (s === undefined) { s = new Set(); _meshesByTexnum.set(texnum, s); }
  s.add(mesh);
}

// Drop every registered mesh. Called by R_NewMap before the old level group
// is torn down — otherwise these Maps keep the previous level's (disposed)
// meshes and their BufferGeometry attribute arrays alive, leaking ~1MB per
// level load.
export function R_ClearMeshRegistry() {
  _meshesByTexnum.clear();
  _meshesByFlatnum.clear();
}
export function R_RegisterFlatMesh(flatnum, mesh) {
  let s = _meshesByFlatnum.get(flatnum);
  if (s === undefined) { s = new Set(); _meshesByFlatnum.set(flatnum, s); }
  s.add(mesh);
}

// Silent flat lookup — return -1 if the lump isn't in the loaded WAD.
function R_CheckFlatNumForName(name) {
  const i = W_CheckNumForName(name);
  return i === -1 ? -1 : i - firstflat;
}

export function R_AddAnim(isTexture, startName, endName, speed) {
  const start = isTexture ? R_CheckTextureNumForName(startName) : R_CheckFlatNumForName(startName);
  const end   = isTexture ? R_CheckTextureNumForName(endName)   : R_CheckFlatNumForName(endName);
  if (start < 0 || end < 0 || end < start) return;
  _animatedTextures.push({ isTexture, start, end, speed });
}

// Default Doom animation table (p_spec.c's animdefs[]).
export function R_InitDefaultAnims() {
  // Flats.
  R_AddAnim(false, 'NUKAGE1', 'NUKAGE3', 8);
  R_AddAnim(false, 'FWATER1', 'FWATER4', 8);
  R_AddAnim(false, 'SWATER1', 'SWATER4', 8);
  R_AddAnim(false, 'LAVA1',   'LAVA4',   8);
  R_AddAnim(false, 'BLOOD1',  'BLOOD3',  8);
  R_AddAnim(false, 'RROCK05', 'RROCK08', 8);
  R_AddAnim(false, 'SLIME01', 'SLIME04', 8);
  R_AddAnim(false, 'SLIME05', 'SLIME08', 8);
  R_AddAnim(false, 'SLIME09', 'SLIME12', 8);
  // Walls.
  R_AddAnim(true, 'BLODGR1',  'BLODGR4',  8);
  R_AddAnim(true, 'SLADRIP1', 'SLADRIP3', 8);
  R_AddAnim(true, 'BLODRIP1', 'BLODRIP4', 8);
  R_AddAnim(true, 'FIREWALA', 'FIREWALL', 8);
  R_AddAnim(true, 'GSTFONT1', 'GSTFONT3', 8);
  R_AddAnim(true, 'FIRELAV3', 'FIRELAVA', 8);
  R_AddAnim(true, 'FIREMAG1', 'FIREMAG3', 8);
  R_AddAnim(true, 'FIREBLU1', 'FIREBLU2', 8);
  R_AddAnim(true, 'ROCKRED1', 'ROCKRED3', 8);
  R_AddAnim(true, 'BFALL1',   'BFALL4',   8);
  R_AddAnim(true, 'SFALL1',   'SFALL4',   8);
  R_AddAnim(true, 'WFALL1',   'WFALL4',   8);
  R_AddAnim(true, 'DBRAIN1',  'DBRAIN4',  8);
}

// Per-tic update — points every animated mesh's texture at the current frame.
// p_spec.c:1102-1108 P_UpdateSpecials: for each lump i in an animation's range,
//   texturetranslation[i] = basepic + ((leveltime/speed + i) % numpics)
// The `+ i` gives each frame in the cycle a per-index phase offset, so a surface
// drawn with a mid-cycle lump (e.g. NUKAGE2) animates one step out of phase from
// the base frame — we reproduce that here.
export function R_AnimateTextures(leveltime) {
  for (const a of _animatedTextures) {
    const numFrames = a.end - a.start + 1;
    const t = (leveltime / a.speed) | 0;
    const byNum = a.isTexture ? _meshesByTexnum : _meshesByFlatnum;
    for (let i = a.start; i <= a.end; i++) {
      const set = byNum.get(i);
      if (set === undefined) continue;
      const pic = a.start + ((t + i) % numFrames);
      const tex = a.isTexture ? R_GetWallTexture(pic) : R_GetFlatTexture(pic);
      if (tex === null) continue;
      // The wall/flat ShaderMaterial (R_MakeDoomMaterial) samples the `map`
      // uniform, NOT material.map — set the uniform so the swap actually renders.
      for (const m of set) m.material.uniforms.map.value = tex;
    }
  }
}
