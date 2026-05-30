// Ported from: linuxdoom-1.10/p_map.c
// Movement clipping + hitscan attack + line activation.

import { lines, numlines, bmaporgx, bmaporgy, bmapwidth, bmapheight } from './p_setup.js';
import { ML_BLOCKING, ML_BLOCKMONSTERS } from './doomdata.js';
import { FINEMASK, ANGLETOFINESHIFT, finecosine, finesine, ANG180 } from './tables.js';
import { P_BoxOnLineSide, P_PointOnLineSide, P_LineOpening, P_AproxDistance,
         P_BlockLinesIterator, P_BlockThingsIterator, bumpValidCount,
         P_PathTraverse, PT_ADDLINES, PT_ADDTHINGS, trace,
         opentop, openbottom, openrange, lowfloor } from './p_maputl.js';
import { FixedDiv } from './m_fixed.js';
import { R_PointInSubsector, R_PointToAngle2 } from './r_bsp.js';
import { FixedMul } from './m_fixed.js';
import { P_Random } from './m_random.js';
import { gamemap as _gamemap, leveltime as _leveltime } from './doomstat.js';
// Cycle: p_mobj.js imports P_TryMove from us. ES modules resolve via late
// binding — calling these at runtime is safe even though p_mobj is loaded
// after p_map.
import { P_SetThingPosition, P_UnsetThingPosition } from './p_mobj.js';
import { P_CheckSight } from './p_sight.js';

export const MELEERANGE  = 64 << 16;
export const ATTACKRANGE = 2048 << 16;
export const USERANGE    = 64 << 16;
const MAXSPECIALCROSS = 8;
const MAXRADIUS       = 32 << 16;
const MAPBLOCKSHIFT   = 16 + 7;

// mobj flag bits referenced here. Imported from p_mobj.js would create a cycle.
const MF_SPECIAL   = 0x0001;
const MF_SOLID     = 0x0002;
const MF_SHOOTABLE = 0x0004;
const MF_NOCLIP    = 0x1000;
const MF_PICKUP    = 0x0800;
const MF_TELEPORT  = 0x8000;
const MF_MISSILE   = 0x10000;
const MF_DROPOFF   = 0x400;
const MF_FLOAT     = 0x4000;
const MF_SKULLFLY  = 0x1000000;

// Vanilla globals — module-scoped so the iterator helpers can read/write them.
export let ceilingline = null;
let tmthing = null;
let tmflags = 0;
let tmx = 0, tmy = 0;
const tmbbox = new Int32Array(4); // [BOXTOP, BOXBOTTOM, BOXLEFT, BOXRIGHT]
let tmfloorz = 0, tmceilingz = 0, tmdropoffz = 0;
// spechit / numspechit are read by p_enemy.js (P_Move) for door-opening.
export let numspechit = 0;
export const spechit = new Array(MAXSPECIALCROSS);
export function get_tmfloorz() { return tmfloorz; }
export function get_tmceilingz() { return tmceilingz; }
export let floatok = false;

// External wiring.
let _PInter = null, _PSpec = null, _PMobj = null, _thinkercap = null, _S = null;
export function P_MapSetExternals(refs) {
  if (refs.PInter != null)     _PInter = refs.PInter;
  if (refs.PSpec != null)      _PSpec  = refs.PSpec;
  if (refs.PMobj != null)      _PMobj  = refs.PMobj;
  if (refs.thinkercap != null) _thinkercap = refs.thinkercap;
  if (refs.S != null)          _S      = refs.S;
}

