// Ported from: linuxdoom-1.10/p_setup.c
// Load a map's lumps into runtime structures (vertexes, sectors, segs, etc).

import {
  vertex_t, sector_t, side_t, line_t, subsector_t, seg_t, node_t,
  ST_HORIZONTAL, ST_VERTICAL, ST_POSITIVE, ST_NEGATIVE,
} from './r_defs.js';
import {
  ML_BLOCKMAP, ML_VERTEXES, ML_SECTORS, ML_SIDEDEFS, ML_LINEDEFS,
  ML_SSECTORS, ML_NODES, ML_SEGS, ML_REJECT, ML_THINGS, ML_TWOSIDED,
  SIZEOF_mapvertex_t, SIZEOF_mapseg_t, SIZEOF_mapsubsector_t,
  SIZEOF_mapsector_t, SIZEOF_mapnode_t, SIZEOF_maplinedef_t,
  SIZEOF_mapsidedef_t, SIZEOF_mapthing_t, mapthing_t,
} from './doomdata.js';
import { W_LumpLength, W_CacheLumpNum, W_GetNumForName } from './w_wad.js';
import { FRACBITS } from './m_fixed.js';
import { FixedDiv } from './m_fixed.js';
import { M_ClearBox, M_AddToBox, BOXLEFT, BOXRIGHT, BOXBOTTOM, BOXTOP } from './m_bbox.js';
import { GameMode_t, MAXPLAYERS } from './doomdef.js';
import { gamemode, set_leveltime, playerstarts } from './doomstat.js';
import { I_Error } from './i_system.js';

// ---------- Map lookup tables ----------
export let numvertexes  = 0;
export let vertexes     = null;
export let numsegs      = 0;
export let segs         = null;
export let numsectors   = 0;
export let sectors      = null;
export let numsubsectors = 0;
export let subsectors   = null;
export let numnodes     = 0;
export let nodes        = null;
export let numlines     = 0;
export let lines        = null;
export let numsides     = 0;
export let sides        = null;

// ---------- Blockmap ----------
export let bmapwidth  = 0;
export let bmapheight = 0;
export let blockmap   = null;       // Int16Array view (excluding 4-short header)
export let blockmaplump = null;     // Int16Array view of full lump
export let bmaporgx   = 0;
export let bmaporgy   = 0;
export let blocklinks = null;       // Array of mobj_t heads

// ---------- Reject ----------
export let rejectmatrix = null;

// ---------- Map things ----------
// Captured by P_LoadThings so the renderer can spawn billboards even before
// the full play-sim is online. (In the C source this isn't stored; mapthings
// are passed straight to P_SpawnMapThing.)
export let mapthings = [];

// ---------- Setters for external mutation ----------
export function set_lines(v) { lines = v; }
export function set_sectors(v) {
  sectors = v;
  // Expose to p_saveg without an import cycle.
  if (typeof globalThis !== 'undefined') globalThis.__doom_sectors = v;
}

// Externals — these are wired from r_data.js at setup time so we can keep the
// dependency one-way (p_setup doesn't have to import r_data, but uses its
// texture/flat number lookups).
let R_TextureNumForName = (_n) => 0;
let R_FlatNumForName    = (_n) => 0;
let P_SpawnMapThing     = (_mt) => {};
let R_PrecacheLevel     = () => {};
export function P_SetExternals(refs) {
  if (refs.R_TextureNumForName != null) R_TextureNumForName = refs.R_TextureNumForName;
  if (refs.R_FlatNumForName != null)    R_FlatNumForName    = refs.R_FlatNumForName;
  if (refs.P_SpawnMapThing != null)     P_SpawnMapThing     = refs.P_SpawnMapThing;
  if (refs.R_PrecacheLevel != null)     R_PrecacheLevel     = refs.R_PrecacheLevel;
}

