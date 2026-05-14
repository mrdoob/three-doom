// Ported from: linuxdoom-1.10/p_floor.c
// Floor raise / lower thinkers + EV_DoFloor + T_MovePlane (the generic plane
// mover used by floors, ceilings, and lifts).

import { sectors, numsectors, sides } from './p_setup.js';
import { textureheight } from './r_data.js';

const FRACUNIT = 65536;

// Result codes from T_MovePlane.
export const RESULT_OK = 0, RESULT_CRUSHED = 1, RESULT_PASTDEST = 2;

let _R_UpdateSectorPlanes = null;
let _P_AddThinker = null, _P_RemoveThinker = null;
let _S = null;
export function P_FloorSetExternals(refs) {
  if (refs.R_UpdateSectorPlanes) _R_UpdateSectorPlanes = refs.R_UpdateSectorPlanes;
  if (refs.P_AddThinker)         _P_AddThinker         = refs.P_AddThinker;
  if (refs.P_RemoveThinker)      _P_RemoveThinker      = refs.P_RemoveThinker;
  if (refs.S)                    _S                    = refs.S;
}

// p_floor.c:49 — T_MovePlane. floorOrCeiling: 0=floor, 1=ceiling. direction:
// -1=down, 1=up. Uses P_ChangeSector to crush mobjs when the plane closes on
// them; non-crush movers reverse direction on contact.
let _P_ChangeSector_ext = null;
export function P_FloorSetMap(refs) { if (refs.P_ChangeSector) _P_ChangeSector_ext = refs.P_ChangeSector; }

function changeAndUpdate(sec, crush) {
  if (_R_UpdateSectorPlanes !== null) _R_UpdateSectorPlanes(sec);
  if (_P_ChangeSector_ext !== null) return _P_ChangeSector_ext(sec, crush);
  return false;
}

export function T_MovePlane(sector, speed, dest, crush, floorOrCeiling, direction) {
  let flag;
  if (floorOrCeiling === 0) {
    // FLOOR
    if (direction === -1) {
      if (sector.floorheight - speed < dest) {
        const lastpos = sector.floorheight;
        sector.floorheight = dest;
        flag = changeAndUpdate(sector, crush);
        if (flag) { sector.floorheight = lastpos; changeAndUpdate(sector, crush); }
        return RESULT_PASTDEST;
      }
      const lastpos = sector.floorheight;
      sector.floorheight -= speed;
      flag = changeAndUpdate(sector, crush);
      if (flag) {
        sector.floorheight = lastpos;
        changeAndUpdate(sector, crush);
        return RESULT_CRUSHED;
      }
      return RESULT_OK;
    }
    if (direction === 1) {
      if (sector.floorheight + speed > dest) {
        const lastpos = sector.floorheight;
        sector.floorheight = dest;
        flag = changeAndUpdate(sector, crush);
        if (flag) { sector.floorheight = lastpos; changeAndUpdate(sector, crush); }
        return RESULT_PASTDEST;
      }
      const lastpos = sector.floorheight;
      sector.floorheight += speed;
      flag = changeAndUpdate(sector, crush);
      if (flag) {
        if (crush) return RESULT_CRUSHED;
        sector.floorheight = lastpos;
        changeAndUpdate(sector, crush);
        return RESULT_CRUSHED;
      }
      return RESULT_OK;
    }
  } else {
    // CEILING
    if (direction === -1) {
      if (sector.ceilingheight - speed < dest) {
        const lastpos = sector.ceilingheight;
        sector.ceilingheight = dest;
        flag = changeAndUpdate(sector, crush);
        if (flag) { sector.ceilingheight = lastpos; changeAndUpdate(sector, crush); }
        return RESULT_PASTDEST;
      }
      const lastpos = sector.ceilingheight;
      sector.ceilingheight -= speed;
      flag = changeAndUpdate(sector, crush);
      if (flag) {
        if (crush) return RESULT_CRUSHED;
        sector.ceilingheight = lastpos;
        changeAndUpdate(sector, crush);
        return RESULT_CRUSHED;
      }
      return RESULT_OK;
    }
    if (direction === 1) {
      if (sector.ceilingheight + speed > dest) {
        const lastpos = sector.ceilingheight;
        sector.ceilingheight = dest;
        flag = changeAndUpdate(sector, crush);
        if (flag) { sector.ceilingheight = lastpos; changeAndUpdate(sector, crush); }
        return RESULT_PASTDEST;
      }
      sector.ceilingheight += speed;
      changeAndUpdate(sector, crush);
      return RESULT_OK;
    }
  }
  return RESULT_OK;
}