// p_map.c:252 — PIT_CheckThing. Returns false to abort the move.
function PIT_CheckThing(thing) {
  if ((thing.flags & (MF_SOLID | MF_SPECIAL | MF_SHOOTABLE)) === 0) return true;
  const blockdist = thing.radius + tmthing.radius;
  if (Math.abs(thing.x - tmx) >= blockdist || Math.abs(thing.y - tmy) >= blockdist) return true;
  if (thing === tmthing) return true;
  // Skull slamming
  if ((tmthing.flags & MF_SKULLFLY) !== 0) {
    const damage = (((P_Random() % 8) + 1) * (tmthing.info !== null ? tmthing.info.damage : 0)) | 0;
    if (_PInter !== null) _PInter.P_DamageMobj(thing, tmthing, tmthing, damage);
    tmthing.flags &= ~MF_SKULLFLY;
    tmthing.momx = 0; tmthing.momy = 0; tmthing.momz = 0;
    if (_PMobj !== null && typeof _PMobj.P_SetMobjState === 'function' && tmthing.info !== null) {
      _PMobj.P_SetMobjState(tmthing, tmthing.info.spawnstate);
    }
    return false; // stop moving
  }
  // Missiles
  if ((tmthing.flags & MF_MISSILE) !== 0) {
    if (tmthing.z > thing.z + thing.height) return true; // overhead
    if (tmthing.z + tmthing.height < thing.z) return true; // underneath
    if (tmthing.target !== null) {
      const tt = tmthing.target.type;
      const tht = thing.type;
      if (tt === tht ||
          (tt === 17 /*MT_KNIGHT*/ && tht === 15 /*MT_BRUISER*/) ||
          (tt === 15 /*MT_BRUISER*/ && tht === 17 /*MT_KNIGHT*/)) {
        if (thing === tmthing.target) return true;
        if (tht !== 0 /*MT_PLAYER*/) return false; // explode, no damage
      }
    }
    if ((thing.flags & MF_SHOOTABLE) === 0) {
      return (thing.flags & MF_SOLID) === 0;
    }
    const damage = (((P_Random() % 8) + 1) * (tmthing.info !== null ? tmthing.info.damage : 0)) | 0;
    if (_PInter !== null) _PInter.P_DamageMobj(thing, tmthing, tmthing.target, damage);
    return false; // don't traverse any more
  }
  // Special pickup
  if ((thing.flags & MF_SPECIAL) !== 0) {
    const solid = (thing.flags & MF_SOLID) !== 0;
    if ((tmflags & MF_PICKUP) !== 0 && _PInter !== null &&
        typeof _PInter.P_TouchSpecialThing === 'function') {
      _PInter.P_TouchSpecialThing(thing, tmthing);
    }
    return !solid;
  }
  return (thing.flags & MF_SOLID) === 0;
}

// p_map.c:189 — PIT_CheckLine. Returns false to abort the move.
function PIT_CheckLine(ld) {
  if (tmbbox[3] <= ld.bbox[2] || tmbbox[2] >= ld.bbox[3] ||
      tmbbox[0] <= ld.bbox[1] || tmbbox[1] >= ld.bbox[0]) return true;
  if (P_BoxOnLineSide(tmbbox, ld) !== -1) return true;
  if (ld.backsector === null) return false; // one-sided
  if ((tmflags & MF_MISSILE) === 0) {
    if ((ld.flags & ML_BLOCKING) !== 0) return false;
    if (tmthing.player === null && (ld.flags & ML_BLOCKMONSTERS) !== 0) return false;
  }
  P_LineOpening(ld);
  // opentop/openbottom/lowfloor are ESM live bindings into p_maputl.js — they
  // reflect the value P_LineOpening just wrote.
  if (opentop < tmceilingz) { tmceilingz = opentop; ceilingline = ld; }
  if (openbottom > tmfloorz) tmfloorz = openbottom;
  if (lowfloor < tmdropoffz) tmdropoffz = lowfloor;
  if (ld.special !== 0 && numspechit < MAXSPECIALCROSS) {
    spechit[numspechit++] = ld;
  }
  return true;
}

