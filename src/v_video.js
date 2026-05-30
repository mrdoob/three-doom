// Ported from: linuxdoom-1.10/v_video.c
// Gamma correction LUT, patch drawing (by post), block blit.

import { SCREENWIDTH, SCREENHEIGHT, RANGECHECK } from './doomdef.js';
import { I_Error, I_AllocLow } from './i_system.js';
import { M_AddToBox } from './m_bbox.js';
import { W_CheckNumForName, W_CacheLumpNum } from './w_wad.js';
import { playpal_rgba } from './r_data.js';

// ----- patch_t accessor -----
// In C, patch_t is a struct overlaid onto raw lump bytes. In JS we wrap the
// raw bytes plus a DataView and expose getters. Patches always come from a
// WAD lump, i.e. a Uint8Array view into the file buffer.
export function patch_t(bytes) {
  // bytes: Uint8Array (subarray into a file buffer)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    bytes,
    view,
    get width()      { return view.getInt16(0, true); },
    get height()     { return view.getInt16(2, true); },
    get leftoffset() { return view.getInt16(4, true); },
    get topoffset()  { return view.getInt16(6, true); },
    columnofs(col)   { return view.getInt32(8 + col * 4, true); },
  };
}

// Lift the gamma table verbatim from v_video.c.
export const gammatable = [
  new Uint8Array([
    1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,
    17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,
    33,34,35,36,37,38,39,40,41,42,43,44,45,46,47,48,
    49,50,51,52,53,54,55,56,57,58,59,60,61,62,63,64,
    65,66,67,68,69,70,71,72,73,74,75,76,77,78,79,80,
    81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,
    97,98,99,100,101,102,103,104,105,106,107,108,109,110,111,112,
    113,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,
    128,129,130,131,132,133,134,135,136,137,138,139,140,141,142,143,
    144,145,146,147,148,149,150,151,152,153,154,155,156,157,158,159,
    160,161,162,163,164,165,166,167,168,169,170,171,172,173,174,175,
    176,177,178,179,180,181,182,183,184,185,186,187,188,189,190,191,
    192,193,194,195,196,197,198,199,200,201,202,203,204,205,206,207,
    208,209,210,211,212,213,214,215,216,217,218,219,220,221,222,223,
    224,225,226,227,228,229,230,231,232,233,234,235,236,237,238,239,
    240,241,242,243,244,245,246,247,248,249,250,251,252,253,254,255
  ]),
  new Uint8Array([
    2,4,5,7,8,10,11,12,14,15,16,18,19,20,21,23,24,25,26,27,29,30,31,
    32,33,34,36,37,38,39,40,41,42,44,45,46,47,48,49,50,51,52,54,55,
    56,57,58,59,60,61,62,63,64,65,66,67,69,70,71,72,73,74,75,76,77,
    78,79,80,81,82,83,84,85,86,87,88,89,90,91,92,93,94,95,96,97,98,
    99,100,101,102,103,104,105,106,107,108,109,110,111,112,113,114,
    115,116,117,118,119,120,121,122,123,124,125,126,127,128,129,129,
    130,131,132,133,134,135,136,137,138,139,140,141,142,143,144,145,
    146,147,148,148,149,150,151,152,153,154,155,156,157,158,159,160,
    161,162,163,163,164,165,166,167,168,169,170,171,172,173,174,175,
    175,176,177,178,179,180,181,182,183,184,185,186,186,187,188,189,
    190,191,192,193,194,195,196,196,197,198,199,200,201,202,203,204,
    205,205,206,207,208,209,210,211,212,213,214,214,215,216,217,218,
    219,220,221,222,222,223,224,225,226,227,228,229,230,230,231,232,
    233,234,235,236,237,237,238,239,240,241,242,243,244,245,245,246,
    247,248,249,250,251,252,252,253,254,255
  ]),
  new Uint8Array([
    4,7,9,11,13,15,17,19,21,22,24,26,27,29,30,32,33,35,36,38,39,40,42,
    43,45,46,47,48,50,51,52,54,55,56,57,59,60,61,62,63,65,66,67,68,69,
    70,72,73,74,75,76,77,78,79,80,82,83,84,85,86,87,88,89,90,91,92,93,
    94,95,96,97,98,100,101,102,103,104,105,106,107,108,109,110,111,112,
    113,114,114,115,116,117,118,119,120,121,122,123,124,125,126,127,128,
    129,130,131,132,133,133,134,135,136,137,138,139,140,141,142,143,144,
    144,145,146,147,148,149,150,151,152,153,153,154,155,156,157,158,159,
    160,160,161,162,163,164,165,166,166,167,168,169,170,171,172,172,173,
    174,175,176,177,178,178,179,180,181,182,183,183,184,185,186,187,188,
    188,189,190,191,192,193,193,194,195,196,197,197,198,199,200,201,201,
    202,203,204,205,206,206,207,208,209,210,210,211,212,213,213,214,215,
    216,217,217,218,219,220,221,221,222,223,224,224,225,226,227,228,228,
    229,230,231,231,232,233,234,235,235,236,237,238,238,239,240,241,241,
    242,243,244,244,245,246,247,247,248,249,250,251,251,252,253,254,254,
    255
  ]),
  new Uint8Array([
    8,12,16,19,22,24,27,29,31,34,36,38,40,41,43,45,47,49,50,52,53,55,
    57,58,60,61,63,64,65,67,68,70,71,72,74,75,76,77,79,80,81,82,84,85,
    86,87,88,90,91,92,93,94,95,96,98,99,100,101,102,103,104,105,106,107,
    108,109,110,111,112,113,114,115,116,117,118,119,120,121,122,123,124,
    125,126,127,128,129,130,131,132,133,134,135,135,136,137,138,139,140,
    141,142,143,143,144,145,146,147,148,149,150,150,151,152,153,154,155,
    155,156,157,158,159,160,160,161,162,163,164,165,165,166,167,168,169,
    169,170,171,172,173,173,174,175,176,176,177,178,179,180,180,181,182,
    183,183,184,185,186,186,187,188,189,189,190,191,192,192,193,194,195,
    195,196,197,197,198,199,200,200,201,202,202,203,204,205,205,206,207,
    207,208,209,210,210,211,212,212,213,214,214,215,216,216,217,218,219,
    219,220,221,221,222,223,223,224,225,225,226,227,227,228,229,229,230,
    231,231,232,233,233,234,235,235,236,237,237,238,238,239,240,240,241,
    242,242,243,244,244,245,246,246,247,247,248,249,249,250,251,251,252,
    253,253,254,254,255
  ]),
  new Uint8Array([
    16,23,28,32,36,39,42,45,48,50,53,55,57,60,62,64,66,68,69,71,73,75,76,
    78,80,81,83,84,86,87,89,90,92,93,94,96,97,98,100,101,102,103,105,106,
    107,108,109,110,112,113,114,115,116,117,118,119,120,121,122,123,124,
    125,126,128,128,129,130,131,132,133,134,135,136,137,138,139,140,141,
    142,143,143,144,145,146,147,148,149,150,150,151,152,153,154,155,155,
    156,157,158,159,159,160,161,162,163,163,164,165,166,166,167,168,169,
    169,170,171,172,172,173,174,175,175,176,177,177,178,179,180,180,181,
    182,182,183,184,184,185,186,187,187,188,189,189,190,191,191,192,193,
    193,194,195,195,196,196,197,198,198,199,200,200,201,202,202,203,203,
    204,205,205,206,207,207,208,208,209,210,210,211,211,212,213,213,214,
    214,215,216,216,217,217,218,219,219,220,220,221,221,222,223,223,224,
    224,225,225,226,227,227,228,228,229,229,230,230,231,232,232,233,233,
    234,234,235,235,236,236,237,237,238,239,239,240,240,241,241,242,242,
    243,243,244,244,245,245,246,246,247,247,248,248,249,249,250,250,251,
    251,252,252,253,254,254,255,255
  ]),
];

