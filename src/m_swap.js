// Ported from: linuxdoom-1.10/m_swap.h
// Endianess handling. WAD files are stored little endian.
// In JS we use DataView with the explicit little-endian flag, so SHORT/LONG
// are no-ops kept for source compatibility with C call sites.

export function SHORT(x) { return x | 0; }
export function LONG(x)  { return x | 0; }
