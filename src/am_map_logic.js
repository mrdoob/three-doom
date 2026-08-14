// Pure automap window/control state from linuxdoom-1.10/am_map.c.
// Map coordinates and scale multipliers remain signed 16.16 fixed point; the
// Canvas renderer only scales the resulting 320x168 framebuffer coordinates.

import {
  KEY_DOWNARROW, KEY_EQUALS, KEY_LEFTARROW, KEY_MINUS, KEY_RIGHTARROW,
  KEY_TAB, KEY_UPARROW,
} from './doomdef.js';
import { evtype_t } from './d_event.js';
import { FixedDiv, FixedMul, FRACUNIT } from './m_fixed.js';
import { MAXINT, MININT } from './doomtype.js';

export const AM_FRAME_WIDTH = 320;
export const AM_FRAME_HEIGHT = 168; // SCREENHEIGHT - status-bar height
export const AM_PLAYER_DIAMETER = 32;

// The C casts truncate these constants before the fixed-point operations.
export const AM_INITIAL_SCALE = Math.trunc(0.2 * FRACUNIT);
export const AM_INITIAL_SCALE_DIVISOR = Math.trunc(0.7 * FRACUNIT);
export const AM_ZOOM_IN = Math.trunc(1.02 * FRACUNIT);
export const AM_ZOOM_OUT = Math.trunc(FRACUNIT / 1.02);
export const AM_PAN_PIXELS = 4;

const FIXED_FRAME_WIDTH = AM_FRAME_WIDTH * FRACUNIT;
const FIXED_FRAME_HEIGHT = AM_FRAME_HEIGHT * FRACUNIT;
const FIXED_PLAYER_DIAMETER = AM_PLAYER_DIAMETER * FRACUNIT;

function half(value) { return Math.trunc(value / 2); }

function windowSize(scaleFtom) {
  return {
    w: FixedMul(FIXED_FRAME_WIDTH, scaleFtom),
    h: FixedMul(FIXED_FRAME_HEIGHT, scaleFtom),
  };
}

function withScale(state, scaleMtof) {
  return {
    ...state,
    scaleMtof,
    scaleFtom: FixedDiv(FRACUNIT, scaleMtof),
  };
}

function activateNewScale(state) {
  const centerX = state.mX + half(state.mW);
  const centerY = state.mY + half(state.mH);
  const size = windowSize(state.scaleFtom);
  return {
    ...state,
    mX: centerX - half(size.w),
    mY: centerY - half(size.h),
    mW: size.w,
    mH: size.h,
  };
}

function clampWindowCenter(state) {
  if (state.hasBounds !== true) return state;
  const halfW = half(state.mW);
  const halfH = half(state.mH);
  let mX = state.mX;
  let mY = state.mY;
  const centerX = mX + halfW;
  const centerY = mY + halfH;
  if (centerX > state.maxX) mX = state.maxX - halfW;
  else if (centerX < state.minX) mX = state.minX - halfW;
  if (centerY > state.maxY) mY = state.maxY - halfH;
  else if (centerY < state.minY) mY = state.minY - halfH;
  return { ...state, mX, mY };
}

// am_map.c:AM_findMinMaxBoundaries. Vertices are already 16.16 fixed point.
export function AM_CalculateLevelBounds(vertices) {
  if (!Array.isArray(vertices) || vertices.length === 0) return null;
  let minX = MAXINT;
  let minY = MAXINT;
  let maxX = MININT;
  let maxY = MININT;
  for (const vertex of vertices) {
    const x = vertex.x;
    const y = vertex.y;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    // Preserve the source's if/else-if update order.
    if (x < minX) minX = x;
    else if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    else if (y > maxY) maxY = y;
  }
  const maxW = maxX - minX;
  const maxH = maxY - minY;
  if (maxW <= 0 || maxH <= 0) return null;

  const widthScale = FixedDiv(FIXED_FRAME_WIDTH, maxW);
  const heightScale = FixedDiv(FIXED_FRAME_HEIGHT, maxH);
  const minScaleMtof = Math.min(widthScale, heightScale);
  const maxScaleMtof = FixedDiv(FIXED_FRAME_HEIGHT, FIXED_PLAYER_DIAMETER);
  let initialScaleMtof = FixedDiv(minScaleMtof, AM_INITIAL_SCALE_DIVISOR);
  if (initialScaleMtof > maxScaleMtof) initialScaleMtof = minScaleMtof;
  return {
    minX, minY, maxX, maxY, maxW, maxH,
    minScaleMtof, maxScaleMtof, initialScaleMtof,
  };
}

