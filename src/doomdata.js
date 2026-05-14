// Ported from: linuxdoom-1.10/doomdata.h
// Persistent WAD data layouts shared across modules. Map lumps live as
// raw bytes in the WAD; p_setup.js wraps them in classes that mirror the C
// structs below.

// Lump order in a map WAD.
export const ML_LABEL    = 0;
export const ML_THINGS   = 1;
export const ML_LINEDEFS = 2;
export const ML_SIDEDEFS = 3;
export const ML_VERTEXES = 4;
export const ML_SEGS     = 5;
export const ML_SSECTORS = 6;
export const ML_NODES    = 7;
export const ML_SECTORS  = 8;
export const ML_REJECT   = 9;
export const ML_BLOCKMAP = 10;

// On-disk sizes (matches the packed C structs in linuxdoom).
export const SIZEOF_mapvertex_t    = 4;   // 2 shorts
export const SIZEOF_mapsidedef_t   = 30;  // 2 shorts + 3*8 chars + 1 short
export const SIZEOF_maplinedef_t   = 14;  // 7 shorts
export const SIZEOF_mapsector_t    = 26;  // 2 shorts + 2*8 chars + 3 shorts
export const SIZEOF_mapsubsector_t = 4;   // 2 shorts
export const SIZEOF_mapseg_t       = 12;  // 6 shorts
export const SIZEOF_mapnode_t      = 28;  // 4 shorts + 2*4 shorts + 2 ushorts
export const SIZEOF_mapthing_t     = 10;  // 5 shorts

// LineDef flags.
export const ML_BLOCKING       = 1;
export const ML_BLOCKMONSTERS  = 2;
export const ML_TWOSIDED       = 4;
export const ML_DONTPEGTOP     = 8;
export const ML_DONTPEGBOTTOM  = 16;
export const ML_SECRET         = 32;
export const ML_SOUNDBLOCK     = 64;
export const ML_DONTDRAW       = 128;
export const ML_MAPPED         = 256;

// BSP child indirection bit.
export const NF_SUBSECTOR = 0x8000;

// A mapthing_t — used both during P_LoadThings (parsed from THINGS lump) and
// stored on each mobj_t.spawnpoint for nightmare respawn.
export class mapthing_t {
  constructor() {
    this.x       = 0;
    this.y       = 0;
    this.angle   = 0;
    this.type    = 0;
    this.options = 0;
  }
}
