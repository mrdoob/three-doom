// Ported from: linuxdoom-1.10/doomtype.h
// Simple basic typedefs, isolated here to make it easier separating modules.

export const MAXCHAR  = 0x7f;
export const MAXSHORT = 0x7fff;
export const MAXINT   = 0x7fffffff;
export const MAXLONG  = 0x7fffffff;
export const MINCHAR  = -0x80;
export const MINSHORT = -0x8000;
export const MININT   = -0x80000000;
export const MINLONG  = -0x80000000;

// In C: typedef enum {false, true} boolean; — JS uses native true/false.
