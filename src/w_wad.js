// Ported from: linuxdoom-1.10/w_wad.c
// Handles WAD file header, directory, lump I/O.
//
// In the browser, "files" come from fetch() and live as ArrayBuffer. Each
// lumpinfo_t records the source buffer + position rather than a file handle.

import { I_Error } from './i_system.js';

// ---------- Types ----------
// wadinfo_t  { identification: 'IWAD'|'PWAD', numlumps, infotableofs }
// filelump_t { filepos, size, name(8 chars) }
// lumpinfo_t { name, handle (buffer index), position, size }

class lumpinfo_t {
  constructor() {
    this.name     = '';
    this.handle   = -1;   // index into _fileBuffers (-1 = invalid)
    this.position = 0;
    this.size     = 0;
  }
}

// ---------- Globals (exported) ----------
export let lumpinfo  = [];
export let numlumps  = 0;
export let lumpcache = [];

export function set_lumpinfo(v)  { lumpinfo = v; }
export function set_numlumps(v)  { numlumps = v; }

// Raw buffers, indexed by lumpinfo_t.handle.
const _fileBuffers = [];

// ---------- Helpers ----------

function readAsciiName(view, offset) {
  // 8-char null-padded ASCII; uppercase for matching.
  let s = '';
  for (let i = 0; i < 8; i++) {
    const b = view.getUint8(offset + i);
    if (b === 0) break;
    s += String.fromCharCode(b);
  }
  return s.toUpperCase();
}

function extractFileBase(path) {
  // back up to last / or \, then take up to 8 uppercase chars before '.'
  let start = path.length - 1;
  while (start > 0 && path[start - 1] !== '/' && path[start - 1] !== '\\') start--;
  let s = '';
  for (let i = start; i < path.length && path[i] !== '.' && s.length < 8; i++) {
    s += path[i].toUpperCase();
  }
  return s;
}

// ---------- W_AddFile ----------

function W_AddFile(filename, buffer) {
  const startlump = numlumps;
  const view = new DataView(buffer);

  const handle = _fileBuffers.length;
  _fileBuffers.push(buffer);

  let fileinfo;

  // Detect WAD vs single-lump by extension.
  const ext = filename.slice(-3).toLowerCase();
  if (ext !== 'wad') {
    fileinfo = [{ filepos: 0, size: buffer.byteLength, name: extractFileBase(filename) }];
    numlumps++;
  } else {
    const ident = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (ident !== 'IWAD' && ident !== 'PWAD') {
      I_Error(`Wad file ${filename} doesn't have IWAD or PWAD id`);
    }
    const nlumps      = view.getInt32(4, true);
    const infotableofs = view.getInt32(8, true);
    fileinfo = new Array(nlumps);
    for (let i = 0; i < nlumps; i++) {
      const off = infotableofs + i * 16;
      fileinfo[i] = {
        filepos: view.getInt32(off + 0, true),
        size:    view.getInt32(off + 4, true),
        name:    readAsciiName(view, off + 8),
      };
    }
    numlumps += nlumps;
  }

  // Append to lumpinfo array.
  for (let i = startlump; i < numlumps; i++) {
    const fi = fileinfo[i - startlump];
    const li = new lumpinfo_t();
    li.handle   = handle;
    li.position = fi.filepos;
    li.size     = fi.size;
    li.name     = fi.name;
    lumpinfo[i] = li;
  }

  console.log(' adding', filename, '(' + (numlumps - startlump) + ' lumps)');
}

// ---------- W_InitMultipleFiles ----------

// `filespecs` is an array of { name, buffer:ArrayBuffer }.
// (C signature takes an array of paths and reads them itself; in the
// browser the host pre-fetches buffers and hands us both pieces.)
export function W_InitMultipleFiles(filespecs) {
  numlumps = 0;
  lumpinfo = [];

  for (const spec of filespecs) {
    W_AddFile(spec.name, spec.buffer);
  }

  if (numlumps === 0) I_Error('W_InitFiles: no files found');

  lumpcache = new Array(numlumps);
  for (let i = 0; i < numlumps; i++) lumpcache[i] = null;
}

export function W_NumLumps() { return numlumps; }

// ---------- W_CheckNumForName / W_GetNumForName ----------

// Returns -1 if not found.
export function W_CheckNumForName(name) {
  // Uppercase, truncated to 8.
  const target = name.toUpperCase().slice(0, 8);
  // Scan backwards so patch WADs override.
  for (let i = numlumps - 1; i >= 0; i--) {
    if (lumpinfo[i].name === target) return i;
  }
  return -1;
}

export function W_GetNumForName(name) {
  const i = W_CheckNumForName(name);
  if (i === -1) I_Error(`W_GetNumForName: ${name} not found!`);
  return i;
}

// ---------- W_LumpLength / W_ReadLump ----------

export function W_LumpLength(lump) {
  if (lump >= numlumps) I_Error(`W_LumpLength: ${lump} >= numlumps`);
  return lumpinfo[lump].size;
}

// Reads `dest.length` bytes into `dest` (Uint8Array).
export function W_ReadLump(lump, dest) {
  if (lump >= numlumps) I_Error(`W_ReadLump: ${lump} >= numlumps`);
  const l = lumpinfo[lump];
  const src = new Uint8Array(_fileBuffers[l.handle], l.position, l.size);
  dest.set(src.subarray(0, Math.min(dest.length, l.size)));
}

// ---------- W_CacheLumpNum / W_CacheLumpName ----------

// Returns a Uint8Array view into the cached lump bytes. Tag is ignored
// because JS GC handles purging — see z_zone.js.
export function W_CacheLumpNum(lump, _tag) {
  if (lump >>> 0 >= numlumps) I_Error(`W_CacheLumpNum: ${lump} >= numlumps`);
  if (lumpcache[lump] === null) {
    const l = lumpinfo[lump];
    // A view into the file buffer — no copy.
    lumpcache[lump] = new Uint8Array(_fileBuffers[l.handle], l.position, l.size);
  }
  return lumpcache[lump];
}

export function W_CacheLumpName(name, tag) {
  return W_CacheLumpNum(W_GetNumForName(name), tag);
}

// Make available to modules that can't take a synchronous import (e.g.
// g_game.js's G_DoPlayDemo fetching a DEMOn lump on a tic boundary).
if (typeof globalThis !== 'undefined') {
  globalThis.__W_CacheLumpName    = W_CacheLumpName;
  globalThis.__W_CheckNumForName  = (n) => {
    try { return W_GetNumForName(n); } catch { return -1; }
  };
}
