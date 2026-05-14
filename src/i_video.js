// Ported from: linuxdoom-1.10/i_video.c
// Browser video adapter. Hosts:
//   - the Three.js WebGLRenderer + scene + perspective camera (used by r_*)
//   - a Canvas2D overlay for paletted-screen blits (status bar, menu, HUD)
//   - keyboard / mouse input -> D_PostEvent
//
// Doom drew a paletted SCREENWIDTH x SCREENHEIGHT framebuffer; we keep that
// framebuffer (`screens[0]` in v_video.js) and copy it to a canvas every
// frame, scaled to fit. The 3D world rendered by Three.js sits BEHIND that
// 2D layer at a configurable viewport.

import * as THREE from 'three';
import { SCREENWIDTH, SCREENHEIGHT, KEY_LEFTARROW, KEY_RIGHTARROW, KEY_UPARROW, KEY_DOWNARROW, KEY_ESCAPE, KEY_ENTER, KEY_TAB, KEY_BACKSPACE, KEY_PAUSE, KEY_F1, KEY_F2, KEY_F3, KEY_F4, KEY_F5, KEY_F6, KEY_F7, KEY_F8, KEY_F9, KEY_F10, KEY_F11, KEY_F12, KEY_RSHIFT, KEY_RCTRL, KEY_RALT } from './doomdef.js';
import { evtype_t, D_PostEvent } from './d_event.js';
import { screens } from './v_video.js';

// ---------- Three.js setup ----------
export let renderer = null;
export let scene    = null;
export let camera   = null;

// 2D overlay
let overlayCanvas = null;
let overlayCtx    = null;
let rgbaBuffer    = null;          // ImageData for paletted-screen blits
let palette       = null;          // 256*4 RGBA bytes (current palette)
const palette14   = new Uint8Array(14 * 256 * 4); // all 14 palettes, prebuilt

// Cached canvas for upscaling the 320x200 framebuffer.
let scratchCanvas = null;

export function I_InitGraphics() {
  // Three.js renderer
  const container = document.getElementById('container');
  renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setClearColor(0x000000);
  // Doom palette values are art-directed for direct CRT display. We keep
  // textures in linear-srgb space so the per-vertex `lightlevel/255`
  // multiplication doesn't double-linearise, and let the renderer apply the
  // standard sRGB output curve so darks look right.
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  scene  = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(90, window.innerWidth / window.innerHeight, 1, 16384);

  // 2D overlay
  overlayCanvas = document.getElementById('overlay');
  // The overlay is sized to the window; we paint the paletted screen
  // into a 320x200 ImageData then drawImage-scale onto the overlay.
  resize();
  overlayCtx = overlayCanvas.getContext('2d');
  overlayCtx.imageSmoothingEnabled = false;

  scratchCanvas = document.createElement('canvas');
  scratchCanvas.width  = SCREENWIDTH;
  scratchCanvas.height = SCREENHEIGHT;
  rgbaBuffer = scratchCanvas.getContext('2d').createImageData(SCREENWIDTH, SCREENHEIGHT);

  window.addEventListener('resize', resize);

  // Keyboard
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup',   onKeyUp);

  // Mouse (pointer lock for FPS-style mouse look) — only acquire inside an
  // interactive level. The title screen, menu, and demo playback all keep the
  // pointer free so the user can navigate / leave without being captured.
  renderer.domElement.addEventListener('click', async () => {
    const ds = await import('./doomstat.js');
    if (ds.gamestate !== 0 /*GS_LEVEL*/) return;
    if (ds.demoplayback) return;
    if (document.pointerLockElement !== renderer.domElement) {
      renderer.domElement.requestPointerLock?.();
    }
  });
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup',   onMouseUp);

  // Expose globals on `window` so the dev console can poke at them.
  if (typeof window !== 'undefined') {
    window.renderer = renderer;
    window.scene    = scene;
    window.camera   = camera;
  }
}

export function I_ShutdownGraphics() {
  if (renderer) renderer.dispose();
  window.removeEventListener('resize', resize);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup',   onKeyUp);
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mousedown', onMouseDown);
  window.removeEventListener('mouseup',   onMouseUp);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  overlayCanvas.width  = w;
  overlayCanvas.height = h;
  if (renderer) { renderer.setSize(w, h); }
  if (camera)   { camera.aspect = w / h; camera.updateProjectionMatrix(); }
}

