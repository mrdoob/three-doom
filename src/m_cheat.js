// Ported from: linuxdoom-1.10/m_cheat.c
// Cheat sequence checking. The original SCRAMBLE table-obfuscation is preserved
// but the practical wrapper here registers explicit code -> action handlers so
// it slots cleanly into the JS keyboard event path.

import { players, consoleplayer, gamemode } from './doomstat.js';
import { GameMode_t } from './doomdef.js';
import { S_ChangeMusic } from './s_sound.js';
import { mus_runnin, mus_e1m1 } from './sounds.js';
import { STSTR_MUS, STSTR_NOMUS } from './d_englsh.js';

// C macro: bit i of input -> bit j of output. From m_cheat.h:
//   bit 0 -> 7, bit 1 -> 6, bit 2 -> 2, bit 3 -> 4,
//   bit 4 -> 3, bit 5 -> 5, bit 6 -> 1, bit 7 -> 0.
function SCRAMBLE(a) {
  return (
    ((a & 1) << 7) +
    ((a & 2) << 5) +
    (a & 4) +
    ((a & 8) << 1) +
    ((a & 16) >> 1) +
    (a & 32) +
    ((a & 64) >> 5) +
    ((a & 128) >> 7)
  );
}
const xlate = new Uint8Array(256);
for (let i = 0; i < 256; i++) xlate[i] = SCRAMBLE(i);

// paramCount > 0 appends a '1' separator followed by that many zeroed capture
// slots, matching m_cheat.h's parameter encoding (e.g. cheat_mus_seq =
// { ...idmus..., 1, 0, 0, 0xff }). cht_CheckCheat captures the keys typed after
// the sequence into the slots; cht_GetParam reads them back.
export function makeCheatSeq(seqStr, paramCount = 0) {
  const extra = paramCount > 0 ? 1 + paramCount : 0;
  const bytes = new Uint8Array(seqStr.length + extra + 1);
  let i = 0;
  for (; i < seqStr.length; i++) bytes[i] = xlate[seqStr.charCodeAt(i)];
  if (paramCount > 0) {
    bytes[i++] = 1;
    for (let k = 0; k < paramCount; k++) bytes[i++] = 0;
  }
  bytes[i] = 0xff;
  return { sequence: bytes, p: 0 };
}

// Faithful port of m_cheat.c:cht_CheckCheat. The order is:
//   1. If the current slot is 0 (uninitialized parameter slot), capture the
//      raw key into the sequence so cht_GetParam can read it back later.
//   2. Else if the scrambled key matches the current slot, advance.
//   3. Else reset to the start of the sequence.
//   4. Then look at the (possibly advanced) slot: skip past the '1'
//      parameter separator if present, and return success on 0xff terminator.
export function cht_CheckCheat(cht, key) {
  let rc = 0;
  if (cht.sequence[cht.p] === 0) {
    cht.sequence[cht.p] = key & 0xff;
    cht.p++;
  } else if (xlate[key & 0xff] === cht.sequence[cht.p]) {
    cht.p++;
  } else {
    cht.p = 0;
  }
  if (cht.sequence[cht.p] === 1) {
    cht.p++;
  } else if (cht.sequence[cht.p] === 0xff) {
    cht.p = 0;
    rc = 1;
  }
  return rc;
}

// Faithful port of m_cheat.c:cht_GetParam. Walks past the first '1' marker
// then copies stored keys into buffer, zeroing each slot back to the "empty
// parameter" state, until terminator or first zero. Final write null-terminates
// buffer when stopping at 0xff.
export function cht_GetParam(cht, buffer) {
  const seq = cht.sequence;
  let p = 0;
  while (p < seq.length && seq[p] !== 1) p++;
  p++;
  let bi = 0;
  let c;
  do {
    c = seq[p];
    buffer[bi++] = c;
    seq[p] = 0;
    p++;
  } while (c !== 0 && p < seq.length && seq[p] !== 0xff);
  if (p < seq.length && seq[p] === 0xff) buffer[bi] = 0;
}

// Active cheat sequences (Doom 1).
const cheats = [
  { seq: makeCheatSeq('iddqd'),  apply: (p) => { p.cheats ^= 2 /*CF_GODMODE*/; p.health = p.cheats & 2 ? 100 : p.health; if (p.mo) p.mo.health = p.health; p.message = (p.cheats & 2) ? 'Degreelessness Mode On' : 'Degreelessness Mode Off'; } },
  { seq: makeCheatSeq('idkfa'),  apply: (p) => { p.armorpoints = 200; p.armortype = 2; for (let i = 0; i < 9; i++) p.weaponowned[i] = true; for (let i = 0; i < 4; i++) p.ammo[i] = p.maxammo[i]; for (let i = 0; i < 6; i++) p.cards[i] = true; p.message = 'Very Happy Ammo Added'; } },
  { seq: makeCheatSeq('idfa'),   apply: (p) => { p.armorpoints = 200; p.armortype = 2; for (let i = 0; i < 9; i++) p.weaponowned[i] = true; for (let i = 0; i < 4; i++) p.ammo[i] = p.maxammo[i]; p.message = 'Ammo (No Keys) Added'; } },
  { seq: makeCheatSeq('idclip'), apply: (p) => { p.cheats ^= 1 /*CF_NOCLIP*/; if (p.mo) { if (p.cheats & 1) p.mo.flags |= 0x1000 /*MF_NOCLIP*/; else p.mo.flags &= ~0x1000; } p.message = (p.cheats & 1) ? 'No Clipping Mode On' : 'No Clipping Mode Off'; } },
  { seq: makeCheatSeq('idspispopd'), apply: (p) => { p.cheats ^= 1; if (p.mo) { if (p.cheats & 1) p.mo.flags |= 0x1000; else p.mo.flags &= ~0x1000; } p.message = (p.cheats & 1) ? 'No Clipping Mode On' : 'No Clipping Mode Off'; } },
  // st_stuff.c:595 — 'idmus##' changes music. Doom 1 reads ExMy from the two
  // digits (mus_e1m1 + (d0-'1')*9 + (d1-'1')); commercial reads MAPxx
  // (mus_runnin + d0d1 - 1). Out-of-range prints STSTR_NOMUS.
  { seq: makeCheatSeq('idmus', 2), apply: (p, seq) => {
    const buf = new Uint8Array(3);
    cht_GetParam(seq, buf);
    p.message = STSTR_MUS;
    if (gamemode === GameMode_t.commercial) {
      const n = (buf[0] - 0x30) * 10 + (buf[1] - 0x30);
      if (n > 35) p.message = STSTR_NOMUS;
      else        S_ChangeMusic(mus_runnin + n - 1, 1);
    } else {
      const n = (buf[0] - 0x31) * 9 + (buf[1] - 0x31);
      if (n > 31) p.message = STSTR_NOMUS;
      else        S_ChangeMusic(mus_e1m1 + n, 1);
    }
  } },
];

// Driven by keyboard listener — each lowercase letter advances all sequences.
export function cht_HandleKey(charCode) {
  const p = players[consoleplayer];
  if (p === undefined || p === null || p.mo === null) return;
  for (const c of cheats) {
    if (cht_CheckCheat(c.seq, charCode) === 1) {
      c.apply(p, c.seq);
      console.log('CHEAT:', p.message);
    }
  }
}