export let usegamma = 0;
export function set_usegamma(v) { usegamma = v | 0; }

// 5 paletted screens, SCREENWIDTH*SCREENHEIGHT each.
export const screens = [null, null, null, null, null];
export const dirtybox = new Int32Array(4);

// Allocates buffer screens, call before R_Init.
export function V_Init() {
  const base = I_AllocLow(SCREENWIDTH * SCREENHEIGHT * 4);
  for (let i = 0; i < 4; i++) {
    screens[i] = new Uint8Array(base.buffer, i * SCREENWIDTH * SCREENHEIGHT, SCREENWIDTH * SCREENHEIGHT);
  }
  // Screen 4 (for status bar background) — allocate a separate buffer.
  screens[4] = new Uint8Array(SCREENWIDTH * SCREENHEIGHT);
}

export function V_MarkRect(x, y, width, height) {
  M_AddToBox(dirtybox, x, y);
  M_AddToBox(dirtybox, x + width - 1, y + height - 1);
}

export function V_CopyRect(srcx, srcy, srcscrn, width, height, destx, desty, destscrn) {
  if (RANGECHECK) {
    if (srcx < 0 || srcx + width > SCREENWIDTH ||
        srcy < 0 || srcy + height > SCREENHEIGHT ||
        destx < 0 || destx + width > SCREENWIDTH ||
        desty < 0 || desty + height > SCREENHEIGHT ||
        (srcscrn >>> 0) > 4 || (destscrn >>> 0) > 4) {
      I_Error('Bad V_CopyRect');
    }
  }
  V_MarkRect(destx, desty, width, height);
  const src = screens[srcscrn];
  const dest = screens[destscrn];
  for (let row = 0; row < height; row++) {
    const sOff = (srcy + row) * SCREENWIDTH + srcx;
    const dOff = (desty + row) * SCREENWIDTH + destx;
    dest.set(src.subarray(sOff, sOff + width), dOff);
  }
}

