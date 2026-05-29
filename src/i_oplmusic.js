// Ported from: Chocolate Doom src/i_oplmusic.c (OPL playback core) + opl/opl.c
// (OPL_InitRegisters). Drives the DBOPL emulator with GENMIDI instrument data
// to reproduce Doom's original OPL2 FM music.
//
// This is the "Option B" path: rather than Chocolate Doom's MUS->MIDI->OPL
// pipeline, we drive the OPL core directly from MUS events (see the MUS reader
// that follows). DMX itself worked on MUS data internally and indexed channels
// by MUS channel number (channel 15 = percussion) — the i_oplmusic comment
// "Because DMX works on MUS data internally" confirms this — so we index the
// channel table by raw MUS channel, which matches DMX more directly than the
// reference's MIDI roundtrip.
//
// We run the chip in OPL2 mode (9 voices, mono), the classic AdLib / Sound
// Blaster configuration Doom's music was authored for.

import { DBOPLChip } from './dbopl.js';
import { GENMIDI_Load, GENMIDI_FLAG_FIXED, GENMIDI_FLAG_2VOICE } from './genmidi.js';

// --- OPL register constants (opl/opl.h) ---
const OPL_NUM_VOICES    = 9;
const OPL_NUM_OPERATORS = 21;
const OPL_REGS_TREMOLO  = 0x20;
const OPL_REGS_LEVEL    = 0x40;
const OPL_REGS_ATTACK   = 0x60;
const OPL_REGS_SUSTAIN  = 0x80;
const OPL_REGS_WAVEFORM  = 0xe0;
const OPL_REGS_FREQ_1    = 0xa0;
const OPL_REGS_FREQ_2    = 0xb0;
const OPL_REGS_FEEDBACK  = 0xc0;
const OPL_REG_WAVEFORM_ENABLE = 0x01;
const OPL_REG_TIMER_CTRL      = 0x04;
const OPL_REG_FM_MODE         = 0x08;
const OPL_REG_NEW             = 0x105;

// --- MIDI controller numbers we act on (midifile.h) ---
const MIDI_CONTROLLER_VOLUME_MSB    = 0x07;
const MIDI_CONTROLLER_PAN           = 0x0a;
const MIDI_CONTROLLER_ALL_NOTES_OFF = 0x7b;
const MIDI_CHANNELS_PER_TRACK = 16;

// Operators used by the different voices (i_oplmusic.c voice_operators[2][9]).
const voice_operators = [
  [0x00, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x10, 0x11, 0x12],
  [0x03, 0x04, 0x05, 0x0b, 0x0c, 0x0d, 0x13, 0x14, 0x15],
];

