// Ported from: linuxdoom-1.10/m_fixed.c
// Fixed point, 32bit as 16.16.

import { MININT, MAXINT } from './doomtype.js';

export const FRACBITS = 16;
export const FRACUNIT = 1 << FRACBITS;

// FixedMul: ((long long) a * (long long) b) >> FRACBITS
// We split into 16-bit halves so the intermediate multiplication stays inside
// JS's 53-bit Number range. Result is truncated to a signed 32-bit integer to
// match the C cast back to fixed_t.
export function FixedMul(a, b) {
  const al = a & 0xFFFF;
  const ah = a >> 16;
  const bl = b & 0xFFFF;
  const bh = b >> 16;
  return ( (ah * bh * 0x10000) + (ah * bl) + (al * bh) + ((al * bl) >>> 16) ) | 0;
}

// FixedDiv: overflow guard then delegate to FixedDiv2.
export function FixedDiv(a, b) {
  if ((Math.abs(a) >> 14) >= Math.abs(b)) {
    return ((a ^ b) < 0) ? MININT : MAXINT;
  }
  return FixedDiv2(a, b);
}

export function FixedDiv2(a, b) {
  const c = (a / b) * FRACUNIT;
  if (c >= 2147483648.0 || c < -2147483648.0) {
    throw new Error('FixedDiv: divide by zero');
  }
  return c | 0;
}
