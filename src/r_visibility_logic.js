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

function clippedColumnRange(angle1, angle2, viewangle, mapping) {
  const span = (angle1 - angle2) >>> 0;
  // Back side of the directed seg, exactly as r_bsp.c:R_AddLine.
  if (span >= ANG180) return null;

  let relative1 = (angle1 - viewangle) >>> 0;
  let relative2 = (angle2 - viewangle) >>> 0;

  const clipangle = mapping.clipangle;
  const doubleClip = (clipangle * 2) >>> 0;
  let clipped = (relative1 + clipangle) >>> 0;
  if (clipped > doubleClip) {
    clipped = (clipped - doubleClip) >>> 0;
    if (clipped >= span) return null;
    relative1 = clipangle;
  }

  clipped = (clipangle - relative2) >>> 0;
  if (clipped > doubleClip) {
    clipped = (clipped - doubleClip) >>> 0;
    if (clipped >= span) return null;
    relative2 = (-clipangle) >>> 0;
  }

  const x1 = R_ViewAngleToX(relative1, mapping);
  const x2 = R_ViewAngleToX(relative2, mapping);
  if (x1 >= x2) return null;
  return { first: x1, last: x2 - 1 };
}

function rangeHasVisibleColumn(ranges, first, last) {
  for (const range of ranges) {
    if (range.last < first) continue;
    if (range.first > first) return true;
    if (range.last >= last) return false;
    first = range.last + 1;
  }
  return first <= last;
}

function addSolidRange(ranges, first, last) {
  let insert = 0;
  while (insert < ranges.length && ranges[insert].last < first - 1) insert++;

  let mergedFirst = first;
  let mergedLast = last;
  let removeEnd = insert;
  while (removeEnd < ranges.length && ranges[removeEnd].first <= mergedLast + 1) {
    mergedFirst = Math.min(mergedFirst, ranges[removeEnd].first);
    mergedLast = Math.max(mergedLast, ranges[removeEnd].last);
    removeEnd++;
  }
  ranges.splice(insert, removeEnd - insert, { first: mergedFirst, last: mergedLast });
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
}) {
  const visible = new Set();
  if (!Number.isInteger(viewwidth) || viewwidth <= 0 ||
      !Array.isArray(subsectors) || !Array.isArray(segs) ||
      subsectors.length === 0) return visible;

  const solidRanges = [];
  const mapping = R_BuildViewAngleMapping(viewwidth);
  const stack = [numnodes === 0 ? NF_SUBSECTOR : numnodes - 1];
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
      const range = clippedColumnRange(
        pointToAngle2(viewx, viewy, seg.v1.x, seg.v1.y),
        pointToAngle2(viewx, viewy, seg.v2.x, seg.v2.y),
        viewangle >>> 0,
        mapping,
      );
      if (range === null) continue;

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