// Frequency values for each note (i_oplmusic.c frequency_curve[], 668 entries
// — extracted verbatim from the reference). Indexed directly for freq_index
// < 284, and via sub_index+284 for the looped higher-octave range.
const frequency_curve = [
  0x133,0x133,0x134,0x134,0x135,0x136,0x136,0x137,0x137,0x138,0x138,0x139,0x139,0x13a,0x13b,0x13b,
  0x13c,0x13c,0x13d,0x13d,0x13e,0x13f,0x13f,0x140,0x140,0x141,0x142,0x142,0x143,0x143,0x144,0x144,
  0x145,0x146,0x146,0x147,0x147,0x148,0x149,0x149,0x14a,0x14a,0x14b,0x14c,0x14c,0x14d,0x14d,0x14e,
  0x14f,0x14f,0x150,0x150,0x151,0x152,0x152,0x153,0x153,0x154,0x155,0x155,0x156,0x157,0x157,0x158,
  0x158,0x159,0x15a,0x15a,0x15b,0x15b,0x15c,0x15d,0x15d,0x15e,0x15f,0x15f,0x160,0x161,0x161,0x162,
  0x162,0x163,0x164,0x164,0x165,0x166,0x166,0x167,0x168,0x168,0x169,0x16a,0x16a,0x16b,0x16c,0x16c,
  0x16d,0x16e,0x16e,0x16f,0x170,0x170,0x171,0x172,0x172,0x173,0x174,0x174,0x175,0x176,0x176,0x177,
  0x178,0x178,0x179,0x17a,0x17a,0x17b,0x17c,0x17c,0x17d,0x17e,0x17e,0x17f,0x180,0x181,0x181,0x182,
  0x183,0x183,0x184,0x185,0x185,0x186,0x187,0x188,0x188,0x189,0x18a,0x18a,0x18b,0x18c,0x18d,0x18d,
  0x18e,0x18f,0x18f,0x190,0x191,0x192,0x192,0x193,0x194,0x194,0x195,0x196,0x197,0x197,0x198,0x199,
  0x19a,0x19a,0x19b,0x19c,0x19d,0x19d,0x19e,0x19f,0x1a0,0x1a0,0x1a1,0x1a2,0x1a3,0x1a3,0x1a4,0x1a5,
  0x1a6,0x1a6,0x1a7,0x1a8,0x1a9,0x1a9,0x1aa,0x1ab,0x1ac,0x1ad,0x1ad,0x1ae,0x1af,0x1b0,0x1b0,0x1b1,
  0x1b2,0x1b3,0x1b4,0x1b4,0x1b5,0x1b6,0x1b7,0x1b8,0x1b8,0x1b9,0x1ba,0x1bb,0x1bc,0x1bc,0x1bd,0x1be,
  0x1bf,0x1c0,0x1c0,0x1c1,0x1c2,0x1c3,0x1c4,0x1c4,0x1c5,0x1c6,0x1c7,0x1c8,0x1c9,0x1c9,0x1ca,0x1cb,
  0x1cc,0x1cd,0x1ce,0x1ce,0x1cf,0x1d0,0x1d1,0x1d2,0x1d3,0x1d3,0x1d4,0x1d5,0x1d6,0x1d7,0x1d8,0x1d8,
  0x1d9,0x1da,0x1db,0x1dc,0x1dd,0x1de,0x1de,0x1df,0x1e0,0x1e1,0x1e2,0x1e3,0x1e4,0x1e5,0x1e5,0x1e6,
  0x1e7,0x1e8,0x1e9,0x1ea,0x1eb,0x1ec,0x1ed,0x1ed,0x1ee,0x1ef,0x1f0,0x1f1,0x1f2,0x1f3,0x1f4,0x1f5,
  0x1f6,0x1f6,0x1f7,0x1f8,0x1f9,0x1fa,0x1fb,0x1fc,0x1fd,0x1fe,0x1ff,0x200,0x201,0x201,0x202,0x203,
  0x204,0x205,0x206,0x207,0x208,0x209,0x20a,0x20b,0x20c,0x20d,0x20e,0x20f,0x210,0x210,0x211,0x212,
  0x213,0x214,0x215,0x216,0x217,0x218,0x219,0x21a,0x21b,0x21c,0x21d,0x21e,0x21f,0x220,0x221,0x222,
  0x223,0x224,0x225,0x226,0x227,0x228,0x229,0x22a,0x22b,0x22c,0x22d,0x22e,0x22f,0x230,0x231,0x232,
  0x233,0x234,0x235,0x236,0x237,0x238,0x239,0x23a,0x23b,0x23c,0x23d,0x23e,0x23f,0x240,0x241,0x242,
  0x244,0x245,0x246,0x247,0x248,0x249,0x24a,0x24b,0x24c,0x24d,0x24e,0x24f,0x250,0x251,0x252,0x253,
  0x254,0x256,0x257,0x258,0x259,0x25a,0x25b,0x25c,0x25d,0x25e,0x25f,0x260,0x262,0x263,0x264,0x265,
  0x266,0x267,0x268,0x269,0x26a,0x26c,0x26d,0x26e,0x26f,0x270,0x271,0x272,0x273,0x275,0x276,0x277,
  0x278,0x279,0x27a,0x27b,0x27d,0x27e,0x27f,0x280,0x281,0x282,0x284,0x285,0x286,0x287,0x288,0x289,
  0x28b,0x28c,0x28d,0x28e,0x28f,0x290,0x292,0x293,0x294,0x295,0x296,0x298,0x299,0x29a,0x29b,0x29c,
  0x29e,0x29f,0x2a0,0x2a1,0x2a2,0x2a4,0x2a5,0x2a6,0x2a7,0x2a9,0x2aa,0x2ab,0x2ac,0x2ae,0x2af,0x2b0,
  0x2b1,0x2b2,0x2b4,0x2b5,0x2b6,0x2b7,0x2b9,0x2ba,0x2bb,0x2bd,0x2be,0x2bf,0x2c0,0x2c2,0x2c3,0x2c4,
  0x2c5,0x2c7,0x2c8,0x2c9,0x2cb,0x2cc,0x2cd,0x2ce,0x2d0,0x2d1,0x2d2,0x2d4,0x2d5,0x2d6,0x2d8,0x2d9,
  0x2da,0x2dc,0x2dd,0x2de,0x2e0,0x2e1,0x2e2,0x2e4,0x2e5,0x2e6,0x2e8,0x2e9,0x2ea,0x2ec,0x2ed,0x2ee,
  0x2f0,0x2f1,0x2f2,0x2f4,0x2f5,0x2f6,0x2f8,0x2f9,0x2fb,0x2fc,0x2fd,0x2ff,0x300,0x302,0x303,0x304,
  0x306,0x307,0x309,0x30a,0x30b,0x30d,0x30e,0x310,0x311,0x312,0x314,0x315,0x317,0x318,0x31a,0x31b,
  0x31c,0x31e,0x31f,0x321,0x322,0x324,0x325,0x327,0x328,0x329,0x32b,0x32c,0x32e,0x32f,0x331,0x332,
  0x334,0x335,0x337,0x338,0x33a,0x33b,0x33d,0x33e,0x340,0x341,0x343,0x344,0x346,0x347,0x349,0x34a,
  0x34c,0x34d,0x34f,0x350,0x352,0x353,0x355,0x357,0x358,0x35a,0x35b,0x35d,0x35e,0x360,0x361,0x363,
  0x365,0x366,0x368,0x369,0x36b,0x36c,0x36e,0x370,0x371,0x373,0x374,0x376,0x378,0x379,0x37b,0x37c,
  0x37e,0x380,0x381,0x383,0x384,0x386,0x388,0x389,0x38b,0x38d,0x38e,0x390,0x392,0x393,0x395,0x397,
  0x398,0x39a,0x39c,0x39d,0x39f,0x3a1,0x3a2,0x3a4,0x3a6,0x3a7,0x3a9,0x3ab,0x3ac,0x3ae,0x3b0,0x3b1,
  0x3b3,0x3b5,0x3b7,0x3b8,0x3ba,0x3bc,0x3bd,0x3bf,0x3c1,0x3c3,0x3c4,0x3c6,0x3c8,0x3ca,0x3cb,0x3cd,
  0x3cf,0x3d1,0x3d2,0x3d4,0x3d6,0x3d8,0x3da,0x3db,0x3dd,0x3df,0x3e1,0x3e3,0x3e4,0x3e6,0x3e8,0x3ea,
  0x3ec,0x3ed,0x3ef,0x3f1,0x3f3,0x3f5,0x3f6,0x3f8,0x3fa,0x3fc,0x3fe,0x36c,
];

