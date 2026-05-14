// Ported from: linuxdoom-1.10/p_sight.c
// LineOfSight via BSP traversal with sight clipping.

import { lines, numlines, nodes, numnodes, segs, subsectors, sectors, numsectors, rejectmatrix } from './p_setup.js';
import { ML_TWOSIDED } from './doomdata.js';
import { FixedDiv, FixedMul } from './m_fixed.js';
import { validcount, bumpValidCount } from './p_maputl.js';

const NF_SUBSECTOR = 0x8000;

// sight state
let sightzstart = 0;
let topslope = 0, bottomslope = 0;
const strace = { x: 0, y: 0, dx: 0, dy: 0 };
let t2x = 0, t2y = 0;

// p_sight.c:54 — P_DivlineSide. Returns 0, 1, or 2 (on).
function P_DivlineSide(x, y, node) {
  if (node.dx === 0) {
    if (x === node.x) return 2;
    if (x <= node.x) return node.dy > 0 ? 1 : 0;
    return node.dy < 0 ? 1 : 0;
  }
  if (node.dy === 0) {
    if (x === node.y) return 2;
    if (y <= node.y) return node.dx < 0 ? 1 : 0;
    return node.dx > 0 ? 1 : 0;
  }
  const dx = x - node.x;
  const dy = y - node.y;
  // Vanilla uses long multiplication on >> FRACBITS shifted values.
  const left  = ((node.dy >> 16) * (dx >> 16)) | 0;
  const right = ((dy        >> 16) * (node.dx >> 16)) | 0;
  if (right < left) return 0;
  if (left === right) return 2;
  return 1;
}

// p_sight.c:109 — P_InterceptVector2. Uses >>8 like the other intercept.
function P_InterceptVector2(v2, v1) {
  const den = (FixedMul(v1.dy >> 8, v2.dx) - FixedMul(v1.dx >> 8, v2.dy)) | 0;
  if (den === 0) return 0;
  const num = (FixedMul((v1.x - v2.x) >> 8, v1.dy) +
               FixedMul((v2.y - v1.y) >> 8, v1.dx)) | 0;
  return FixedDiv(num, den);
}

// p_sight.c:135 — P_CrossSubsector.
function P_CrossSubsector(num) {
  const sub = subsectors[num];
  let segIdx = sub.firstline;
  let count  = sub.numlines;
  const divl = { x: 0, y: 0, dx: 0, dy: 0 };
  while (count-- > 0) {
    const seg = segs[segIdx++];
    const line = seg.linedef;
    if (line.validcount === validcount) continue;
    line.validcount = validcount;
    const v1 = line.v1, v2 = line.v2;
    let s1 = P_DivlineSide(v1.x, v1.y, strace);
    let s2 = P_DivlineSide(v2.x, v2.y, strace);
    if (s1 === s2) continue;
    divl.x = v1.x; divl.y = v1.y;
    divl.dx = v2.x - v1.x; divl.dy = v2.y - v1.y;
    s1 = P_DivlineSide(strace.x, strace.y, divl);
    s2 = P_DivlineSide(t2x, t2y, divl);
    if (s1 === s2) continue;
    if ((line.flags & ML_TWOSIDED) === 0) return false;
    const front = seg.frontsector, back = seg.backsector;
    if (front === null || back === null) return false;
    if (front.floorheight === back.floorheight && front.ceilingheight === back.ceilingheight) continue;
    const opentop    = Math.min(front.ceilingheight, back.ceilingheight);
    const openbottom = Math.max(front.floorheight,   back.floorheight);
    if (openbottom >= opentop) return false;
    const frac = P_InterceptVector2(strace, divl);
    if (front.floorheight !== back.floorheight) {
      const slope = FixedDiv(openbottom - sightzstart, frac);
      if (slope > bottomslope) bottomslope = slope;
    }
    if (front.ceilingheight !== back.ceilingheight) {
      const slope = FixedDiv(opentop - sightzstart, frac);
      if (slope < topslope) topslope = slope;
    }
    if (topslope <= bottomslope) return false;
  }
  return true;
}

// p_sight.c:257 — P_CrossBSPNode.
function P_CrossBSPNode(bspnum) {
  if ((bspnum & NF_SUBSECTOR) !== 0) {
    if (bspnum === -1) return P_CrossSubsector(0);
    return P_CrossSubsector(bspnum & ~NF_SUBSECTOR);
  }
  const bsp = nodes[bspnum];
  let side = P_DivlineSide(strace.x, strace.y, bsp);
  if (side === 2) side = 0;
  if (!P_CrossBSPNode(bsp.children[side])) return false;
  if (side === P_DivlineSide(t2x, t2y, bsp)) return true;
  return P_CrossBSPNode(bsp.children[side ^ 1]);
}

// p_sight.c:300 — P_CheckSight.
export function P_CheckSight(t1, t2) {
  if (t1 === null || t2 === null) return false;
  if (t1.subsector === null || t2.subsector === null) return false;
  // REJECT lookup: a 1 bit means "definitely can't see".
  if (rejectmatrix !== null && rejectmatrix !== undefined) {
    const s1 = t1.subsector.sector.index;
    const s2 = t2.subsector.sector.index;
    if (s1 !== undefined && s2 !== undefined) {
      const pnum = s1 * numsectors + s2;
      const byteIdx = pnum >> 3;
      const bit = 1 << (pnum & 7);
      if (byteIdx < rejectmatrix.length && (rejectmatrix[byteIdx] & bit) !== 0) return false;
    }
  }
  bumpValidCount();
  sightzstart = t1.z + t1.height - (t1.height >> 2);
  topslope    = (t2.z + t2.height) - sightzstart;
  bottomslope = t2.z - sightzstart;
  strace.x = t1.x; strace.y = t1.y;
  t2x = t2.x; t2y = t2.y;
  strace.dx = t2.x - t1.x; strace.dy = t2.y - t1.y;
  return P_CrossBSPNode(numnodes - 1);
}
