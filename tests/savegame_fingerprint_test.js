import {
  P_GetMapFingerprintForLump,
  P_MapContentDigest,
  P_MapFingerprintsEqual,
} from '../src/p_saveg_fingerprint.js';
import { W_GetNumForName, W_InitMultipleFiles } from '../src/w_wad.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function makeWad(changedThingByte = 0) {
  const lumps = [
    ['E1M1', new Uint8Array()],
    ['THINGS', new Uint8Array(10)],
    ['LINEDEFS', new Uint8Array(14)],
    ['SIDEDEFS', new Uint8Array(30)],
    ['VERTEXES', new Uint8Array(4)],
    ['SEGS', new Uint8Array(12)],
    ['SSECTORS', new Uint8Array(4)],
    ['NODES', new Uint8Array(28)],
    ['SECTORS', new Uint8Array(26)],
    ['REJECT', new Uint8Array(1)],
    ['BLOCKMAP', new Uint8Array(8)],
  ];
  lumps[1][1][0] = changedThingByte;
  const dataLength = lumps.reduce((total, [, bytes]) => total + bytes.byteLength, 0);
  const directoryOffset = 12 + dataLength;
  const wad = new Uint8Array(directoryOffset + lumps.length * 16);
  wad.set([0x50, 0x57, 0x41, 0x44]); // PWAD
  const view = new DataView(wad.buffer);
  view.setInt32(4, lumps.length, true);
  view.setInt32(8, directoryOffset, true);
  let dataOffset = 12;
  for (let i = 0; i < lumps.length; i++) {
    const [name, bytes] = lumps[i];
    wad.set(bytes, dataOffset);
    const entry = directoryOffset + i * 16;
    view.setInt32(entry, dataOffset, true);
    view.setInt32(entry + 4, bytes.byteLength, true);
    for (let j = 0; j < name.length; j++) wad[entry + 8 + j] = name.charCodeAt(j);
    dataOffset += bytes.byteLength;
  }
  return wad;
}

Deno.test('map fingerprint distinguishes same-count PWAD maps by content', () => {
  const firstWad = makeWad(0);
  W_InitMultipleFiles([{ name: 'first.wad', buffer: firstWad }]);
  const first = P_GetMapFingerprintForLump(W_GetNumForName('E1M1'));

  const secondWad = makeWad(1);
  W_InitMultipleFiles([{ name: 'second.wad', buffer: secondWad }]);
  const second = P_GetMapFingerprintForLump(W_GetNumForName('E1M1'));

  assert(first.sectors === second.sectors, 'sector fixture counts differ');
  assert(first.lines === second.lines, 'line fixture counts differ');
  assert(first.sides === second.sides, 'side fixture counts differ');
  assert(first.digest !== second.digest, 'same-count map content produced the same digest');
  assert(!P_MapFingerprintsEqual(first, second), 'different same-count maps matched');
});

Deno.test('map fingerprint framing preserves lump boundaries', () => {
  const first = Array.from({ length: 10 }, () => new Uint8Array());
  const second = Array.from({ length: 10 }, () => new Uint8Array());
  first[0] = new Uint8Array([1]);
  first[1] = new Uint8Array([2]);
  second[0] = new Uint8Array([1, 2]);
  assert(P_MapContentDigest(first) !== P_MapContentDigest(second),
    'equal concatenated bytes with different lump boundaries matched');
});
