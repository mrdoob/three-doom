// Ported from: linuxdoom-1.10/m_cheat.c
// Cheat sequence checking. The original SCRAMBLE table-obfuscation is preserved
// but the practical wrapper here registers explicit code -> action handlers so
// it slots cleanly into the JS keyboard event path.

import { players, consoleplayer } from './doomstat.js';

function SCRAMBLE(c) { return ((c << 4) & 0xF0) | ((c >> 4) & 0x0F); }
const xlate = new Uint8Array(256);
for (let i = 0; i < 256; i++) xlate[i] = SCRAMBLE(i);

export function makeCheatSeq(seqStr) {
  const bytes = new Uint8Array(seqStr.length + 1);
  for (let i = 0; i < seqStr.length; i++) bytes[i] = xlate[seqStr.charCodeAt(i)];
  bytes[seqStr.length] = 0xff;
  return { sequence: bytes, p: 0 };
}

export function cht_CheckCheat(cht, key) {
  if (cht.sequence[cht.p] === 1) cht.p++;
  if (cht.sequence[cht.p] === 0xff) { cht.p = 0; return 1; }
  if (cht.sequence[cht.p] === xlate[key & 0xff]) {
    cht.p++;
    if (cht.sequence[cht.p] === 0xff) { cht.p = 0; return 1; }
    return 0;
  }
  cht.p = 0;
  return 0;
}

export function cht_GetParam(cht, buffer) {
  let i = 0, j = 0;
  while (cht.sequence[j] !== 1 && j < cht.sequence.length) j++;
  j++;
  while (cht.sequence[j] !== 0xff && j < cht.sequence.length) {
    buffer[i++] = cht.sequence[j];
    cht.sequence[j] = 0;
    j++;
  }
  buffer[i] = 0;
}

// Active cheat sequences (Doom 1).
const cheats = [
  { seq: makeCheatSeq('iddqd'),  apply: (p) => { p.cheats ^= 2 /*CF_GODMODE*/; p.health = p.cheats & 2 ? 100 : p.health; if (p.mo) p.mo.health = p.health; p.message = (p.cheats & 2) ? 'Degreelessness Mode On' : 'Degreelessness Mode Off'; } },
  { seq: makeCheatSeq('idkfa'),  apply: (p) => { p.armorpoints = 200; p.armortype = 2; for (let i = 0; i < 9; i++) p.weaponowned[i] = true; for (let i = 0; i < 4; i++) p.ammo[i] = p.maxammo[i]; for (let i = 0; i < 6; i++) p.cards[i] = true; p.message = 'Very Happy Ammo Added'; } },
  { seq: makeCheatSeq('idfa'),   apply: (p) => { p.armorpoints = 200; p.armortype = 2; for (let i = 0; i < 9; i++) p.weaponowned[i] = true; for (let i = 0; i < 4; i++) p.ammo[i] = p.maxammo[i]; p.message = 'Ammo (No Keys) Added'; } },
  { seq: makeCheatSeq('idclip'), apply: (p) => { p.cheats ^= 1 /*CF_NOCLIP*/; if (p.mo) { if (p.cheats & 1) p.mo.flags |= 0x1000 /*MF_NOCLIP*/; else p.mo.flags &= ~0x1000; } p.message = (p.cheats & 1) ? 'No Clipping Mode On' : 'No Clipping Mode Off'; } },
  { seq: makeCheatSeq('idspispopd'), apply: (p) => { p.cheats ^= 1; if (p.mo) { if (p.cheats & 1) p.mo.flags |= 0x1000; else p.mo.flags &= ~0x1000; } p.message = (p.cheats & 1) ? 'No Clipping Mode On' : 'No Clipping Mode Off'; } },
];

// Driven by keyboard listener — each lowercase letter advances all sequences.
export function cht_HandleKey(charCode) {
  const p = players[consoleplayer];
  if (p === undefined || p === null || p.mo === null) return;
  for (const c of cheats) {
    if (cht_CheckCheat(c.seq, charCode) === 1) {
      c.apply(p);
      console.log('CHEAT:', p.message);
    }
  }
}
