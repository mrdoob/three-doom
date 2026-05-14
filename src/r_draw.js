// Ported from: linuxdoom-1.10/r_draw.c, r_draw.h
// The original software column/span rasterizer. Three-Doom's WebGL pipeline
// does not call into this — Three.js rasterises wall/floor/ceiling geometry
// directly — but the C functions are ported here verbatim against the
// `screens[0]` paletted framebuffer so anyone wanting a software fallback,
// reference verification, or 1:1 source mapping has it available.

import { SCREENWIDTH, SCREENHEIGHT } from './doomdef.js';
import { I_Error } from './i_system.js';
import { screens } from './v_video.js';

// Drawing-state inputs, matching the C globals.
export let dc_x = 0, dc_yl = 0, dc_yh = 0;
export let dc_iscale = 0, dc_texturemid = 0;
export let dc_source = null;     // 128-byte column source
export let dc_colormap = null;   // 256-byte lighting/colormap LUT
export let dc_translation = null;
export let dc_translevel = 0;

export let ds_y = 0, ds_x1 = 0, ds_x2 = 0;
export let ds_xfrac = 0, ds_yfrac = 0;
export let ds_xstep = 0, ds_ystep = 0;
export let ds_source = null;     // 4096-byte (64x64) flat
export let ds_colormap = null;

export let centery = SCREENHEIGHT >> 1;
export let viewwindowx = 0, viewwindowy = 0;
export let viewwidth = SCREENWIDTH, viewheight = SCREENHEIGHT;

export function set_dc(args) {
  if (args.x !== undefined)          dc_x = args.x;
  if (args.yl !== undefined)         dc_yl = args.yl;
  if (args.yh !== undefined)         dc_yh = args.yh;
  if (args.iscale !== undefined)     dc_iscale = args.iscale;
  if (args.texturemid !== undefined) dc_texturemid = args.texturemid;
  if (args.source !== undefined)     dc_source = args.source;
  if (args.colormap !== undefined)   dc_colormap = args.colormap;
  if (args.translation !== undefined) dc_translation = args.translation;
  if (args.translevel !== undefined) dc_translevel = args.translevel;
}
export function set_ds(args) {
  if (args.y !== undefined)        ds_y = args.y;
  if (args.x1 !== undefined)       ds_x1 = args.x1;
  if (args.x2 !== undefined)       ds_x2 = args.x2;
  if (args.xfrac !== undefined)    ds_xfrac = args.xfrac;
  if (args.yfrac !== undefined)    ds_yfrac = args.yfrac;
  if (args.xstep !== undefined)    ds_xstep = args.xstep;
  if (args.ystep !== undefined)    ds_ystep = args.ystep;
  if (args.source !== undefined)   ds_source = args.source;
  if (args.colormap !== undefined) ds_colormap = args.colormap;
}

// Pre-computed row offsets into screens[0]. R_InitBuffer fills these.
const ylookup    = new Int32Array(SCREENHEIGHT);
const columnofs  = new Int32Array(SCREENWIDTH);

export function R_InitBuffer(width, height) {
  viewwindowx = (SCREENWIDTH - width) >> 1;
  viewwindowy = (height === SCREENHEIGHT)
    ? 0
    : (SCREENHEIGHT - 32 /*ST_HEIGHT*/ - height) >> 1;
  for (let i = 0; i < width; i++) columnofs[i] = viewwindowx + i;
  for (let i = 0; i < height; i++) ylookup[i] = (i + viewwindowy) * SCREENWIDTH;
  viewwidth = width;
  viewheight = height;
  centery = viewheight >> 1;
}

// R_DrawColumn — vanilla inner loop: DDA-style 1-column texture mapping.
export function R_DrawColumn() {
  let count = dc_yh - dc_yl;
  if (count < 0) return;
  if (dc_x >>> 0 >= SCREENWIDTH || dc_yl < 0 || dc_yh >= SCREENHEIGHT) {
    I_Error(`R_DrawColumn: ${dc_yl} to ${dc_yh} at ${dc_x}`);
  }
  const fb = screens[0];
  let dest = ylookup[dc_yl] + columnofs[dc_x];
  const fracstep = dc_iscale;
  let frac = (dc_texturemid + (dc_yl - centery) * fracstep) | 0;
  do {
    fb[dest] = dc_colormap[dc_source[(frac >> 16) & 127]];
    dest += SCREENWIDTH;
    frac = (frac + fracstep) | 0;
  } while (count-- > 0);
}

