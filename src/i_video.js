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
import { gammatable, screens, usegamma } from './v_video.js';
import {
  V_GetActivePalette, V_InitPlaypal, V_IsPlaypalReady,
  V_PaletteCSS, V_SetPaletteIndex,
} from './v_palette.js';
import {
  paletteIndexCaptureUniform,
  R_SetPaletteIndex,
  R_SetPlaypal,
  R_SetSpriteFuzzFrame,
  R_ShutdownShader,
} from './r_shader.js';
import { D_DoomRafLoop } from './d_loop.js';
import { D_ShouldInterceptDemoInput } from './d_input_logic.js';
import {
  R_CalculateCanvasView, R_CAMERA_FAR, R_CAMERA_NEAR, R_DoomVerticalFov,
  R_GetViewSize,
} from './r_view.js';
import { I_Quit, I_RegisterQuitGraphics } from './i_system.js';
import { I_RunCleanupSteps } from './i_shutdown.js';
import { R_RenderRetainedLevel } from './r_sprite_depth.js';
import {
  R_BeginFuzzFrame,
  R_ClearPspriteFuzzCapture,
  R_ShutdownFuzz,
  R_StorePspriteFuzzCapture,
  R_TakePspriteFuzzCaptureRequest,
} from './r_fuzz.js';

// ---------- Three.js setup ----------
export let renderer = null;
export let scene    = null;
export let camera   = null;

// Vanilla sets `projection = centerx`, so the left and right view rays are
// always 45 degrees from the optical axis: a 90-degree horizontal FOV.
// THREE.PerspectiveCamera.fov is vertical, so derive it from the live aspect.
function configureViewCamera(targetCamera, view = R_GetViewSize()) {
  if (targetCamera === null) return;
  const aspect = view.scaledviewwidth / view.viewheight;
  const fov = R_DoomVerticalFov(aspect);
  if (targetCamera.aspect === aspect && targetCamera.fov === fov) return;
  targetCamera.aspect = aspect;
  targetCamera.fov = fov;
  targetCamera.updateProjectionMatrix();
}

// 2D overlay
let overlayCanvas = null;
let overlayCtx    = null;
let rgbaBuffer    = null;          // ImageData for paletted-screen blits

// Cached canvas for upscaling the 320x200 framebuffer.
let scratchCanvas = null;

// Logical-view-sized RGBA8 targets. Their red byte is a post-COLORMAP palette
// index. The first holds the world with frustum-visible fuzz sprites omitted;
// the second is allocated only for the rare world-fuzz + psprite-fuzz frame,
// where it captures the composed world after those sprites sample the first.
let spriteFuzzIndexTarget = null;
let spriteFuzzComposedTarget = null;
let spriteFuzzReadback = null;
const spriteFuzzFrustum = new THREE.Frustum();
const spriteFuzzProjection = new THREE.Matrix4();
const spriteFuzzSavedViewport = new THREE.Vector4();
const spriteFuzzSavedScissor = new THREE.Vector4();
const spriteFuzzSavedClearColor = new THREE.Color();
const spriteFuzzVisible = [];
const _fuzzCaptureStats = {
  indexPasses: 0,
  readbacks: 0,
  lastWorldFuzzSprites: 0,
  lastIndexPasses: 0,
  lastPspriteCapture: false,
  lastComposedCapture: false,
  lastTargetWidth: 0,
  lastTargetHeight: 0,
};

// Cache cross-module references at module load — input handlers are a hot
// path and `await import()` per event adds microtask latency. Dynamic import
// is only needed to break the i_video ↔ m_menu cycle at startup.
let _mMenu    = null;
let _doomstat = null;
import('./m_menu.js').then((m)  => { if (_shuttingDown === false) _mMenu = m; });
import('./doomstat.js').then((d) => { if (_shuttingDown === false) _doomstat = d; });

