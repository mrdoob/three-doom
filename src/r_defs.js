// Ported from: linuxdoom-1.10/r_defs.h
// Runtime structures shared between rendering and play.

import { thinker_t } from './d_think.js';
import { SCREENWIDTH } from './doomdef.js';

// Silhouette codes (for r_segs/r_things clipping).
export const SIL_NONE   = 0;
export const SIL_BOTTOM = 1;
export const SIL_TOP    = 2;
export const SIL_BOTH   = 3;
export const MAXDRAWSEGS = 256;

export class vertex_t {
  constructor() { this.x = 0; this.y = 0; }
}

// Each sector carries a degenmobj_t at its centroid for spatial sound origin.
export class degenmobj_t {
  constructor() {
    this.thinker = new thinker_t();
    this.x = 0; this.y = 0; this.z = 0;
  }
}

export class sector_t {
  constructor() {
    this.floorheight    = 0;
    this.ceilingheight  = 0;
    this.floorpic       = 0;
    this.ceilingpic     = 0;
    this.lightlevel     = 0;
    this.special        = 0;
    this.tag            = 0;
    this.soundtraversed = 0;
    this.soundtarget    = null;
    this.blockbox       = new Int32Array(4);
    this.soundorg       = new degenmobj_t();
    this.validcount     = 0;
    this.thinglist      = null;
    this.specialdata    = null;
    this.linecount      = 0;
    this.lines          = null;
  }
}

export class side_t {
  constructor() {
    this.textureoffset = 0;
    this.rowoffset     = 0;
    this.toptexture    = 0;
    this.bottomtexture = 0;
    this.midtexture    = 0;
    this.sector        = null;
  }
}

// Slope kinds for line clip optimisations.
export const ST_HORIZONTAL = 0;
export const ST_VERTICAL   = 1;
export const ST_POSITIVE   = 2;
export const ST_NEGATIVE   = 3;

export class line_t {
  constructor() {
    this.v1 = null; this.v2 = null;
    this.dx = 0; this.dy = 0;
    this.flags = 0; this.special = 0; this.tag = 0;
    this.sidenum = [-1, -1];
    this.bbox    = new Int32Array(4);
    this.slopetype  = 0;
    this.frontsector = null;
    this.backsector  = null;
    this.validcount  = 0;
    this.specialdata = null;
  }
}

export class subsector_t {
  constructor() {
    this.sector = null;
    this.numlines = 0;
    this.firstline = 0;
  }
}

export class seg_t {
  constructor() {
    this.v1 = null; this.v2 = null;
    this.offset = 0;
    this.angle  = 0;
    this.sidedef = null;
    this.linedef = null;
    this.frontsector = null;
    this.backsector  = null;
  }
}

export class node_t {
  constructor() {
    this.x = 0; this.y = 0; this.dx = 0; this.dy = 0;
    // bbox[2][4] flattened — left[0..3], right[0..3]
    this.bbox = [new Int32Array(4), new Int32Array(4)];
    this.children = new Uint16Array(2);
  }
}

// drawseg_t — used by r_segs.js for sprite clipping bookkeeping.
export class drawseg_t {
  constructor() {
    this.curline = null;
    this.x1 = 0; this.x2 = 0;
    this.scale1 = 0; this.scale2 = 0; this.scalestep = 0;
    this.silhouette = 0;
    this.bsilheight = 0;
    this.tsilheight = 0;
    this.sprtopclip = null;
    this.sprbottomclip = null;
    this.maskedtexturecol = null;
  }
}

// vissprite_t — used by r_things.js (mostly relevant in the software path,
// kept here so r_main.js wiring matches the C structure).
export class vissprite_t {
  constructor() {
    this.prev = null; this.next = null;
    this.x1 = 0; this.x2 = 0;
    this.gx = 0; this.gy = 0;
    this.gz = 0; this.gzt = 0;
    this.startfrac = 0;
    this.scale = 0;
    this.xiscale = 0;
    this.texturemid = 0;
    this.patch = 0;
    this.colormap = null;
    this.mobjflags = 0;
  }
}

// Sprite frame: up to 8 rotations, with per-rotation flip bit.
export class spriteframe_t {
  constructor() {
    this.rotate = false;
    this.lump = new Int16Array(8);
    this.flip = new Uint8Array(8);
  }
}

export class spritedef_t {
  constructor() {
    this.numframes = 0;
    this.spriteframes = null;
  }
}

export class visplane_t {
  constructor() {
    this.height = 0;
    this.picnum = 0;
    this.lightlevel = 0;
    this.minx = 0;
    this.maxx = 0;
    // top/bottom are SCREENWIDTH-wide span buffers used by the software
    // span renderer. Retained for compatibility — r_plane.js may use them
    // as bookkeeping even when the geometry is uploaded to Three.js.
    this.top    = new Uint8Array(SCREENWIDTH);
    this.bottom = new Uint8Array(SCREENWIDTH);
  }
}