// T_MoveFloor — thinker for an active floor mover.
export function T_MoveFloor(thinker) {
  const f = thinker.__floor;
  if (f === undefined) return;
  const res = T_MovePlane(f.sector, f.speed, f.floordestheight, f.crush, 0, f.direction);
  // C: if (!(leveltime&7)) S_StartSound(sec.soundorg, sfx_stnmov);
  if (((globalThis.__doom_leveltime | 0) & 7) === 0 && _S !== null) {
    _S.S_StartSound(f.sector.soundorg, 22 /*sfx_stnmov*/);
  }
  if (res === RESULT_PASTDEST) {
    f.sector.specialdata = null;
    if (f.direction === 1) {
      if (f.type === donutRaise) {
        f.sector.special  = f.newspecial;
        f.sector.floorpic = f.texture;
      }
    } else if (f.direction === -1) {
      if (f.type === lowerAndChange) {
        f.sector.special  = f.newspecial;
        f.sector.floorpic = f.texture;
      }
    }
    if (_P_RemoveThinker !== null) _P_RemoveThinker(thinker);
    if (_S !== null) _S.S_StartSound(f.sector.soundorg, 19 /*sfx_pstop*/);
  }
}

// Find a sector's neighbor with the lowest floor.
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

// p_floor.c — P_FindHighestFloorSurrounding. Vanilla seeds with -500*FRACUNIT.
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

// p_floor.c — P_FindNextHighestFloor. The next-higher neighbour above `currentheight`.
function P_FindNextHighestFloor(sec, currentheight) {
  let h = 0x7fffffff;
  let found = false;
  for (const li of sec.lines) {
    let other = null;
    if (li.frontsector === sec && li.backsector !== null) other = li.backsector;
    else if (li.backsector === sec && li.frontsector !== null) other = li.frontsector;
    if (other === null) continue;
    if (other.floorheight > currentheight && other.floorheight < h) {
      h = other.floorheight;
      found = true;
    }
  }
  return found ? h : currentheight;
}

// Floor types (mirrors floor_e enum in p_spec.h).
// p_spec.h order: lowerFloor, lowerFloorToLowest, turboLower, raiseFloor,
// raiseFloorToNearest, raiseToTexture, lowerAndChange, raiseFloor24,
// raiseFloor24AndChange, raiseFloorCrush, raiseFloorTurbo, donutRaise, raiseFloor512.
export const lowerFloor = 0, lowerFloorToLowest = 1, turboLower = 2, raiseFloor = 3,
  raiseFloorToNearest = 4, raiseToTexture = 5, lowerAndChange = 6,
  raiseFloor24 = 7, raiseFloor24AndChange = 8, raiseFloorCrush = 9,
  raiseFloorTurbo = 10, donutRaise = 11, raiseFloor512 = 12;

// Stair builder type (mirrors stair_e in p_spec.h:577 — build8=0, turbo16=1).
export const build8 = 0, turbo16 = 1;

