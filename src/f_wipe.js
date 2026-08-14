// Ported from: linuxdoom-1.10/f_wipe.c — Doom's iconic "melt" screen wipe.
// In the 3D port a displayed frame is split between the WebGL canvas and the
// transparent UI canvas above it. Keep a composed presentation-resolution
// copy of the last completed frame so wipe_StartScreen can still read it after
// WebGL has discarded its (non-preserved) drawing buffer. Melt timing and
// column ownership remain in Doom's canonical 320x200 coordinate space.
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
let _wipeCanvas = null;
let _wipeCtx = null;
let _y = null;
let _active = false;

function _makeCanvas(width = SCREENWIDTH, height = SCREENHEIGHT) {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function _resizeCanvas(canvas, width, height) {
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
}

function _presentationInfo() {
  const overlay = document.getElementById('overlay');
  const rendererCanvas = window.renderer?.domElement ?? null;
  if (overlay === null || overlay.width <= 0 || overlay.height <= 0) {
    return {
      overlay,
      rendererCanvas,
      layout: null,
      scaleX: 1,
      scaleY: 1,
      width: SCREENWIDTH,
      height: SCREENHEIGHT,
    };
  }
  const layout = R_CalculateCanvasView(overlay.width, overlay.height);
  const scaleX = rendererCanvas === null ? 1 : rendererCanvas.width / overlay.width;
  const scaleY = rendererCanvas === null ? 1 : rendererCanvas.height / overlay.height;
  return {
    overlay,
    rendererCanvas,
    layout,
    scaleX,
    scaleY,
    width: Math.max(1, Math.round(layout.screenWidth * scaleX)),
    height: Math.max(1, Math.round(layout.screenHeight * scaleY)),
  };
}

function _hideWipeLayer() {
  if (_wipeCanvas === null || _wipeCanvas.style.display === 'none') return;
  _wipeCanvas.style.display = 'none';
  _wipeCtx?.clearRect(0, 0, _wipeCanvas.width, _wipeCanvas.height);
}

// The normal Three view is rendered at device-pixel resolution. Present the
// wipe at that same resolution on a temporary layer above WebGL and below the
// regular UI overlay; drawing the melt into the CSS-pixel-backed UI canvas
// would still halve its resolution on a Retina display.
function _ensureWipeLayer() {
  const overlay = document.getElementById('overlay');
  const rendererCanvas = window.renderer?.domElement ?? null;
  if (overlay === null || overlay.parentNode === null || rendererCanvas === null) return null;
  if (_wipeCanvas === null) {
    _wipeCanvas = document.createElement('canvas');
    _wipeCanvas.id = 'doom-wipe';
    _wipeCanvas.setAttribute('aria-hidden', 'true');
    Object.assign(_wipeCanvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      display: 'none',
    });
    overlay.parentNode.insertBefore(_wipeCanvas, overlay);
    _wipeCtx = _wipeCanvas.getContext('2d');
  }
  _resizeCanvas(_wipeCanvas, rendererCanvas.width, rendererCanvas.height);
  _wipeCtx.imageSmoothingEnabled = false;
  return _wipeCanvas;
}