// p_map.c:374 — P_CheckPosition. Pure predicate; sets the tm* statics.
export function P_CheckPosition(thing, x, y) {
  tmthing = thing;
  tmflags = thing.flags;
  tmx = x; tmy = y;
  tmbbox[0] = y + thing.radius;   // BOXTOP
  tmbbox[1] = y - thing.radius;   // BOXBOTTOM
  tmbbox[2] = x - thing.radius;   // BOXLEFT
  tmbbox[3] = x + thing.radius;   // BOXRIGHT
  // Subsector at the target gives the base floor/ceiling (p_map.c:399-407).
  const ss = R_PointInSubsector(x, y);
  const sec = (ss !== null && ss !== undefined) ? ss.sector : null;
  if (sec !== null) {
    tmfloorz = sec.floorheight;
    tmdropoffz = sec.floorheight;
    tmceilingz = sec.ceilingheight;
  } else {
    tmfloorz = -0x80000000; tmdropoffz = -0x80000000; tmceilingz = 0x7fffffff;
  }
  ceilingline = null;
  numspechit = 0;

  if ((tmflags & MF_NOCLIP) !== 0) return true;

  // Check things first, possibly picking things up. Vanilla extends the box
  // by MAXRADIUS because mobjs are bucketed by origin and can overlap into
  // adjacent blocks.
  let xl = (tmbbox[2] - bmaporgx - MAXRADIUS) >> MAPBLOCKSHIFT;
  let xh = (tmbbox[3] - bmaporgx + MAXRADIUS) >> MAPBLOCKSHIFT;
  let yl = (tmbbox[1] - bmaporgy - MAXRADIUS) >> MAPBLOCKSHIFT;
  let yh = (tmbbox[0] - bmaporgy + MAXRADIUS) >> MAPBLOCKSHIFT;
  for (let bx = xl; bx <= xh; bx++) {
    for (let by = yl; by <= yh; by++) {
      if (!P_BlockThingsIterator(bx, by, PIT_CheckThing)) return false;
    }
  }
  // Now check lines via blockmap (validcount avoids re-checking the same line
  // in multiple blocks).
  bumpValidCount();
  xl = (tmbbox[2] - bmaporgx) >> MAPBLOCKSHIFT;
  xh = (tmbbox[3] - bmaporgx) >> MAPBLOCKSHIFT;
  yl = (tmbbox[1] - bmaporgy) >> MAPBLOCKSHIFT;
  yh = (tmbbox[0] - bmaporgy) >> MAPBLOCKSHIFT;
  for (let bx = xl; bx <= xh; bx++) {
    for (let by = yl; by <= yh; by++) {
      if (!P_BlockLinesIterator(bx, by, PIT_CheckLine)) return false;
    }
  }
  return true;
}


// p_map.c:450 — P_TryMove. Commits the move (relinks the thing, updates
// floorz/ceilingz, triggers crossed special lines).
export function P_TryMove(thing, x, y) {
  floatok = false;
  if (!P_CheckPosition(thing, x, y)) return false;
  if ((thing.flags & MF_NOCLIP) === 0) {
    if (tmceilingz - tmfloorz < thing.height) return false; // doesn't fit
    floatok = true;
    if ((thing.flags & MF_TELEPORT) === 0 && tmceilingz - thing.z < thing.height) return false;
    if ((thing.flags & MF_TELEPORT) === 0 && tmfloorz - thing.z > (24 << 16)) return false;
    if ((thing.flags & (MF_DROPOFF | MF_FLOAT)) === 0 &&
        tmfloorz - tmdropoffz > (24 << 16)) return false;
  }
  // Relink the thing into its new sector / blockmap cell.
  P_UnsetThingPosition(thing);
  const oldx = thing.x, oldy = thing.y;
  thing.floorz   = tmfloorz;
  thing.ceilingz = tmceilingz;
  thing.x = x; thing.y = y;
  P_SetThingPosition(thing);
  // Cross any special lines we passed over. Vanilla pops them off in reverse
  // order — both sides are walked so we match `P_PointOnLineSide` at old vs
  // new position to determine direction.
  if ((thing.flags & (MF_TELEPORT | MF_NOCLIP)) === 0) {
    while (numspechit-- > 0) {
      const ld = spechit[numspechit];
      const side    = P_PointOnLineSide(thing.x, thing.y, ld);
      const oldside = P_PointOnLineSide(oldx,     oldy,     ld);
      if (side !== oldside && ld.special !== 0 && _PSpec !== null) {
        // Pass the line object plus its index in lines[] for vanilla parity.
        _PSpec.P_CrossSpecialLine(ld, oldside, thing);
      }
    }
    numspechit = 0;
  }
  return true;
}

// ---- Slide move (vanilla P_SlideMove + PTR_SlideTraverse) ----
let bestslidefrac = 0;
let bestslideline = null;
let slidemo = null;
let tmxmove = 0, tmymove = 0;

