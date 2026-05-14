// Ported from: linuxdoom-1.10/p_plats.c
// Platform / lift movement. Lift goes down, waits, raises back up.

import { sectors, numsectors, sides } from './p_setup.js';
import { T_MovePlane, RESULT_PASTDEST, RESULT_CRUSHED } from './p_floor.js';
import { P_Random } from './m_random.js';

const FRACUNIT = 65536;
const PLATSPEED = FRACUNIT;
const PLATWAIT  = 3; // seconds — vanilla uses 35*PLATWAIT

export const PLAT_UP = 1, PLAT_DOWN = -1, PLAT_WAITING = 0, PLAT_IN_STASIS = 2;

// Plat types.
export const perpetualRaise = 0, downWaitUpStay = 1, raiseAndChange = 2,
  raiseToNearestAndChange = 3, blazeDWUS = 4;

let _R_UpdateSectorPlanes = null;
let _P_AddThinker = null, _P_RemoveThinker = null;
let _S = null;
export function P_PlatsSetExternals(refs) {
  if (refs.R_UpdateSectorPlanes != null) _R_UpdateSectorPlanes = refs.R_UpdateSectorPlanes;
  if (refs.P_AddThinker != null)         _P_AddThinker         = refs.P_AddThinker;
  if (refs.P_RemoveThinker != null)      _P_RemoveThinker      = refs.P_RemoveThinker;
  if (refs.S != null)                    _S                    = refs.S;
}

function P_FindLowestFloorSurrounding(sec) {
  let h = sec.floorheight;
  for (const li of sec.lines) {
    let other = null;
    if (li.frontsector === sec && li.backsector !== null) other = li.backsector;
    else if (li.backsector === sec && li.frontsector !== null) other = li.frontsector;
    if (other !== null && other.floorheight < h) h = other.floorheight;
  }
  return h;
}
function P_FindHighestFloorSurrounding(sec) {
  let h = -500 * FRACUNIT;
  for (const li of sec.lines) {
    let other = null;
    if (li.frontsector === sec && li.backsector !== null) other = li.backsector;
    else if (li.backsector === sec && li.frontsector !== null) other = li.frontsector;
    if (other !== null && other.floorheight > h) h = other.floorheight;
  }
  return h;
}
function P_FindNextHighestFloor(sec, current) {
  let h = 0x7fffffff;
  let found = false;
  for (const li of sec.lines) {
    let other = null;
    if (li.frontsector === sec && li.backsector !== null) other = li.backsector;
    else if (li.backsector === sec && li.frontsector !== null) other = li.frontsector;
    if (other === null) continue;
    if (other.floorheight > current && other.floorheight < h) { h = other.floorheight; found = true; }
  }
  return found ? h : current;
}

// p_plats.c:55 — T_PlatRaise.
export function T_PlatRaise(thinker) {
  const plat = thinker.__plat;
  if (plat === undefined) return;
  let res;
  switch (plat.status) {
    case PLAT_UP:
      res = T_MovePlane(plat.sector, plat.speed, plat.high, plat.crush, 0, 1);
      if ((plat.type === raiseAndChange || plat.type === raiseToNearestAndChange) &&
          (((globalThis.__doom_leveltime | 0) & 7) === 0) && _S !== null) {
        _S.S_StartSound(plat.sector.soundorg, 22 /*sfx_stnmov*/);
      }
      if (res === RESULT_CRUSHED && !plat.crush) {
        plat.count = plat.wait;
        plat.status = PLAT_DOWN;
        if (_S !== null) _S.S_StartSound(plat.sector.soundorg, 18 /*sfx_pstart*/);
      } else if (res === RESULT_PASTDEST) {
        plat.count = plat.wait;
        plat.status = PLAT_WAITING;
        if (_S !== null) _S.S_StartSound(plat.sector.soundorg, 19 /*sfx_pstop*/);
        switch (plat.type) {
          case blazeDWUS:
          case downWaitUpStay:
          case raiseAndChange:
          case raiseToNearestAndChange:
            plat.sector.specialdata = null;
            if (_P_RemoveThinker !== null) _P_RemoveThinker(thinker);
            break;
          default: break;
        }
      }
      break;
    case PLAT_DOWN:
      res = T_MovePlane(plat.sector, plat.speed, plat.low, false, 0, -1);
      if (res === RESULT_PASTDEST) {
        plat.count = plat.wait;
        plat.status = PLAT_WAITING;
        if (_S !== null) _S.S_StartSound(plat.sector.soundorg, 19 /*sfx_pstop*/);
      }
      break;
    case PLAT_WAITING:
      // C: if (!--plat->count)
      if (--plat.count === 0) {
        plat.status = plat.sector.floorheight === plat.low ? PLAT_UP : PLAT_DOWN;
        if (_S !== null) _S.S_StartSound(plat.sector.soundorg, 18 /*sfx_pstart*/);
      }
      break;
  }
}