// Mapping from MIDI volume level to OPL level value (i_oplmusic.c).
const volume_mapping_table = [
  0,1,3,5,6,8,10,11,13,14,16,17,19,20,22,23,
  25,26,27,29,30,32,33,34,36,37,39,41,43,45,47,49,
  50,52,54,55,57,59,60,61,63,64,66,67,68,69,71,72,
  73,74,75,76,77,79,80,81,82,83,84,84,85,86,87,88,
  89,90,91,92,92,93,94,95,96,96,97,98,99,99,100,101,
  101,102,103,103,104,105,105,106,107,107,108,109,109,110,110,111,
  112,112,113,113,114,114,115,115,116,117,117,118,118,119,119,120,
  120,121,121,122,122,123,123,123,124,124,125,125,126,126,127,127,
];

// --- State ---
let chip = null;
const opl_opl3mode = 0;
const num_opl_voices = OPL_NUM_VOICES;

let voices = [];                 // opl_voice_t[num_opl_voices]
let voice_free_list = [];        // refs
let voice_alloced_list = [];     // refs
let voice_free_num = 0;
let voice_alloced_num = 0;

let channels = [];               // opl_channel_data_t[16]
let main_instrs = null;          // genmidi main[128]
let percussion_instrs = null;    // genmidi percussion[47]

let current_music_volume = 127;
let start_music_volume = 127;

function writeReg(reg, val) { chip.writeReg(reg, val); }

