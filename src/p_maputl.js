// Ported from: linuxdoom-1.10/p_maputl.c
// Map utility math: blockmap iteration, line-side checks, intercept solver,
// path traversal.

import { lines, numlines, blockmap, blockmaplump, bmapwidth, bmapheight, bmaporgx, bmaporgy, blocklinks } from './p_setup.js';
import { FixedMul, FixedDiv } from './m_fixed.js';

export function P_AproxDistance(dx, dy) {
  dx = Math.abs(dx); dy = Math.abs(dy);
  return dx < dy ? dx + dy - (dx >> 1) : dx + dy - (dy >> 1);
}

// p_maputl.c:66 — P_PointOnLineSide. Returns 0 for front, 1 for back. Uses
// FixedMul on the cross product so demo-bit-exact with vanilla.
export function P_PointOnLineSide(x, y, line) {
  if (line.dx === 0) return x <= line.v1.x ? (line.dy > 0 ? 1 : 0) : (line.dy < 0 ? 1 : 0);
  if (line.dy === 0) return y <= line.v1.y ? (line.dx < 0 ? 1 : 0) : (line.dx > 0 ? 1 : 0);
  const dx = (x - line.v1.x) | 0;
  const dy = (y - line.v1.y) | 0;
  const left  = FixedMul(line.dy >> 16, dx);
  const right = FixedMul(dy, line.dx >> 16);
  return right < left ? 0 : 1;
}

// p_maputl.c:105 — P_BoxOnLineSide. Returns 0/1 for the side, or -1 if the
// box straddles the line. `tmbox` is an [BOXTOP, BOXBOTTOM, BOXLEFT, BOXRIGHT]
// Int32Array. The line's slopetype lets us short-circuit to one of four cases.
export function P_BoxOnLineSide(tmbox, ld) {
  let p1 = 0, p2 = 0;
  switch (ld.slopetype) {
    case 0 /*ST_HORIZONTAL*/: {
      p1 = tmbox[0] > ld.v1.y ? 1 : 0;
      p2 = tmbox[1] > ld.v1.y ? 1 : 0;
      if (ld.dx < 0) { p1 ^= 1; p2 ^= 1; }
      break;
    }
    case 1 /*ST_VERTICAL*/: {
      p1 = tmbox[3] < ld.v1.x ? 1 : 0;
      p2 = tmbox[2] < ld.v1.x ? 1 : 0;
      if (ld.dy < 0) { p1 ^= 1; p2 ^= 1; }
      break;
    }
    case 2 /*ST_POSITIVE*/: {
      p1 = P_PointOnLineSide(tmbox[2], tmbox[0], ld);
      p2 = P_PointOnLineSide(tmbox[3], tmbox[1], ld);
      break;
    }
    case 3 /*ST_NEGATIVE*/: {
      p1 = P_PointOnLineSide(tmbox[3], tmbox[0], ld);
      p2 = P_PointOnLineSide(tmbox[2], tmbox[1], ld);
      break;
    }
  }
  return p1 === p2 ? p1 : -1;
}

// p_maputl.c:160 — P_PointOnDivlineSide. A divline_t is (x, y, dx, dy).
export function P_PointOnDivlineSide(x, y, dl) {
  if (dl.dx === 0) return x <= dl.x ? (dl.dy > 0 ? 1 : 0) : (dl.dy < 0 ? 1 : 0);
  if (dl.dy === 0) return y <= dl.y ? (dl.dx < 0 ? 1 : 0) : (dl.dx > 0 ? 1 : 0);
  const dx = (x - dl.x) | 0;
  const dy = (y - dl.y) | 0;
  // Sign-bit fast path (vanilla short-circuit).
  if (((dl.dy ^ dl.dx ^ dx ^ dy) & 0x80000000) !== 0) {
    if (((dl.dy ^ dx) & 0x80000000) !== 0) return 1;
    return 0;
  }
  const left  = FixedMul(dl.dy >> 8, dx >> 8);
  const right = FixedMul(dy >> 8,    dl.dx >> 8);
  return right < left ? 0 : 1;
}