// ---------- Palette ----------

// Takes a 768-byte PLAYPAL chunk (RGB triplets for 256 colors) and stores it.
// Doom's PLAYPAL lump holds 14 such palettes back-to-back (3584 bytes).
// We accept either form: a single palette (768 bytes) sets palette index 0,
// while a full PLAYPAL (3584 bytes) populates all 14.
export function I_SetPalette(rgbBytes) {
  if (rgbBytes.length === 768) {
    palette = palettize(rgbBytes);
  } else if (rgbBytes.length >= 14 * 768) {
    for (let p = 0; p < 14; p++) {
      const dst = palette14.subarray(p * 256 * 4);
      const src = rgbBytes.subarray(p * 768, (p + 1) * 768);
      dst.set(palettize(src));
    }
    palette = palette14.subarray(0, 256 * 4);
  } else {
    // Partial — interpret what we have as a single palette.
    palette = palettize(rgbBytes);
  }
}

function palettize(rgb) {
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    out[i * 4 + 0] = rgb[i * 3 + 0];
    out[i * 4 + 1] = rgb[i * 3 + 1];
    out[i * 4 + 2] = rgb[i * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

// Fullscreen tint quad — driven by I_SetPaletteIndex. Rendered with an
// OrthographicCamera over the main scene; pure WebGL, no DOM filters.
let _tintScene = null, _tintCamera = null, _tintMat = null;
function ensureTintQuad() {
  if (_tintScene !== null) return;
  _tintScene  = new THREE.Scene();
  _tintCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  _tintMat = new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0, depthTest: false, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), _tintMat);
  _tintScene.add(mesh);
}
function setTint(r, g, b, alpha) {
  ensureTintQuad();
  _tintMat.color.setRGB(r, g, b);
  _tintMat.opacity = alpha;
}
// Called from D_Display after the main 3D scene is rendered.
export function I_RenderTint() {
  if (_tintScene === null || _tintMat.opacity <= 0 || renderer === null) return;
  renderer.autoClear = false;
  renderer.render(_tintScene, _tintCamera);
  renderer.autoClear = true;
}

// Switches the active palette to one of the 14 stored in palette14 (used by
// damage flash, item flash, radiation suit).
export function I_SetPaletteIndex(n) {
  if (n < 0 || n >= 14) n = 0;
  palette = palette14.subarray(n * 256 * 4, (n + 1) * 256 * 4);
  ensureTintQuad();
  if (n === 0) {
    setTint(0, 0, 0, 0);
  } else if (n >= 1 && n <= 8) {       // red damage (PLAYPAL 1..8)
    const t = n / 8;
    setTint(1, 0, 0, 0.15 + t * 0.30);
  } else if (n >= 9 && n <= 12) {      // yellow bonus pickup
    const t = (n - 8) / 4;
    setTint(1, 0.85, 0.35, 0.08 + t * 0.10);
  } else if (n === 13) {                // green radsuit
    setTint(0.2, 1, 0.2, 0.25);
  }
}

// ---------- Per-frame ----------

// I_UpdateNoBlit: no-op (the C code used it for dirty-rect tracking only).
export function I_UpdateNoBlit() {}

// I_FinishUpdate: present the frame. Paint the paletted screen onto the 2D
// overlay; Three.js renders the 3D world separately (called from R_RenderPlayerView).
export function I_FinishUpdate() {
  if (palette === null || overlayCtx === null) return;

  // Pal-index -> RGBA into rgbaBuffer.
  const src = screens[0];
  const dst = rgbaBuffer.data;
  for (let i = 0, j = 0; i < src.length; i++, j += 4) {
    const p = src[i] * 4;
    dst[j + 0] = palette[p + 0];
    dst[j + 1] = palette[p + 1];
    dst[j + 2] = palette[p + 2];
    dst[j + 3] = palette[p + 3];
  }
  const sctx = scratchCanvas.getContext('2d');
  sctx.putImageData(rgbaBuffer, 0, 0);

  const cw = overlayCanvas.width;
  const ch = overlayCanvas.height;
  // Letterboxed to 320x200 aspect (1.6:1).
  const scale = Math.min(cw / SCREENWIDTH, ch / SCREENHEIGHT);
  const dw = SCREENWIDTH  * scale;
  const dh = SCREENHEIGHT * scale;
  const dx = (cw - dw) * 0.5;
  const dy = (ch - dh) * 0.5;
  overlayCtx.clearRect(0, 0, cw, ch);
  overlayCtx.drawImage(scratchCanvas, 0, 0, SCREENWIDTH, SCREENHEIGHT, dx, dy, dw, dh);
}