function readName8(bytes, offset) {
  let s = '';
  for (let i = 0; i < 8; i++) {
    const b = bytes[offset + i];
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s.toUpperCase();
}

// ---------- P_LoadVertexes ----------
export function P_LoadVertexes(lump) {
  numvertexes = W_LumpLength(lump) / SIZEOF_mapvertex_t;
  vertexes = new Array(numvertexes);
  const data = W_CacheLumpNum(lump, 0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < numvertexes; i++) {
    const v = new vertex_t();
    v.x = view.getInt16(i * 4 + 0, true) << FRACBITS;
    v.y = view.getInt16(i * 4 + 2, true) << FRACBITS;
    vertexes[i] = v;
  }
}

// ---------- P_LoadSegs ----------
export function P_LoadSegs(lump) {
  numsegs = W_LumpLength(lump) / SIZEOF_mapseg_t;
  segs = new Array(numsegs);
  const data = W_CacheLumpNum(lump, 0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < numsegs; i++) {
    const s = new seg_t();
    const off = i * SIZEOF_mapseg_t;
    s.v1 = vertexes[view.getInt16(off + 0, true)];
    s.v2 = vertexes[view.getInt16(off + 2, true)];
    s.angle  = view.getInt16(off + 4, true) << 16;
    const linedef = view.getInt16(off + 6, true);
    const side    = view.getInt16(off + 8, true);
    s.offset = view.getInt16(off + 10, true) << 16;
    const ldef = lines[linedef];
    s.linedef = ldef;
    s.sidedef = sides[ldef.sidenum[side]];
    s.frontsector = sides[ldef.sidenum[side]].sector;
    if ((ldef.flags & ML_TWOSIDED) !== 0) {
      s.backsector = sides[ldef.sidenum[side ^ 1]].sector;
    } else {
      s.backsector = null;
    }
    segs[i] = s;
  }
}

// ---------- P_LoadSubsectors ----------
export function P_LoadSubsectors(lump) {
  numsubsectors = W_LumpLength(lump) / SIZEOF_mapsubsector_t;
  subsectors = new Array(numsubsectors);
  const data = W_CacheLumpNum(lump, 0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < numsubsectors; i++) {
    const ss = new subsector_t();
    ss.numlines  = view.getInt16(i * 4 + 0, true);
    ss.firstline = view.getInt16(i * 4 + 2, true);
    subsectors[i] = ss;
  }
}

// ---------- P_LoadSectors ----------
export function P_LoadSectors(lump) {
  numsectors = W_LumpLength(lump) / SIZEOF_mapsector_t;
  sectors = new Array(numsectors);
  if (typeof globalThis !== 'undefined') globalThis.__doom_sectors = sectors;
  const data = W_CacheLumpNum(lump, 0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < numsectors; i++) {
    const s = new sector_t();
    const off = i * SIZEOF_mapsector_t;
    s.floorheight   = view.getInt16(off + 0, true) << FRACBITS;
    s.ceilingheight = view.getInt16(off + 2, true) << FRACBITS;
    s.floorpic      = R_FlatNumForName(readName8(data, off + 4));
    s.ceilingpic    = R_FlatNumForName(readName8(data, off + 12));
    s.lightlevel    = view.getInt16(off + 20, true);
    s.special       = view.getInt16(off + 22, true);
    s.tag           = view.getInt16(off + 24, true);
    s.thinglist     = null;
    s.index         = i; // for O(1) REJECT lookup
    sectors[i] = s;
  }
}

// ---------- P_LoadNodes ----------
export function P_LoadNodes(lump) {
  numnodes = W_LumpLength(lump) / SIZEOF_mapnode_t;
  nodes = new Array(numnodes);
  const data = W_CacheLumpNum(lump, 0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < numnodes; i++) {
    const n = new node_t();
    const off = i * SIZEOF_mapnode_t;
    n.x  = view.getInt16(off + 0, true) << FRACBITS;
    n.y  = view.getInt16(off + 2, true) << FRACBITS;
    n.dx = view.getInt16(off + 4, true) << FRACBITS;
    n.dy = view.getInt16(off + 6, true) << FRACBITS;
    for (let j = 0; j < 2; j++) {
      for (let k = 0; k < 4; k++) {
        n.bbox[j][k] = view.getInt16(off + 8 + j * 8 + k * 2, true) << FRACBITS;
      }
      n.children[j] = view.getUint16(off + 24 + j * 2, true);
    }
    nodes[i] = n;
  }
}

// ---------- P_LoadThings ----------
export function P_LoadThings(lump) {
  mapthings = [];
  const data = W_CacheLumpNum(lump, 0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const numthings = W_LumpLength(lump) / SIZEOF_mapthing_t;
  for (let i = 0; i < numthings; i++) {
    const off = i * SIZEOF_mapthing_t;
    const mt = new mapthing_t();
    mt.x       = view.getInt16(off + 0, true);
    mt.y       = view.getInt16(off + 2, true);
    mt.angle   = view.getInt16(off + 4, true);
    mt.type    = view.getInt16(off + 6, true);
    mt.options = view.getInt16(off + 8, true);

    // Skip commercial-only thing types when running shareware/registered/retail.
    // C p_setup.c:337 — vanilla quirk: `break` (not `continue`) ends the entire
    // thing-loading loop on the first non-commercial type encountered.
    if (gamemode !== GameMode_t.commercial) {
      switch (mt.type) {
        case 64: case 65: case 66: case 67: case 68: case 69: case 71:
        case 84: case 88: case 89:
          // Match vanilla bug: bail out of the entire P_LoadThings loop.
          // (Harmless in practice — Doom 1 maps don't contain these types.)
          return;
      }
    }
    // Record player starts (type 1..4) eagerly so the renderer can place the
    // camera even before the play simulation comes online.
    if (mt.type >= 1 && mt.type <= MAXPLAYERS) {
      const ps = playerstarts[mt.type - 1];
      ps.x = mt.x; ps.y = mt.y; ps.angle = mt.angle; ps.type = mt.type; ps.options = mt.options;
    }
    mapthings.push(mt);
    P_SpawnMapThing(mt);
  }
}

// ---------- P_LoadLineDefs ----------
export function P_LoadLineDefs(lump) {
  numlines = W_LumpLength(lump) / SIZEOF_maplinedef_t;
  lines = new Array(numlines);
  const data = W_CacheLumpNum(lump, 0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < numlines; i++) {
    const ld = new line_t();
    const off = i * SIZEOF_maplinedef_t;
    const v1 = vertexes[view.getInt16(off + 0, true)];
    const v2 = vertexes[view.getInt16(off + 2, true)];
    ld.flags   = view.getInt16(off + 4, true);
    ld.special = view.getInt16(off + 6, true);
    ld.tag     = view.getInt16(off + 8, true);
    ld.v1 = v1; ld.v2 = v2;
    ld.dx = v2.x - v1.x; ld.dy = v2.y - v1.y;
    if (ld.dx === 0)      ld.slopetype = ST_VERTICAL;
    else if (ld.dy === 0) ld.slopetype = ST_HORIZONTAL;
    else if (FixedDiv(ld.dy, ld.dx) > 0) ld.slopetype = ST_POSITIVE;
    else                                  ld.slopetype = ST_NEGATIVE;

    if (v1.x < v2.x) { ld.bbox[BOXLEFT] = v1.x; ld.bbox[BOXRIGHT] = v2.x; }
    else             { ld.bbox[BOXLEFT] = v2.x; ld.bbox[BOXRIGHT] = v1.x; }
    if (v1.y < v2.y) { ld.bbox[BOXBOTTOM] = v1.y; ld.bbox[BOXTOP] = v2.y; }
    else             { ld.bbox[BOXBOTTOM] = v2.y; ld.bbox[BOXTOP] = v1.y; }

    ld.sidenum[0] = view.getInt16(off + 10, true);
    ld.sidenum[1] = view.getInt16(off + 12, true);
    ld.frontsector = ld.sidenum[0] !== -1 ? sides[ld.sidenum[0]].sector : null;
    ld.backsector  = ld.sidenum[1] !== -1 ? sides[ld.sidenum[1]].sector : null;

    lines[i] = ld;
  }
}

// ---------- P_LoadSideDefs ----------
export function P_LoadSideDefs(lump) {
  numsides = W_LumpLength(lump) / SIZEOF_mapsidedef_t;
  sides = new Array(numsides);
  const data = W_CacheLumpNum(lump, 0);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = 0; i < numsides; i++) {
    const sd = new side_t();
    const off = i * SIZEOF_mapsidedef_t;
    sd.textureoffset = view.getInt16(off + 0, true) << FRACBITS;
    sd.rowoffset     = view.getInt16(off + 2, true) << FRACBITS;
    sd.toptexture    = R_TextureNumForName(readName8(data, off + 4));
    sd.bottomtexture = R_TextureNumForName(readName8(data, off + 12));
    sd.midtexture    = R_TextureNumForName(readName8(data, off + 20));
    sd.sector        = sectors[view.getInt16(off + 28, true)];
    sides[i] = sd;
  }
}

// ---------- P_LoadBlockMap ----------
export function P_LoadBlockMap(lump) {
  const data = W_CacheLumpNum(lump, 0);
  const len = W_LumpLength(lump);
  // Build an Int16Array view (signed because Doom's blockmap entries are signed).
  blockmaplump = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + len));
  blockmap = blockmaplump.subarray(4);
  bmaporgx  = blockmaplump[0] << FRACBITS;
  bmaporgy  = blockmaplump[1] << FRACBITS;
  bmapwidth  = blockmaplump[2];
  bmapheight = blockmaplump[3];
  blocklinks = new Array(bmapwidth * bmapheight);
  for (let i = 0; i < blocklinks.length; i++) blocklinks[i] = null;
}