export function P_MakeDivline(li, dl) {
  dl.x = li.v1.x; dl.y = li.v1.y; dl.dx = li.dx; dl.dy = li.dy;
}

// p_maputl.c:230 — P_InterceptVector. Fixed-point intercept of v1 with v2.
// Returns the fraction (in FRACUNITs) along v1 at which the two divlines
// cross. 0 = v1's origin, FRACUNIT = past v1's far end.
export function P_InterceptVector(v2, v1) {
  const den = (FixedMul(v1.dy >> 8, v2.dx) - FixedMul(v1.dx >> 8, v2.dy)) | 0;
  if (den === 0) return 0;
  const num = (FixedMul((v1.x - v2.x) >> 8, v1.dy) +
               FixedMul((v2.y - v1.y) >> 8, v1.dx)) | 0;
  return FixedDiv(num, den);
}

// Set by P_LineOpening — used by P_TryMove's step-up check in the C code.
export let openrange = 0, opentop = 0, openbottom = 0, lowfloor = 0;
export function P_LineOpening(linedef) {
  if (linedef.sidenum[1] === -1) { openrange = 0; return; }
  const front = linedef.frontsector, back = linedef.backsector;
  opentop    = Math.min(front.ceilingheight, back.ceilingheight);
  openbottom = Math.max(front.floorheight,   back.floorheight);
  lowfloor   = Math.min(front.floorheight,   back.floorheight);
  openrange  = opentop - openbottom;
}

// Shared validcount — bumped before every traversal call so lines bucketed
// into multiple blockmap cells aren't checked twice per call.
export let validcount = 0;
export function bumpValidCount() { validcount = (validcount + 1) | 0; }

// Iterate every line touching block (x, y). Returns false on early-stop.
export function P_BlockLinesIterator(x, y, func) {
  if (x < 0 || y < 0 || x >= bmapwidth || y >= bmapheight) return true;
  const offset = blockmap[y * bmapwidth + x];
  for (let i = offset; ; i++) {
    const lineindex = blockmaplump[i];
    if (lineindex === -1) break;
    const ld = lines[lineindex];
    if (ld === undefined) continue;
    if (ld.validcount === validcount) continue;
    ld.validcount = validcount;
    if (!func(ld)) return false;
  }
  return true;
}

// Iterate every thing in block (x, y). Returns false on early-stop.
export function P_BlockThingsIterator(x, y, func) {
  if (x < 0 || y < 0 || x >= bmapwidth || y >= bmapheight) return true;
  let mo = blocklinks[y * bmapwidth + x];
  while (mo !== null) {
    if (!func(mo)) return false;
    mo = mo.bnext;
  }
  return true;
}

// p_maputl.c — trace divline + intercept buffer. Used by PathTraverse and
// the PIT_AddLine/ThingIntercepts traversers.
const FRACUNIT_MAP = 65536;
const MAPBLOCKSHIFT = 16 + 7;
const MAPBLOCKSIZE  = 128 * FRACUNIT_MAP;
const MAPBTOFRAC    = MAPBLOCKSHIFT - 16;

export const PT_ADDLINES  = 1;
export const PT_ADDTHINGS = 2;
export const PT_EARLYOUT  = 4;

const MAXINTERCEPTS = 128;
// intercept_t: { frac, isaline, line, thing }
const intercepts = new Array(MAXINTERCEPTS);
for (let i = 0; i < MAXINTERCEPTS; i++) intercepts[i] = { frac: 0, isaline: false, line: null, thing: null };
let intercept_p = 0;
let earlyout = false;
export const trace = { x: 0, y: 0, dx: 0, dy: 0 };

