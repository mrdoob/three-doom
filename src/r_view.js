// Pure view-size geometry shared by the Three.js viewport and Canvas overlay.
// Mirrors r_main.c:R_ExecuteSetViewSize and r_draw.c:R_InitBuffer.

import { SCREENWIDTH, SCREENHEIGHT } from './doomdef.js';
import * as doomstat from './doomstat.js';

export const STATUS_BAR_HEIGHT = 32;
export const VIEW_AREA_HEIGHT = SCREENHEIGHT - STATUS_BAR_HEIGHT;
export const MIN_SCREENBLOCKS = 3;
export const MAX_SCREENBLOCKS = 11;
export const DEFAULT_SCREENBLOCKS = 10;
export const R_CAMERA_NEAR = 1;
// Map vertices and sector heights are signed 16-bit map units. The maximum
// opposite-corner 3D span is sqrt(3) * 65535 (~113,510), so 2^17 covers every
// representable map without introducing an arbitrary custom-map cutoff.
export const R_CAMERA_FAR = 131072;

let _screenblocks = DEFAULT_SCREENBLOCKS;
let _detailLevel = 0;

export function R_CalculateViewSize(blocks, detail = 0) {
  const screenblocks = blocks | 0;
  const detailshift = detail | 0;
  let scaledviewwidth;
  let viewheight;

  if (screenblocks === MAX_SCREENBLOCKS) {
    scaledviewwidth = SCREENWIDTH;
    viewheight = SCREENHEIGHT;
  } else {
    scaledviewwidth = screenblocks * 32;
    viewheight = (Math.trunc(screenblocks * VIEW_AREA_HEIGHT / 10)) & ~7;
  }

  const viewwidth = scaledviewwidth >> detailshift;
  const viewwindowx = (SCREENWIDTH - scaledviewwidth) >> 1;
  const viewwindowy = scaledviewwidth === SCREENWIDTH
    ? 0
    : (VIEW_AREA_HEIGHT - viewheight) >> 1;

  return {
    screenblocks,
    detailshift,
    scaledviewwidth,
    viewwidth,
    viewheight,
    viewwindowx,
    viewwindowy,
  };
}

export function R_SetViewSize(blocks, detail = _detailLevel) {
  const bounded = Math.max(MIN_SCREENBLOCKS, Math.min(MAX_SCREENBLOCKS, blocks | 0));
  _screenblocks = bounded;
  _detailLevel = detail | 0;
  const view = R_CalculateViewSize(_screenblocks, _detailLevel);
  doomstat.set_scaledviewwidth(view.scaledviewwidth);
  doomstat.set_viewwidth(view.viewwidth);
  doomstat.set_viewheight(view.viewheight);
  doomstat.set_viewwindowx(view.viewwindowx);
  doomstat.set_viewwindowy(view.viewwindowy);
  return view;
}

export function R_GetScreenblocks() { return _screenblocks; }

export function R_GetViewSize() {
  return R_CalculateViewSize(_screenblocks, _detailLevel);
}

// Map the reference 320x200 framebuffer into a browser canvas. Coordinates
// named `viewY` are top-origin Canvas coordinates; `webglViewY` is the
// equivalent bottom-origin WebGL viewport coordinate.
export function R_CalculateCanvasView(canvasWidth, canvasHeight, view = R_GetViewSize()) {
  const scale = Math.min(canvasWidth / SCREENWIDTH, canvasHeight / SCREENHEIGHT);
  const screenWidth = SCREENWIDTH * scale;
  const screenHeight = SCREENHEIGHT * scale;
  const screenX = (canvasWidth - screenWidth) * 0.5;
  const screenY = (canvasHeight - screenHeight) * 0.5;
  const viewX = screenX + view.viewwindowx * scale;
  const viewY = screenY + view.viewwindowy * scale;
  const viewWidth = view.scaledviewwidth * scale;
  const viewHeight = view.viewheight * scale;
  return {
    canvasWidth,
    canvasHeight,
    scale,
    screenX,
    screenY,
    screenWidth,
    screenHeight,
    viewX,
    viewY,
    viewWidth,
    viewHeight,
    webglViewY: canvasHeight - viewY - viewHeight,
  };
}

// Three.js accepts vertical FOV, while Doom's projection=centerx keeps the
// horizontal FOV at 90 degrees for every view size.
export function R_DoomVerticalFov(aspect) {
  return 2 * Math.atan(1 / aspect) * 180 / Math.PI;
}

// Use one step above m_misc.c's compiled screenblocks 9 default: a full-width
// 320x168 view with the status bar retained. Initialise the legacy doomstat
// fields immediately so every display path observes real geometry even before
// the options menu is first opened.
R_SetViewSize(_screenblocks, _detailLevel);
