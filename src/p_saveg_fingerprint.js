// Deterministic identity for the immutable map data underlying a save game.
// Counts remain part of the DTO because they bound the archived world arrays,
// while the digest prevents unrelated same-sized IWAD/PWAD maps from matching.

import {
  ML_THINGS, ML_LINEDEFS, ML_SIDEDEFS, ML_VERTEXES, ML_SEGS,
  ML_SSECTORS, ML_NODES, ML_SECTORS, ML_REJECT, ML_BLOCKMAP,
  SIZEOF_maplinedef_t, SIZEOF_mapsidedef_t, SIZEOF_mapsector_t,
} from './doomdata.js';
import { M_SHA256Hex } from './m_sha256.js';
import { W_CacheLumpNum } from './w_wad.js';

export const MAP_FINGERPRINT_VERSION = 1;
export const MAP_FINGERPRINT_ALGORITHM = 'sha256';

const MAP_LUMP_OFFSETS = Object.freeze([
  ML_THINGS,
  ML_LINEDEFS,
  ML_SIDEDEFS,
  ML_VERTEXES,
  ML_SEGS,
  ML_SSECTORS,
  ML_NODES,
  ML_SECTORS,
  ML_REJECT,
  ML_BLOCKMAP,
]);

// Domain separation ensures this digest cannot be confused with a plain hash
// of concatenated lump bytes. Each length is framed so lump boundaries matter.
const DIGEST_DOMAIN = new Uint8Array([
  0x6c, 0x69, 0x6e, 0x75, 0x78, 0x64, 0x6f, 0x6f, 0x6d, 0x2d,
  0x6a, 0x73, 0x2d, 0x6d, 0x61, 0x70, 0x2d, 0x76, 0x31, 0x00,
]);
const fingerprintCache = new WeakMap();

function byteView(value, index) {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new TypeError(`map lump ${index} has no readable byte buffer`);
}

function exactRecordCount(bytes, recordSize, name) {
  if (bytes.byteLength % recordSize !== 0) {
    throw new TypeError(`${name} lump length ${bytes.byteLength} is not divisible by ${recordSize}`);
  }
  return bytes.byteLength / recordSize;
}

export function P_MapContentDigest(sources) {
  if (!Array.isArray(sources) || sources.length !== MAP_LUMP_OFFSETS.length) {
    throw new TypeError(`map fingerprint needs ${MAP_LUMP_OFFSETS.length} lumps`);
  }
  const lumps = sources.map((source, index) => byteView(source, index));
  const totalLength = lumps.reduce(
    (total, lump) => total + 5 + lump.byteLength,
    DIGEST_DOMAIN.byteLength,
  );
  const framed = new Uint8Array(totalLength);
  framed.set(DIGEST_DOMAIN);
  const view = new DataView(framed.buffer);
  let offset = DIGEST_DOMAIN.byteLength;
  for (let i = 0; i < lumps.length; i++) {
    framed[offset++] = MAP_LUMP_OFFSETS[i];
    view.setUint32(offset, lumps[i].byteLength, true);
    offset += 4;
    framed.set(lumps[i], offset);
    offset += lumps[i].byteLength;
  }
  return M_SHA256Hex(framed);
}

export function P_GetMapFingerprintForLump(mapLump) {
  if (!Number.isInteger(mapLump) || mapLump < 0) {
    throw new TypeError('map marker lump must be a non-negative integer');
  }
  // W_CacheLumpNum returns a stable view until the complete WAD set is
  // replaced. Keying by that view reuses the digest for save, preflight, and
  // restore while naturally invalidating it after W_InitMultipleFiles.
  const identityLump = W_CacheLumpNum(mapLump + MAP_LUMP_OFFSETS[0], 0);
  const cached = fingerprintCache.get(identityLump);
  if (cached !== undefined) return cached;
  const lumps = [identityLump];
  for (let i = 1; i < MAP_LUMP_OFFSETS.length; i++) {
    lumps.push(W_CacheLumpNum(mapLump + MAP_LUMP_OFFSETS[i], 0));
  }
  const sectors = exactRecordCount(
    lumps[ML_SECTORS - 1], SIZEOF_mapsector_t, 'SECTORS');
  const lines = exactRecordCount(
    lumps[ML_LINEDEFS - 1], SIZEOF_maplinedef_t, 'LINEDEFS');
  const sides = exactRecordCount(
    lumps[ML_SIDEDEFS - 1], SIZEOF_mapsidedef_t, 'SIDEDEFS');
  const fingerprint = Object.freeze({
    version: MAP_FINGERPRINT_VERSION,
    algorithm: MAP_FINGERPRINT_ALGORITHM,
    digest: P_MapContentDigest(lumps),
    sectors,
    lines,
    sides,
  });
  fingerprintCache.set(identityLump, fingerprint);
  return fingerprint;
}

export function P_MapFingerprintsEqual(a, b) {
  return a !== null && a !== undefined && b !== null && b !== undefined &&
    a.version === MAP_FINGERPRINT_VERSION && b.version === MAP_FINGERPRINT_VERSION &&
    a.algorithm === MAP_FINGERPRINT_ALGORITHM && b.algorithm === MAP_FINGERPRINT_ALGORITHM &&
    a.digest === b.digest &&
    a.sectors === b.sectors && a.lines === b.lines && a.sides === b.sides;
}