// p_map.c:584 — P_HitSlideLine.
function P_HitSlideLine(ld) {
  if (ld.slopetype === 0 /*ST_HORIZONTAL*/) { tmymove = 0; return; }
  if (ld.slopetype === 1 /*ST_VERTICAL*/)   { tmxmove = 0; return; }
  const side = P_PointOnLineSide(slidemo.x, slidemo.y, ld);
  let lineangle = R_PointToAngle2(0, 0, ld.dx, ld.dy);
  if (side === 1) lineangle = (lineangle + ANG180) >>> 0;
  const moveangle = R_PointToAngle2(0, 0, tmxmove, tmymove);
  let deltaangle = (moveangle - lineangle) >>> 0;
  if (deltaangle > ANG180) deltaangle = (deltaangle + ANG180) >>> 0;
  const la = (lineangle >>> ANGLETOFINESHIFT) & FINEMASK;
  const da = (deltaangle >>> ANGLETOFINESHIFT) & FINEMASK;
  const movelen = P_AproxDistance(tmxmove, tmymove);
  const newlen  = FixedMul(movelen, finecosine[da]);
  tmxmove = FixedMul(newlen, finecosine[la]);
  tmymove = FixedMul(newlen, finesine[la]);
}

// p_map.c:636 — PTR_SlideTraverse.
function PTR_SlideTraverse(it) {
  const li = it.line;
  if (!it.isaline) return true; // shouldn't happen — lines flag only
  let isblocking = false;
  if ((li.flags & 4 /*ML_TWOSIDED*/) === 0) {
    if (P_PointOnLineSide(slidemo.x, slidemo.y, li) !== 0) return true;
    isblocking = true;
  } else {
    P_LineOpening(li);
    if (openrange < slidemo.height) isblocking = true;
    else if (opentop - slidemo.z < slidemo.height) isblocking = true;
    else if (openbottom - slidemo.z > 24 * 65536) isblocking = true;
  }
  if (!isblocking) return true;
  if (it.frac < bestslidefrac) {
    bestslidefrac = it.frac;
    bestslideline = li;
  }
  return false; // stop
}

// p_map.c:695 — P_SlideMove.
export function P_SlideMove(mo) {
  slidemo = mo;
  let hitcount = 0;
  // Cap loop iterations to match vanilla.
  while (true) {
    if (++hitcount === 3) {
      // stairstep
      if (!P_TryMove(mo, mo.x, (mo.y + mo.momy) | 0))
        P_TryMove(mo, (mo.x + mo.momx) | 0, mo.y);
      return;
    }
    let leadx, leady, trailx, traily;
    if (mo.momx > 0) { leadx = (mo.x + mo.radius) | 0; trailx = (mo.x - mo.radius) | 0; }
    else             { leadx = (mo.x - mo.radius) | 0; trailx = (mo.x + mo.radius) | 0; }
    if (mo.momy > 0) { leady = (mo.y + mo.radius) | 0; traily = (mo.y - mo.radius) | 0; }
    else             { leady = (mo.y - mo.radius) | 0; traily = (mo.y + mo.radius) | 0; }
    bestslidefrac = 65536 + 1;
    bestslideline = null;
    P_PathTraverse(leadx,  leady,  (leadx  + mo.momx) | 0, (leady + mo.momy) | 0, PT_ADDLINES, PTR_SlideTraverse);
    P_PathTraverse(trailx, leady,  (trailx + mo.momx) | 0, (leady + mo.momy) | 0, PT_ADDLINES, PTR_SlideTraverse);
    P_PathTraverse(leadx,  traily, (leadx  + mo.momx) | 0, (traily + mo.momy) | 0, PT_ADDLINES, PTR_SlideTraverse);
    if (bestslidefrac === 65536 + 1) {
      // stairstep
      if (!P_TryMove(mo, mo.x, (mo.y + mo.momy) | 0))
        P_TryMove(mo, (mo.x + mo.momx) | 0, mo.y);
      return;
    }
    bestslidefrac -= 0x800;
    if (bestslidefrac > 0) {
      const newx = FixedMul(mo.momx, bestslidefrac);
      const newy = FixedMul(mo.momy, bestslidefrac);
      if (!P_TryMove(mo, (mo.x + newx) | 0, (mo.y + newy) | 0)) {
        // stairstep
        if (!P_TryMove(mo, mo.x, (mo.y + mo.momy) | 0))
          P_TryMove(mo, (mo.x + mo.momx) | 0, mo.y);
        return;
      }
    }
    bestslidefrac = 65536 - (bestslidefrac + 0x800);
    if (bestslidefrac > 65536) bestslidefrac = 65536;
    if (bestslidefrac <= 0) return;
    tmxmove = FixedMul(mo.momx, bestslidefrac);
    tmymove = FixedMul(mo.momy, bestslidefrac);
    P_HitSlideLine(bestslideline);
    mo.momx = tmxmove;
    mo.momy = tmymove;
    if (P_TryMove(mo, (mo.x + tmxmove) | 0, (mo.y + tmymove) | 0)) return;
    // else loop
  }
}