// opl/opl.c:OPL_InitRegisters — Doom's chip reset sequence (OPL2: opl3=0).
function OPL_InitRegisters(opl3) {
  let r;
  for (r = OPL_REGS_LEVEL; r <= OPL_REGS_LEVEL + OPL_NUM_OPERATORS; ++r) writeReg(r, 0x3f);
  for (r = OPL_REGS_ATTACK; r <= OPL_REGS_WAVEFORM + OPL_NUM_OPERATORS; ++r) writeReg(r, 0x00);
  for (r = 1; r < OPL_REGS_LEVEL; ++r) writeReg(r, 0x00);
  // Reset both timers and enable interrupts:
  writeReg(OPL_REG_TIMER_CTRL, 0x60);
  writeReg(OPL_REG_TIMER_CTRL, 0x80);
  // Allow FM chips to control the waveform of each operator:
  writeReg(OPL_REG_WAVEFORM_ENABLE, 0x20);
  if (opl3) {
    writeReg(OPL_REG_NEW, 0x01);
    for (r = OPL_REGS_LEVEL; r <= OPL_REGS_LEVEL + OPL_NUM_OPERATORS; ++r) writeReg(r | 0x100, 0x3f);
    for (r = OPL_REGS_ATTACK; r <= OPL_REGS_WAVEFORM + OPL_NUM_OPERATORS; ++r) writeReg(r | 0x100, 0x00);
    for (r = 1; r < OPL_REGS_LEVEL; ++r) writeReg(r | 0x100, 0x00);
  }
  writeReg(OPL_REG_FM_MODE, 0x40);
  if (opl3) writeReg(OPL_REG_NEW, 0x01);
}

// --- Voice management ---
function GetFreeVoice() {
  if (voice_free_num === 0) return null;
  const result = voice_free_list[0];
  voice_free_num--;
  for (let i = 0; i < voice_free_num; i++) voice_free_list[i] = voice_free_list[i + 1];
  voice_alloced_list[voice_alloced_num++] = result;
  return result;
}

function ReleaseVoice(index) {
  // Doom 2 1.666 OPL crash emulation.
  if (index >= voice_alloced_num) {
    voice_alloced_num = 0;
    voice_free_num = 0;
    return;
  }
  const voice = voice_alloced_list[index];
  VoiceKeyOff(voice);
  voice.channel = null;
  voice.note = 0;
  // (double-voice recursive release only applies to opl_drv_ver < opl_doom_1_9;
  //  we run as opl_doom_1_9, so it never triggers.)
  voice_alloced_num--;
  for (let i = index; i < voice_alloced_num; i++) voice_alloced_list[i] = voice_alloced_list[i + 1];
  voice_free_list[voice_free_num++] = voice;
}

// Returns the combined scale/level register value (C's `*volume` out-param).
function LoadOperatorData(operator, data, max_level) {
  let level = data.scale;
  if (max_level) level |= 0x3f;
  else           level |= data.level;
  writeReg(OPL_REGS_LEVEL + operator, level);
  writeReg(OPL_REGS_TREMOLO + operator, data.tremolo);
  writeReg(OPL_REGS_ATTACK + operator, data.attack);
  writeReg(OPL_REGS_SUSTAIN + operator, data.sustain);
  writeReg(OPL_REGS_WAVEFORM + operator, data.waveform);
  return level;
}

function SetVoiceInstrument(voice, instr, instr_voice) {
  if (voice.current_instr === instr && voice.current_instr_voice === instr_voice) return;
  voice.current_instr = instr;
  voice.current_instr_voice = instr_voice;
  const data = instr.voices[instr_voice];
  const modulating = (data.feedback & 0x01) === 0;
  // Doom loads the carrier first, then the modulator.
  voice.car_volume = LoadOperatorData(voice.op2 | voice.array, data.carrier, true);
  voice.mod_volume = LoadOperatorData(voice.op1 | voice.array, data.modulator, !modulating);
  writeReg((OPL_REGS_FEEDBACK + voice.index) | voice.array, data.feedback | voice.reg_pan);
  voice.priority = 0x0f - (data.carrier.attack >> 4) + 0x0f - (data.carrier.sustain & 0x0f);
}

