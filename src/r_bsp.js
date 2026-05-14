// Ported from: linuxdoom-1.10/r_bsp.c
// BSP traversal. In the 3D port we let Three.js handle visibility, so most of
// this module is now about geometric queries (R_PointOnSide, R_PointInSubsector)
// rather than the render-time wall-clip walk.

import { nodes, numnodes, subsectors } from './p_setup.js';
import { NF_SUBSECTOR } from './doomdata.js';
import { FixedMul } from './m_fixed.js';

export let firstseg = null;
export let curline  = null;

// R_PointOnSide — ported from r_bsp.c. Returns 0 if (x,y) is on the right
// side of the node's partition line, 1 if on the left. All fixed-point.
export function R_PointOnSide(x, y, node) {
  if (node.dx === 0) {
    if (x <= node.x) return node.dy > 0 ? 1 : 0;
    return node.dy < 0 ? 1 : 0;
  }
  if (node.dy === 0) {
    if (y <= node.y) return node.dx < 0 ? 1 : 0;
    return node.dx > 0 ? 1 : 0;
  }
  const dx = (x - node.x) | 0;
  const dy = (y - node.y) | 0;
  if (((node.dy ^ node.dx ^ dx ^ dy) & 0x80000000) !== 0) {
    if (((node.dy ^ dx) & 0x80000000) !== 0) return 1;
    return 0;
  }
  // r_bsp.c R_PointOnSide: left = FixedMul(node->dy>>FRACBITS, dx);
  //                         right = FixedMul(dy, node->dx>>FRACBITS);
  const left  = FixedMul(node.dy >> 16, dx);
  const right = FixedMul(dy, node.dx >> 16);
  if (right < left) return 0;
  return 1;
}

// R_PointInSubsector: BSP walk to find the leaf subsector containing (x, y).
export function R_PointInSubsector(x, y) {
  if (numnodes === 0) return subsectors[0];
  let nodenum = numnodes - 1;
  while ((nodenum & NF_SUBSECTOR) === 0) {
    const node = nodes[nodenum];
    const side = R_PointOnSide(x, y, node);
    nodenum = node.children[side];
  }
  return subsectors[nodenum & ~NF_SUBSECTOR];
}

// R_PointOnSegSide — like R_PointOnSide but using a seg_t's stored v1/v2.
export function R_PointOnSegSide(x, y, line) {
  const lx = line.v1.x, ly = line.v1.y;
  const ldx = line.v2.x - lx, ldy = line.v2.y - ly;
  if (ldx === 0) return x <= lx ? (ldy > 0 ? 1 : 0) : (ldy < 0 ? 1 : 0);
  if (ldy === 0) return y <= ly ? (ldx < 0 ? 1 : 0) : (ldx > 0 ? 1 : 0);
  const dx = (x - lx) | 0, dy = (y - ly) | 0;
  const left  = FixedMul(ldy >> 16, dx);
  const right = FixedMul(dy, ldx >> 16);
  return right < left ? 0 : 1;
}

// R_PointToAngle — angle from viewx/viewy to (x, y) in BAM (32-bit unsigned).
// Faithful port of r_main.c:292 using the tantoangle[] LUT + octant select.
// Demo determinism requires this — Math.atan2 introduces FP rounding that
// diverges from the table-exact angles vanilla uses for monster facing etc.
import { viewx as _viewx, viewy as _viewy } from './r_things.js';
import { tantoangle, SlopeDiv, ANG90, ANG180, ANG270 } from './tables.js';

function _R_PointToAngle(x, y) {
  if (x === 0 && y === 0) return 0;
  if (x >= 0) {
    if (y >= 0) {
      return x > y
        ? tantoangle[SlopeDiv(y, x)]                    // octant 0
        : ((ANG90 - 1 - tantoangle[SlopeDiv(x, y)]) >>> 0); // octant 1
    } else {
      y = -y;
      return x > y
        ? ((-tantoangle[SlopeDiv(y, x)]) >>> 0)              // octant 8
        : ((ANG270 + tantoangle[SlopeDiv(x, y)]) >>> 0);     // octant 7
    }
  } else {
    x = -x;
    if (y >= 0) {
      return x > y
        ? ((ANG180 - 1 - tantoangle[SlopeDiv(y, x)]) >>> 0)  // octant 3
        : ((ANG90 + tantoangle[SlopeDiv(x, y)]) >>> 0);      // octant 2
    } else {
      y = -y;
      return x > y
        ? ((ANG180 + tantoangle[SlopeDiv(y, x)]) >>> 0)      // octant 4
        : ((ANG270 - 1 - tantoangle[SlopeDiv(x, y)]) >>> 0); // octant 5
    }
  }
}

export function R_PointToAngle(x, y) {
  return _R_PointToAngle(x - _viewx, y - _viewy);
}
export function R_PointToAngle2(x1, y1, x2, y2) {
  return _R_PointToAngle(x2 - x1, y2 - y1);
}

// Render-time BSP walk — Three.js handles visibility so we don't traverse,
// but a fast point-in-subsector + back-to-front sprite ordering walk would
// live here. Kept as no-ops for source-map parity.
export function R_ClearDrawSegs() {}
export function R_ClearClipSegs() {}
export function R_RenderBSPNode(_bspnum) {}