let _onPointerLockChange = null;
let _rendererClickTarget = null;
let _paletteClearColor = 0x000000;
// A primary press that opens the attract/demo menu is followed by a browser
// `click`.  Suppress only that matching click so it cannot immediately act on
// the newly-opened menu; later clicks remain available to M_HandleTap.
let _suppressRendererClick = false;
let _shutdownPromise = null;
let _shuttingDown = false;
const _shutdownHooks = new Set();

function demoInputIsIntercepted() {
  return _doomstat !== null && D_ShouldInterceptDemoInput(_doomstat);
}

// Input modules register their listener cleanup here. This lets graphics
// shutdown detach input synchronously before its async resource imports yield.
export function I_RegisterGraphicsShutdownHook(hook) {
  if (_shuttingDown === true) {
    hook();
    return () => {};
  }
  _shutdownHooks.add(hook);
  return () => { _shutdownHooks.delete(hook); };
}

function onRendererClick(e) {
  if (_shuttingDown === true || renderer === null || _doomstat === null) return;
  if (_suppressRendererClick === true && e.button === 0) {
    _suppressRendererClick = false;
    return;
  }
  // Menu open → route the tap into the menu, before the level pointer-lock
  // grab below so it isn't swallowed into recapturing the mouse.
  if (_doomstat.menuactive === true && _mMenu !== null && overlayCanvas !== null) {
    const rect = overlayCanvas.getBoundingClientRect();
    _mMenu.M_HandleTap(e.clientX - rect.left, e.clientY - rect.top);
    return;
  }
  // g_game.c:G_Responder opens the menu for a mouse-button event throughout
  // demo playback, including demo intermissions/finales, not just GS_LEVEL.
  if (demoInputIsIntercepted() && _mMenu !== null) {
    _mMenu.M_StartControlPanel();
    return;
  }
  if (_doomstat.gamestate === 0 /*GS_LEVEL*/ && _doomstat.demoplayback !== true) {
    if (document.pointerLockElement !== renderer.domElement) {
      renderer.domElement.requestPointerLock?.();
    }
    return;
  }
  // Intermission / finale own their own input — clicking should not hijack
  // them into opening the menu, or the user can never get past them.
  if (_doomstat.gamestate === 1 /*GS_INTERMISSION*/ ||
      _doomstat.gamestate === 2 /*GS_FINALE*/) return;
  if (_doomstat.menuactive !== true && _mMenu !== null) _mMenu.M_StartControlPanel();
}

function onDoomQuit() {
  // Keep the event as a public browser entry point for explicit teardown.
  // The menu's browser-friendly Quit action only opens its farewell tab.
  void I_Quit();
}

// Registered at module evaluation, before async D_DoomMain startup can yield.
// This also makes an early programmatic I_Quit terminal for the renderer.
I_RegisterQuitGraphics(I_ShutdownGraphics);

export function I_InitGraphics() {
  if (renderer !== null || _shutdownPromise !== null) {
    throw new Error('I_InitGraphics: graphics already initialized or shut down');
  }
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

  scene = new THREE.Scene();
  const aspect = window.innerWidth / window.innerHeight;
  camera = new THREE.PerspectiveCamera(
    R_DoomVerticalFov(aspect), aspect, R_CAMERA_NEAR, R_CAMERA_FAR,
  );

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
  _rendererClickTarget = renderer.domElement;
  _rendererClickTarget.addEventListener('click', onRendererClick);
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mousedown', onMouseDown);
  window.addEventListener('mouseup',   onMouseUp);

  // The browser captures the first Esc press to drop pointer lock — that
  // keypress never reaches our keydown handler. Without this listener the
  // user has to press Esc twice (once to release, once to open the menu).
  _onPointerLockChange = () => {
    if (document.pointerLockElement === renderer.domElement) return;
    if (_doomstat === null || _mMenu === null) return;
    if (_doomstat.gamestate !== 0 /*GS_LEVEL*/) return;
    if (_doomstat.demoplayback === true) return;
    if (_doomstat.menuactive === true) return;
    _mMenu.M_StartControlPanel();
  };
  document.addEventListener('pointerlockchange', _onPointerLockChange);

  // Expose globals on `window` so the dev console can poke at them.
  if (typeof window !== 'undefined') {
    window.renderer = renderer;
    window.scene    = scene;
    window.camera   = camera;
  }
  // Wire G_ScreenShot — m_misc.M_ScreenShot dispatches 'doom:screenshot' on
  // window after G_Ticker dispatches ga_screenshot. We grab the WebGL canvas,
  // composite the 2D overlay on top, and trigger a download.
  window.addEventListener('doom:screenshot', captureScreenshot);
  window.addEventListener('doom:quit', onDoomQuit);
}

