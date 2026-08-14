// Horizontal visibility walk used for automap discovery.
//
// Doom marks ML_MAPPED from R_StoreWallRange, after a seg has survived the
// front-to-back BSP walk and the solid-column clip list. The Three.js port
// retains the whole level, so it has no equivalent render-time walk. This
// module reproduces the small part of that walk which decides whether at
// least one screen column of a linedef is visible.

import { NF_SUBSECTOR } from './doomdata.js';
import {
  ANG90, ANG180, ANGLETOFINESHIFT, FINEANGLES, finetangent,
} from './tables.js';
import { FixedDiv, FixedMul, FRACBITS, FRACUNIT } from './m_fixed.js';

const FIELDOFVIEW = 2048;
const _angleMappings = new Map();

// Exact r_main.c:R_InitTextureMapping table for a logical view width. Low
// detail changes the number of horizontal columns, but not the 90-degree FOV.
export function R_BuildViewAngleMapping(viewwidth) {
  const cached = _angleMappings.get(viewwidth);
  if (cached !== undefined) return cached;

  const centerx = viewwidth >> 1;
  const centerxfrac = centerx << FRACBITS;
  const focallength = FixedDiv(
    centerxfrac,
    finetangent[FINEANGLES / 4 + FIELDOFVIEW / 2],
  );
  const viewangletox = new Int32Array(FINEANGLES / 2);
  for (let i = 0; i < viewangletox.length; i++) {
    const tangent = finetangent[i];
    let x;
    if (tangent > FRACUNIT * 2) x = -1;
    else if (tangent < -FRACUNIT * 2) x = viewwidth + 1;
    else {
      const projected = FixedMul(tangent, focallength);
      x = (centerxfrac - projected + FRACUNIT - 1) >> FRACBITS;
      if (x < -1) x = -1;
      else if (x > viewwidth + 1) x = viewwidth + 1;
    }
    viewangletox[i] = x;
  }

  // xtoviewangle[0], computed before the source repairs table fenceposts.
  let leftIndex = 0;
  while (viewangletox[leftIndex] > 0) leftIndex++;
  const clipangle = ((leftIndex << ANGLETOFINESHIFT) - ANG90) >>> 0;
  for (let i = 0; i < viewangletox.length; i++) {
    if (viewangletox[i] === -1) viewangletox[i] = 0;
    else if (viewangletox[i] === viewwidth + 1) viewangletox[i] = viewwidth;
  }

  const result = Object.freeze({ viewangletox, clipangle });
  _angleMappings.set(viewwidth, result);
  return result;
}

export function R_ViewAngleToX(angle, mapping) {
  const fine = ((angle + ANG90) >>> 0) >>> ANGLETOFINESHIFT;
  return mapping.viewangletox[fine];
}

function clippedColumnRange(angle1, angle2, viewangle, mapping, output) {
  const span = (angle1 - angle2) >>> 0;
  // Back side of the directed seg, exactly as r_bsp.c:R_AddLine.
  if (span >= ANG180) return false;

  let relative1 = (angle1 - viewangle) >>> 0;
  let relative2 = (angle2 - viewangle) >>> 0;

  const clipangle = mapping.clipangle;
  const doubleClip = (clipangle * 2) >>> 0;
  let clipped = (relative1 + clipangle) >>> 0;
  if (clipped > doubleClip) {
    clipped = (clipped - doubleClip) >>> 0;
    if (clipped >= span) return false;
    relative1 = clipangle;
  }

  clipped = (clipangle - relative2) >>> 0;
  if (clipped > doubleClip) {
    clipped = (clipped - doubleClip) >>> 0;
    if (clipped >= span) return false;
    relative2 = (-clipangle) >>> 0;
  }

  const x1 = R_ViewAngleToX(relative1, mapping);
  const x2 = R_ViewAngleToX(relative2, mapping);
  if (x1 >= x2) return false;
  output.first = x1;
  output.last = x2 - 1;
  return true;
}

function rangeHasVisibleColumn(ranges, first, last) {
  // Flat [first, last, ...] storage keeps the production scratch allocation-
  // free while preserving the sorted, non-overlapping clip-list invariant.
  for (let i = 0; i < ranges.length; i += 2) {
    if (ranges[i + 1] < first) continue;
    if (ranges[i] > first) return true;
    if (ranges[i + 1] >= last) return false;
    first = ranges[i + 1] + 1;
  }
  return first <= last;
}

