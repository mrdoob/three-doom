// Ported from: linuxdoom-1.10/p_tick.c
// Thinker list (doubly-linked) + P_Ticker, the per-tic update.

import { thinker_t } from './d_think.js';
import { paused, netgame, menuactive, demoplayback, players, playeringame, consoleplayer, set_leveltime, leveltime, gametic } from './doomstat.js';
import { MAXPLAYERS } from './doomdef.js';
import { _get_prndindex } from './m_random.js';

export const thinkercap = new thinker_t();
if (typeof globalThis !== 'undefined') globalThis.__doom_thinkercap = thinkercap;

export function P_InitThinkers() {
  thinkercap.prev = thinkercap;
  thinkercap.next = thinkercap;
}

export function P_AddThinker(thinker) {
  thinkercap.prev.next = thinker;
  thinker.next = thinkercap;
  thinker.prev = thinkercap.prev;
  thinkercap.prev = thinker;
}

// Lazy removal — the thinker is unlinked on its next P_RunThinkers visit.
const _REMOVED = Symbol('thinker_removed');
export function P_RemoveThinker(thinker) {
  thinker.function = _REMOVED;
}
// True if the thinker has been queued for removal. Use to bail mid-tick when
// e.g. P_XYMovement explodes a missile that then calls P_RemoveMobj.
export function P_ThinkerRemoved(thinker) {
  return thinker.function === _REMOVED;
}

export function P_AllocateThinker(_thinker) {
  // JS GC; no-op.
}

// External hooks wired by other modules during init.
let P_PlayerThink     = (_p) => {};
let P_UpdateSpecials  = () => {};
let P_RespawnSpecials = () => {};
export function P_SetExternals(refs) {
  if (refs.P_PlayerThink != null)            P_PlayerThink            = refs.P_PlayerThink;
  if (refs.P_UpdateSpecials != null)         P_UpdateSpecials         = refs.P_UpdateSpecials;
  if (refs.P_RespawnSpecials != null)        P_RespawnSpecials        = refs.P_RespawnSpecials;
}

export function P_RunThinkers() {
  let cur = thinkercap.next;
  while (cur !== thinkercap) {
    if (cur.function === _REMOVED) {
      // Unlink + drop reference (GC).
      cur.next.prev = cur.prev;
      cur.prev.next = cur.next;
    } else if (cur.function !== null) {
      cur.function(cur);
    }
    cur = cur.next;
  }
}

// Per-tic trace, lazily enabled by setting `globalThis.__demoTrace = []` from
// the browser console. One row per executed tic: same fields as the patched
// chocolate-doom logger, for direct diffing.
// Demo trace dumper for desync investigation. Off by default; enable from
// the console with `globalThis.__demoTrace = []` BEFORE the auto-attract
// demo starts. Each tic pushes [gametic, prndindex, x, y, angle, hp].
function _maybeTrace() {
  if (typeof globalThis === 'undefined') return;
  const buf = globalThis.__demoTrace;
  if (buf === undefined || buf === null) return;
  const p = players[consoleplayer];
  if (p === null || p === undefined || p.mo === null || p.mo === undefined) return;
  buf.push([gametic, _get_prndindex(), p.mo.x | 0, p.mo.y | 0, p.mo.angle >>> 0, p.health | 0]);
}

// p_tick.c — P_Ticker. P_PlayerInSpecialSector is called inside P_PlayerThink
// (vanilla); do not call it here too or damage applies twice per tic.
export function P_Ticker() {
  if (paused) return;
  if (netgame === false && menuactive && demoplayback === false &&
      players[consoleplayer] !== null && players[consoleplayer] !== undefined &&
      players[consoleplayer].viewz !== 1) return;
  for (let i = 0; i < MAXPLAYERS; i++) {
    if (playeringame[i]) P_PlayerThink(players[i]);
  }
  P_RunThinkers();
  P_UpdateSpecials();
  P_RespawnSpecials();
  set_leveltime(leveltime + 1);
  _maybeTrace();
}