export function EV_DoFloor(line, floortype) {
  let rtn = 0;
  for (let i = 0; i < numsectors; i++) {
    const sec = sectors[i];
    if (sec.tag !== line.tag) continue;
    if (sec.specialdata !== null) continue;
    rtn = 1;
    const f = {
      sector: sec, speed: FRACUNIT, direction: 1, crush: false,
      floordestheight: sec.floorheight, type: floortype,
    };
    switch (floortype) {
      case lowerFloor:
        f.direction = -1; f.floordestheight = P_FindHighestFloorSurrounding(sec); break;
      case lowerFloorToLowest:
        f.direction = -1; f.floordestheight = P_FindLowestFloorSurrounding(sec); break;
      case turboLower:
        f.direction = -1; f.speed = 4 * FRACUNIT;
        f.floordestheight = P_FindHighestFloorSurrounding(sec);
        if (f.floordestheight !== sec.floorheight) f.floordestheight += 8 * FRACUNIT;
        break;
      case raiseFloor:
        f.direction = 1;
        f.floordestheight = P_FindLowestCeilingSurrounding(sec);
        if (f.floordestheight > sec.ceilingheight) f.floordestheight = sec.ceilingheight;
        break;
      case raiseFloorCrush:
        f.direction = 1; f.crush = true;
        f.floordestheight = P_FindLowestCeilingSurrounding(sec) - 8 * FRACUNIT;
        if (f.floordestheight > sec.ceilingheight - 8 * FRACUNIT) f.floordestheight = sec.ceilingheight - 8 * FRACUNIT;
        break;
      case raiseFloorToNearest:
        f.direction = 1;
        f.floordestheight = P_FindNextHighestFloor(sec, sec.floorheight);
        break;
      case raiseToTexture: {
        // p_floor.c:372 — raise floor by the minimum bottom-texture height
        // among the sector's two-sided linedef sides. Used by line action 91
        // (S1 Floor Raise By Texture) and friends.
        let minsize = 0x7fffffff;
        f.direction = 1;
        if (textureheight !== null && sides !== null) {
          for (const li of sec.lines) {
            if ((li.flags & 4 /*ML_TWOSIDED*/) === 0) continue;
            for (let s = 0; s < 2; s++) {
              const sidenum = li.sidenum[s];
              if (sidenum < 0) continue;
              const sd = sides[sidenum];
              if (sd === null || sd === undefined) continue;
              const tex = sd.bottomtexture | 0;
              if (tex >= 0 && tex < textureheight.length && textureheight[tex] < minsize) {
                minsize = textureheight[tex];
              }
            }
          }
        }
        if (minsize === 0x7fffffff) minsize = 0;
        f.floordestheight = sec.floorheight + minsize;
        break;
      }
      case raiseFloor24:
        f.direction = 1; f.floordestheight = sec.floorheight + 24 * FRACUNIT; break;
      case raiseFloor24AndChange:
        f.direction = 1;
        f.floordestheight = sec.floorheight + 24 * FRACUNIT;
        sec.floorpic = line.frontsector.floorpic;
        sec.special  = line.frontsector.special;
        break;
      case raiseFloor512:
        f.direction = 1; f.floordestheight = sec.floorheight + 512 * FRACUNIT; break;
      case raiseFloorTurbo:
        // C (p_floor.c): destination is the next-higher floor (NOT the highest).
        f.direction = 1; f.speed = 4 * FRACUNIT;
        f.floordestheight = P_FindNextHighestFloor(sec, sec.floorheight); break;
      case lowerAndChange: {
        f.direction = -1;
        f.floordestheight = P_FindLowestFloorSurrounding(sec);
        f.texture = sec.floorpic;
        f.newspecial = 0;
        for (const li of sec.lines) {
          if ((li.flags & 4 /*ML_TWOSIDED*/) === 0) continue;
          // C: walk the side that's not this sector; if its sector's floor matches dest,
          // copy that sector's floorpic/special as the target after the move.
          let osec = null;
          if (li.frontsector === sec) osec = li.backsector;
          else if (li.backsector === sec) osec = li.frontsector;
          if (osec === null) continue;
          if (osec.floorheight === f.floordestheight) {
            f.texture    = osec.floorpic;
            f.newspecial = osec.special;
            break;
          }
        }
        break;
      }
      default:
        break;
    }
    sec.specialdata = f;
    if (_P_AddThinker !== null) {
      const t = { prev: null, next: null, function: T_MoveFloor, __floor: f };
      _P_AddThinker(t);
    }
  }
  return rtn;
}