function SetVoiceVolume(voice, volume) {
  voice.note_volume = volume;
  const opl_voice = voice.current_instr.voices[voice.current_instr_voice];
  const midi_volume = 2 * (volume_mapping_table[voice.channel.volume] + 1);
  const full_volume = (volume_mapping_table[voice.note_volume] * midi_volume) >> 9;
  const car_volume = 0x3f - full_volume;
  if (car_volume !== (voice.car_volume & 0x3f)) {
    voice.car_volume = car_volume | (voice.car_volume & 0xc0);
    writeReg((OPL_REGS_LEVEL + voice.op2) | voice.array, voice.car_volume);
    if ((opl_voice.feedback & 0x01) !== 0 && opl_voice.modulator.level !== 0x3f) {
      let mod_volume = opl_voice.modulator.level;
      if (mod_volume < car_volume) mod_volume = car_volume;
      mod_volume |= voice.mod_volume & 0xc0;
      if (mod_volume !== voice.mod_volume) {
        voice.mod_volume = mod_volume;
        writeReg((OPL_REGS_LEVEL + voice.op1) | voice.array,
                 mod_volume | (opl_voice.modulator.scale & 0xc0));
      }
    }
  }
}

function SetVoicePan(voice, pan) {
  voice.reg_pan = pan;
  const opl_voice = voice.current_instr.voices[voice.current_instr_voice];
  writeReg((OPL_REGS_FEEDBACK + voice.index) | voice.array, opl_voice.feedback | pan);
}

function InitVoices() {
  voice_free_num = num_opl_voices;
  voice_alloced_num = 0;
  voices = new Array(num_opl_voices);
  voice_free_list = new Array(num_opl_voices);
  voice_alloced_list = new Array(num_opl_voices * 2);
  for (let i = 0; i < num_opl_voices; ++i) {
    voices[i] = {
      index: i % OPL_NUM_VOICES,
      op1: voice_operators[0][i % OPL_NUM_VOICES],
      op2: voice_operators[1][i % OPL_NUM_VOICES],
      array: (Math.floor(i / OPL_NUM_VOICES)) << 8,
      current_instr: null,
      current_instr_voice: 0,
      channel: null,
      key: 0, note: 0, freq: 0, note_volume: 0,
      car_volume: 0, mod_volume: 0, reg_pan: 0, priority: 0,
    };
    voice_free_list[i] = voices[i];
  }
}

function VoiceKeyOff(voice) {
  writeReg((OPL_REGS_FREQ_2 + voice.index) | voice.array, voice.freq >> 8);
}

// --- Channel / note events (driven directly by the MUS reader) ---
function channelForNum(channel_num) { return channels[channel_num]; }

function KeyOffEvent(channel_num, key) {
  const channel = channelForNum(channel_num);
  for (let i = 0; i < voice_alloced_num; i++) {
    if (voice_alloced_list[i].channel === channel && voice_alloced_list[i].key === key) {
      ReleaseVoice(i);
      i--;
    }
  }
}

function ReplaceExistingVoice() {
  let result = 0;
  for (let i = 0; i < voice_alloced_num; i++) {
    if (voice_alloced_list[i].current_instr_voice !== 0
     || voice_alloced_list[i].channel.num >= voice_alloced_list[result].channel.num) {
      result = i;
    }
  }
  ReleaseVoice(result);
}

function FrequencyForVoice(voice) {
  let note = voice.note;
  const gm_voice = voice.current_instr.voices[voice.current_instr_voice];
  if ((voice.current_instr.flags & GENMIDI_FLAG_FIXED) === 0) {
    note += gm_voice.baseNoteOffset; // baseNoteOffset is already signed
  }
  while (note < 0) note += 12;
  while (note > 95) note -= 12;
  let freq_index = 64 + 32 * note + voice.channel.bend;
  if (voice.current_instr_voice !== 0) {
    freq_index += ((voice.current_instr.fineTuning / 2) | 0) - 64;
  }
  if (freq_index < 0) freq_index = 0;
  if (freq_index < 284) return frequency_curve[freq_index];
  const sub_index = (freq_index - 284) % (12 * 32);
  let octave = ((freq_index - 284) / (12 * 32)) | 0;
  if (octave >= 7) octave = 7;
  return frequency_curve[sub_index + 284] | (octave << 10);
}

function UpdateVoiceFrequency(voice) {
  const freq = FrequencyForVoice(voice);
  if (voice.freq !== freq) {
    writeReg((OPL_REGS_FREQ_1 + voice.index) | voice.array, freq & 0xff);
    writeReg((OPL_REGS_FREQ_2 + voice.index) | voice.array, (freq >> 8) | 0x20);
    voice.freq = freq;
  }
}