// ---- Hitscan attack (PTR_AimTraverse / PTR_ShootTraverse) ----
// p_map.c:794+

let linetarget = null;
let shootthing = null;
let shootz = 0;
let la_damage = 0;
let attackrange = 0;
let aimslope = 0;
let topslope = 0, bottomslope = 0;

// p_map.c:815 — PTR_AimTraverse.
function PTR_AimTraverse(it) {
  if (it.isaline) {
    const li = it.line;
    if ((li.flags & 4 /*ML_TWOSIDED*/) === 0) return false;
    P_LineOpening(li);
    if (openbottom >= opentop) return false;
    const dist = FixedMul(attackrange, it.frac);
    // p_map.c:865 — null backsector also restricts the slope
    // (ML_TWOSIDED flag with no real second side, a WAD quirk).
    if (li.backsector === null || li.frontsector.floorheight !== li.backsector.floorheight) {
      const slope = FixedDiv(openbottom - shootz, dist);
      if (slope > bottomslope) bottomslope = slope;
    }
    if (li.backsector === null || li.frontsector.ceilingheight !== li.backsector.ceilingheight) {
      const slope = FixedDiv(opentop - shootz, dist);
      if (slope < topslope) topslope = slope;
    }
    if (topslope <= bottomslope) return false;
    return true;
  }
  const th = it.thing;
  if (th === shootthing) return true;
  if ((th.flags & 4 /*MF_SHOOTABLE*/) === 0) return true;
  const dist = FixedMul(attackrange, it.frac);
  let thingtopslope = FixedDiv((th.z + th.height) - shootz, dist);
  if (thingtopslope < bottomslope) return true;
  let thingbottomslope = FixedDiv(th.z - shootz, dist);
  if (thingbottomslope > topslope) return true;
  if (thingtopslope > topslope)       thingtopslope = topslope;
  if (thingbottomslope < bottomslope) thingbottomslope = bottomslope;
  aimslope = ((thingtopslope + thingbottomslope) / 2) | 0;
  linetarget = th;
  return false;
}