// p_maputl.c:562 — PIT_AddLineIntercepts.
function PIT_AddLineIntercepts(ld) {
  let s1, s2;
  if (trace.dx > 16 * FRACUNIT_MAP || trace.dy > 16 * FRACUNIT_MAP ||
      trace.dx < -16 * FRACUNIT_MAP || trace.dy < -16 * FRACUNIT_MAP) {
    s1 = P_PointOnDivlineSide(ld.v1.x, ld.v1.y, trace);
    s2 = P_PointOnDivlineSide(ld.v2.x, ld.v2.y, trace);
  } else {
    s1 = P_PointOnLineSide(trace.x, trace.y, ld);
    s2 = P_PointOnLineSide((trace.x + trace.dx) | 0, (trace.y + trace.dy) | 0, ld);
  }
  if (s1 === s2) return true; // line isn't crossed
  // P_MakeDivline(ld) inline
  _dlTmp.x = ld.v1.x; _dlTmp.y = ld.v1.y; _dlTmp.dx = ld.dx; _dlTmp.dy = ld.dy;
  const frac = P_InterceptVector(trace, _dlTmp);
  if (frac < 0) return true; // behind source
  if (earlyout && frac < FRACUNIT_MAP && ld.backsector === null) return false;
  if (intercept_p >= MAXINTERCEPTS) return true;
  const it = intercepts[intercept_p++];
  it.frac = frac; it.isaline = true; it.line = ld; it.thing = null;
  return true;
}
const _dlTmp = { x: 0, y: 0, dx: 0, dy: 0 };

// p_maputl.c:616 — PIT_AddThingIntercepts.
function PIT_AddThingIntercepts(thing) {
  const tracepositive = (trace.dx ^ trace.dy) > 0;
  let x1, y1, x2, y2;
  if (tracepositive) {
    x1 = thing.x - thing.radius; y1 = thing.y + thing.radius;
    x2 = thing.x + thing.radius; y2 = thing.y - thing.radius;
  } else {
    x1 = thing.x - thing.radius; y1 = thing.y - thing.radius;
    x2 = thing.x + thing.radius; y2 = thing.y + thing.radius;
  }
  const s1 = P_PointOnDivlineSide(x1, y1, trace);
  const s2 = P_PointOnDivlineSide(x2, y2, trace);
  if (s1 === s2) return true;
  _dlTmp.x = x1; _dlTmp.y = y1; _dlTmp.dx = (x2 - x1) | 0; _dlTmp.dy = (y2 - y1) | 0;
  const frac = P_InterceptVector(trace, _dlTmp);
  if (frac < 0) return true;
  if (intercept_p >= MAXINTERCEPTS) return true;
  const it = intercepts[intercept_p++];
  it.frac = frac; it.isaline = false; it.line = null; it.thing = thing;
  return true;
}

// p_maputl.c:683 — P_TraverseIntercepts. Pop the closest unused intercept,
// dispatch to trav. Stop when trav returns false or all consumed.
function P_TraverseIntercepts(trav, maxfrac) {
  let count = intercept_p;
  while (count-- > 0) {
    let dist = 0x7fffffff;
    let best = -1;
    for (let i = 0; i < intercept_p; i++) {
      if (intercepts[i].frac < dist) { dist = intercepts[i].frac; best = i; }
    }
    if (dist > maxfrac) return true;
    if (best < 0) return true;
    if (!trav(intercepts[best])) return false;
    intercepts[best].frac = 0x7fffffff;
  }
  return true;
}