function addSolidRange(ranges, first, last) {
  let insert = 0;
  while (insert < ranges.length && ranges[insert + 1] < first - 1) insert += 2;

  let mergedFirst = first;
  let mergedLast = last;
  let removeEnd = insert;
  while (removeEnd < ranges.length && ranges[removeEnd] <= mergedLast + 1) {
    mergedFirst = Math.min(mergedFirst, ranges[removeEnd]);
    mergedLast = Math.max(mergedLast, ranges[removeEnd + 1]);
    removeEnd += 2;
  }
  const oldLength = ranges.length;
  const newLength = oldLength - (removeEnd - insert) + 2;
  // Shift the untouched tail in place. Grow first for rightward insertion;
  // shrink only after a leftward merge so copyWithin can still read the tail.
  if (newLength > oldLength) ranges.length = newLength;
  ranges.copyWithin(insert + 2, removeEnd, oldLength);
  ranges.length = newLength;
  ranges[insert] = mergedFirst;
  ranges[insert + 1] = mergedLast;
}

function classifySeg(seg) {
  const front = seg.frontsector;
  const back = seg.backsector;
  if (front === null || front === undefined) return 'empty';
  if (back === null || back === undefined) return 'solid';
  if (back.ceilingheight <= front.floorheight ||
      back.floorheight >= front.ceilingheight) return 'solid';
  if (back.ceilingheight !== front.ceilingheight ||
      back.floorheight !== front.floorheight) return 'pass';

  // r_bsp.c rejects trigger-only lines whose two sectors look identical.
  if (back.ceilingpic === front.ceilingpic &&
      back.floorpic === front.floorpic &&
      back.lightlevel === front.lightlevel &&
      (seg.sidedef?.midtexture ?? 0) === 0) return 'empty';
  return 'pass';
}

/**
 * Return the linedef objects that would reach R_StoreWallRange for this view.
 * The traversal deliberately visits the complete back subtree instead of
 * porting R_CheckBBox: the same solid-column list rejects a fully hidden seg,
 * while keeping this visibility-only path independent of renderer tables.
 */
export function R_CreateVisibilityScratch() {
  return {
    visible: new Set(),
    solidRanges: [],
    stack: [],
    clippedRange: { first: 0, last: 0 },
  };
}

export function R_CollectVisibleLinedefs({
  viewx,
  viewy,
  viewangle,
  viewwidth,
  nodes,
  numnodes,
  subsectors,
  segs,
  pointOnSide,
  pointToAngle2,
  scratch = null,
}) {
  // Pure callers receive independent output by default. r_bsp supplies one
  // private scratch object so the production per-view walk reuses its Set,
  // traversal stack, clip ranges, and clipped-range record.
  const work = scratch ?? R_CreateVisibilityScratch();
  const visible = work.visible;
  const solidRanges = work.solidRanges;
  const stack = work.stack;
  const range = work.clippedRange;
  visible.clear();
  solidRanges.length = 0;
  stack.length = 0;
  if (!Number.isInteger(viewwidth) || viewwidth <= 0 ||
      !Array.isArray(subsectors) || !Array.isArray(segs) ||
      subsectors.length === 0) return visible;

  const mapping = R_BuildViewAngleMapping(viewwidth);
  stack.push(numnodes === 0 ? NF_SUBSECTOR : numnodes - 1);
  while (stack.length !== 0) {
    const index = stack.pop();
    if ((index & NF_SUBSECTOR) === 0) {
      const node = nodes[index];
      if (node === undefined || node === null) continue;
      const side = pointOnSide(viewx, viewy, node);
      // LIFO: push back first so the viewpoint side is processed first.
      stack.push(node.children[side ^ 1]);
      stack.push(node.children[side]);
      continue;
    }

    const subsectorIndex = index & ~NF_SUBSECTOR;
    const subsector = subsectors[subsectorIndex];
    if (subsector === undefined || subsector === null) continue;
    for (let i = 0; i < subsector.numlines; i++) {
      const seg = segs[subsector.firstline + i];
      if (seg === undefined || seg === null || seg.linedef === null) continue;
      if (!clippedColumnRange(
        pointToAngle2(viewx, viewy, seg.v1.x, seg.v1.y),
        pointToAngle2(viewx, viewy, seg.v2.x, seg.v2.y),
        viewangle >>> 0,
        mapping,
        range,
      )) continue;

      const kind = classifySeg(seg);
      if (kind === 'empty') continue;
      if (rangeHasVisibleColumn(solidRanges, range.first, range.last)) {
        visible.add(seg.linedef);
      }
      if (kind === 'solid') addSolidRange(solidRanges, range.first, range.last);
    }
  }
  return visible;
}
