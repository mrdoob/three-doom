// 2D overlay renderer for the player's "psprite" (weapon + muzzle flash).
// In linuxdoom this is part of r_things.c's masked-sprite path (R_DrawPlayerSprites);
// in the 3D port we render the same patches via Canvas2D since they live in
// screen space (no perspective).
//
// Each pspr entry references a state via player.psprites[].state which is an
// index into the global states[] table. The state has a sprite + frame; the
// sprite name + 'A' + '0' (rotation) gives the lump name (e.g. PISGA0).

import { states } from './info.js';
import { sprites } from './r_things.js';
import { weaponinfo } from './d_items.js';
import { W_CacheLumpNum } from './w_wad.js';
import { colormaps, firstspritelump } from './r_data.js';
import { patch_t } from './v_video.js';
import { V_GetActivePalette, V_GetPaletteRevision } from './v_palette.js';
import { gamemode } from './doomstat.js';
import { GameMode_t, powertype_t, SCREENWIDTH, SCREENHEIGHT } from './doomdef.js';
import {
  PSPRITE_SHADOW_ROW,
  R_IsPspriteInvisible,
  R_PspriteColormapRow,
  SPRITE_SHADOW_PALETTE_INDEX,
} from './r_sprite_logic.js';
import {
  R_GetFuzzPhase,
  R_GetPspriteFuzzCapture,
  R_RasterizeFuzzPatch,
  R_SetFuzzPhase,
} from './r_fuzz.js';
import {
  R_DrawPspritePatch,
  R_ProjectPspritePatch,
  R_PspritePatchBounds,
} from './r_psprite_projection.js';

// Cache source indices and one reusable Canvas per patch. Lighting/palette
// changes repaint that Canvas in place; they do not allocate a remapped array,
// ImageData, or a new Canvas during R_DrawPlayerSprites.
const _cache = new Map();
let _sourceBuilds = 0;
let _canvasBuilds = 0;
let _canvasRepaints = 0;
let _fuzzOutputCanvas = null;
let _fuzzOutputContext = null;
let _fuzzOutputImage = null;
let _fuzzWorkingIndices = null;
let _fuzzOutputIndices = null;
let _fuzzOutputAlpha = null;
export function R_ShutdownPlayerSprites() {
  _cache.clear();
  _sourceBuilds = 0;
  _canvasBuilds = 0;
  _canvasRepaints = 0;
  if (_fuzzOutputCanvas !== null) {
    _fuzzOutputCanvas.width = 0;
    _fuzzOutputCanvas.height = 0;
  }
  _fuzzOutputCanvas = null;
  _fuzzOutputContext = null;
  _fuzzOutputImage = null;
  _fuzzWorkingIndices = null;
  _fuzzOutputIndices = null;
  _fuzzOutputAlpha = null;
  R_SetFuzzPhase(0);
}
function decodePatch(lumpIdx) {
  let entry = _cache.get(lumpIdx);
  if (entry !== undefined) return entry;
  const bytes = W_CacheLumpNum(firstspritelump + lumpIdx, 0);
  const p = patch_t(bytes);
  const indices = new Uint8Array(p.width * p.height);
  const alphas = new Uint8Array(p.width * p.height);
  for (let col = 0; col < p.width; col++) {
    let colptr = p.columnofs(col);
    while (bytes[colptr] !== 0xff) {
      const topdelta = bytes[colptr];
      const length   = bytes[colptr + 1];
      const src      = colptr + 3;
      for (let i = 0; i < length; i++) {
        const y = topdelta + i;
        const dst = y * p.width + col;
        indices[dst] = bytes[src + i];
        alphas[dst] = 255;
      }
      colptr += length + 4;
    }
  }
  entry = {
    indices,
    alphas,
    w: p.width,
    h: p.height,
    leftoffset: p.leftoffset,
    topoffset: p.topoffset,
    canvasInfo: null,
  };
  _cache.set(lumpIdx, entry);
  _sourceBuilds++;
  return entry;
}

function createReusableCanvasInfo(source) {
  const canvas = document.createElement('canvas');
  canvas.width = source.w;
  canvas.height = source.h;
  const context = canvas.getContext('2d');
  const image = context.createImageData(source.w, source.h);
  let selectedRow = 0;
  let selectedMaps = colormaps;
  let renderedRow = null;
  let renderedMaps = null;
  let renderedRevision = -1;

  const info = {
    w: source.w,
    h: source.h,
    leftoffset: source.leftoffset,
    topoffset: source.topoffset,
    select(row, maps) {
      selectedRow = row;
      selectedMaps = maps;
    },
  };
  Object.defineProperty(info, 'canvas', {
    enumerable: true,
    get() {
      const revision = V_GetPaletteRevision();
      if (renderedRow !== selectedRow || renderedMaps !== selectedMaps ||
          renderedRevision !== revision) {
        const palette = V_GetActivePalette();
        for (let i = 0; i < source.indices.length; i++) {
          const paletteIndex = selectedRow === PSPRITE_SHADOW_ROW
            ? SPRITE_SHADOW_PALETTE_INDEX
            : selectedMaps[selectedRow * 256 + source.indices[i]];
          const src = paletteIndex * 4;
          const dst = i * 4;
          image.data[dst + 0] = palette[src + 0];
          image.data[dst + 1] = palette[src + 1];
          image.data[dst + 2] = palette[src + 2];
          image.data[dst + 3] = source.alphas[i];
        }
        context.putImageData(image, 0, 0);
        renderedRow = selectedRow;
        renderedMaps = selectedMaps;
        renderedRevision = revision;
        _canvasRepaints++;
      }
      return canvas;
    },
  });
  _canvasBuilds++;
  return info;
}