// V_DrawPatch: masks a column-based pic into a paletted screen buffer.
export function V_DrawPatch(x, y, scrn, patch) {
  y -= patch.topoffset;
  x -= patch.leftoffset;
  const w = patch.width;
  const h = patch.height;
  if (RANGECHECK) {
    if (x < 0 || x + w > SCREENWIDTH || y < 0 || y + h > SCREENHEIGHT || (scrn >>> 0) > 4) {
      console.warn(`V_DrawPatch: bad patch at ${x},${y} (${w}x${h}) — ignoring`);
      return;
    }
  }
  if (scrn === 0) V_MarkRect(x, y, w, h);

  const dst   = screens[scrn];
  const bytes = patch.bytes;
  let desttop = y * SCREENWIDTH + x;

  for (let col = 0; col < w; col++, desttop++) {
    let colptr = patch.columnofs(col);
    while (bytes[colptr] !== 0xff) {
      const topdelta = bytes[colptr];
      const length   = bytes[colptr + 1];
      // bytes[colptr + 2] is padding
      const srcStart = colptr + 3;
      let dPos = desttop + topdelta * SCREENWIDTH;
      for (let i = 0; i < length; i++) {
        dst[dPos] = bytes[srcStart + i];
        dPos += SCREENWIDTH;
      }
      colptr += length + 4; // pad-end byte
    }
  }
}

// V_DrawPatchFlipped: same but mirrored on X.
export function V_DrawPatchFlipped(x, y, scrn, patch) {
  y -= patch.topoffset;
  x -= patch.leftoffset;
  const w = patch.width;
  const h = patch.height;
  if (RANGECHECK) {
    if (x < 0 || x + w > SCREENWIDTH || y < 0 || y + h > SCREENHEIGHT || (scrn >>> 0) > 4) {
      I_Error(`Bad V_DrawPatch in V_DrawPatchFlipped (${x},${y} ${w}x${h})`);
    }
  }
  if (scrn === 0) V_MarkRect(x, y, w, h);

  const dst   = screens[scrn];
  const bytes = patch.bytes;
  let desttop = y * SCREENWIDTH + x;

  for (let col = 0; col < w; col++, desttop++) {
    let colptr = patch.columnofs(w - 1 - col);
    while (bytes[colptr] !== 0xff) {
      const topdelta = bytes[colptr];
      const length   = bytes[colptr + 1];
      const srcStart = colptr + 3;
      let dPos = desttop + topdelta * SCREENWIDTH;
      for (let i = 0; i < length; i++) {
        dst[dPos] = bytes[srcStart + i];
        dPos += SCREENWIDTH;
      }
      colptr += length + 4;
    }
  }
}

// V_DrawPatchDirect is identical to V_DrawPatch in the linuxdoom port (the C
// version had a planar VGA path commented out).
export function V_DrawPatchDirect(x, y, scrn, patch) {
  V_DrawPatch(x, y, scrn, patch);
}