function captureScreenshot() {
  if (renderer === null || overlayCanvas === null) return;
  // Re-render so preserveDrawingBuffer isn't required.
  if (_doomstat?.gamestate === 0 /*GS_LEVEL*/) I_RenderView(scene, camera);
  else I_ClearFrame();
  const w = renderer.domElement.width;
  const h = renderer.domElement.height;
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const ctx = out.getContext('2d');
  ctx.drawImage(renderer.domElement, 0, 0);
  ctx.drawImage(overlayCanvas, 0, 0, w, h);
  out.toBlob((blob) => {
    if (blob === null) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const t = new Date().toISOString().replace(/[:.]/g, '-');
    a.download = `doom-${t}.png`;
    a.click();
    URL.revokeObjectURL(url);
  }, 'image/png');
}

export function I_ShutdownGraphics() {
  // This happens before any asynchronous teardown work, so neither a queued
  // RAF nor a callback stopped from inside a ticker can render disposed state.
  D_DoomRafLoop.close();
  if (_shutdownPromise !== null) return _shutdownPromise;
  _shuttingDown = true;

  const ownedRenderer = renderer;
  const ownedScene = scene;
  const ownedCamera = camera;
  const ownedOverlay = overlayCanvas;
  const ownedWebGLCanvas = _rendererClickTarget ?? ownedRenderer?.domElement ?? null;
  const ownedSpriteFuzzIndexTarget = spriteFuzzIndexTarget;
  const ownedSpriteFuzzComposedTarget = spriteFuzzComposedTarget;

  window.removeEventListener('resize', resize);
  window.removeEventListener('keydown', onKeyDown);
  window.removeEventListener('keyup',   onKeyUp);
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mousedown', onMouseDown);
  window.removeEventListener('mouseup',   onMouseUp);
  window.removeEventListener('doom:screenshot', captureScreenshot);
  window.removeEventListener('doom:quit', onDoomQuit);
  if (_rendererClickTarget !== null) {
    _rendererClickTarget.removeEventListener('click', onRendererClick);
    _rendererClickTarget = null;
  }
  if (_onPointerLockChange !== null) {
    document.removeEventListener('pointerlockchange', _onPointerLockChange);
    _onPointerLockChange = null;
  }
  const cleanupErrors = [];
  // Remove the pointer-lock observer first: exitPointerLock fires a
  // pointerlockchange event which must not reopen the menu during shutdown.
  if (ownedWebGLCanvas !== null && document.pointerLockElement === ownedWebGLCanvas) {
    try { document.exitPointerLock?.(); } catch (error) { cleanupErrors.push(error); }
  }
  for (const hook of [..._shutdownHooks]) {
    try { hook(); } catch (error) { cleanupErrors.push(error); }
  }
  _shutdownHooks.clear();
  // An input event can synchronously open the menu in the same task that
  // requests shutdown. Once input continuations have been invalidated above,
  // clear that UI state so quitting cannot leave doomstat.menuactive latched.
  try { _mMenu?.M_ClearMenus(); } catch (error) { cleanupErrors.push(error); }
  mouseButtons = 0;
  _suppressRendererClick = false;

  _shutdownPromise = (async () => {
    let disposedLevelObjects = 0;
    let contextLost = ownedRenderer === null;
    try {
      await I_RunCleanupSteps([
        async () => (await import('./d_main.js')).D_ShutdownDoomLoop(),
        async () => (await import('./d_keyboard.js')).D_KeyboardInput.shutdown(),
        async () => (await import('./d_freecamera.js')).D_FreeCamera.shutdown(),
        async () => { disposedLevelObjects = (await import('./r_main.js')).R_Shutdown(); },
        async () => (await import('./r_things.js')).R_ShutdownThings(),
        async () => (await import('./r_psprite.js')).R_ShutdownPlayerSprites(),
        async () => (await import('./r_border.js')).R_ShutdownViewBorder(),
        async () => (await import('./f_wipe.js')).wipe_Shutdown(),
        async () => (await import('./hu_stuff.js')).HU_Shutdown(),
        async () => (await import('./wi_stuff.js')).WI_Shutdown(),
        async () => (await import('./f_finale.js')).F_Shutdown(),
        async () => (await import('./v_video.js')).V_ShutdownCanvases(),
        async () => (await import('./r_data.js')).R_ShutdownData(),
        () => R_ShutdownShader(),
      ], cleanupErrors);
    } catch (error) {
      // I_RunCleanupSteps contains individual failures; retain this guard for
      // an unexpected iterator/helper failure without skipping finalization.
      cleanupErrors.push(error);
    } finally {
      try { if (ownedScene !== null) ownedScene.clear(); } catch (error) { cleanupErrors.push(error); }
      try { ownedSpriteFuzzIndexTarget?.dispose(); } catch (error) { cleanupErrors.push(error); }
      try { ownedSpriteFuzzComposedTarget?.dispose(); } catch (error) { cleanupErrors.push(error); }
      try {
        if (ownedOverlay !== null) {
          ownedOverlay.getContext('2d')?.clearRect(0, 0, ownedOverlay.width, ownedOverlay.height);
        }
      } catch (error) { cleanupErrors.push(error); }
      if (ownedRenderer !== null) {
        try { ownedRenderer.renderLists.dispose(); } catch (error) { cleanupErrors.push(error); }
        try { ownedRenderer.dispose(); } catch (error) { cleanupErrors.push(error); }
        try { ownedRenderer.forceContextLoss(); } catch (error) { cleanupErrors.push(error); }
        try { contextLost = ownedRenderer.getContext().isContextLost(); } catch (error) { cleanupErrors.push(error); }
      }
      try { ownedWebGLCanvas?.remove(); } catch (error) { cleanupErrors.push(error); }

      try {
        if (typeof window !== 'undefined') {
          if (window.renderer === ownedRenderer) delete window.renderer;
          if (window.scene === ownedScene) delete window.scene;
          if (window.camera === ownedCamera) delete window.camera;
        }
      } catch (error) { cleanupErrors.push(error); }
      renderer = null;
      scene = null;
      camera = null;
      overlayCanvas = null;
      overlayCtx = null;
      rgbaBuffer = null;
      spriteFuzzIndexTarget = null;
      spriteFuzzComposedTarget = null;
      spriteFuzzReadback = null;
      spriteFuzzVisible.length = 0;
      _fuzzCaptureStats.indexPasses = 0;
      _fuzzCaptureStats.readbacks = 0;
      _fuzzCaptureStats.lastWorldFuzzSprites = 0;
      _fuzzCaptureStats.lastIndexPasses = 0;
      _fuzzCaptureStats.lastPspriteCapture = false;
      _fuzzCaptureStats.lastComposedCapture = false;
      _fuzzCaptureStats.lastTargetWidth = 0;
      _fuzzCaptureStats.lastTargetHeight = 0;
      R_ShutdownFuzz();
      try {
        if (scratchCanvas !== null) {
          scratchCanvas.width = 0;
          scratchCanvas.height = 0;
        }
      } catch (error) { cleanupErrors.push(error); }
      scratchCanvas = null;
      _mMenu = null;
      _doomstat = null;
    }

    if (cleanupErrors.length !== 0) {
      throw new AggregateError(cleanupErrors, 'I_ShutdownGraphics cleanup failed');
    }
    return { disposedLevelObjects, contextLost };
  })();
  return _shutdownPromise;
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  overlayCanvas.width  = w;
  overlayCanvas.height = h;
  // Setting either canvas dimension resets every 2D context attribute.
  // Restore Doom's nearest-neighbour presentation before the next blit.
  if (overlayCtx !== null) overlayCtx.imageSmoothingEnabled = false;
  if (renderer) { renderer.setSize(w, h); }
  configureViewCamera(camera);
}

