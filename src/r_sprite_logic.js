// Pure sprite colour-selection helpers shared by the Canvas psprite path and
// the WebGL world-sprite path.  Keeping the integer decisions here makes the
// renderer's translation/COLORMAP precedence testable without a DOM or GL.

import {
  MAXLIGHTSCALE,
  REFERENCE_SCREENWIDTH,
  R_ScalelightRow,
} from './r_light_logic.js';

export const SPRITE_FF_FULLBRIGHT = 0x8000;
export const SPRITE_MF_NOSECTOR = 0x8;
export const SPRITE_MF_SHADOW = 0x40000;
export const SPRITE_MF_TRANSLATION = 0x0c000000;
export const SPRITE_MF_TRANSSHIFT = 26;

// A shadow canvas cache still needs some RGB value under its alpha mask even
// though the real fuzz compositor ignores that colour. Keep the historical
// index for cache/tests and direct-material diagnostics; production world and
// psprite rendering samples the composed screen instead.
export const SPRITE_SHADOW_PALETTE_INDEX = 5;

// A negative result is the explicit shadow/fuzz path; non-negative results
// are literal COLORMAP rows.
export const PSPRITE_SHADOW_ROW = -1;

// MF_NOSECTOR mobjs are deliberately absent from sector.thinglist. Vanilla's
// R_AddSprites can therefore never discover them, even though they remain in
// the thinker list (the MAP30 boss brain eye/targets are the stock examples).
export function R_MobjHasWorldSprite(flags) {
  return (flags & SPRITE_MF_NOSECTOR) === 0;
}

// r_things.c:R_DrawPlayerSprites blinks the weapon back to normal during the
// final four seconds of partial invisibility. MF_SHADOW remains set for that
// whole interval, so the power timer (not the mobj flag) must select fuzz.
export function R_IsPspriteInvisible(invisibilityPower) {
  return invisibilityPower > 4 * 32 || (invisibilityPower & 8) !== 0;
}

// r_things.c:R_DrawPlayerSprites / R_DrawPSprite selects the psprite drawer in
// this order: invisibility fuzz, fixed colormap, fullbright, normal lighting.
// Normal psprites always use scalelight[MAXLIGHTSCALE-1]. The selected table
// is rebuilt for scaledviewwidth, so reduced views darken that last entry by
// j*SCREENWIDTH/scaledviewwidth/DISTMAP just like walls and world sprites.
export function R_PspriteColormapRow(
  invisible,
  fixedColormap,
  frame,
  sectorLightLevel,
  extralight,
  scaledViewWidth = REFERENCE_SCREENWIDTH,
) {
  if (invisible) return PSPRITE_SHADOW_ROW;
  if (fixedColormap !== 0) return fixedColormap;
  if ((frame & SPRITE_FF_FULLBRIGHT) !== 0) return 0;

  return R_ScalelightRow(
    sectorLightLevel >> 4,
    extralight,
    MAXLIGHTSCALE - 1,
    scaledViewWidth,
  );
}

// Resolve one patch palette index through the already-selected psprite mode.
// PLAYPAL is intentionally not consulted here: the returned palette index is
// resolved through the active PLAYPAL only when the Canvas cache is painted.
export function R_RemapPspriteIndex(sourceIndex, colormapRow, colormaps) {
  // Only the alpha channel of this cached shadow image is consumed by the
  // framebuffer fuzz path.
  if (colormapRow === PSPRITE_SHADOW_ROW) return SPRITE_SHADOW_PALETTE_INDEX;
  return colormaps[colormapRow * 256 + sourceIndex];
}

// Players 2-4 reuse the green PLAY sprite lumps. Vanilla encodes their colour
// table in MF_TRANSLATION and changes only the green 0x70..0x7f ramp before
// the selected COLORMAP is applied.
const PLAYER_TRANSLATION_BASE = [0x70, 0x60, 0x40, 0x20];

export function R_PlayerTranslationFromFlags(flags) {
  return (flags & SPRITE_MF_TRANSLATION) >>> SPRITE_MF_TRANSSHIFT;
}

export function R_TranslatePlayerPaletteIndex(sourceIndex, translation) {
  if (translation === 0 || sourceIndex < 0x70 || sourceIndex > 0x7f) return sourceIndex;
  return PLAYER_TRANSLATION_BASE[translation] + (sourceIndex - 0x70);
}