// ---------- P_GroupLines ----------
const MAXRADIUS    = 32 << FRACBITS;
const MAPBLOCKSHIFT = FRACBITS + 7;
export function P_GroupLines() {
  // subsector -> sector
  for (let i = 0; i < numsubsectors; i++) {
    const ss = subsectors[i];
    const sg = segs[ss.firstline];
    ss.sector = sg.sidedef.sector;
  }
  // Count lines per sector.
  let total = 0;
  for (let i = 0; i < numlines; i++) {
    const li = lines[i];
    total++;
    li.frontsector.linecount++;
    if (li.backsector !== null && li.backsector !== li.frontsector) {
      li.backsector.linecount++;
      total++;
    }
  }
  // Build sector->lines list.
  const bbox = new Int32Array(4);
  for (let i = 0; i < numsectors; i++) {
    const sector = sectors[i];
    M_ClearBox(bbox);
    sector.lines = new Array(sector.linecount);
    let idx = 0;
    for (let j = 0; j < numlines; j++) {
      const li = lines[j];
      if (li.frontsector === sector || li.backsector === sector) {
        sector.lines[idx++] = li;
        M_AddToBox(bbox, li.v1.x, li.v1.y);
        M_AddToBox(bbox, li.v2.x, li.v2.y);
      }
    }
    if (idx !== sector.linecount) I_Error('P_GroupLines: miscounted');
    sector.soundorg.x = ((bbox[BOXRIGHT] + bbox[BOXLEFT]) / 2) | 0;
    sector.soundorg.y = ((bbox[BOXTOP] + bbox[BOXBOTTOM]) / 2) | 0;
    let b;
    b = (bbox[BOXTOP]    - bmaporgy + MAXRADIUS) >> MAPBLOCKSHIFT; sector.blockbox[BOXTOP]    = b >= bmapheight ? bmapheight - 1 : b;
    b = (bbox[BOXBOTTOM] - bmaporgy - MAXRADIUS) >> MAPBLOCKSHIFT; sector.blockbox[BOXBOTTOM] = b < 0 ? 0 : b;
    b = (bbox[BOXRIGHT]  - bmaporgx + MAXRADIUS) >> MAPBLOCKSHIFT; sector.blockbox[BOXRIGHT]  = b >= bmapwidth  ? bmapwidth  - 1 : b;
    b = (bbox[BOXLEFT]   - bmaporgx - MAXRADIUS) >> MAPBLOCKSHIFT; sector.blockbox[BOXLEFT]   = b < 0 ? 0 : b;
  }
}