// ---------- Palette ----------

// Takes one 768-byte RGB palette or PLAYPAL's complete 14-palette lump and
// publishes it to both the Canvas and WebGL indexed renderers.
export function I_SetPalette(rgbBytes) {
  R_SetPlaypal(V_InitPlaypal(rgbBytes, gammatable[usegamma]));
  I_SetPaletteIndex(0);
}

// Switches the whole logical Doom frame to the selected PLAYPAL palette,
// matching the hardware-palette update in linuxdoom i_video.c.
export function I_SetPaletteIndex(n) {
  const selected = V_SetPaletteIndex(n);
  R_SetPaletteIndex(selected);

  // Doom also palette-shifts index 0 inside its 320x200 framebuffer. Keep that
  // color for the scissored game view, but not for the browser-only letterbox
  // outside the logical screen; the original display has no such pixels.
  _paletteClearColor = V_PaletteCSS(0);
  if (renderer !== null) renderer.setClearColor(_paletteClearColor);
}

// ---------- Per-frame ----------

// I_UpdateNoBlit: no-op (the C code used it for dirty-rect tracking only).
export function I_UpdateNoBlit() {}

export function I_GetCanvasView() {
  if (overlayCanvas === null) return null;
  return R_CalculateCanvasView(overlayCanvas.width, overlayCanvas.height);
}