function VoiceKeyOn(channel, instrument, instrument_voice, note, key, volume) {
  const voice = GetFreeVoice();
  if (voice === null) return;
  voice.channel = channel;
  voice.key = key;
  if ((instrument.flags & GENMIDI_FLAG_FIXED) !== 0) voice.note = instrument.fixedNote;
  else                                               voice.note = note;
  voice.reg_pan = channel.pan;
  SetVoiceInstrument(voice, instrument, instrument_voice);
  SetVoiceVolume(voice, volume);
  voice.freq = 0;
  UpdateVoiceFrequency(voice);
}

// channel_num is the raw MUS channel; 15 is percussion (matching DMX).
function KeyOnEvent(channel_num, key, volume) {
  let note = key;
  if (volume <= 0) { KeyOffEvent(channel_num, key); return; }
  const channel = channelForNum(channel_num);
  let instrument;
  if (channel_num === 15) {
    if (key < 35 || key > 81) return;
    instrument = percussion_instrs[key - 35];
    note = 60;
  } else {
    instrument = channel.instrument;
  }
  const double_voice = (instrument.flags & GENMIDI_FLAG_2VOICE) !== 0;
  // opl_doom_1_9 voice-allocation path.
  if (voice_free_num === 0) ReplaceExistingVoice();
  VoiceKeyOn(channel, instrument, 0, note, key, volume);
  if (double_voice) VoiceKeyOn(channel, instrument, 1, note, key, volume);
}

function ProgramChangeEvent(channel_num, instrument) {
  channels[channel_num].instrument = main_instrs[instrument];
}

function SetChannelVolume(channel, volume, clip_start) {
  channel.volume_base = volume;
  if (volume > current_music_volume) volume = current_music_volume;
  if (clip_start && volume > start_music_volume) volume = start_music_volume;
  channel.volume = volume;
  for (let i = 0; i < num_opl_voices; ++i) {
    if (voices[i].channel === channel) SetVoiceVolume(voices[i], voices[i].note_volume);
  }
}

function SetChannelPan(channel, pan) {
  if (!opl_opl3mode) return; // OPL2: panning has no effect
  let reg_pan;
  if (pan >= 96) reg_pan = 0x10;
  else if (pan <= 48) reg_pan = 0x20;
  else reg_pan = 0x30;
  if (channel.pan !== reg_pan) {
    channel.pan = reg_pan;
    for (let i = 0; i < num_opl_voices; i++) {
      if (voices[i].channel === channel) SetVoicePan(voices[i], reg_pan);
    }
  }
}

function AllNotesOff(channel) {
  for (let i = 0; i < voice_alloced_num; i++) {
    if (voice_alloced_list[i].channel === channel) { ReleaseVoice(i); i--; }
  }
}

function ControllerEvent(channel_num, controller, param) {
  const channel = channelForNum(channel_num);
  switch (controller) {
    case MIDI_CONTROLLER_VOLUME_MSB:    SetChannelVolume(channel, param, true); break;
    case MIDI_CONTROLLER_PAN:           SetChannelPan(channel, param); break;
    case MIDI_CONTROLLER_ALL_NOTES_OFF: AllNotesOff(channel); break;
    default: break;
  }
}

// Reusable scratch for PitchBendEvent's voice re-ordering (C uses fixed stack
// arrays voice_updated_list[]/voice_not_updated_list[]; reused to avoid
// allocating on the audio thread for every pitch-wheel event).
const _pbUpdated = new Array(OPL_NUM_VOICES * 2);
const _pbNotUpdated = new Array(OPL_NUM_VOICES * 2);

// param2 is the MIDI pitch-wheel MSB (Doom only uses the MSB).
function PitchBendEvent(channel_num, param2) {
  const channel = channelForNum(channel_num);
  channel.bend = param2 - 64;
  // Re-order voice_alloced_list so updated voices sort after non-updated ones,
  // matching i_oplmusic.c (preserves the voice-stealing order).
  let u = 0, nu = 0;
  for (let i = 0; i < voice_alloced_num; ++i) {
    if (voice_alloced_list[i].channel === channel) {
      UpdateVoiceFrequency(voice_alloced_list[i]);
      _pbUpdated[u++] = voice_alloced_list[i];
    } else {
      _pbNotUpdated[nu++] = voice_alloced_list[i];
    }
  }
  for (let i = 0; i < nu; i++) voice_alloced_list[i] = _pbNotUpdated[i];
  for (let i = 0; i < u; i++) voice_alloced_list[i + nu] = _pbUpdated[i];
}