// p_plats.c:139 — EV_DoPlat.
export function EV_DoPlat(line, type, amount) {
  let rtn = 0;
  // perpetualRaise re-activates any in-stasis lifts with the same tag.
  if (type === perpetualRaise) P_ActivateInStasis(line.tag);
  for (let i = 0; i < numsectors; i++) {
    const sec = sectors[i];
    if (sec.tag !== line.tag) continue;
    if (sec.specialdata !== null) continue;
    rtn = 1;
    const plat = {
      sector: sec, speed: PLATSPEED, crush: false, wait: 35 * PLATWAIT,
      count: 0, status: PLAT_UP, oldstatus: PLAT_UP, type, tag: line.tag,
      low: sec.floorheight, high: sec.floorheight,
    };
    switch (type) {
      case raiseToNearestAndChange:
        plat.speed = PLATSPEED / 2;
        sec.floorpic = sides[line.sidenum[0]].sector.floorpic;
        plat.high = P_FindNextHighestFloor(sec, sec.floorheight);
        plat.wait = 0;
        plat.status = PLAT_UP;
        sec.special = 0;
        if (_S !== null) _S.S_StartSound(sec.soundorg, 22 /*sfx_stnmov*/);
        break;
      case raiseAndChange:
        plat.speed = PLATSPEED / 2;
        sec.floorpic = sides[line.sidenum[0]].sector.floorpic;
        plat.high = sec.floorheight + amount * FRACUNIT;
        plat.wait = 0;
        plat.status = PLAT_UP;
        if (_S !== null) _S.S_StartSound(sec.soundorg, 22 /*sfx_stnmov*/);
        break;
      case downWaitUpStay:
        plat.speed = PLATSPEED * 4;
        plat.low = P_FindLowestFloorSurrounding(sec);
        if (plat.low > sec.floorheight) plat.low = sec.floorheight;
        plat.high = sec.floorheight;
        plat.wait = 35 * PLATWAIT;
        plat.status = PLAT_DOWN;
        if (_S !== null) _S.S_StartSound(sec.soundorg, 18 /*sfx_pstart*/);
        break;
      case blazeDWUS:
        plat.speed = PLATSPEED * 8;
        plat.low = P_FindLowestFloorSurrounding(sec);
        if (plat.low > sec.floorheight) plat.low = sec.floorheight;
        plat.high = sec.floorheight;
        plat.wait = 35 * PLATWAIT;
        plat.status = PLAT_DOWN;
        if (_S !== null) _S.S_StartSound(sec.soundorg, 18 /*sfx_pstart*/);
        break;
      case perpetualRaise:
        plat.speed = PLATSPEED;
        plat.low = P_FindLowestFloorSurrounding(sec);
        if (plat.low > sec.floorheight) plat.low = sec.floorheight;
        plat.high = P_FindHighestFloorSurrounding(sec);
        if (plat.high < sec.floorheight) plat.high = sec.floorheight;
        plat.wait = 35 * PLATWAIT;
        // C: plat->status = P_Random()&1;  (0 = up, 1 = down)
        plat.status = (P_Random() & 1) === 0 ? PLAT_UP : PLAT_DOWN;
        if (_S !== null) _S.S_StartSound(sec.soundorg, 18 /*sfx_pstart*/);
        break;
    }
    sec.specialdata = plat;
    if (_P_AddThinker !== null) {
      const t = { prev: null, next: null, function: T_PlatRaise, __plat: plat };
      _P_AddThinker(t);
    }
  }
  return rtn;
}

export function P_AddActivePlat(_plat) { /* tracked via thinker list */ }
export function P_RemoveActivePlat(_plat) { /* tracked via thinker list */ }
export function EV_StopPlat(line) {
  for (let i = 0; i < numsectors; i++) {
    const sec = sectors[i];
    if (sec.specialdata !== null && sec.tag === line.tag && sec.specialdata.status !== PLAT_IN_STASIS) {
      sec.specialdata.oldstatus = sec.specialdata.status;
      sec.specialdata.status    = PLAT_IN_STASIS;
    }
  }
}
export function P_ActivateInStasis(tag) {
  for (let i = 0; i < numsectors; i++) {
    const sec = sectors[i];
    if (sec.specialdata !== null && sec.tag === tag && sec.specialdata.status === PLAT_IN_STASIS) {
      sec.specialdata.status = sec.specialdata.oldstatus;
    }
  }
}
