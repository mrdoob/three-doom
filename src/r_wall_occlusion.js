// Pure retained-wall occlusion decisions mirroring r_bsp.c:R_AddLine.
// Kept free of Three.js so the exact solid-span rules can be unit tested.

// A missing texture is represented by texture number 0 (the "-" marker).
// One-sided lines are always terminal. Two-sided lines are terminal only when
// the back sector lies wholly below or above the visible front-sector span;
// in those cases the corresponding upper/lower texture normally supplies the
// depth-writing wall surface.
export function R_NeedsTerminalDepthOccluder(front, back, side) {
  if (front === null || front === undefined || side === null || side === undefined ||
      front.ceilingheight <= front.floorheight) {
    return false;
  }
  if (back === null || back === undefined) return side.midtexture <= 0;
  return (back.ceilingheight <= front.floorheight && side.toptexture <= 0) ||
    (back.floorheight >= front.ceilingheight && side.bottomtexture <= 0);
}