// p_map.c:899 — PTR_ShootTraverse.
function PTR_ShootTraverse(it) {
  if (it.isaline) {
    const li = it.line;
    if (li.special !== 0 && _PSpec !== null && typeof _PSpec.P_ShootSpecialLine === 'function') {
      _PSpec.P_ShootSpecialLine(shootthing, li);
    }
    let hit = (li.flags & 4 /*ML_TWOSIDED*/) === 0;
    if (!hit) {
      P_LineOpening(li);
      const dist = FixedMul(attackrange, it.frac);
      // Vanilla p_map.c:958 — null backsector checks against the entire
      // open without the height-difference gate.
      if (li.backsector === null) {
        const slopeBot = FixedDiv(openbottom - shootz, dist);
        if (slopeBot > aimslope) hit = true;
        if (!hit) {
          const slopeTop = FixedDiv(opentop - shootz, dist);
          if (slopeTop < aimslope) hit = true;
        }
      } else {
        if (li.frontsector.floorheight !== li.backsector.floorheight) {
          const slope = FixedDiv(openbottom - shootz, dist);
          if (slope > aimslope) hit = true;
        }
        if (!hit && li.frontsector.ceilingheight !== li.backsector.ceilingheight) {
          const slope = FixedDiv(opentop - shootz, dist);
          if (slope < aimslope) hit = true;
        }
      }
    }
    if (!hit) return true; // shot continues
    // hitline:
    const frac = (it.frac - FixedDiv(4 * 65536, attackrange)) | 0;
    const x = (trace.x + FixedMul(trace.dx, frac)) | 0;
    const y = (trace.y + FixedMul(trace.dy, frac)) | 0;
    const z = (shootz + FixedMul(aimslope, FixedMul(frac, attackrange))) | 0;
    // Sky hack: don't spawn puffs on sky ceilings/walls.
    const skyflatnum = (typeof globalThis !== 'undefined') ? (globalThis.__doom_skyflatnum | 0) : -1;
    if (skyflatnum >= 0 && li.frontsector.ceilingpic === skyflatnum) {
      if (z > li.frontsector.ceilingheight) return false;
      if (li.backsector !== null && li.backsector.ceilingpic === skyflatnum) return false;
    }
    if (_PMobj !== null && typeof _PMobj.P_SpawnPuff === 'function') {
      _PMobj.P_SpawnPuff(x, y, z, attackrange);
    }
    return false;
  }
  // shoot a thing
  const th = it.thing;
  if (th === shootthing) return true;
  if ((th.flags & 4 /*MF_SHOOTABLE*/) === 0) return true;
  const dist = FixedMul(attackrange, it.frac);
  const thingtopslope = FixedDiv((th.z + th.height) - shootz, dist);
  if (thingtopslope < aimslope) return true;
  const thingbottomslope = FixedDiv(th.z - shootz, dist);
  if (thingbottomslope > aimslope) return true;
  // hit thing — back off a bit
  const frac = (it.frac - FixedDiv(10 * 65536, attackrange)) | 0;
  const x = (trace.x + FixedMul(trace.dx, frac)) | 0;
  const y = (trace.y + FixedMul(trace.dy, frac)) | 0;
  const z = (shootz + FixedMul(aimslope, FixedMul(frac, attackrange))) | 0;
  if (_PMobj !== null) {
    if ((th.flags & 0x80000 /*MF_NOBLOOD*/) !== 0) {
      if (typeof _PMobj.P_SpawnPuff === 'function') _PMobj.P_SpawnPuff(x, y, z, attackrange);
    } else {
      if (typeof _PMobj.P_SpawnBlood === 'function') _PMobj.P_SpawnBlood(x, y, z, la_damage);
    }
  }
  if (la_damage !== 0 && _PInter !== null) {
    _PInter.P_DamageMobj(th, shootthing, shootthing, la_damage);
  }
  return false;
}

// p_map.c:1022 — P_AimLineAttack. Returns the slope to the target (and sets
// `linetarget` for the caller to read).
export function P_AimLineAttack(t1, angle, distance) {
  const fa = (angle >>> ANGLETOFINESHIFT) & FINEMASK;
  shootthing = t1;
  const x2 = (t1.x + (((distance >> 16) | 0) * finecosine[fa])) | 0;
  const y2 = (t1.y + (((distance >> 16) | 0) * finesine[fa]))   | 0;
  shootz = (t1.z + (t1.height >> 1) + 8 * 65536) | 0;
  topslope    = ((100 * 65536) / 160) | 0;
  bottomslope = -((100 * 65536) / 160) | 0;
  attackrange = distance;
  linetarget = null;
  P_PathTraverse(t1.x, t1.y, x2, y2,
    PT_ADDLINES | PT_ADDTHINGS, PTR_AimTraverse);
  if (linetarget !== null) return aimslope;
  return 0;
}

// Public so weapons can read who got hit after P_LineAttack/P_AimLineAttack.
export function getLinetarget() { return linetarget; }

// p_map.c:1062 — P_LineAttack.
export function P_LineAttack(t1, angle, distance, slope, damage) {
  const fa = (angle >>> ANGLETOFINESHIFT) & FINEMASK;
  shootthing = t1;
  la_damage = damage;
  const x2 = (t1.x + (((distance >> 16) | 0) * finecosine[fa])) | 0;
  const y2 = (t1.y + (((distance >> 16) | 0) * finesine[fa]))   | 0;
  shootz = (t1.z + (t1.height >> 1) + 8 * 65536) | 0;
  attackrange = distance;
  aimslope = slope;
  P_PathTraverse(t1.x, t1.y, x2, y2,
    PT_ADDLINES | PT_ADDTHINGS, PTR_ShootTraverse);
}

// ---- Radius attack (PIT_RadiusAttack) ----
// p_map.c:1164
let bombspot = null, bombsource = null, bombdamage = 0;