// Select the palette-index image used by R_DrawPSprite. The returned object is
// the source patch's one reusable view; callers consume `.canvas` immediately
// before another row may be selected for the same patch.
export function R_CreatePspriteCanvasInfo(source, colormapRow, maps = colormaps) {
  if (source.canvasInfo === null || source.canvasInfo === undefined) {
    source.canvasInfo = createReusableCanvasInfo(source);
  }
  source.canvasInfo.select(colormapRow, maps);
  return source.canvasInfo;
}

function collectStateSprites(root, stateSprites, visited) {
  let stateIndex = root;
  while (Number.isInteger(stateIndex) && stateIndex > 0 && !visited.has(stateIndex)) {
    visited.add(stateIndex);
    const state = states[stateIndex];
    if (state === undefined || state === null) break;
    // P_SetPsprite immediately skips zero-tic states, so their synthetic frame
    // numbers (notably S_LIGHTDONE) must not be decoded.
    if (state.tics !== 0) stateSprites.add(state.sprite);
    stateIndex = state.nextstate;
  }
}

// Decode every stock weapon/flash family once. Cheats can grant weapons that
// were not owned at level start, so coverage is based on weaponinfo rather
// than the current inventory. Current restored psprite states are included for
// completeness before the first post-load frame.
export function R_PrecachePlayerSprites(players = []) {
  if (sprites === null) return R_GetPspriteCacheStats();
  const stateSprites = new Set();
  const visited = new Set();
  for (let weapon = 0; weapon < weaponinfo.length; weapon++) {
    if (gamemode === GameMode_t.shareware && (weapon === 5 || weapon === 6 || weapon === 8)) continue;
    if (gamemode !== GameMode_t.commercial && weapon === 8) continue;
    const info = weaponinfo[weapon];
    for (const root of [
      info.upstate, info.downstate, info.readystate, info.atkstate, info.flashstate,
    ]) collectStateSprites(root, stateSprites, visited);
    // Chaingun and plasma choose one of two sibling flash roots directly.
    if ((weapon === 3 || weapon === 5) && info.flashstate > 0) {
      collectStateSprites(info.flashstate + 1, stateSprites, visited);
    }
  }
  for (const player of players ?? []) {
    for (const psprite of player?.psprites ?? []) {
      collectStateSprites(psprite.state, stateSprites, visited);
    }
  }

  for (const spriteIndex of stateSprites) {
    const definition = sprites[spriteIndex];
    if (definition === undefined || definition === null || definition.numframes === 0 ||
        !Array.isArray(definition.spriteframes)) continue;
    for (const frame of definition.spriteframes) {
      const lump = frame?.lump?.[0];
      if (!Number.isInteger(lump) || lump < 0) continue;
      const source = decodePatch(lump);
      // Allocate the one Canvas/ImageData and paint a valid initial row now.
      const canvasInfo = R_CreatePspriteCanvasInfo(source, 0);
      void canvasInfo.canvas;
    }
  }
  return R_GetPspriteCacheStats();
}

export function R_GetPspriteCacheStats() {
  let canvasEntries = 0;
  for (const source of _cache.values()) {
    if (source.canvasInfo !== null) canvasEntries++;
  }
  return {
    sourceEntries: _cache.size,
    canvasEntries,
    sourceBuilds: _sourceBuilds,
    canvasBuilds: _canvasBuilds,
    repaints: _canvasRepaints,
  };
}

function ensureFuzzCanvases() {
  if (_fuzzOutputCanvas !== null) return;
  _fuzzOutputCanvas = document.createElement('canvas');
  _fuzzOutputCanvas.width = SCREENWIDTH;
  _fuzzOutputCanvas.height = SCREENHEIGHT;
  _fuzzOutputContext = _fuzzOutputCanvas.getContext('2d');
  _fuzzOutputContext.imageSmoothingEnabled = false;
  _fuzzOutputImage = _fuzzOutputContext.createImageData(SCREENWIDTH, SCREENHEIGHT);
  const pixels = SCREENWIDTH * SCREENHEIGHT;
  _fuzzWorkingIndices = new Uint8Array(pixels);
  _fuzzOutputIndices = new Uint8Array(pixels);
  _fuzzOutputAlpha = new Uint8Array(pixels);
}