// V_DrawBlock: blit `width*height` bytes of `src` into screen `scrn` at (x,y).
export function V_DrawBlock(x, y, scrn, width, height, src) {
  if (RANGECHECK) {
    if (x < 0 || x + width > SCREENWIDTH || y < 0 || y + height > SCREENHEIGHT || (scrn >>> 0) > 4) {
      I_Error('Bad V_DrawBlock');
    }
  }
  V_MarkRect(x, y, width, height);
  const dst = screens[scrn];
  for (let row = 0; row < height; row++) {
    const sOff = row * width;
    const dOff = (y + row) * SCREENWIDTH + x;
    dst.set(src.subarray(sOff, sOff + width), dOff);
  }
}

// V_GetBlock: copy `width*height` bytes out of screen `scrn` into `dest`.
export function V_GetBlock(x, y, scrn, width, height, dest) {
  if (RANGECHECK) {
    if (x < 0 || x + width > SCREENWIDTH || y < 0 || y + height > SCREENHEIGHT || (scrn >>> 0) > 4) {
      I_Error('Bad V_DrawBlock');
    }
  }
  const src = screens[scrn];
  for (let row = 0; row < height; row++) {
    const sOff = (y + row) * SCREENWIDTH + x;
    const dOff = row * width;
    dest.set(src.subarray(sOff, sOff + width), dOff);
  }
}

// V_DecodePatchToCanvas — decode a WAD patch lump to an off-screen Canvas
// once and cache it. Returns `{ canvas, w, h, leftoffset, topoffset }` or
// null if the lump is missing.
const _patchCanvasCache = new Map();
// External PNG files registered as patches (e.g. UI graphics that aren't in
// the WAD). Lookup wins over the WAD path so callers don't need to know.
const _pngOverrides = new Map();
// Load a PNG from `url` and expose it under `name` so V_DecodePatchToCanvas
// returns it like a WAD patch. Asynchronous: until the image finishes
// loading, the lookup falls through (the menu drawer's text fallback covers
// the gap).
export function V_RegisterPNGPatch(name, url, leftoffset = 0, topoffset = 0) {
  const img = new Image();
  img.onload = () => {
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    _pngOverrides.set(name, { canvas: c, w: c.width, h: c.height, leftoffset, topoffset });
  };
  img.onerror = () => {
    console.warn(`V_RegisterPNGPatch: failed to load "${name}" from ${url}`);
  };
  img.src = url;
}
export function V_DecodePatchToCanvas(name) {
  const override = _pngOverrides.get(name);
  if (override !== undefined) return override;
  if (_patchCanvasCache.has(name)) return _patchCanvasCache.get(name);
  const lumpNum = W_CheckNumForName(name);
  if (lumpNum === -1) { _patchCanvasCache.set(name, null); return null; }
  const bytes = W_CacheLumpNum(lumpNum, 0);
  const p = patch_t(bytes);
  const c = document.createElement('canvas');
  c.width = p.width; c.height = p.height;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(p.width, p.height);
  for (let col = 0; col < p.width; col++) {
    let cp = p.columnofs(col);
    while (bytes[cp] !== 0xff) {
      const top = bytes[cp], len = bytes[cp + 1], src = cp + 3;
      for (let i = 0; i < len; i++) {
        const yy = top + i;
        const pal = bytes[src + i] * 4;
        const off = (yy * p.width + col) * 4;
        img.data[off + 0] = playpal_rgba[pal + 0];
        img.data[off + 1] = playpal_rgba[pal + 1];
        img.data[off + 2] = playpal_rgba[pal + 2];
        img.data[off + 3] = 255;
      }
      cp += len + 4;
    }
  }
  ctx.putImageData(img, 0, 0);
  const info = { canvas: c, w: p.width, h: p.height, leftoffset: p.leftoffset, topoffset: p.topoffset };
  _patchCanvasCache.set(name, info);
  return info;
}

// V_DrawPatchAtCanvas — mirror of V_DrawPatch's leftoffset/topoffset subtract,
// for Canvas2D drawing of decoded patches. Pairs with V_DecodePatchToCanvas.
export function V_DrawPatchAtCanvas(ctx, info, x, y, sx = 1, sy = 1) {
  if (info === null) return;
  ctx.drawImage(info.canvas, x - info.leftoffset * sx, y - info.topoffset * sy, info.w * sx, info.h * sy);
}