function InitChannel(channel) {
  channel.instrument = main_instrs[0];
  channel.volume = current_music_volume;
  channel.volume_base = 100;
  if (channel.volume > channel.volume_base) channel.volume = channel.volume_base;
  channel.pan = 0x30;
  channel.bend = 0;
}

// --- Public API ---
export function OPL_InitMusic(sampleRate) {
  _sampleRate = sampleRate;
  _samplesPerTic = sampleRate / MUS_TICRATE;
  chip = new DBOPLChip(sampleRate);
  OPL_InitRegisters(opl_opl3mode);
  InitVoices();
  channels = new Array(MIDI_CHANNELS_PER_TRACK);
  for (let i = 0; i < MIDI_CHANNELS_PER_TRACK; i++) {
    channels[i] = { num: i, instrument: null, volume: 0, volume_base: 0, pan: 0x30, bend: 0 };
  }
}

export function OPL_LoadGenmidi(lump) {
  const g = GENMIDI_Load(lump);
  main_instrs = g.main;
  percussion_instrs = g.percussion;
}

// Reset channels for the start of a song.
export function OPL_ResetChannels() {
  for (let i = 0; i < MIDI_CHANNELS_PER_TRACK; i++) InitChannel(channels[i]);
  start_music_volume = current_music_volume;
}

export function OPL_SetMusicVolume(volume) {
  if (current_music_volume === volume) return;
  current_music_volume = volume;
  for (let i = 0; i < MIDI_CHANNELS_PER_TRACK; ++i) {
    if (i === 15) SetChannelVolume(channels[i], volume, false);
    else          SetChannelVolume(channels[i], channels[i].volume_base, false);
  }
}

// Silence all voices (used on stop/song change).
export function OPL_AllVoicesOff() {
  for (let i = voice_alloced_num - 1; i >= 0; i--) ReleaseVoice(i);
}

// Generate `samples` mono OPL2 samples into the Int32Array `out`.
export function OPL_Generate(out, samples) {
  chip.generate(out, samples);
}

// ===========================================================================
// MUS reader / sequencer (Option B)
//
// Reads MUS lump events directly and drives the OPL core, folding in the
// MUS->MIDI semantic mapping from Chocolate Doom's mus2mid.c (cached
// velocities, controller_map, pitchwheel = key*64 -> MSB, system events). MUS
// runs at a fixed 140 Hz tic rate; we advance the score sample-accurately
// between OPL_Generate() calls so this drops straight into an AudioWorklet.
// ===========================================================================

// mus2mid.c controller_map: MUS controller/system number -> MIDI controller.
const controller_map = [
  0x00, 0x20, 0x01, 0x07, 0x0a, 0x0b, 0x5b, 0x5d,
  0x40, 0x43, 0x78, 0x7b, 0x7e, 0x7f, 0x79,
];

const MUS_TICRATE = 140;

let _sampleRate = 48000;
let _score = null;
let _scoreStart = 0;
let _scoreEnd = 0;
let _scorePos = 0;
const _vel = new Uint8Array(16);     // cached channel velocities (mus2mid)
let _looping = false;
let _playing = false;
let _paused = false;
let _samplesUntilEvent = 0;          // fractional samples until the next event block
let _samplesPerTic = _sampleRate / MUS_TICRATE;
const _scratch = new Int32Array(8192);

// Int32 OPL sample -> float scale. Tuned so a busy song sits below clipping;
// final loudness is set by the music volume + Web Audio gain in the wiring layer.
let OPL_GAIN = 1 / 10240;

function readDelay() {
  let delay = 0, b;
  do { b = _score[_scorePos++]; delay = delay * 128 + (b & 0x7f); } while (b & 0x80);
  return delay;
}

