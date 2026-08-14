// Ported from: linuxdoom-1.10/w_wad.c
// Handles WAD file header, directory, lump I/O.
//
// In the browser, "files" usually come from fetch() as ArrayBuffers; sliced
// typed-array views are accepted too. Each lumpinfo_t records the source byte
// view + position rather than a file handle.

import { I_Error } from './i_system.js';
import { W_ByteView, W_ParseWadDirectory } from './w_wad_logic.js';

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

// Zero-copy byte views, indexed by lumpinfo_t.handle.
const _fileBuffers = [];

// ---------- Helpers ----------

function extractFileBase(path) {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const basename = path.slice(slash + 1);
  const dot = basename.indexOf('.');
  return (dot < 0 ? basename : basename.slice(0, dot)).toUpperCase().slice(0, 8);
}

// ---------- File decoding ----------

function W_DecodeFile(filename, buffer) {
  let fileinfo;
  let bytes;

  // Detect WAD vs single-lump by extension.
  // Browser asset URLs may carry cache-busting query strings or fragments;
  // classify the pathname, not the raw fetch URL suffix.
  const suffix = filename.search(/[?#]/);
  const assetPath = suffix < 0 ? filename : filename.slice(0, suffix);
  const ext = assetPath.slice(-3).toLowerCase();
  if (ext !== 'wad') {
    bytes = W_ByteView(buffer);
    if (bytes === null) I_Error(`File ${filename} has no readable byte buffer`);
    fileinfo = [{ filepos: 0, size: bytes.byteLength, name: extractFileBase(assetPath) }];
  } else {
    const parsed = W_ParseWadDirectory(buffer);
    if (parsed.valid !== true) I_Error(`Wad file ${filename} is invalid: ${parsed.error}`);
    bytes = parsed.bytes;
    fileinfo = parsed.lumps;
  }

  return { bytes, fileinfo };
}

// ---------- W_InitMultipleFiles ----------

// `filespecs` is an array of { name, buffer:ArrayBuffer|ArrayBufferView }.
// (C signature takes an array of paths and reads them itself; in the
// browser the host pre-fetches buffers and hands us both pieces.)
export function W_InitMultipleFiles(filespecs) {
  const nextBuffers = [];
  const nextLumpinfo = [];
  const additions = [];

  for (const spec of filespecs) {
    const { bytes, fileinfo } = W_DecodeFile(spec.name, spec.buffer);
    const handle = nextBuffers.length;
    nextBuffers.push(bytes);
    additions.push({ name: spec.name, count: fileinfo.length });
    for (const fi of fileinfo) {
      const li = new lumpinfo_t();
      li.handle   = handle;
      li.position = fi.filepos;
      li.size     = fi.size;
      li.name     = fi.name;
      nextLumpinfo.push(li);
    }
  }

  if (nextLumpinfo.length === 0) I_Error('W_InitFiles: no files found');

  // Publish only after every source has validated, so a caught startup error
  // cannot pair a partially replaced directory with the previous lump cache.
  numlumps = nextLumpinfo.length;
  lumpinfo = nextLumpinfo;
  _fileBuffers.length = 0;
  for (const bytes of nextBuffers) _fileBuffers.push(bytes);
  lumpcache = new Array(numlumps);
  for (let i = 0; i < numlumps; i++) lumpcache[i] = null;
  for (const addition of additions) {
    console.log(' adding', addition.name, '(' + addition.count + ' lumps)');
  }
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
  const source = _fileBuffers[l.handle];
  const src = source.subarray(l.position, l.position + l.size);
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
    const source = _fileBuffers[l.handle];
    lumpcache[lump] = source.subarray(l.position, l.position + l.size);
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
