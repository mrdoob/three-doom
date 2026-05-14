// Ported from: linuxdoom-1.10/f_wipe.c — Doom's iconic "melt" screen wipe.
// In the 3D port we snapshot the WebGL canvas at level transition, then animate
// per-column drops from top to bottom revealing the new screen.
//
// Demo-determinism note: f_wipe.c initializes `y[]` with one M_Random call per
// byte of screen width (320), even though `wipe_doMelt` only animates the first
// `width/2` (160) entries (the screen is treated as 2-byte short columns there).
// We match the C RNG consumption exactly by sizing `_y` at SCREENWIDTH and only
// using the first SCREENWIDTH/2 entries during animation.

import { M_Random } from './m_random.js';

const SCREENWIDTH  = 320;
const SCREENHEIGHT = 200;
const MELT_COLS    = SCREENWIDTH / 2; // 160 logical 2-px columns animated

let _startCanvas = null;
let _endCanvas   = null;
let _y = null;
let _active = false;

function _grabCanvas() {
  const c = document.createElement('canvas');
  c.width = SCREENWIDTH; c.height = SCREENHEIGHT;
  try {
    const r = window.renderer;
    if (r !== undefined) c.getContext('2d').drawImage(r.domElement, 0, 0, SCREENWIDTH, SCREENHEIGHT);
  } catch (_) {}
  return c;
}

export function wipe_StartScreen(_x, _y_, _w, _h) { _startCanvas = _grabCanvas(); return 0; }
export function wipe_EndScreen(_x, _y_, _w, _h) {
  _endCanvas = _grabCanvas();
  // C: allocates `width` ints and iterates `width` times even though only
  // `width/2` are read by wipe_doMelt. Reproduce the full RNG sequence.
  _y = new Int32Array(SCREENWIDTH);
  _y[0] = -(M_Random() % 16);
  for (let i = 1; i < SCREENWIDTH; i++) {
    const r = (M_Random() % 3) - 1;
    _y[i] = _y[i - 1] + r;
    if (_y[i] > 0) _y[i] = 0;
    else if (_y[i] === -16) _y[i] = -15;
  }
  _active = true;
  return 0;
}

export function wipe_ScreenWipe(_no, _x, _y_, _w, _h, ticks) {
  if (_active === false || _y === null) return 1;
  let done = true;
  for (let t = 0; t < ticks; t++) {
    for (let i = 0; i < MELT_COLS; i++) {
      if (_y[i] < 0) { _y[i]++; done = false; }
      else if (_y[i] < SCREENHEIGHT) {
        const dy = _y[i] < 16 ? _y[i] + 1 : 8;
        _y[i] = Math.min(SCREENHEIGHT, _y[i] + dy);
        done = false;
      }
    }
  }
  if (done === true) _active = false;
  return done === true ? 1 : 0;
}

export function wipe_Draw(ctx, dstX, dstY, dstW, dstH) {
  if (_active === false || _startCanvas === null || _endCanvas === null) return;
  const sx = dstW / SCREENWIDTH;
  const sy = dstH / SCREENHEIGHT;
  const colSrcW = SCREENWIDTH / MELT_COLS; // 2 source pixels per logical column
  for (let i = 0; i < MELT_COLS; i++) {
    const srcCol = i * colSrcW;
    const dCol   = dstX + srcCol * sx;
    const colW   = colSrcW * sx;
    const yOff   = Math.max(0, _y[i]);
    if (yOff > 0) {
      ctx.drawImage(_endCanvas, srcCol, 0, colSrcW, yOff,
                    dCol, dstY, colW, yOff * sy);
    }
    if (yOff < SCREENHEIGHT) {
      ctx.drawImage(_startCanvas, srcCol, 0, colSrcW, SCREENHEIGHT - yOff,
                    dCol, dstY + yOff * sy, colW, (SCREENHEIGHT - yOff) * sy);
    }
  }
}

export function wipe_isActive() { return _active; }
