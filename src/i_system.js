// Ported from: linuxdoom-1.10/i_system.c, i_system.h
// System-specific interface for the browser.

import { TICRATE } from './doomdef.js';
import { M_SaveDefaults, M_StopDefaultsPersistence } from './m_misc.js';
import { I_ShutdownMusic, I_ShutdownSound } from './i_sound.js';
import { I_RunQuitSequence } from './i_shutdown.js';

// Doom uses a 35Hz tic clock derived from real-time. In the browser we anchor
// at I_Init() and report ticks based on performance.now().
let timeBase = 0;

export function I_Init() {
  timeBase = (typeof performance !== 'undefined' ? performance.now() : Date.now());
}

// Returns current time in tics (1 tic = 1/35 second).
export function I_GetTime() {
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return ((now - timeBase) * TICRATE / 1000) | 0;
}

// In C, I_ZoneBase mallocs a 6MB heap. JS GC handles allocation, so this is
// a stub kept for API compatibility.
export function I_ZoneBase() { return null; }

// I_StartFrame / I_StartTic: per-frame and per-tic input poll hooks. The
// actual event delivery happens in i_video.js (keyboard/mouse listeners
// post events directly), so both are no-ops in the browser port.
export function I_StartFrame() {}
export function I_StartTic() {}

// Base ticcmd buffer (one of MAXPLAYERS).
let _baseTiccmd = null;
export function I_BaseTiccmd() {
  if (_baseTiccmd === null) {
    _baseTiccmd = { forwardmove: 0, sidemove: 0, angleturn: 0, consistancy: 0, chatchar: 0, buttons: 0 };
  }
  return _baseTiccmd;
}

// i_video registers its graphics owner at module evaluation time. Keeping the
// callback here avoids an i_system -> i_video import cycle while still letting
// I_Quit own the reference subsystem order.
let _shutdownGraphics = null;
let _pendingGraphicsQuit = null;
export function I_RegisterQuitGraphics(shutdown) {
  _shutdownGraphics = shutdown;
  if (_pendingGraphicsQuit === null) return;

  // I_Quit can precede i_video module evaluation during early startup. Claim
  // graphics synchronously as registration completes so later startup work
  // sees the renderer as terminal, while preserving its result in I_Quit.
  const pending = _pendingGraphicsQuit;
  _pendingGraphicsQuit = null;
  try {
    Promise.resolve(shutdown()).then(pending.resolve, pending.reject);
  } catch (error) {
    pending.reject(error);
  }
}

function I_ShutdownRegisteredGraphics() {
  if (_shutdownGraphics !== null) return _shutdownGraphics();
  return new Promise((resolve, reject) => {
    _pendingGraphicsQuit = { resolve, reject };
  });
}

// The browser port has no live network transport. This is the single-player
// no-op equivalent of d_net.c:D_QuitNetGame, retained as an explicit stage so
// a future transport cannot accidentally be shut down out of order.
function D_QuitNetGame() {}

function I_SaveDefaultsAndStopPersistence() {
  try {
    M_SaveDefaults();
  } finally {
    M_StopDefaultsPersistence();
  }
}

let _quitPromise = null;
export function I_Quit() {
  if (_quitPromise !== null) return _quitPromise;

  // Publish the cached promise before any stage runs so even a re-entrant quit
  // from a callback observes the same terminal operation.
  let resolveQuit;
  let rejectQuit;
  _quitPromise = new Promise((resolve, reject) => {
    resolveQuit = resolve;
    rejectQuit = reject;
  });

  const sequence = I_RunQuitSequence({
    // i_system.c:118-122 — exact source call order.
    D_QuitNetGame,
    I_ShutdownSound,
    I_ShutdownMusic,
    M_SaveDefaults: I_SaveDefaultsAndStopPersistence,
    I_ShutdownGraphics: I_ShutdownRegisteredGraphics,
  });
  sequence.then(resolveQuit, rejectQuit);

  // Event and programmatic callers need not await process-style quit. Observe
  // the cached promise here so aggregated cleanup failures are not unhandled.
  void _quitPromise.catch((error) => {
    console.error('I_Quit teardown failed:', error);
  });
  return _quitPromise;
}

// Allocate low memory. In the browser this is just a typed array.
export function I_AllocLow(length) {
  return new Uint8Array(length);
}

export function I_Tactile(_on, _off, _total) {
  // No haptics in the browser port.
}

// I_Error: log and throw. The main loop catches and displays it.
export function I_Error(...args) {
  const msg = args.length === 1 ? String(args[0]) : args.map(String).join(' ');
  console.error('I_Error:', msg);
  throw new Error(msg);
}