// Non-level states are entirely composed by the paletted Canvas overlay.
// Clear the WebGL backing canvas without rendering a retained level scene;
// otherwise its pixels show through the transparent letterbox around title,
// credit, intermission, and screenshot frames.
export function I_ClearFrame() {
  if (renderer === null || overlayCanvas === null) return;
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, overlayCanvas.width, overlayCanvas.height);
  // Clear the host window to fixed black, then restore the active PLAYPAL
  // index-0 color. renderer.render() will use the restored color only inside
  // the Doom view's scissor rectangle.
  renderer.setClearColor(0x000000);
  renderer.clear(true, true, true);
  renderer.setClearColor(_paletteClearColor);
}

function ensureSpriteFuzzTarget(target, width, height, name) {
  const targetWidth = Math.max(1, width | 0);
  const targetHeight = Math.max(1, height | 0);
  if (target === null) {
    target = new THREE.WebGLRenderTarget(targetWidth, targetHeight, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
      stencilBuffer: false,
    });
    target.texture.generateMipmaps = false;
    target.texture.colorSpace = THREE.NoColorSpace;
    target.texture.name = name;
  } else if (target.width !== targetWidth || target.height !== targetHeight) {
    target.setSize(targetWidth, targetHeight);
  }
  // setRenderTarget uses these native target coordinates directly; avoiding a
  // public setViewport call here also avoids device-pixel-ratio scaling.
  target.viewport.set(0, 0, targetWidth, targetHeight);
  target.scissor.set(0, 0, targetWidth, targetHeight);
  target.scissorTest = false;
  return target;
}

function collectFrustumFuzzSprite(object) {
  if (object.isSprite !== true || object.userData?.doomFuzz !== true ||
      object.material?.visible === false || (object.layers.mask & 1) === 0) return;
  spriteFuzzVisible.push(object);
}