function PIT_RadiusAttack(thing) {
  if ((thing.flags & 4 /*MF_SHOOTABLE*/) === 0) return true;
  // Cyberdemon and spider mastermind are immune to splash.
  if (thing.type === 21 /*MT_CYBORG*/ || thing.type === 19 /*MT_SPIDER*/) return true;
  const dx = Math.abs(thing.x - bombspot.x);
  const dy = Math.abs(thing.y - bombspot.y);
  let dist = dx > dy ? dx : dy;
  dist = ((dist - thing.radius) >> 16) | 0;
  if (dist < 0) dist = 0;
  if (dist >= bombdamage) return true;
  // line of sight check — vanilla p_map.c:1234 only damages targets with a
  // clear sight line to the bomb spot. Skipping this lets explosions damage
  // monsters behind walls/doors.
  if (!P_CheckSight(thing, bombspot)) return true;
  if (_PInter !== null) _PInter.P_DamageMobj(thing, bombspot, bombsource, bombdamage - dist);
  return true;
}

// p_map.c:1205 — P_RadiusAttack.
export function P_RadiusAttack(spot, source, damage) {
  const dist = (damage + (MAXRADIUS >> 16)) << 16;
  const yh = (spot.y + dist - bmaporgy) >> MAPBLOCKSHIFT;
  const yl = (spot.y - dist - bmaporgy) >> MAPBLOCKSHIFT;
  const xh = (spot.x + dist - bmaporgx) >> MAPBLOCKSHIFT;
  const xl = (spot.x - dist - bmaporgx) >> MAPBLOCKSHIFT;
  bombspot = spot; bombsource = source; bombdamage = damage;
  for (let y = yl; y <= yh; y++) {
    for (let x = xl; x <= xh; x++) {
      P_BlockThingsIterator(x, y, PIT_RadiusAttack);
    }
  }
}
// p_map.c:81 — PIT_StompThing. Used by P_TeleportMove to kill mobjs in the way.
function PIT_StompThing(thing) {
  if ((thing.flags & MF_SHOOTABLE) === 0) return true;
  const blockdist = thing.radius + tmthing.radius;
  if (Math.abs(thing.x - tmx) >= blockdist || Math.abs(thing.y - tmy) >= blockdist) return true;
  if (thing === tmthing) return true;
  // monsters don't stomp things except on boss level (MAP30)
  if (tmthing.player === null && _gamemap !== 30) return false;
  if (_PInter !== null) _PInter.P_DamageMobj(thing, tmthing, tmthing, 10000);
  return true;
}

// p_map.c:114 — P_TeleportMove. Stomps anything in the destination cell.
export function P_TeleportMove(thing, x, y) {
  tmthing = thing;
  tmflags = thing.flags;
  tmx = x; tmy = y;
  tmbbox[0] = y + thing.radius;
  tmbbox[1] = y - thing.radius;
  tmbbox[2] = x - thing.radius;
  tmbbox[3] = x + thing.radius;
  const ss = R_PointInSubsector(x, y);
  ceilingline = null;
  const sec = (ss !== null && ss !== undefined) ? ss.sector : null;
  if (sec !== null) {
    tmfloorz = sec.floorheight;
    tmdropoffz = sec.floorheight;
    tmceilingz = sec.ceilingheight;
  } else {
    tmfloorz = -0x80000000; tmdropoffz = -0x80000000; tmceilingz = 0x7fffffff;
  }
  bumpValidCount();
  numspechit = 0;
  const xl = (tmbbox[2] - bmaporgx - MAXRADIUS) >> MAPBLOCKSHIFT;
  const xh = (tmbbox[3] - bmaporgx + MAXRADIUS) >> MAPBLOCKSHIFT;
  const yl = (tmbbox[1] - bmaporgy - MAXRADIUS) >> MAPBLOCKSHIFT;
  const yh = (tmbbox[0] - bmaporgy + MAXRADIUS) >> MAPBLOCKSHIFT;
  for (let bx = xl; bx <= xh; bx++) {
    for (let by = yl; by <= yh; by++) {
      if (!P_BlockThingsIterator(bx, by, PIT_StompThing)) return false;
    }
  }
  P_UnsetThingPosition(thing);
  thing.floorz   = tmfloorz;
  thing.ceilingz = tmceilingz;
  thing.x = x; thing.y = y;
  P_SetThingPosition(thing);
  return true;
}

