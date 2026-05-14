// Ported from: linuxdoom-1.10/f_wipe.c — Doom's iconic "melt" screen wipe.
// In the 3D port we snapshot the WebGL canvas at level transition, then animate
// per-column drops from top to bottom revealing the new screen.

import { M_Random } from './m_random.js';

const SCREENWIDTH  = 320;
const SCREENHEIGHT = 200;

let _startCanvas = null;
let _endCanvas   = null;
let _y = null;
let _active = false;
const STRIDE = 4;

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
  const cols = (SCREENWIDTH / STRIDE) | 0;
  _y = new Int32Array(cols);
  _y[0] = -(M_Random() % 16);
  for (let i = 1; i < cols; i++) {
    const r = (M_Random() % 3) - 1;
    _y[i] = _y[i - 1] + r;
    if (_y[i] > 0) _y[i] = 0;
    else if (_y[i] === -16) _y[i] = -15;
  }
  _active = true;
  return 0;
}

export function wipe_ScreenWipe(_no, _x, _y_, _w, _h, ticks) {
  if (!_active || _y === null) return 1;
  let done = true;
  for (let t = 0; t < ticks; t++) {
    for (let i = 0; i < _y.length; i++) {
      if (_y[i] < 0) { _y[i]++; done = false; }
      else if (_y[i] < SCREENHEIGHT) {
        const dy = _y[i] < 16 ? _y[i] + 1 : 8;
        _y[i] = Math.min(SCREENHEIGHT, _y[i] + dy);
        done = false;
      }
    }
  }
  if (done) _active = false;
  return done ? 1 : 0;
}

export function wipe_Draw(ctx, dstX, dstY, dstW, dstH) {
  if (!_active || _startCanvas === null || _endCanvas === null) return;
  const sx = dstW / SCREENWIDTH;
  const sy = dstH / SCREENHEIGHT;
  for (let i = 0; i < _y.length; i++) {
    const srcCol = i * STRIDE;
    const dCol   = dstX + srcCol * sx;
    const colW   = STRIDE * sx;
    const yOff   = Math.max(0, _y[i]);
    if (yOff > 0) {
      ctx.drawImage(_endCanvas, srcCol, 0, STRIDE, yOff,
                    dCol, dstY, colW, yOff * sy);
    }
    if (yOff < SCREENHEIGHT) {
      ctx.drawImage(_startCanvas, srcCol, 0, STRIDE, SCREENHEIGHT - yOff,
                    dCol, dstY + yOff * sy, colW, (SCREENHEIGHT - yOff) * sy);
    }
  }
}

export function wipe_isActive() { return _active; }