// Process one block of simultaneous MUS events. Returns ticks until the next
// block, or -1 at end-of-score.
function processBlock() {
  for (;;) {
    if (_scorePos >= _scoreEnd) return -1;
    const desc = _score[_scorePos++];
    const type = desc & 0x70;
    const channel = desc & 0x0f;
    if (type === 0x00) {            // release key
      const key = _score[_scorePos++];
      KeyOffEvent(channel, key & 0x7f);
    } else if (type === 0x10) {     // press key
      let key = _score[_scorePos++];
      if (key & 0x80) { _vel[channel] = _score[_scorePos++] & 0x7f; key &= 0x7f; }
      KeyOnEvent(channel, key & 0x7f, _vel[channel]);
    } else if (type === 0x20) {     // pitch wheel
      const b = _score[_scorePos++];
      PitchBendEvent(channel, ((b * 64) >> 7) & 0x7f);
    } else if (type === 0x30) {     // system event (valueless controller)
      const cn = _score[_scorePos++];
      if (cn >= 10 && cn <= 14) ControllerEvent(channel, controller_map[cn], 0);
    } else if (type === 0x40) {     // change controller
      const cn = _score[_scorePos++];
      let val = _score[_scorePos++];
      if (cn === 0) {
        ProgramChangeEvent(channel, val & 0x7f);
      } else if (cn >= 1 && cn <= 9) {
        if (val & 0x80) val = 0x7f; // mus2mid clamps out-of-range controller values
        ControllerEvent(channel, controller_map[cn], val);
      }
    } else if (type === 0x60) {     // score end
      return -1;
    }
    // types 0x50 / 0x70 are unused in MUS — skip with no data bytes.
    if (desc & 0x80) return readDelay();
  }
}

// Register a MUS lump for playback (parse header, locate the score).
export function I_OPL_RegisterSong(lump) {
  const view = new DataView(lump.buffer, lump.byteOffset, lump.byteLength);
  const scoreLen = view.getUint16(4, true);
  const scoreStart = view.getUint16(6, true);
  _score = lump;
  _scoreStart = scoreStart;
  _scoreEnd = scoreStart + scoreLen;
  _scorePos = scoreStart;
}

export function I_OPL_PlaySong(looping) {
  if (_score === null) return;
  _looping = !!looping;
  _scorePos = _scoreStart;
  _vel.fill(127);
  OPL_ResetChannels();
  _samplesUntilEvent = 0;   // process the first block immediately
  _playing = true;
  _paused = false;
}

export function I_OPL_StopSong() {
  _playing = false;
  OPL_AllVoicesOff();
}

export function I_OPL_PauseSong() {
  _paused = true;
  // Vanilla turns off the main instrument voices (not percussion) on pause.
  for (let i = 0; i < num_opl_voices; ++i) {
    if (voices[i].channel !== null && voices[i].channel !== channels[15]) {
      VoiceKeyOff(voices[i]);
    }
  }
}

export function I_OPL_ResumeSong() { _paused = false; }

export function I_OPL_SongPlaying() { return _playing; }

export function I_OPL_SetGain(g) { OPL_GAIN = g; }

// Fill `numSamples` of mono float audio in [-1, 1] into `out` (Float32Array),
// advancing the MUS sequencer sample-accurately and rendering the OPL chip in
// between events.
export function I_OPL_FillBuffer(out, numSamples) {
  let produced = 0;
  let guard = 0;
  while (produced < numSamples) {
    if (_playing && !_paused) {
      // Process any events that are due (delay accumulated below 1 sample).
      while (_samplesUntilEvent < 1) {
        if (++guard > 100000) { _playing = false; break; } // degenerate-song backstop
        const r = processBlock();
        if (r < 0) {
          if (_looping) { _scorePos = _scoreStart; _vel.fill(127); OPL_ResetChannels(); }
          else { _playing = false; break; }
        } else {
          _samplesUntilEvent += r * _samplesPerTic;
        }
      }
    }
    let chunk = numSamples - produced;
    if (_playing && !_paused) {
      const avail = Math.floor(_samplesUntilEvent);
      if (avail < chunk) chunk = avail;
    }
    if (chunk < 1) chunk = 1;
    if (chunk > _scratch.length) chunk = _scratch.length;
    OPL_Generate(_scratch, chunk);
    for (let i = 0; i < chunk; i++) {
      let s = _scratch[i] * OPL_GAIN;
      if (s > 1) s = 1; else if (s < -1) s = -1;
      out[produced + i] = s;
    }
    produced += chunk;
    if (_playing && !_paused) _samplesUntilEvent -= chunk;
  }
}
