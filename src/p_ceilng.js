// Ported from: linuxdoom-1.10/p_ceilng.c — ceiling crushers + raise/lower.

import { sectors, numsectors } from './p_setup.js';
import { T_MovePlane, RESULT_PASTDEST, RESULT_CRUSHED } from './p_floor.js';

const FRACUNIT = 65536;
const CEILSPEED = FRACUNIT;

export const lowerToFloor = 0, raiseToHighest = 1, lowerAndCrush = 2,
  crushAndRaise = 3, fastCrushAndRaise = 4, silentCrushAndRaise = 5;

let _R_UpdateSectorPlanes = null;
let _P_AddThinker = null, _P_RemoveThinker = null;
let _S = null;
export function P_CeilingSetExternals(refs) {
  if (refs.R_UpdateSectorPlanes != null) _R_UpdateSectorPlanes = refs.R_UpdateSectorPlanes;
  if (refs.P_AddThinker != null)         _P_AddThinker         = refs.P_AddThinker;
  if (refs.P_RemoveThinker != null)      _P_RemoveThinker      = refs.P_RemoveThinker;
  if (refs.S != null)                    _S                    = refs.S;
}

function P_FindHighestCeilingSurrounding(sec) {
  let h = 0;
  for (const li of sec.lines) {
    let other = null;
    if (li.frontsector === sec && li.backsector !== null) other = li.backsector;
    else if (li.backsector === sec && li.frontsector !== null) other = li.frontsector;
    if (other !== null && other.ceilingheight > h) h = other.ceilingheight;
  }
  return h;
}

// p_ceilng.c:52 — T_MoveCeiling.
export function T_MoveCeiling(thinker) {
  const c = thinker.__ceiling;
  if (c === undefined) return;
  const leveltime = (globalThis.__doom_leveltime | 0);
  let res;
  switch (c.direction) {
    case 0: return; // stasis
    case 1: // UP
      res = T_MovePlane(c.sector, c.speed, c.topheight, false, 1, 1);
      if ((leveltime & 7) === 0 && c.type !== silentCrushAndRaise && _S !== null) {
        _S.S_StartSound(c.sector.soundorg, 22 /*sfx_stnmov*/);
      }
      if (res === RESULT_PASTDEST) {
        switch (c.type) {
          case raiseToHighest:
            c.sector.specialdata = null;
            if (_P_RemoveThinker !== null) _P_RemoveThinker(thinker);
            break;
          case silentCrushAndRaise:
            if (_S !== null) _S.S_StartSound(c.sector.soundorg, 19 /*sfx_pstop*/);
            // fallthrough
          case fastCrushAndRaise:
          case crushAndRaise:
            c.direction = -1;
            break;
        }
      }
      break;
    case -1: // DOWN
      res = T_MovePlane(c.sector, c.speed, c.bottomheight, c.crush, 1, -1);
      if ((leveltime & 7) === 0 && c.type !== silentCrushAndRaise && _S !== null) {
        _S.S_StartSound(c.sector.soundorg, 22 /*sfx_stnmov*/);
      }
      if (res === RESULT_PASTDEST) {
        switch (c.type) {
          case silentCrushAndRaise:
            if (_S !== null) _S.S_StartSound(c.sector.soundorg, 19 /*sfx_pstop*/);
            c.speed = CEILSPEED;
            c.direction = 1;
            break;
          case crushAndRaise:
            c.speed = CEILSPEED;
            c.direction = 1;
            break;
          case fastCrushAndRaise:
            c.direction = 1;
            break;
          case lowerAndCrush:
          case lowerToFloor:
            c.sector.specialdata = null;
            if (_P_RemoveThinker !== null) _P_RemoveThinker(thinker);
            break;
        }
      } else if (res === RESULT_CRUSHED) {
        switch (c.type) {
          case crushAndRaise:
          case silentCrushAndRaise:
          case lowerAndCrush:
            c.speed = CEILSPEED / 8;
            break;
        }
      }
      break;
  }
}

// p_ceilng.c:148 — EV_DoCeiling.
export function EV_DoCeiling(line, type) {
  let rtn = 0;
  // p_ceilng.c:180 — for the crusher types, first try to reactivate any
  // matching crusher already in stasis. SR Crush lines depend on this so a
  // halted crusher can be re-triggered.
  if (type === fastCrushAndRaise || type === silentCrushAndRaise || type === crushAndRaise) {
    P_ActivateInStasisCeiling(line);
  }
  for (let i = 0; i < numsectors; i++) {
    const sec = sectors[i];
    if (sec.tag !== line.tag) continue;
    if (sec.specialdata !== null) continue;
    rtn = 1;
    const c = {
      sector: sec, speed: CEILSPEED, crush: false, type, direction: 0,
      topheight: sec.ceilingheight, bottomheight: sec.floorheight,
      tag: sec.tag, olddirection: 0,
    };
    switch (type) {
      case fastCrushAndRaise:
        c.crush = true;
        c.topheight    = sec.ceilingheight;
        c.bottomheight = sec.floorheight + 8 * FRACUNIT;
        c.direction = -1;
        c.speed = CEILSPEED * 2;
        break;
      case silentCrushAndRaise:
      case crushAndRaise:
        c.crush = true;
        c.topheight    = sec.ceilingheight;
        // fallthrough
      case lowerAndCrush:
      case lowerToFloor:
        c.bottomheight = (type === lowerToFloor) ? sec.floorheight : sec.floorheight + 8 * FRACUNIT;
        c.direction = -1;
        break;
      case raiseToHighest:
        c.topheight = P_FindHighestCeilingSurrounding(sec);
        c.direction = 1;
        break;
    }
    sec.specialdata = c;
    if (_P_AddThinker !== null) {
      const t = { prev: null, next: null, function: T_MoveCeiling, __ceiling: c };
      _P_AddThinker(t);
    }
  }
  return rtn;
}

// p_ceilng.c uses an explicit activeceilings[MAXCEILINGS] table. Our port
// tracks live ceilings via the thinker list (the same convention p_plats
// uses) by reading sector.specialdata, so the add/remove primitives are
// just bookkeeping hooks — the array lookup becomes a sector walk.
export function P_AddActiveCeiling(_c)    { /* tracked via thinker list */ }
export function P_RemoveActiveCeiling(_c) { /* tracked via thinker list */ }

// p_ceilng.c:314 — EV_CeilingCrushStop. Pauses every active crusher with
// the matching line tag. T_MoveCeiling already early-returns on direction=0,
// so we just stash olddirection and zero direction. EV_DoCeiling's stasis
// detection later (via P_ActivateInStasisCeiling) reverses it.
export function EV_CeilingCrushStop(line) {
  let rtn = 0;
  for (let i = 0; i < numsectors; i++) {
    const sec = sectors[i];
    const c = sec.specialdata;
    if (c !== null && c.tag === line.tag && c.direction !== 0) {
      c.olddirection = c.direction;
      c.direction    = 0;
      rtn = 1;
    }
  }
  return rtn;
}

// p_ceilng.c:291 — P_ActivateInStasisCeiling. Resumes paused crushers whose
// tag matches the (re-)pressed line. Called from EV_DoCeiling at the top of
// the dispatch so an SR Crush line can flip a halted crusher back on.
export function P_ActivateInStasisCeiling(line) {
  for (let i = 0; i < numsectors; i++) {
    const sec = sectors[i];
    const c = sec.specialdata;
    if (c !== null && c.tag === line.tag && c.direction === 0) {
      c.direction = c.olddirection;
    }
  }
}