function baseState(previous, bounds) {
  const hasBounds = bounds !== null;
  const scaleMtof = hasBounds ? bounds.initialScaleMtof : AM_INITIAL_SCALE;
  return {
    hasBounds,
    minX: bounds?.minX ?? 0,
    minY: bounds?.minY ?? 0,
    maxX: bounds?.maxX ?? 0,
    maxY: bounds?.maxY ?? 0,
    minScaleMtof: bounds?.minScaleMtof ?? 1,
    maxScaleMtof: bounds?.maxScaleMtof ?? MAXINT,
    scaleMtof,
    scaleFtom: FixedDiv(FRACUNIT, scaleMtof),
    mX: 0,
    mY: 0,
    mW: 0,
    mH: 0,
    oldMX: 0,
    oldMY: 0,
    oldMW: 0,
    oldMH: 0,
    panX: 0,
    panY: 0,
    zoomMtof: FRACUNIT,
    zoomFtom: FRACUNIT,
    followPlayer: previous?.followPlayer ?? true,
    followOldX: MAXINT,
    followOldY: MAXINT,
    grid: previous?.grid ?? false,
    // bigstate is a static local in AM_Responder. Tab resets it, but other
    // AM_Stop paths leave it intact across AM_LevelInit.
    bigState: previous?.bigState ?? false,
  };
}

// AM_LevelInit + AM_initVariables. `player` carries fixed-point x/y fields.
export function AM_CreateViewState(vertices, player, previous = null) {
  return AM_OpenView(baseState(previous, AM_CalculateLevelBounds(vertices)), player);
}

// Browser focus can move away without delivering the matching keyup. Keep
// this reset limited to the automap's held pan/zoom controls so its persistent
// follow, grid, scale, and window position survive the ownership boundary.
export function AM_ResetHeldControls(state) {
  return {
    ...state,
    panX: 0,
    panY: 0,
    zoomMtof: FRACUNIT,
    zoomFtom: FRACUNIT,
  };
}

// AM_initVariables for reopening the same level: retain the current scale,
// follow/grid settings and bounds, but clear held controls and center on plr.
export function AM_OpenView(state, player) {
  const size = windowSize(state.scaleFtom);
  const playerX = player?.x ?? 0;
  const playerY = player?.y ?? 0;
  let next = {
    ...AM_ResetHeldControls(state),
    followOldX: MAXINT,
    followOldY: MAXINT,
    mW: size.w,
    mH: size.h,
    mX: playerX - half(size.w),
    mY: playerY - half(size.h),
  };
  next = clampWindowCenter(next);
  return {
    ...next,
    oldMX: next.mX,
    oldMY: next.mY,
    oldMW: next.mW,
    oldMH: next.mH,
  };
}

function restoreScaleAndLoc(state, player) {
  let mX = state.oldMX;
  let mY = state.oldMY;
  if (state.followPlayer === true && player !== null && player !== undefined) {
    mX = player.x - half(state.oldMW);
    mY = player.y - half(state.oldMH);
  }
  let next = {
    ...state,
    mX,
    mY,
    mW: state.oldMW,
    mH: state.oldMH,
  };
  next = withScale(next, FixedDiv(FIXED_FRAME_WIDTH, next.mW));
  return next;
}