// ---------- P_SetupLevel ----------
export function P_SetupLevel(episode, map, _playermask, _skill) {
  set_leveltime(0);
  // Find map name (ExMy for Doom 1, MAPxx for Doom 2).
  let lumpname;
  if (gamemode === GameMode_t.commercial) {
    lumpname = (map < 10 ? 'MAP0' : 'MAP') + map;
  } else {
    lumpname = 'E' + episode + 'M' + map;
  }
  const lumpnum = W_GetNumForName(lumpname);
  P_LoadBlockMap(lumpnum + ML_BLOCKMAP);
  P_LoadVertexes(lumpnum + ML_VERTEXES);
  P_LoadSectors(lumpnum + ML_SECTORS);
  P_LoadSideDefs(lumpnum + ML_SIDEDEFS);
  P_LoadLineDefs(lumpnum + ML_LINEDEFS);
  P_LoadSubsectors(lumpnum + ML_SSECTORS);
  P_LoadNodes(lumpnum + ML_NODES);
  P_LoadSegs(lumpnum + ML_SEGS);
  rejectmatrix = W_CacheLumpNum(lumpnum + ML_REJECT, 0);
  P_GroupLines();
  P_LoadThings(lumpnum + ML_THINGS);

  // R_PrecacheLevel + P_SpawnSpecials wire in when those modules exist.
  R_PrecacheLevel();
}
