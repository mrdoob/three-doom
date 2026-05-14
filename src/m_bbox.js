// Ported from: linuxdoom-1.10/m_bbox.c
// Bounding box utilities (fixed_t[4]).

import { MININT, MAXINT } from './doomtype.js';

export const BOXTOP    = 0;
export const BOXBOTTOM = 1;
export const BOXLEFT   = 2;
export const BOXRIGHT  = 3;

export function M_ClearBox(box) {
  box[BOXTOP]    = MININT;
  box[BOXRIGHT]  = MININT;
  box[BOXBOTTOM] = MAXINT;
  box[BOXLEFT]   = MAXINT;
}

export function M_AddToBox(box, x, y) {
  if      (x < box[BOXLEFT])  box[BOXLEFT]  = x;
  else if (x > box[BOXRIGHT]) box[BOXRIGHT] = x;
  if      (y < box[BOXBOTTOM]) box[BOXBOTTOM] = y;
  else if (y > box[BOXTOP])    box[BOXTOP]    = y;
}
