// Ported from: linuxdoom-1.10/i_system.c, i_system.h
// System-specific interface for the browser.

import { TICRATE } from './doomdef.js';

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

export function I_Quit() {
  // No exit code in the browser — show the title screen / stop the loop.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('doom:quit'));
  }
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