// p_maputl.c:743 — P_PathTraverse. Fixed-point DDA across the blockmap, then
// dispatch buffered intercepts to `trav` in sorted distance order.
export function P_PathTraverse(x1, y1, x2, y2, flags, trav) {
  if (bmaporgx === undefined) return true;
  earlyout = (flags & PT_EARLYOUT) !== 0;
  validcount = (validcount + 1) | 0;
  intercept_p = 0;

  // Nudge off block-aligned origins so we don't ride exactly on a line.
  if (((x1 - bmaporgx) & (MAPBLOCKSIZE - 1)) === 0) x1 += FRACUNIT_MAP;
  if (((y1 - bmaporgy) & (MAPBLOCKSIZE - 1)) === 0) y1 += FRACUNIT_MAP;

  trace.x = x1; trace.y = y1;
  trace.dx = (x2 - x1) | 0;
  trace.dy = (y2 - y1) | 0;

  const tx1 = (x1 - bmaporgx) | 0, ty1 = (y1 - bmaporgy) | 0;
  const tx2 = (x2 - bmaporgx) | 0, ty2 = (y2 - bmaporgy) | 0;
  const xt1 = tx1 >> MAPBLOCKSHIFT, yt1 = ty1 >> MAPBLOCKSHIFT;
  const xt2 = tx2 >> MAPBLOCKSHIFT, yt2 = ty2 >> MAPBLOCKSHIFT;

  let mapxstep, mapystep;
  let partial, xstep, ystep, xintercept, yintercept;
  if (xt2 > xt1) {
    mapxstep = 1;
    partial = FRACUNIT_MAP - ((tx1 >> MAPBTOFRAC) & (FRACUNIT_MAP - 1));
    ystep = FixedDiv(ty2 - ty1, Math.abs(tx2 - tx1));
  } else if (xt2 < xt1) {
    mapxstep = -1;
    partial = (tx1 >> MAPBTOFRAC) & (FRACUNIT_MAP - 1);
    ystep = FixedDiv(ty2 - ty1, Math.abs(tx2 - tx1));
  } else {
    mapxstep = 0;
    partial = FRACUNIT_MAP;
    ystep = 256 * FRACUNIT_MAP;
  }
  yintercept = (ty1 >> MAPBTOFRAC) + FixedMul(partial, ystep);

  if (yt2 > yt1) {
    mapystep = 1;
    partial = FRACUNIT_MAP - ((ty1 >> MAPBTOFRAC) & (FRACUNIT_MAP - 1));
    xstep = FixedDiv(tx2 - tx1, Math.abs(ty2 - ty1));
  } else if (yt2 < yt1) {
    mapystep = -1;
    partial = (ty1 >> MAPBTOFRAC) & (FRACUNIT_MAP - 1);
    xstep = FixedDiv(tx2 - tx1, Math.abs(ty2 - ty1));
  } else {
    mapystep = 0;
    partial = FRACUNIT_MAP;
    xstep = 256 * FRACUNIT_MAP;
  }
  xintercept = (tx1 >> MAPBTOFRAC) + FixedMul(partial, xstep);

  let mapx = xt1, mapy = yt1;
  for (let count = 0; count < 64; count++) {
    if ((flags & PT_ADDLINES) !== 0) {
      if (!P_BlockLinesIterator(mapx, mapy, PIT_AddLineIntercepts)) return false;
    }
    if ((flags & PT_ADDTHINGS) !== 0) {
      if (!P_BlockThingsIterator(mapx, mapy, PIT_AddThingIntercepts)) return false;
    }
    if (mapx === xt2 && mapy === yt2) break;
    if ((yintercept >> 16) === mapy) {
      yintercept += ystep;
      mapx += mapxstep;
    } else if ((xintercept >> 16) === mapx) {
      xintercept += xstep;
      mapy += mapystep;
    }
  }
  return P_TraverseIntercepts(trav, FRACUNIT_MAP);
}

// P_RoughBlockCheck — pre-filter for monster wake-up search. Walks every mobj
// in the thinker list (we don't have an active blockmap) and calls `trav(mo)`;
// returns true if any callback returns true. Used by vanilla
// `P_LookForPlayers` as a coarse range filter before line-of-sight.
export function P_RoughBlockCheck(mo, _index, trav) {
  const cap = (typeof globalThis !== 'undefined') ? globalThis.__doom_thinkercap : null;
  if (cap === null || cap === undefined || typeof trav !== 'function') return false;
  let cur = cap.next;
  while (cur !== cap) {
    const m = cur.__mobj;
    cur = cur.next;
    if (m === undefined || m === mo) continue;
    if (trav(m)) return true;
  }
  return false;
}