function frustumFuzzSprites(pass, targetScene, targetCamera) {
  spriteFuzzVisible.length = 0;
  const root = pass?.things ?? targetScene;
  if (root === null || root === undefined || typeof root.traverseVisible !== 'function') {
    return spriteFuzzVisible;
  }
  // Discover candidates before forcing a full retained-scene matrix update.
  // Most levels/frames contain no fuzzy actor, so the ordinary render path
  // should not pay that extra walk merely to prove the empty case.
  root.traverseVisible(collectFrustumFuzzSprite);
  if (spriteFuzzVisible.length === 0) return spriteFuzzVisible;

  targetCamera.updateMatrixWorld();
  root.updateWorldMatrix?.(true, true);
  spriteFuzzProjection.multiplyMatrices(
    targetCamera.projectionMatrix, targetCamera.matrixWorldInverse,
  );
  spriteFuzzFrustum.setFromProjectionMatrix(spriteFuzzProjection);
  let visibleCount = 0;
  for (let i = 0; i < spriteFuzzVisible.length; i++) {
    const object = spriteFuzzVisible[i];
    const intersects = typeof spriteFuzzFrustum.intersectsSprite === 'function'
      ? spriteFuzzFrustum.intersectsSprite(object)
      : spriteFuzzFrustum.intersectsObject(object);
    if (intersects) spriteFuzzVisible[visibleCount++] = object;
  }
  spriteFuzzVisible.length = visibleCount;
  return spriteFuzzVisible;
}

export function I_GetFuzzCaptureStats() {
  return { ..._fuzzCaptureStats };
}

function renderRetainedScene(targetScene, targetCamera, spriteDepthPass) {
  if (spriteDepthPass !== undefined) {
    return R_RenderRetainedLevel(renderer, targetScene, targetCamera, spriteDepthPass);
  }
  renderer.render(targetScene, targetCamera);
  return 1;
}

function renderPaletteIndexPass(
  targetScene,
  targetCamera,
  spriteDepthPass,
  target,
) {
  const previousTarget = renderer.getRenderTarget();
  renderer.getViewport(spriteFuzzSavedViewport);
  renderer.getScissor(spriteFuzzSavedScissor);
  renderer.getClearColor(spriteFuzzSavedClearColor);
  const previousScissorTest = renderer.getScissorTest();
  const previousClearAlpha = renderer.getClearAlpha();
  const previousAutoClear = renderer.autoClear;
  const previousCapture = paletteIndexCaptureUniform.value;
  const previousSceneBackground = targetScene.background;
  try {
    paletteIndexCaptureUniform.value = true;
    renderer.autoClear = true;
    renderer.setClearColor(0x000000, 1);
    targetScene.background = null;
    renderer.setRenderTarget(target);
    const submissions = renderRetainedScene(targetScene, targetCamera, spriteDepthPass);
    _fuzzCaptureStats.indexPasses++;
    _fuzzCaptureStats.lastIndexPasses++;
    return submissions;
  } finally {
    paletteIndexCaptureUniform.value = previousCapture;
    targetScene.background = previousSceneBackground;
    renderer.autoClear = previousAutoClear;
    renderer.setRenderTarget(previousTarget);
    renderer.setViewport(spriteFuzzSavedViewport);
    renderer.setScissor(spriteFuzzSavedScissor);
    renderer.setScissorTest(previousScissorTest);
    renderer.setClearColor(spriteFuzzSavedClearColor, previousClearAlpha);
  }
}

function renderBaseIndexPass(
  targetScene,
  targetCamera,
  spriteDepthPass,
  target,
  fuzzSprites,
) {
  for (const object of fuzzSprites) object.visible = false;
  try {
    return renderPaletteIndexPass(targetScene, targetCamera, spriteDepthPass, target);
  } finally {
    // traverseVisible admitted only objects whose complete parent chain and
    // own visibility were true, so their exact prior value is known.
    for (const object of fuzzSprites) object.visible = true;
  }
}

function readPspriteIndexTarget(target, view) {
  const pixelCount = target.width * target.height;
  const byteCount = pixelCount * 4;
  if (spriteFuzzReadback === null || spriteFuzzReadback.length !== byteCount) {
    spriteFuzzReadback = new Uint8Array(byteCount);
  }
  renderer.readRenderTargetPixels(
    target, 0, 0, target.width, target.height, spriteFuzzReadback,
  );
  R_StorePspriteFuzzCapture(
    spriteFuzzReadback,
    target.width,
    target.height,
    view.viewwindowx,
    view.viewwindowy,
    SCREENWIDTH,
    SCREENHEIGHT,
  );
  _fuzzCaptureStats.readbacks++;
}