// R_DrawFuzzColumn — semi-transparent shadow effect (spectres / invisibility).
// Vanilla uses a fixed fuzz offset table; we port the table verbatim.
const FUZZTABLE = 50;
const fuzzoffset = new Int32Array([
   1,-1, 1,-1, 1, 1,-1,  1, 1,-1, 1, 1, 1,-1, 1, 1,
   1,-1,-1,-1,-1, 1,-1, -1, 1, 1, 1, 1,-1, 1,-1, 1,
   1,-1,-1, 1, 1,-1,-1, -1,-1, 1, 1, 1, 1,-1, 1, 1,
  -1, 1,
].map(v => v * SCREENWIDTH));
let fuzzpos = 0;

export function R_DrawFuzzColumn() {
  if (dc_yl === 0) dc_yl = 1;
  if (dc_yh === viewheight - 1) dc_yh = viewheight - 2;
  let count = dc_yh - dc_yl;
  if (count < 0) return;
  if (dc_x >>> 0 >= SCREENWIDTH || dc_yl < 0 || dc_yh >= SCREENHEIGHT) {
    I_Error(`R_DrawFuzzColumn: ${dc_yl} to ${dc_yh} at ${dc_x}`);
  }
  const fb = screens[0];
  let dest = ylookup[dc_yl] + columnofs[dc_x];
  // Vanilla's COLORMAP row 6 (the dim row).
  const cmap = dc_colormap; // caller should pass colormaps + 6*256 in software path
  do {
    fb[dest] = cmap[fb[dest + fuzzoffset[fuzzpos]]];
    fuzzpos = (fuzzpos + 1) % FUZZTABLE;
    dest += SCREENWIDTH;
  } while (count-- > 0);
}

// R_DrawTranslatedColumn — player sprites (multiplayer body colours).
export function R_DrawTranslatedColumn() {
  let count = dc_yh - dc_yl;
  if (count < 0) return;
  if (dc_x >>> 0 >= SCREENWIDTH || dc_yl < 0 || dc_yh >= SCREENHEIGHT) {
    I_Error(`R_DrawColumn: ${dc_yl} to ${dc_yh} at ${dc_x}`);
  }
  const fb = screens[0];
  let dest = ylookup[dc_yl] + columnofs[dc_x];
  const fracstep = dc_iscale;
  let frac = (dc_texturemid + (dc_yl - centery) * fracstep) | 0;
  do {
    fb[dest] = dc_colormap[dc_translation[dc_source[frac >> 16]]];
    dest += SCREENWIDTH;
    frac = (frac + fracstep) | 0;
  } while (count-- > 0);
}

// R_InitTranslationTables — three translation maps (green→indigo, brown, red)
// used for cooperative deathmatch player colours.
export const translationtables = new Uint8Array(256 * 3);
export function R_InitTranslationTables() {
  for (let i = 0; i < 256; i++) {
    if (i >= 0x70 && i <= 0x7f) {
      translationtables[i]       = 0x60 + (i & 0xf); // -> grey
      translationtables[i + 256] = 0x40 + (i & 0xf); // -> brown
      translationtables[i + 512] = 0x20 + (i & 0xf); // -> red
    } else {
      translationtables[i] = translationtables[i + 256] = translationtables[i + 512] = i;
    }
  }
}

// R_DrawSpan — horizontal flat (floor/ceiling) span.
export function R_DrawSpan() {
  if (ds_x2 < ds_x1 || ds_x1 < 0 || ds_x2 >= SCREENWIDTH || ds_y >= SCREENHEIGHT) {
    I_Error(`R_DrawSpan: ${ds_x1} to ${ds_x2} at ${ds_y}`);
  }
  const fb = screens[0];
  let xfrac = ds_xfrac, yfrac = ds_yfrac;
  let dest = ylookup[ds_y] + columnofs[ds_x1];
  let count = ds_x2 - ds_x1;
  do {
    const spot = ((yfrac >> (16 - 6)) & (63 * 64)) + ((xfrac >> 16) & 63);
    fb[dest++] = ds_colormap[ds_source[spot]];
    xfrac = (xfrac + ds_xstep) | 0;
    yfrac = (yfrac + ds_ystep) | 0;
  } while (count-- > 0);
}

// R_FillBackScreen / R_DrawViewBorder — paint the bezel around the playfield
// when the view-size is reduced. The 3D port doesn't shrink the view, so we
// leave these as functional no-ops.
export function R_FillBackScreen() {}
export function R_DrawViewBorder() {}

// R_VideoErase — used by the screen-wipe to lift pixels from screens[1].
export function R_VideoErase(ofs, count) {
  const src = screens[1];
  const dst = screens[0];
  if (src === null || dst === null) return;
  for (let i = 0; i < count; i++) dst[ofs + i] = src[ofs + i];
}