// p_map.c:1095 — PTR_UseTraverse.
let usething = null;
function PTR_UseTraverse(it) {
  if (it.line.special === 0) {
    P_LineOpening(it.line);
    if (openrange <= 0) {
      if (_S !== null) _S.S_StartSound(usething, 81 /*sfx_noway*/);
      return false;
    }
    return true;
  }
  let side = 0;
  if (P_PointOnLineSide(usething.x, usething.y, it.line) === 1) side = 1;
  if (_PSpec !== null) _PSpec.P_UseSpecialLine(usething, it.line, side);
  return false; // can't use more than one special line in a row
}

// p_map.c:1130 — P_UseLines.
export function P_UseLines(player) {
  if (player.mo === null) return;
  usething = player.mo;
  const fa = (player.mo.angle >>> ANGLETOFINESHIFT) & FINEMASK;
  const x1 = player.mo.x, y1 = player.mo.y;
  const x2 = (x1 + (USERANGE >> 16) * finecosine[fa]) | 0;
  const y2 = (y1 + (USERANGE >> 16) * finesine[fa])   | 0;
  P_PathTraverse(x1, y1, x2, y2, PT_ADDLINES, PTR_UseTraverse);
}

// p_map.c:530 — P_ThingHeightClip. Refresh a thing's floorz/ceilingz after a
// nearby sector's height changed, snapping to floor if it was standing on it.
// Returns false if it no longer fits.
export function P_ThingHeightClip(thing) {
  const onfloor = (thing.z === thing.floorz);
  P_CheckPosition(thing, thing.x, thing.y);
  thing.floorz   = tmfloorz;
  thing.ceilingz = tmceilingz;
  if (onfloor) {
    // Walking monsters / players follow the floor.
    thing.z = thing.floorz;
  } else {
    // Hangers (e.g. floating gibs) sink along with a lowering ceiling.
    if (thing.z + thing.height > thing.ceilingz) thing.z = thing.ceilingz - thing.height;
  }
  return (thing.ceilingz - thing.floorz >= thing.height);
}

// p_map.c:1257 — PIT_ChangeSector / P_ChangeSector. Iterate every mobj in the
// blockmap cells covering the sector and clip it against the new floor/ceiling.
let crushchange = false;
let nofit = false;

function PIT_ChangeSector(thing) {
  if (P_ThingHeightClip(thing)) return true; // fits, keep checking
  // crunch bodies to giblets
  if (thing.health <= 0) {
    if (_PMobj !== null && typeof _PMobj.P_SetMobjState === 'function') {
      _PMobj.P_SetMobjState(thing, 895 /*S_GIBS*/);
    }
    thing.flags &= ~MF_SOLID;
    thing.height = 0;
    thing.radius = 0;
    return true;
  }
  // crunch dropped items
  if ((thing.flags & 0x20000 /*MF_DROPPED*/) !== 0) {
    if (_PMobj !== null && typeof _PMobj.P_RemoveMobj === 'function') {
      _PMobj.P_RemoveMobj(thing);
    }
    return true;
  }
  if ((thing.flags & MF_SHOOTABLE) === 0) {
    // assume it is bloody gibs or something
    return true;
  }
  nofit = true;
  if (crushchange && ((_leveltime | 0) & 3) === 0) {
    if (_PInter !== null) _PInter.P_DamageMobj(thing, null, null, 10);
    // spray blood in a random direction
    if (_PMobj !== null && typeof _PMobj.P_SpawnMobj === 'function') {
      const mo = _PMobj.P_SpawnMobj(thing.x, thing.y, (thing.z + (thing.height >> 1)) | 0, 38 /*MT_BLOOD*/);
      if (mo !== null && mo !== undefined) {
        mo.momx = ((P_Random() - P_Random()) << 12) | 0;
        mo.momy = ((P_Random() - P_Random()) << 12) | 0;
      }
    }
  }
  return true;
}

export function P_ChangeSector(sector, crunch) {
  if (sector === null) return false;
  nofit = false;
  crushchange = !!crunch;
  // re-check heights for all things near the moving sector — iterate every
  // blockmap cell covered by the sector's blockbox so we also catch mobjs
  // that overlap from adjacent sectors. [BOXTOP=0, BOXBOTTOM=1, BOXLEFT=2, BOXRIGHT=3]
  const bb = sector.blockbox;
  for (let x = bb[2]; x <= bb[3]; x++) {
    for (let y = bb[1]; y <= bb[0]; y++) {
      P_BlockThingsIterator(x, y, PIT_ChangeSector);
    }
  }
  return nofit;
}
