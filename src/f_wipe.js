// Ported from: linuxdoom-1.10/f_wipe.c — Doom's iconic "melt" screen wipe.
// In the 3D port a displayed frame is split between the WebGL canvas and the
// transparent UI canvas above it.  Keep a composed 320x200 copy of the last
// completed frame so wipe_StartScreen can still read it after WebGL has
// discarded its (non-preserved) drawing buffer.
//
// Demo-determinism note: f_wipe.c initializes `y[]` with one M_Random call per
// byte of screen width (320), even though `wipe_doMelt` only animates the first
// `width/2` (160) entries (the screen is treated as 2-byte short columns there).
// We match the C RNG consumption exactly by sizing `_y` at SCREENWIDTH and only
// using the first SCREENWIDTH/2 entries during animation.

import { M_Random } from './m_random.js';
import { R_CalculateCanvasView } from './r_view.js';

const SCREENWIDTH  = 320;
const SCREENHEIGHT = 200;
const MELT_COLS    = SCREENWIDTH / 2; // 160 logical 2-px columns animated

let _startCanvas = null;
let _endCanvas   = null;
let _presentCanvas = null;
let _y = null;
let _active = false;

function _makeCanvas() {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = SCREENWIDTH;
  canvas.height = SCREENHEIGHT;
  return canvas;
}

function _captureComposedFrame(canvas) {
  const c = canvas ?? _makeCanvas();
  if (c === null) return null;
  if (c.width !== SCREENWIDTH) c.width = SCREENWIDTH;
  if (c.height !== SCREENHEIGHT) c.height = SCREENHEIGHT;
  const ctx = c.getContext('2d');
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SCREENWIDTH, SCREENHEIGHT);
  const overlay = document.getElementById('overlay');
  const layout = overlay === null
    ? null
    : R_CalculateCanvasView(overlay.width, overlay.height);
  try {
    const r = window.renderer;
    if (r?.domElement !== undefined) {
      if (layout === null || overlay.width === 0 || overlay.height === 0) {
        ctx.drawImage(r.domElement, 0, 0, SCREENWIDTH, SCREENHEIGHT);
      } else {
        // Three's drawing buffer is device-pixel sized while the overlay uses
        // CSS pixels. Crop the same centered logical screen from each layer.
        const sx = r.domElement.width / overlay.width;
        const sy = r.domElement.height / overlay.height;
        ctx.drawImage(
          r.domElement,
          layout.screenX * sx,
          layout.screenY * sy,
          layout.screenWidth * sx,
          layout.screenHeight * sy,
          0,
          0,
          SCREENWIDTH,
          SCREENHEIGHT,
        );
      }
    }
  } catch {
    // A discarded or inaccessible WebGL buffer simply omits that layer.
  }
  try {
    if (overlay !== null) {
      if (layout === null) {
        ctx.drawImage(overlay, 0, 0, SCREENWIDTH, SCREENHEIGHT);
      } else {
        ctx.drawImage(
          overlay,
          layout.screenX,
          layout.screenY,
          layout.screenWidth,
          layout.screenHeight,
          0,
          0,
          SCREENWIDTH,
          SCREENHEIGHT,
        );
      }
    }
  } catch {
    // A detached overlay simply leaves the already-captured layers intact.
  }
  return c;
}

function _copyCanvas(source, destination) {
  if (source === null) return _captureComposedFrame(destination);
  const copy = destination ?? _makeCanvas();
  if (copy === null) return null;
  if (copy.width !== SCREENWIDTH) copy.width = SCREENWIDTH;
  if (copy.height !== SCREENHEIGHT) copy.height = SCREENHEIGHT;
  const ctx = copy.getContext('2d');
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(source, 0, 0, SCREENWIDTH, SCREENHEIGHT);
  ctx.globalCompositeOperation = 'source-over';
  return copy;
}

// Called after a non-wipe D_Display has composed WebGL and Canvas UI.  This is
// the browser equivalent of the indexed screen buffer I_ReadScreen reads in C.
export function wipe_RecordScreen() {
  _presentCanvas = _captureComposedFrame(_presentCanvas);
}

export function wipe_StartScreen(_x, _y_, _w, _h) {
  _startCanvas = _presentCanvas === null
    ? _captureComposedFrame(_startCanvas)
    : _copyCanvas(_presentCanvas, _startCanvas);
  return 0;
}

export function wipe_EndScreen(_x, _y_, _w, _h) {
  _endCanvas = _captureComposedFrame(_endCanvas);
  _y = null;
  _active = _startCanvas !== null && _endCanvas !== null;
  return 0;
}

function _initMelt() {
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
}

export function wipe_ScreenWipe(_no, _x, _y_, _w, _h, ticks) {
  if (_active === false) return 1;
  // f_wipe.c initializes the melt on the first ScreenWipe call, after the end
  // screen has been captured, rather than while wipe_EndScreen is running.
  if (_y === null) _initMelt();
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
  if (_startCanvas === null || _endCanvas === null) return;
  if (_y === null) {
    ctx.drawImage(_startCanvas, dstX, dstY, dstW, dstH);
    return;
  }
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

export function wipe_Shutdown() {
  if (_startCanvas !== null) { _startCanvas.width = 0; _startCanvas.height = 0; }
  if (_endCanvas !== null) { _endCanvas.width = 0; _endCanvas.height = 0; }
  if (_presentCanvas !== null) { _presentCanvas.width = 0; _presentCanvas.height = 0; }
  _startCanvas = null;
  _endCanvas = null;
  _presentCanvas = null;
  _y = null;
  _active = false;
}
