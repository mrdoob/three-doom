// 2D overlay renderer for the player's "psprite" (weapon + muzzle flash).
// In linuxdoom this is part of r_things.c's masked-sprite path (R_DrawPlayerSprites);
// in the 3D port we render the same patches via Canvas2D since they live in
// screen space (no perspective).
//
// Each pspr entry references a state via player.psprites[].state which is an
// index into the global states[] table. The state has a sprite + frame; the
// sprite name + 'A' + '0' (rotation) gives the lump name (e.g. PISGA0).

import { sprnames, states } from './info.js';
import { sprites } from './r_things.js';
import { W_CacheLumpNum } from './w_wad.js';
import { firstspritelump, playpal_rgba } from './r_data.js';
import { patch_t } from './v_video.js';
import { SCREENWIDTH, SCREENHEIGHT } from './doomdef.js';

// Cache of decoded sprite lumps as ImageBitmap so the overlay paint is cheap.
const _cache = new Map();
function decodeAsCanvas(lumpIdx) {
  let entry = _cache.get(lumpIdx);
  if (entry !== undefined) return entry;
  const bytes = W_CacheLumpNum(firstspritelump + lumpIdx, 0);
  const p = patch_t(bytes);
  const c = document.createElement('canvas');
  c.width = p.width; c.height = p.height;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(p.width, p.height);
  for (let col = 0; col < p.width; col++) {
    let colptr = p.columnofs(col);
    while (bytes[colptr] !== 0xff) {
      const topdelta = bytes[colptr];
      const length   = bytes[colptr + 1];
      const src      = colptr + 3;
      for (let i = 0; i < length; i++) {
        const y = topdelta + i;
        const pal = bytes[src + i] * 4;
        const off = (y * p.width + col) * 4;
        img.data[off + 0] = playpal_rgba[pal + 0];
        img.data[off + 1] = playpal_rgba[pal + 1];
        img.data[off + 2] = playpal_rgba[pal + 2];
        img.data[off + 3] = 255;
      }
      colptr += length + 4;
    }
  }
  ctx.putImageData(img, 0, 0);
  entry = { canvas: c, w: p.width, h: p.height, leftoffset: p.leftoffset, topoffset: p.topoffset };
  _cache.set(lumpIdx, entry);
  return entry;
}

// Draw the player's psprites onto the overlay canvas. Called from D_Display
// after the 3D scene is painted. `overlayCtx` is the 2D context, `scale` is
// the upscale factor from 320×200 to the overlay's pixel size.
export function R_DrawPlayerSprites(overlayCtx, player, dstX, dstY, dstW, dstH) {
  if (player === null || player.mo === null) return;
  const sx = dstW / SCREENWIDTH;
  const sy = dstH / SCREENHEIGHT;
  for (const psp of player.psprites) {
    // Vanilla: `if (!psp->state) continue;` — state pointer NULL means inactive.
    // The JS port uses index 0 (S_NULL) or -1 as the inactive marker.
    if (psp.state === -1 || psp.state === 0 || psp.state == null) continue;
    const st = states[psp.state];
    if (st === undefined) continue;
    const sd = sprites[st.sprite];
    if (sd === undefined || sd.numframes === 0) continue;
    const frame = st.frame & 0x7fff;
    if (frame >= sd.numframes) continue;
    const sf = sd.spriteframes[frame];
    const lumpIdx = sf.lump[0];
    if (lumpIdx < 0) continue;
    const t = decodeAsCanvas(lumpIdx);
    // Ported from r_pspr.c:
    //   x1 = centerx + psp.sx - 160 - leftoffset  →  psp.sx - leftoffset (in pixels)
    //   patch_top_y = psp.sy - topoffset
    const patchX = (psp.sx >> 16) - t.leftoffset;
    const patchY = (psp.sy >> 16) - t.topoffset;
    overlayCtx.drawImage(
      t.canvas,
      0, 0, t.w, t.h,
      dstX + patchX * sx, dstY + patchY * sy,
      t.w * sx, t.h * sy
    );
  }
}
