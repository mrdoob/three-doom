// Ported from: Chocolate Doom src/i_oplmusic.c (GENMIDI structures + loader).
//
// GENMIDI is the WAD lump that defines the OPL2 FM instrument bank Doom's music
// plays through. Layout:
//   8 bytes   "#OPL_II#" header (DMX does not actually check it)
//   128 x 36  melodic instruments  (GM programs 0..127)
//   47  x 36  percussion instruments (GM percussion notes 35..81)
//   128 x 32  melodic instrument names   (unused at runtime)
//   47  x 32  percussion names           (unused at runtime)
//
// Each instrument is a genmidi_instr_t; each of its two voices is a
// genmidi_voice_t built from two genmidi_op_t operator patches. All multi-byte
// fields are little-endian (WAD byte order), read directly via DataView.

export const GENMIDI_NUM_INSTRS    = 128;
export const GENMIDI_NUM_PERCUSSION = 47;
export const GENMIDI_HEADER         = '#OPL_II#';
export const GENMIDI_FLAG_FIXED  = 0x0001;   // fixed pitch (percussion)
export const GENMIDI_FLAG_2VOICE = 0x0004;   // double voice

const OP_SIZE    = 6;    // genmidi_op_t
const VOICE_SIZE = 16;   // genmidi_voice_t
const INSTR_SIZE = 36;   // genmidi_instr_t

// Parse a GENMIDI lump (Uint8Array) into { main: instr[128], percussion: instr[47] }.
// Each instr: { flags, fineTuning, fixedNote, voices: [voice, voice] }
// Each voice: { modulator: op, feedback, carrier: op, baseNoteOffset }
// Each op:    { tremolo, attack, sustain, waveform, scale, level }
export function GENMIDI_Load(lump) {
  const view = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);

  const readOp = (o) => ({
    tremolo:  lump[o],
    attack:   lump[o + 1],
    sustain:  lump[o + 2],
    waveform: lump[o + 3],
    scale:    lump[o + 4],
    level:    lump[o + 5],
  });
  const readVoice = (o) => ({
    modulator: readOp(o),
    feedback:  lump[o + OP_SIZE],
    carrier:   readOp(o + OP_SIZE + 1),
    // o + 13: unused byte
    baseNoteOffset: view.getInt16(o + 14, true),
  });
  const readInstr = (o) => ({
    flags:      view.getUint16(o, true),
    fineTuning: lump[o + 2],
    fixedNote:  lump[o + 3],
    voices: [readVoice(o + 4), readVoice(o + 4 + VOICE_SIZE)],
  });

  // DMX does not verify the header; skip it the same way (length, not contents).
  let off = GENMIDI_HEADER.length;
  const main = new Array(GENMIDI_NUM_INSTRS);
  for (let i = 0; i < GENMIDI_NUM_INSTRS; i++) { main[i] = readInstr(off); off += INSTR_SIZE; }
  const percussion = new Array(GENMIDI_NUM_PERCUSSION);
  for (let i = 0; i < GENMIDI_NUM_PERCUSSION; i++) { percussion[i] = readInstr(off); off += INSTR_SIZE; }

  return { main, percussion };
}