function P_FindLowestCeilingSurrounding(sec) {
  let h = 0x7fffffff;
  for (const li of sec.lines) {
    let other = null;
    if (li.frontsector === sec && li.backsector !== null) other = li.backsector;
    else if (li.backsector === sec && li.frontsector !== null) other = li.frontsector;
    if (other !== null && other.ceilingheight < h) h = other.ceilingheight;
  }
  return h;
}

// EV_BuildStairs — port from p_floor.c. Builds stepped floors of `stepHeight`
// connected through shared-texture neighbour sectors of the tagged seed.
// EV_RaiseDonut — called by EV_DoDonut in p_spec.js to spawn the two floor
// movers (outer rising, inner lowering) of a donut linedef-type-9.
export function EV_RaiseDonut(s1, s2, s3) {
  // Outer ring rises to s3's floor.
  const FLOORSPEED = 65536;
  const outerFloor = {
    sector: s2, speed: FLOORSPEED >> 1, direction: 1, crush: false,
    floordestheight: s3.floorheight, type: donutRaise, newspecial: 0, texture: s3.floorpic,
  };
  s2.specialdata = outerFloor;
  if (_P_AddThinker !== null) _P_AddThinker({ prev: null, next: null, function: T_MoveFloor, __floor: outerFloor });
  // Inner hole drops to s3's floor.
  const innerFloor = {
    sector: s1, speed: FLOORSPEED >> 1, direction: -1, crush: false,
    floordestheight: s3.floorheight, type: lowerFloor, newspecial: 0,
  };
  s1.specialdata = innerFloor;
  if (_P_AddThinker !== null) _P_AddThinker({ prev: null, next: null, function: T_MoveFloor, __floor: innerFloor });
}

export function EV_BuildStairs(line, type) {
  // p_floor.c:493 — build8 = 8-unit slow step; turbo16 = 16-unit fast step.
  const stepHeight = (type === build8 ? 8 : 16) * FRACUNIT;
  const speed      = (type === build8 ? FRACUNIT / 4 : FRACUNIT);
  let rtn = 0;
  for (let i = 0; i < numsectors; i++) {
    const seed = sectors[i];
    if (seed.tag !== line.tag || seed.specialdata !== null) continue;
    rtn = 1;
    let height = seed.floorheight + stepHeight;
    const texture = seed.floorpic;
    const beginThinker = (sec, dest) => {
      const f = { sector: sec, speed, direction: 1, crush: false, floordestheight: dest, type };
      sec.specialdata = f;
      if (_P_AddThinker !== null) _P_AddThinker({ prev: null, next: null, function: T_MoveFloor, __floor: f });
    };
    beginThinker(seed, height);
    // Walk outward: any neighbour sharing the same floor-flat that hasn't been
    // touched yet gets the next step.
    let stairsec = seed;
    let walked = true;
    while (walked) {
      walked = false;
      for (const li of stairsec.lines) {
        if ((li.flags & 4 /*ML_TWOSIDED*/) === 0) continue;
        let other = (li.frontsector === stairsec) ? li.backsector : null;
        if (other === null) continue;
        if (other.floorpic !== texture) continue;
        // C order: height += stairsize THEN check specialdata (vanilla quirk:
        // height counter increments even when sector skipped).
        height += stepHeight;
        if (other.specialdata !== null) continue;
        beginThinker(other, height);
        stairsec = other;
        walked = true;
        break;
      }
    }
  }
  return rtn;
}