// Index capture occurs only when a frustum-intersecting world fuzz sprite or
// an invisible psprite needs it. When both coexist, a second index pass lets
// the psprite sample the already-composed spectre pixels in Doom draw order.
function renderViewWithFuzz(
  targetScene,
  targetCamera,
  spriteDepthPass,
  view,
  phase,
  pspriteCaptureRequested,
) {
  const fuzzSprites = frustumFuzzSprites(spriteDepthPass, targetScene, targetCamera);
  const hasWorldFuzz = fuzzSprites.length !== 0;
  _fuzzCaptureStats.lastWorldFuzzSprites = fuzzSprites.length;
  _fuzzCaptureStats.lastPspriteCapture = pspriteCaptureRequested;

  R_SetSpriteFuzzFrame(
    null, view.scaledviewwidth, view.viewheight, view.viewheight, phase,
  );
  if (hasWorldFuzz || pspriteCaptureRequested) {
    spriteFuzzIndexTarget = ensureSpriteFuzzTarget(
      spriteFuzzIndexTarget,
      view.scaledviewwidth,
      view.viewheight,
      'doom-fuzz-base-indices',
    );
    _fuzzCaptureStats.lastTargetWidth = spriteFuzzIndexTarget.width;
    _fuzzCaptureStats.lastTargetHeight = spriteFuzzIndexTarget.height;
    renderBaseIndexPass(
      targetScene, targetCamera, spriteDepthPass, spriteFuzzIndexTarget, fuzzSprites,
    );
  }

  if (hasWorldFuzz) {
    R_SetSpriteFuzzFrame(
      spriteFuzzIndexTarget.texture,
      view.scaledviewwidth,
      view.viewheight,
      view.viewheight,
      phase,
    );
  }

  if (pspriteCaptureRequested) {
    let pspriteTarget = spriteFuzzIndexTarget;
    if (hasWorldFuzz) {
      spriteFuzzComposedTarget = ensureSpriteFuzzTarget(
        spriteFuzzComposedTarget,
        view.scaledviewwidth,
        view.viewheight,
        'doom-fuzz-composed-indices',
      );
      renderPaletteIndexPass(
        targetScene, targetCamera, spriteDepthPass, spriteFuzzComposedTarget,
      );
      pspriteTarget = spriteFuzzComposedTarget;
      _fuzzCaptureStats.lastComposedCapture = true;
    }
    // Readback is intentionally deferred until after the visible render below,
    // allowing its GPU work to overlap the completed index target first.
    const submissions = renderRetainedScene(targetScene, targetCamera, spriteDepthPass);
    readPspriteIndexTarget(pspriteTarget, view);
    return submissions;
  }

  return renderRetainedScene(targetScene, targetCamera, spriteDepthPass);
}