function _captureComposedFrame(canvas) {
  const info = _presentationInfo();
  const c = canvas ?? _makeCanvas(info.width, info.height);
  if (c === null) return null;
  _resizeCanvas(c, info.width, info.height);
  const ctx = c.getContext('2d');
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, c.width, c.height);
  const { overlay, rendererCanvas, layout, scaleX, scaleY } = info;
  try {
    if (rendererCanvas !== null) {
      if (layout === null || overlay.width === 0 || overlay.height === 0) {
        ctx.drawImage(rendererCanvas, 0, 0, c.width, c.height);
      } else {
        // Three's drawing buffer is device-pixel sized while the overlay uses
        // CSS-pixel backing storage. Crop the same centered logical screen
        // from each layer without reducing the WebGL image to 320x200.
        ctx.drawImage(
          rendererCanvas,
          layout.screenX * scaleX,
          layout.screenY * scaleY,
          layout.screenWidth * scaleX,
          layout.screenHeight * scaleY,
          0,
          0,
          c.width,
          c.height,
        );
      }
    }
  } catch {
    // A discarded or inaccessible WebGL buffer simply omits that layer.
  }
  try {
    if (overlay !== null) {
      if (layout === null) {
        ctx.drawImage(overlay, 0, 0, c.width, c.height);
      } else {
        ctx.drawImage(
          overlay,
          layout.screenX,
          layout.screenY,
          layout.screenWidth,
          layout.screenHeight,
          0,
          0,
          c.width,
          c.height,
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
  const copy = destination ?? _makeCanvas(source.width, source.height);
  if (copy === null) return null;
  _resizeCanvas(copy, source.width, source.height);
  const ctx = copy.getContext('2d');
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(source, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  return copy;
}

// Called after a non-wipe D_Display has composed WebGL and Canvas UI.  This is
// the browser equivalent of the indexed screen buffer I_ReadScreen reads in C.
export function wipe_RecordScreen() {
  // A completed wipe leaves the ordinary destination fully drawn underneath
  // its temporary presentation layer. Remove that layer before retaining the
  // destination so menu/HUD pixels are neither hidden nor composited twice.
  _hideWipeLayer();
  _presentCanvas = _captureComposedFrame(_presentCanvas);
}

export function wipe_StartScreen(_x, _y_, _w, _h) {
  _startCanvas = _presentCanvas === null
    ? _captureComposedFrame(_startCanvas)
    : _copyCanvas(_presentCanvas, _startCanvas);
  _hideWipeLayer();
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
  let targetCtx = ctx;
  let targetX = dstX;
  let targetY = dstY;
  let targetW = dstW;
  let targetH = dstH;
  const overlay = document.getElementById('overlay');
  const layer = ctx?.canvas === overlay ? _ensureWipeLayer() : null;
  if (layer !== null && ctx.canvas.width > 0 && ctx.canvas.height > 0) {
    // The destination HUD/status/menu was needed for wipe_EndScreen, but the
    // high-resolution melt now owns the logical screen. Leave only the menu,
    // which D_Display redraws after this call, on the ordinary overlay.
    ctx.clearRect(dstX, dstY, dstW, dstH);
    const scaleX = layer.width / ctx.canvas.width;
    const scaleY = layer.height / ctx.canvas.height;
    targetCtx = _wipeCtx;
    targetX *= scaleX;
    targetY *= scaleY;
    targetW *= scaleX;
    targetH *= scaleY;
    targetCtx.clearRect(0, 0, layer.width, layer.height);
    layer.style.display = 'block';
  }
  targetCtx.imageSmoothingEnabled = false;
  if (_y === null) {
    targetCtx.drawImage(_startCanvas, targetX, targetY, targetW, targetH);
    return;
  }
  for (let i = 0; i < MELT_COLS; i++) {
    const startX0 = Math.round(i * _startCanvas.width / MELT_COLS);
    const startX1 = Math.round((i + 1) * _startCanvas.width / MELT_COLS);
    const endX0 = Math.round(i * _endCanvas.width / MELT_COLS);
    const endX1 = Math.round((i + 1) * _endCanvas.width / MELT_COLS);
    const destX0 = Math.round(targetX + i * targetW / MELT_COLS);
    const destX1 = Math.round(targetX + (i + 1) * targetW / MELT_COLS);
    const yOff   = Math.max(0, _y[i]);
    const destY = Math.round(targetY + yOff * targetH / SCREENHEIGHT);
    if (yOff > 0) {
      const endY = Math.round(yOff * _endCanvas.height / SCREENHEIGHT);
      targetCtx.drawImage(
        _endCanvas,
        endX0, 0, endX1 - endX0, endY,
        destX0, targetY, destX1 - destX0, destY - targetY,
      );
    }
    if (yOff < SCREENHEIGHT) {
      const startH = _startCanvas.height - Math.round(
        yOff * _startCanvas.height / SCREENHEIGHT,
      );
      targetCtx.drawImage(
        _startCanvas,
        startX0, 0, startX1 - startX0, startH,
        destX0, destY, destX1 - destX0, Math.round(targetY + targetH) - destY,
      );
    }
  }
}

export function wipe_isActive() { return _active; }

export function wipe_Shutdown() {
  if (_startCanvas !== null) { _startCanvas.width = 0; _startCanvas.height = 0; }
  if (_endCanvas !== null) { _endCanvas.width = 0; _endCanvas.height = 0; }
  if (_presentCanvas !== null) { _presentCanvas.width = 0; _presentCanvas.height = 0; }
  if (_wipeCanvas !== null) {
    _wipeCanvas.width = 0;
    _wipeCanvas.height = 0;
    _wipeCanvas.remove();
  }
  _startCanvas = null;
  _endCanvas = null;
  _presentCanvas = null;
  _wipeCanvas = null;
  _wipeCtx = null;
  _y = null;
  _active = false;
}