// Draw the player's psprites onto the overlay canvas. Called from D_Display
// after the 3D scene is painted. dstX/Y/W/H describe the complete logical
// 320x200 screen; an optional view applies native reduced-view projection.
export function R_DrawPlayerSprites(
  overlayCtx,
  player,
  dstX,
  dstY,
  dstW,
  dstH,
  view = null,
  backgroundIndices = null,
) {
  if (player === null || player.mo === null) return;
  const sx = dstW / SCREENWIDTH;
  const sy = dstH / SCREENHEIGHT;
  const invisible = R_IsPspriteInvisible(player.powers?.[powertype_t.pw_invisibility] ?? 0);
  const sectorLight = player.mo.subsector?.sector?.lightlevel ?? 255;
  const reduced = view !== null && view !== undefined;
  if (invisible) {
    ensureFuzzCanvases();
    const captured = backgroundIndices ?? R_GetPspriteFuzzCapture();
    _fuzzWorkingIndices.fill(0);
    if (captured !== null && captured !== undefined &&
        captured.length >= _fuzzWorkingIndices.length) {
      _fuzzWorkingIndices.set(captured.subarray(0, _fuzzWorkingIndices.length));
    }
    _fuzzOutputIndices.fill(0);
    _fuzzOutputAlpha.fill(0);
    _fuzzOutputImage.data.fill(0);
  }
  let fuzzPhase = R_GetFuzzPhase();
  let fuzzPixels = 0;
  const fuzzClip = reduced
    ? {
        left: view.viewwindowx,
        top: view.viewwindowy,
        right: view.viewwindowx + view.scaledviewwidth,
        bottom: view.viewwindowy + view.viewheight,
      }
    : { left: 0, top: 0, right: SCREENWIDTH, bottom: SCREENHEIGHT };
  if (reduced) {
    overlayCtx.save();
    overlayCtx.beginPath();
    overlayCtx.rect(
      dstX + view.viewwindowx * sx,
      dstY + view.viewwindowy * sy,
      view.scaledviewwidth * sx,
      view.viewheight * sy,
    );
    overlayCtx.clip();
  }
  try {
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
      const source = decodePatch(lumpIdx);
      const colormapRow = R_PspriteColormapRow(
        invisible,
        player.fixedcolormap,
        st.frame,
        sectorLight,
        player.extralight,
        reduced ? view.scaledviewwidth : SCREENWIDTH,
      );
      const t = R_CreatePspriteCanvasInfo(source, colormapRow);
      // R_DrawPSprite computes its patch bounds before inspecting flip. The
      // flipped branch only reverses startfrac/xiscale, so both orientations
      // retain the exact same spriteoffset/spritetopoffset rectangle.
      let bounds;
      if (reduced) {
        const projected = R_ProjectPspritePatch(psp.sx, psp.sy, t, view.viewwidth, view.viewheight);
        if (projected.clipLeft >= projected.clipRight || projected.clipTop >= projected.clipBottom) continue;
        const detailScale = 1 << view.detailshift;
        bounds = {
          ...projected,
          left: view.viewwindowx + projected.left * detailScale,
          right: view.viewwindowx + projected.right * detailScale,
          top: view.viewwindowy + projected.top,
          bottom: view.viewwindowy + projected.bottom,
          width: projected.width * detailScale,
        };
      } else {
        bounds = R_PspritePatchBounds(psp.sx, psp.sy, t);
      }
      if (colormapRow === PSPRITE_SHADOW_ROW) {
        const result = R_RasterizeFuzzPatch({
          background: _fuzzWorkingIndices,
          output: _fuzzOutputIndices,
          outputAlpha: _fuzzOutputAlpha,
          screenWidth: SCREENWIDTH,
          screenHeight: SCREENHEIGHT,
          mask: source.alphas,
          sourceWidth: source.w,
          sourceHeight: source.h,
          bounds,
          flip: sf.flip[0] === 1,
          clipLeft: fuzzClip.left,
          clipTop: fuzzClip.top,
          clipRight: fuzzClip.right,
          clipBottom: fuzzClip.bottom,
          phase: fuzzPhase,
          colormaps,
        });
        fuzzPhase = result.phase;
        fuzzPixels += result.pixels;
      } else {
        R_DrawPspritePatch(
          overlayCtx,
          t.canvas,
          bounds,
          dstX,
          dstY,
          sx,
          sy,
          sf.flip[0] === 1,
        );
      }
    }
    if (fuzzPixels > 0) {
      const palette = V_GetActivePalette();
      const rgba = _fuzzOutputImage.data;
      for (let pixel = 0, offset = 0; pixel < _fuzzOutputIndices.length; pixel++, offset += 4) {
        if (_fuzzOutputAlpha[pixel] === 0) continue;
        const colour = _fuzzOutputIndices[pixel] * 4;
        rgba[offset] = palette[colour];
        rgba[offset + 1] = palette[colour + 1];
        rgba[offset + 2] = palette[colour + 2];
        rgba[offset + 3] = 255;
      }
      _fuzzOutputContext.putImageData(_fuzzOutputImage, 0, 0);
      overlayCtx.drawImage(
        _fuzzOutputCanvas,
        0,
        0,
        SCREENWIDTH,
        SCREENHEIGHT,
        dstX,
        dstY,
        dstW,
        dstH,
      );
      R_SetFuzzPhase(fuzzPhase);
    }
  } finally {
    if (reduced) overlayCtx.restore();
  }
}