// Render the world only into the logical Doom view window. WebGL viewport Y
// is bottom-origin, while every Canvas overlay coordinate is top-origin.
// Clearing once with scissoring disabled prevents an old larger view from
// surviving around a newly-shrunk one.
export function I_RenderView(targetScene = scene, targetCamera = camera) {
  const pspriteCaptureRequested = R_TakePspriteFuzzCaptureRequest();
  R_ClearPspriteFuzzCapture();
  _fuzzCaptureStats.lastWorldFuzzSprites = 0;
  _fuzzCaptureStats.lastIndexPasses = 0;
  _fuzzCaptureStats.lastPspriteCapture = false;
  _fuzzCaptureStats.lastComposedCapture = false;
  _fuzzCaptureStats.lastTargetWidth = 0;
  _fuzzCaptureStats.lastTargetHeight = 0;
  if (renderer === null || targetScene === null || targetCamera === null || overlayCanvas === null) {
    return null;
  }
  const view = R_GetViewSize();
  const layout = R_CalculateCanvasView(overlayCanvas.width, overlayCanvas.height, view);
  const fuzzPhase = R_BeginFuzzFrame();
  configureViewCamera(targetCamera, view);

  I_ClearFrame();
  renderer.setViewport(layout.viewX, layout.webglViewY, layout.viewWidth, layout.viewHeight);
  renderer.setScissor(layout.viewX, layout.webglViewY, layout.viewWidth, layout.viewHeight);
  renderer.setScissorTest(true);
  try {
    const spriteDepthPass = targetScene.userData.doomSpriteDepthPass;
    renderViewWithFuzz(
      targetScene,
      targetCamera,
      spriteDepthPass,
      view,
      fuzzPhase,
      pspriteCaptureRequested,
    );
  } finally {
    spriteFuzzVisible.length = 0;
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, layout.canvasWidth, layout.canvasHeight);
  }
  return layout;
}

// I_FinishUpdate: present the frame. Paint the paletted screen onto the 2D
// overlay; I_RenderView submits the Three.js world separately.
export function I_FinishUpdate() {
  if (!V_IsPlaypalReady() || overlayCtx === null) return;

  // Pal-index -> RGBA into rgbaBuffer.
  const src = screens[0];
  const dst = rgbaBuffer.data;
  const palette = V_GetActivePalette();
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

// Map a browser KeyboardEvent.code to Doom's keycode space. d_keyboard uses
// the same translation when it offers DOM keydowns to M_Responder first.
export function I_TranslateKey(e) {
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
    case 'Backspace': case 'Delete': return KEY_BACKSPACE;
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
  const k = I_TranslateKey(e);
  if (k !== 0) {
    D_PostEvent({ type: evtype_t.ev_keydown, data1: k, data2: 0, data3: 0 });
    e.preventDefault();
  }
}

function onKeyUp(e) {
  const k = I_TranslateKey(e);
  if (k !== 0) {
    D_PostEvent({ type: evtype_t.ev_keyup, data1: k, data2: 0, data3: 0 });
    e.preventDefault();
  }
}

let mouseButtons = 0;
function onMouseMove(e) {
  // g_game.c:G_Responder intercepts demo mouse events only when their button
  // mask is nonzero.  Plain motion must still reach the local input state so
  // G_BuildTiccmd can drain it even though the demo command later replaces it.
  if (demoInputIsIntercepted() && mouseButtons !== 0) return;
  if (document.pointerLockElement !== renderer?.domElement) return;
  // Doom expects ev_mouse with x/y deltas. movementX/movementY are in CSS pixels.
  D_PostEvent({ type: evtype_t.ev_mouse, data1: mouseButtons, data2: e.movementX | 0, data3: -e.movementY | 0 });
}
function onMouseDown(e) {
  // Clear a stale suppression (for example, a drag that emitted no click).
  // A demo-opening primary press below immediately arms it again.
  if (e.button === 0) _suppressRendererClick = false;
  if (demoInputIsIntercepted()) {
    mouseButtons |= (1 << e.button);
    // Open on mousedown, not the primary-only click event: vanilla accepts any
    // nonzero mouse-button mask, including middle and right.  d_keyboard has
    // already declined to mutate gameplay state before this window handler.
    if (_doomstat?.menuactive !== true && _mMenu !== null) {
      _mMenu.M_StartControlPanel();
      if (e.button === 0) _suppressRendererClick = true;
    }
    e.preventDefault?.();
    return;
  }
  mouseButtons |= (1 << e.button);
  D_PostEvent({ type: evtype_t.ev_mouse, data1: mouseButtons, data2: 0, data3: 0 });
}
function onMouseUp(e) {
  mouseButtons &= ~(1 << e.button);
  if (demoInputIsIntercepted()) return;
  D_PostEvent({ type: evtype_t.ev_mouse, data1: mouseButtons, data2: 0, data3: 0 });
}