// Pure active-map half of AM_Responder. Side effects are returned as `action`
// and `message` so am_map.js can update marks/player text separately.
export function AM_ApplyControlEvent(state, ev, player = null) {
  if (ev === null || ev === undefined) {
    return { state, handled: false, action: null, message: null };
  }
  const key = ev.data1;
  if (ev.type === evtype_t.ev_keyup) {
    let next = state;
    switch (key) {
      case KEY_RIGHTARROW:
      case KEY_LEFTARROW:
        if (state.followPlayer !== true) next = { ...state, panX: 0 };
        break;
      case KEY_UPARROW:
      case KEY_DOWNARROW:
        if (state.followPlayer !== true) next = { ...state, panY: 0 };
        break;
      case KEY_MINUS:
      case KEY_EQUALS:
        next = { ...state, zoomMtof: FRACUNIT, zoomFtom: FRACUNIT };
        break;
    }
    // Vanilla always lets automap keyups filter down to gamekeydown cleanup.
    return { state: next, handled: false, action: null, message: null };
  }
  if (ev.type !== evtype_t.ev_keydown) {
    return { state, handled: false, action: null, message: null };
  }

  switch (key) {
    case KEY_RIGHTARROW:
      if (state.followPlayer === true) break;
      return {
        state: { ...state, panX: FixedMul(AM_PAN_PIXELS * FRACUNIT, state.scaleFtom) },
        handled: true, action: null, message: null,
      };
    case KEY_LEFTARROW:
      if (state.followPlayer === true) break;
      return {
        state: { ...state, panX: -FixedMul(AM_PAN_PIXELS * FRACUNIT, state.scaleFtom) },
        handled: true, action: null, message: null,
      };
    case KEY_UPARROW:
      if (state.followPlayer === true) break;
      return {
        state: { ...state, panY: FixedMul(AM_PAN_PIXELS * FRACUNIT, state.scaleFtom) },
        handled: true, action: null, message: null,
      };
    case KEY_DOWNARROW:
      if (state.followPlayer === true) break;
      return {
        state: { ...state, panY: -FixedMul(AM_PAN_PIXELS * FRACUNIT, state.scaleFtom) },
        handled: true, action: null, message: null,
      };
    case KEY_MINUS:
      return {
        state: { ...state, zoomMtof: AM_ZOOM_OUT, zoomFtom: AM_ZOOM_IN },
        handled: true, action: null, message: null,
      };
    case KEY_EQUALS:
      return {
        state: { ...state, zoomMtof: AM_ZOOM_IN, zoomFtom: AM_ZOOM_OUT },
        handled: true, action: null, message: null,
      };
    case KEY_TAB:
      return {
        state: { ...state, bigState: false },
        handled: true, action: 'stop', message: null,
      };
    case 0x30: { // '0': save/restore the non-big window.
      if (state.bigState !== true) {
        let next = {
          ...state,
          oldMX: state.mX,
          oldMY: state.mY,
          oldMW: state.mW,
          oldMH: state.mH,
          bigState: true,
        };
        next = activateNewScale(withScale(next, state.minScaleMtof));
        return { state: next, handled: true, action: null, message: null };
      }
      return {
        state: { ...restoreScaleAndLoc(state, player), bigState: false },
        handled: true, action: null, message: null,
      };
    }
    case 0x66: // 'f'
      return {
        state: {
          ...state,
          followPlayer: !state.followPlayer,
          followOldX: MAXINT,
          followOldY: MAXINT,
        },
        handled: true, action: null,
        message: state.followPlayer === true ? 'followOff' : 'followOn',
      };
    case 0x67: // 'g'
      return {
        state: { ...state, grid: !state.grid },
        handled: true, action: null,
        message: state.grid === true ? 'gridOff' : 'gridOn',
      };
    case 0x6d: // 'm'
      return { state, handled: true, action: 'mark', message: null };
    case 0x63: // 'c'
      return { state, handled: true, action: 'clear', message: 'marksCleared' };
  }
  return { state, handled: false, action: null, message: null };
}

function followPlayer(state, player) {
  if (player === null || player === undefined) return state;
  if (state.followOldX === player.x && state.followOldY === player.y) return state;
  // AM_doFollowPlayer quantizes through framebuffer coordinates before
  // converting back to map coordinates.
  const frameX = FixedMul(player.x, state.scaleMtof) >> 16;
  const frameY = FixedMul(player.y, state.scaleMtof) >> 16;
  const centerX = FixedMul(frameX * FRACUNIT, state.scaleFtom);
  const centerY = FixedMul(frameY * FRACUNIT, state.scaleFtom);
  return {
    ...state,
    mX: centerX - half(state.mW),
    mY: centerY - half(state.mH),
    followOldX: player.x,
    followOldY: player.y,
  };
}

function changeWindowScale(state) {
  let next = withScale(state, FixedMul(state.scaleMtof, state.zoomMtof));
  if (next.scaleMtof < state.minScaleMtof) {
    next = activateNewScale(withScale(next, state.minScaleMtof));
  } else if (next.scaleMtof > state.maxScaleMtof) {
    next = activateNewScale(withScale(next, state.maxScaleMtof));
  } else {
    next = activateNewScale(next);
  }
  return next;
}

// Pure AM_Ticker state update: follow, held zoom, then held pan.
export function AM_TickViewState(state, player = null) {
  let next = state;
  if (next.followPlayer === true) next = followPlayer(next, player);
  if (next.zoomFtom !== FRACUNIT) next = changeWindowScale(next);
  if (next.panX !== 0 || next.panY !== 0) {
    next = clampWindowCenter({
      ...next,
      followPlayer: false,
      followOldX: MAXINT,
      followOldY: MAXINT,
      mX: next.mX + next.panX,
      mY: next.mY + next.panY,
    });
  }
  return next;
}

// Convert a fixed map point using the same MTOF/CXMTOF/CYMTOF operations as
// the reference framebuffer; callers scale the logical pixel to Canvas.
export function AM_ProjectFixedPoint(state, x, y) {
  return {
    x: FixedMul(x - state.mX, state.scaleMtof) >> 16,
    y: AM_FRAME_HEIGHT - (FixedMul(y - state.mY, state.scaleMtof) >> 16),
  };
}