export function I_WaitVBL(_count) { /* unused in browser */ }

export function I_ReadScreen(scr) {
  scr.set(screens[0]);
}

export function I_BeginRead() {}
export function I_EndRead()   {}

// ---------- Input ----------

// Map a browser KeyboardEvent.code to Doom's keycode space.
function xlatekey(e) {
  // Doom uses lowercase ASCII for letters and special codes for arrows/F-keys.
  // We map common keys; everything else falls back to e.key.charCodeAt(0).
  const code = e.code;
  switch (code) {
    case 'ArrowLeft':  return KEY_LEFTARROW;
    case 'ArrowRight': return KEY_RIGHTARROW;
    case 'ArrowUp':    return KEY_UPARROW;
    case 'ArrowDown':  return KEY_DOWNARROW;
    case 'Escape':     return KEY_ESCAPE;
    case 'Enter':      return KEY_ENTER;
    case 'Tab':        return KEY_TAB;
    case 'Backspace':  return KEY_BACKSPACE;
    case 'Pause':      return KEY_PAUSE;
    case 'F1': return KEY_F1; case 'F2': return KEY_F2;
    case 'F3': return KEY_F3; case 'F4': return KEY_F4;
    case 'F5': return KEY_F5; case 'F6': return KEY_F6;
    case 'F7': return KEY_F7; case 'F8': return KEY_F8;
    case 'F9': return KEY_F9; case 'F10': return KEY_F10;
    case 'F11': return KEY_F11; case 'F12': return KEY_F12;
    case 'ShiftLeft': case 'ShiftRight': return KEY_RSHIFT;
    case 'ControlLeft': case 'ControlRight': return KEY_RCTRL;
    case 'AltLeft': case 'AltRight': return KEY_RALT;
    case 'Space': return ' '.charCodeAt(0);
  }
  // Letters / digits — Doom uses lowercase ASCII.
  if (code.startsWith('Key') && code.length === 4) {
    return code.charCodeAt(3) + 32; // 'KeyA' -> 'a'
  }
  if (code.startsWith('Digit') && code.length === 6) {
    return code.charCodeAt(5);
  }
  if (e.key.length === 1) return e.key.toLowerCase().charCodeAt(0);
  return 0;
}

function onKeyDown(e) {
  const k = xlatekey(e);
  if (k !== 0) {
    D_PostEvent({ type: evtype_t.ev_keydown, data1: k, data2: 0, data3: 0 });
    e.preventDefault();
  }
}

function onKeyUp(e) {
  const k = xlatekey(e);
  if (k !== 0) {
    D_PostEvent({ type: evtype_t.ev_keyup, data1: k, data2: 0, data3: 0 });
    e.preventDefault();
  }
}

let mouseButtons = 0;
function onMouseMove(e) {
  if (document.pointerLockElement !== renderer?.domElement) return;
  // Doom expects ev_mouse with x/y deltas. movementX/movementY are in CSS pixels.
  D_PostEvent({ type: evtype_t.ev_mouse, data1: mouseButtons, data2: e.movementX | 0, data3: -e.movementY | 0 });
}
function onMouseDown(e) {
  mouseButtons |= (1 << e.button);
  D_PostEvent({ type: evtype_t.ev_mouse, data1: mouseButtons, data2: 0, data3: 0 });
}
function onMouseUp(e) {
  mouseButtons &= ~(1 << e.button);
  D_PostEvent({ type: evtype_t.ev_mouse, data1: mouseButtons, data2: 0, data3: 0 });
}
