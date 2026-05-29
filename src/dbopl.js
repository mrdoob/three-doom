// Ported from: DOSBox DBOPL (src/hardware/dbopl.cpp r3635) via Chocolate Doom's
// C adaptation (opl/dbopl.c, dbopl.h). A combined Yamaha YMF262 (OPL3) /
// YM3812 (OPL2) FM-synthesis emulator. Doom drives this in OPL2 mode through
// the GENMIDI instrument bank to reproduce the original AdLib/Sound Blaster
// music.
//
// Linuxdoom 1.10 itself has NO music code (its i_sound.c MUSIC API is a stub);
// the original sound came from id's proprietary DMX library feeding the OPL2
// chip. DBOPL is the faithful reverse-engineered emulator of that chip.
//
// Faithfulness notes for the C -> JS port:
//   - DBOPL_WAVE == WAVE_TABLEMUL and ENV_EXTRA == 0 (ENV_BITS == 9), matching
//     the upstream build configuration; the dead WAVE_HANDLER/WAVE_TABLELOG
//     branches are not ported.
//   - The C addresses operators/channels via byte-offset tables and pointer
//     arithmetic (self + 1, ChanOffsetTable[]). We model channels/operators as
//     object arrays and translate the offset tables into channel/operator
//     *index* maps computed by the same formulas.
//   - Function pointers (synthHandler/volHandler) become a stored SynthMode /
//     OperatorState dispatched through Channel__BlockTemplate / TemplateVolume.
//   - 32-bit integer wraparound is reproduced with >>>0 / |0 / Math.imul.

// ---------------------------------------------------------------------------
// Constants (dbopl.c macros)
// ---------------------------------------------------------------------------
const OPLRATE = 14318180.0 / 288.0;
const TREMOLO_TABLE = 52;

const WAVE_BITS = 10;
const WAVE_SH   = 32 - WAVE_BITS;          // 22
const WAVE_MASK = (1 << WAVE_SH) - 1;      // 0x3fffff

const LFO_SH  = WAVE_SH - 10;              // 12
const LFO_MAX = 256 << LFO_SH;             // 0x100000

const ENV_BITS  = 9;
const ENV_MIN   = 0;
const ENV_EXTRA = ENV_BITS - 9;            // 0
const ENV_MAX   = 511 << ENV_EXTRA;        // 511
const ENV_LIMIT = (12 * 256) >> (3 - ENV_EXTRA); // 384
function ENV_SILENT(x) { return x >= ENV_LIMIT; }

const RATE_SH   = 24;
const RATE_MASK = (1 << RATE_SH) - 1;      // 0xffffff
const MUL_SH    = 16;

// chandata shifts
const SHIFT_KSLBASE = 16;
const SHIFT_KEYCODE = 24;

// reg20 masks
const MASK_KSR     = 0x10;
const MASK_SUSTAIN = 0x20;
const MASK_VIBRATO = 0x40;
const MASK_TREMOLO = 0x80;

// OperatorState
const OFF = 0, RELEASE = 1, SUSTAIN = 2, DECAY = 3, ATTACK = 4;

// SynthMode
const sm2AM = 0, sm2FM = 1, sm3AM = 2, sm3FM = 3, sm4Start = 4,
      sm3FMFM = 5, sm3AMFM = 6, sm3FMAM = 7, sm3AMAM = 8, sm6Start = 9,
      sm2Percussion = 10, sm3Percussion = 11;

// ---------------------------------------------------------------------------
// Static const tables (dbopl.c)
// ---------------------------------------------------------------------------
const KslCreateTable = [
  64, 32, 24, 19,
  16, 12, 11, 10,
   8,  6,  5,  4,
   3,  2,  1,  0,
];

// M(x) = x*2
const FreqCreateTable = [
  1, 2, 4, 6, 8, 10, 12, 14,
  16, 18, 20, 20, 24, 24, 30, 30,
];

const AttackSamplesTable = [
  69, 55, 46, 40,
  35, 29, 23, 20,
  19, 15, 11, 10,
  9,
];
const EnvelopeIncreaseTable = [
  4,  5,  6,  7,
  8, 10, 12, 14,
  16, 20, 24, 28,
  32,
];

const WaveBaseTable = [0x000, 0x200, 0x200, 0x800, 0xa00, 0xc00, 0x100, 0x400];
const WaveMaskTable = [1023, 1023, 511, 511, 1023, 1023, 512, 1023];
const WaveStartTable = [512, 0, 0, 0, 0, 512, 512, 256];

// The lower 3 bits are the operator-vibrato shift; the high bit drives the
// -1/0 negation. Stored as signed 8-bit values (JS sign-extends to 32-bit for
// the >>7 and &7 the code does, matching the C Bit8s semantics).
const VibratoTable = [
  1 - 0x00, 0 - 0x00, 1 - 0x00, 30 - 0x00,
  1 - 0x80, 0 - 0x80, 1 - 0x80, 30 - 0x80,
];

const KslShiftTable = [31, 1, 2, 0];

// ---------------------------------------------------------------------------
// Generated tables (DBOPL_InitTables)
// ---------------------------------------------------------------------------
const MulTable     = new Uint16Array(384);
const WaveTable    = new Int16Array(8 * 512);
const KslTable     = new Uint8Array(8 * 16);
const TremoloTable = new Uint8Array(TREMOLO_TABLE);

// Offset tables, translated to index maps:
//   chanForReg[regIndex] = channel index 0..17, or -1 if the register is unused
//   opForReg[regIndex]   = { chan, op } operator location, or null if unused
const chanForReg = new Int8Array(32).fill(-1);
const opForReg   = new Array(64).fill(null);

function EnvelopeSelect(val) {
  // returns [index, shift]
  if (val < 13 * 4) {            // Rate 0 - 12
    return [val & 3, 12 - (val >> 2)];
  } else if (val < 15 * 4) {     // rate 13 - 14
    return [val - 12 * 4, 0];
  } else {                       // rate 15 and up
    return [12, 0];
  }
}

let doneTables = false;
export function DBOPL_InitTables() {
  if (doneTables) return;
  doneTables = true;

  // Multiplication based tables
  for (let i = 0; i < 384; i++) {
    const s = i * 8;
    const val = (0.5 + Math.pow(2.0, -1.0 + (255 - s) * (1.0 / 256)) * (1 << MUL_SH));
    MulTable[i] = val & 0xffff; // (Bit16u) truncation
  }

  // Sine Wave Base
  for (let i = 0; i < 512; i++) {
    WaveTable[0x0200 + i] = Math.trunc(Math.sin((i + 0.5) * (Math.PI / 512.0)) * 4084);
    WaveTable[0x0000 + i] = -WaveTable[0x200 + i];
  }
  // Exponential wave
  for (let i = 0; i < 256; i++) {
    WaveTable[0x700 + i] = Math.trunc(0.5 + Math.pow(2.0, -1.0 + (255 - i * 8) * (1.0 / 256)) * 4085);
    WaveTable[0x6ff - i] = -WaveTable[0x700 + i];
  }
  for (let i = 0; i < 256; i++) {
    // Fill silence gaps
    WaveTable[0x400 + i] = WaveTable[0];
    WaveTable[0x500 + i] = WaveTable[0];
    WaveTable[0x900 + i] = WaveTable[0];
    WaveTable[0xc00 + i] = WaveTable[0];
    WaveTable[0xd00 + i] = WaveTable[0];
    // Replicate sines in other pieces
    WaveTable[0x800 + i] = WaveTable[0x200 + i];
    // double speed sines
    WaveTable[0xa00 + i] = WaveTable[0x200 + i * 2];
    WaveTable[0xb00 + i] = WaveTable[0x000 + i * 2];
    WaveTable[0xe00 + i] = WaveTable[0x200 + i * 2];
    WaveTable[0xf00 + i] = WaveTable[0x200 + i * 2];
  }

  // ksl table
  for (let oct = 0; oct < 8; oct++) {
    const base = oct * 8;
    for (let i = 0; i < 16; i++) {
      let val = base - KslCreateTable[i];
      if (val < 0) val = 0;
      KslTable[oct * 16 + i] = val * 4;
    }
  }
  // Tremolo table (triangle up/down)
  for (let i = 0; i < TREMOLO_TABLE / 2; i++) {
    const val = i << ENV_EXTRA;
    TremoloTable[i] = val;
    TremoloTable[TREMOLO_TABLE - 1 - i] = val;
  }

  // Channel/operator index maps (replacing ChanOffsetTable/OpOffsetTable).
  for (let i = 0; i < 32; i++) {
    let index = i & 0xf;
    if (index >= 9) { chanForReg[i] = -1; continue; }
    if (index < 6) index = (index % 3) * 2 + ((index / 3) | 0);
    if (i >= 16) index += 9;
    chanForReg[i] = index;
  }
  for (let i = 0; i < 64; i++) {
    if (i % 8 >= 6 || (((i / 8) | 0) % 4) === 3) { opForReg[i] = null; continue; }
    let chNum = ((i / 8) | 0) * 3 + (i % 8) % 3;
    if (chNum >= 12) chNum += 16 - 12;
    const opNum = ((i % 8) / 3) | 0;
    const ci = chanForReg[chNum];
    opForReg[i] = (ci < 0) ? null : { chan: ci, op: opNum };
  }
}

// ---------------------------------------------------------------------------
// Operator
// ---------------------------------------------------------------------------
class Operator {
  constructor() {
    this.waveBase = 0;     // index into WaveTable where this wave starts
    this.waveMask = 0;
    this.waveStart = 0;
    this.waveIndex = 0;    // uint32 phase counter (WAVE_BITS in top bits)
    this.waveAdd = 0;      // uint32, base frequency w/o vibrato
    this.waveCurrent = 0;  // uint32, waveAdd + vibrato
    this.chanData = 0;     // uint32
    this.freqMul = 0;
    this.vibrato = 0;      // uint32
    this.sustainLevel = 0;
    this.totalLevel = 0;
    this.currentLevel = 0;
    this.volume = 0;
    this.attackAdd = 0;
    this.decayAdd = 0;
    this.releaseAdd = 0;
    this.rateIndex = 0;    // uint32
    this.rateZero = 0;
    this.keyOn = 0;
    this.reg20 = 0; this.reg40 = 0; this.reg60 = 0; this.reg80 = 0; this.regE0 = 0;
    this.state = 0;
    this.tremoloMask = 0;  // 0 or -1
    this.vibStrength = 0;
    this.ksr = 0;
    Operator__Operator(this);
  }
}

function Operator__UpdateAttack(self, chip) {
  const rate = self.reg60 >> 4;
  if (rate) {
    const val = (rate << 2) + self.ksr;
    self.attackAdd = chip.attackRates[val];
    self.rateZero &= ~(1 << ATTACK);
  } else {
    self.attackAdd = 0;
    self.rateZero |= (1 << ATTACK);
  }
}
function Operator__UpdateDecay(self, chip) {
  const rate = self.reg60 & 0xf;
  if (rate) {
    const val = (rate << 2) + self.ksr;
    self.decayAdd = chip.linearRates[val];
    self.rateZero &= ~(1 << DECAY);
  } else {
    self.decayAdd = 0;
    self.rateZero |= (1 << DECAY);
  }
}
function Operator__UpdateRelease(self, chip) {
  const rate = self.reg80 & 0xf;
  if (rate) {
    const val = (rate << 2) + self.ksr;
    self.releaseAdd = chip.linearRates[val];
    self.rateZero &= ~(1 << RELEASE);
    if (!(self.reg20 & MASK_SUSTAIN)) self.rateZero &= ~(1 << SUSTAIN);
  } else {
    self.rateZero |= (1 << RELEASE);
    self.releaseAdd = 0;
    if (!(self.reg20 & MASK_SUSTAIN)) self.rateZero |= (1 << SUSTAIN);
  }
}
function Operator__UpdateAttenuation(self) {
  const kslBase = (self.chanData >>> SHIFT_KSLBASE) & 0xff;
  const tl = self.reg40 & 0x3f;
  const kslShift = KslShiftTable[self.reg40 >> 6];
  self.totalLevel = tl << (ENV_BITS - 7);            // 2 bits below max
  self.totalLevel += (kslBase << ENV_EXTRA) >>> kslShift;
}
function Operator__UpdateFrequency(self) {
  const freq = self.chanData & ((1 << 10) - 1);
  const block = (self.chanData >>> 10) & 0xff;
  self.waveAdd = ((freq << block) * self.freqMul) >>> 0;
  if (self.reg20 & MASK_VIBRATO) {
    self.vibStrength = (freq >> 7) & 0xff;
    self.vibrato = ((self.vibStrength << block) * self.freqMul) >>> 0;
  } else {
    self.vibStrength = 0;
    self.vibrato = 0;
  }
}
function Operator__UpdateRates(self, chip) {
  let newKsr = (self.chanData >>> SHIFT_KEYCODE) & 0xff;
  if (!(self.reg20 & MASK_KSR)) newKsr >>= 2;
  if (self.ksr === newKsr) return;
  self.ksr = newKsr;
  Operator__UpdateAttack(self, chip);
  Operator__UpdateDecay(self, chip);
  Operator__UpdateRelease(self, chip);
}
function Operator__RateForward(self, add) {
  self.rateIndex = (self.rateIndex + add) >>> 0;
  const ret = self.rateIndex >>> RATE_SH;
  self.rateIndex = self.rateIndex & RATE_MASK;
  return ret;
}

// VolumeHandlerTable / TemplateVolume<state>, dispatched on self.state.
function Operator__TemplateVolume(self, yes) {
  let vol = self.volume;
  let change;
  switch (yes) {
    case OFF:
      return ENV_MAX;
    case ATTACK:
      change = Operator__RateForward(self, self.attackAdd);
      if (!change) return vol;
      vol += (~vol * change) >> 3;
      if (vol < ENV_MIN) {
        self.volume = ENV_MIN;
        self.rateIndex = 0;
        Operator__SetState(self, DECAY);
        return ENV_MIN;
      }
      break;
    case DECAY:
      vol += Operator__RateForward(self, self.decayAdd);
      if (vol >= self.sustainLevel) {
        if (vol >= ENV_MAX) {
          self.volume = ENV_MAX;
          Operator__SetState(self, OFF);
          return ENV_MAX;
        }
        self.rateIndex = 0;
        Operator__SetState(self, SUSTAIN);
      }
      break;
    case SUSTAIN:
      if (self.reg20 & MASK_SUSTAIN) return vol;
      // fall through: sustaining disabled -> regular release
    case RELEASE:
      vol += Operator__RateForward(self, self.releaseAdd);
      if (vol >= ENV_MAX) {
        self.volume = ENV_MAX;
        Operator__SetState(self, OFF);
        return ENV_MAX;
      }
      break;
  }
  self.volume = vol;
  return vol;
}

function Operator__ForwardVolume(self) {
  return self.currentLevel + Operator__TemplateVolume(self, self.state);
}
function Operator__ForwardWave(self) {
  self.waveIndex = (self.waveIndex + self.waveCurrent) >>> 0;
  return self.waveIndex >>> WAVE_SH;
}

function Operator__Write20(self, chip, val) {
  const change = self.reg20 ^ val;
  if (!change) return;
  self.reg20 = val;
  // Spread the tremolo bit across the register (sign of Bit8s val >> 7).
  self.tremoloMask = (((val << 24) >> 24) >> 7) & ~((1 << ENV_EXTRA) - 1);
  if (change & MASK_KSR) Operator__UpdateRates(self, chip);
  if ((self.reg20 & MASK_SUSTAIN) || (!self.releaseAdd)) self.rateZero |= (1 << SUSTAIN);
  else self.rateZero &= ~(1 << SUSTAIN);
  if (change & (0xf | MASK_VIBRATO)) {
    self.freqMul = chip.freqMul[val & 0xf];
    Operator__UpdateFrequency(self);
  }
}
function Operator__Write40(self, chip, val) {
  if (!(self.reg40 ^ val)) return;
  self.reg40 = val;
  Operator__UpdateAttenuation(self);
}
function Operator__Write60(self, chip, val) {
  const change = self.reg60 ^ val;
  self.reg60 = val;
  if (change & 0x0f) Operator__UpdateDecay(self, chip);
  if (change & 0xf0) Operator__UpdateAttack(self, chip);
}
function Operator__Write80(self, chip, val) {
  const change = self.reg80 ^ val;
  if (!change) return;
  self.reg80 = val;
  let sustain = val >> 4;
  sustain |= (sustain + 1) & 0x10;        // turn 0xf into 0x1f
  self.sustainLevel = sustain << (ENV_BITS - 5);
  if (change & 0x0f) Operator__UpdateRelease(self, chip);
}
function Operator__WriteE0(self, chip, val) {
  if (!(self.regE0 ^ val)) return;
  const waveForm = val & ((0x3 & chip.waveFormMask) | (0x7 & chip.opl3Active));
  self.regE0 = val;
  self.waveBase = WaveBaseTable[waveForm];
  self.waveStart = WaveStartTable[waveForm] << WAVE_SH;
  self.waveMask = WaveMaskTable[waveForm];
}
function Operator__SetState(self, s) {
  self.state = s;
}
function Operator__Silent(self) {
  if (!ENV_SILENT(self.totalLevel + self.volume)) return false;
  if (!(self.rateZero & (1 << self.state))) return false;
  return true;
}
function Operator__Prepare(self, chip) {
  self.currentLevel = self.totalLevel + (chip.tremoloValue & self.tremoloMask);
  self.waveCurrent = self.waveAdd;
  if (self.vibStrength >> chip.vibratoShift) {
    let add = self.vibrato >>> chip.vibratoShift;
    const neg = chip.vibratoSign;           // 0 or -1
    add = (add ^ neg) - neg;
    self.waveCurrent = (self.waveCurrent + add) >>> 0;
  }
}
function Operator__KeyOn(self, mask) {
  if (!self.keyOn) {
    self.waveIndex = self.waveStart >>> 0;
    self.rateIndex = 0;
    Operator__SetState(self, ATTACK);
  }
  self.keyOn |= mask;
}
function Operator__KeyOff(self, mask) {
  self.keyOn &= ~mask;
  if (!self.keyOn) {
    if (self.state !== OFF) Operator__SetState(self, RELEASE);
  }
}
function Operator__GetWave(self, index, vol) {
  // WAVE_TABLEMUL, ENV_EXTRA == 0
  return (WaveTable[self.waveBase + (index & self.waveMask)] * MulTable[vol >> ENV_EXTRA]) >> MUL_SH;
}
function Operator__GetSample(self, modulation) {
  const vol = Operator__ForwardVolume(self);
  if (ENV_SILENT(vol)) {
    self.waveIndex = (self.waveIndex + self.waveCurrent) >>> 0;
    return 0;
  } else {
    let index = Operator__ForwardWave(self);
    index = (index + modulation) | 0;
    return Operator__GetWave(self, index, vol);
  }
}
function Operator__Operator(self) {
  self.chanData = 0;
  self.freqMul = 0;
  self.waveIndex = 0;
  self.waveAdd = 0;
  self.waveCurrent = 0;
  self.keyOn = 0;
  self.ksr = 0;
  self.reg20 = 0; self.reg40 = 0; self.reg60 = 0; self.reg80 = 0; self.regE0 = 0;
  Operator__SetState(self, OFF);
  self.rateZero = (1 << OFF);
  self.sustainLevel = ENV_MAX;
  self.currentLevel = ENV_MAX;
  self.totalLevel = ENV_MAX;
  self.volume = ENV_MAX;
  self.releaseAdd = 0;
}

// ---------------------------------------------------------------------------
// Channel
// ---------------------------------------------------------------------------
class Channel {
  constructor() {
    this.op = [new Operator(), new Operator()];
    this.synthMode = sm2FM;
    this.chanData = 0;
    this.old = [0, 0];
    this.feedback = 31;
    this.regB0 = 0;
    this.regC0 = 0;
    this.fourMask = 0;
    this.maskLeft = -1;
    this.maskRight = -1;
  }
}

// Operator addressing: Channel__Op(self, index) in C is
//   &((self + (index>>1))->op[index&1])
// i.e. operator (index&1) of channel (ci + (index>>1)).
function chanOp(chip, ci, index) {
  return chip.chan[ci + (index >> 1)].op[index & 1];
}

function Channel__SetChanData(chip, ci, data) {
  const self = chip.chan[ci];
  const change = self.chanData ^ data;
  self.chanData = data;
  chanOp(chip, ci, 0).chanData = data;
  chanOp(chip, ci, 1).chanData = data;
  Operator__UpdateFrequency(chanOp(chip, ci, 0));
  Operator__UpdateFrequency(chanOp(chip, ci, 1));
  if (change & (0xff << SHIFT_KSLBASE)) {
    Operator__UpdateAttenuation(chanOp(chip, ci, 0));
    Operator__UpdateAttenuation(chanOp(chip, ci, 1));
  }
  if (change & (0xff << SHIFT_KEYCODE)) {
    Operator__UpdateRates(chanOp(chip, ci, 0), chip);
    Operator__UpdateRates(chanOp(chip, ci, 1), chip);
  }
}
function Channel__UpdateFrequency(chip, ci, fourOp) {
  const self = chip.chan[ci];
  let data = self.chanData & 0xffff;
  const kslBase = KslTable[data >> 6];
  let keyCode = (data & 0x1c00) >> 9;
  if (chip.reg08 & 0x40) keyCode |= (data & 0x100) >> 8;  // notesel == 1
  else                   keyCode |= (data & 0x200) >> 9;  // notesel == 0
  data |= (keyCode << SHIFT_KEYCODE) | (kslBase << SHIFT_KSLBASE);
  Channel__SetChanData(chip, ci, data >>> 0);
  if (fourOp & 0x3f) Channel__SetChanData(chip, ci + 1, data >>> 0);
}
function Channel__WriteA0(chip, ci, val) {
  const self = chip.chan[ci];
  const fourOp = chip.reg104 & chip.opl3Active & self.fourMask;
  if (fourOp > 0x80) return;
  const change = (self.chanData ^ val) & 0xff;
  if (change) {
    self.chanData ^= change;
    Channel__UpdateFrequency(chip, ci, fourOp);
  }
}
function Channel__WriteB0(chip, ci, val) {
  const self = chip.chan[ci];
  const fourOp = chip.reg104 & chip.opl3Active & self.fourMask;
  if (fourOp > 0x80) return;
  const change = (self.chanData ^ (val << 8)) & 0x1f00;
  if (change) {
    self.chanData ^= change;
    Channel__UpdateFrequency(chip, ci, fourOp);
  }
  if (!((val ^ self.regB0) & 0x20)) return;
  self.regB0 = val;
  if (val & 0x20) {
    Operator__KeyOn(chanOp(chip, ci, 0), 0x1);
    Operator__KeyOn(chanOp(chip, ci, 1), 0x1);
    if (fourOp & 0x3f) {
      Operator__KeyOn(chanOp(chip, ci + 1, 0), 1);
      Operator__KeyOn(chanOp(chip, ci + 1, 1), 1);
    }
  } else {
    Operator__KeyOff(chanOp(chip, ci, 0), 0x1);
    Operator__KeyOff(chanOp(chip, ci, 1), 0x1);
    if (fourOp & 0x3f) {
      Operator__KeyOff(chanOp(chip, ci + 1, 0), 1);
      Operator__KeyOff(chanOp(chip, ci + 1, 1), 1);
    }
  }
}
function Channel__WriteC0(chip, ci, val) {
  const self = chip.chan[ci];
  const change = val ^ self.regC0;
  if (!change) return;
  self.regC0 = val;
  self.feedback = (val >> 1) & 7;
  if (self.feedback) self.feedback = 9 - self.feedback;  // shift into 10-bit wave index
  else self.feedback = 31;
  if (chip.opl3Active) {
    if ((chip.reg104 & self.fourMask) & 0x3f) {
      let ci0, ci1;
      if (!(self.fourMask & 0x80)) { ci0 = ci; ci1 = ci + 1; }
      else                         { ci0 = ci - 1; ci1 = ci; }
      const synth = ((chip.chan[ci0].regC0 & 1) << 0) | ((chip.chan[ci1].regC0 & 1) << 1);
      switch (synth) {
        case 0: chip.chan[ci0].synthMode = sm3FMFM; break;
        case 1: chip.chan[ci0].synthMode = sm3AMFM; break;
        case 2: chip.chan[ci0].synthMode = sm3FMAM; break;
        case 3: chip.chan[ci0].synthMode = sm3AMAM; break;
      }
    } else if ((self.fourMask & 0x40) && (chip.regBD & 0x20)) {
      // Disable updating percussion channels
    } else if (val & 1) {
      self.synthMode = sm3AM;
    } else {
      self.synthMode = sm3FM;
    }
    self.maskLeft  = (val & 0x10) ? -1 : 0;
    self.maskRight = (val & 0x20) ? -1 : 0;
  } else {
    if ((self.fourMask & 0x40) && (chip.regBD & 0x20)) {
      // Disable updating percussion channels
    } else if (val & 1) {
      self.synthMode = sm2AM;
    } else {
      self.synthMode = sm2FM;
    }
  }
}
function Channel__ResetC0(chip, ci) {
  const self = chip.chan[ci];
  const val = self.regC0;
  self.regC0 ^= 0xff;
  Channel__WriteC0(chip, ci, val);
}

function Channel__GeneratePercussion(chip, ci, output, outIdx, opl3Mode) {
  const self = chip.chan[ci];
  // BassDrum
  let mod = (((self.old[0] + self.old[1]) >>> 0) >>> self.feedback) | 0;
  self.old[0] = self.old[1];
  self.old[1] = Operator__GetSample(chanOp(chip, ci, 0), mod);

  if (self.regC0 & 1) mod = 0;          // AM mode: first operator ignored
  else                mod = self.old[0];
  let sample = Operator__GetSample(chanOp(chip, ci, 1), mod);

  const noiseBit = Chip__ForwardNoise(chip) & 0x1;
  const c2 = Operator__ForwardWave(chanOp(chip, ci, 2));
  const c5 = Operator__ForwardWave(chanOp(chip, ci, 5));
  const phaseBit = (((c2 & 0x88) ^ ((c2 << 5) & 0x80)) | ((c5 ^ (c5 << 2)) & 0x20)) ? 0x02 : 0x00;

  // Hi-Hat
  const hhVol = Operator__ForwardVolume(chanOp(chip, ci, 2));
  if (!ENV_SILENT(hhVol)) {
    const hhIndex = (phaseBit << 8) | (0x34 << (phaseBit ^ (noiseBit << 1)));
    sample += Operator__GetWave(chanOp(chip, ci, 2), hhIndex, hhVol);
  }
  // Snare Drum
  const sdVol = Operator__ForwardVolume(chanOp(chip, ci, 3));
  if (!ENV_SILENT(sdVol)) {
    const sdIndex = (0x100 + (c2 & 0x100)) ^ (noiseBit << 8);
    sample += Operator__GetWave(chanOp(chip, ci, 3), sdIndex, sdVol);
  }
  // Tom-tom
  sample += Operator__GetSample(chanOp(chip, ci, 4), 0);
  // Top-Cymbal
  const tcVol = Operator__ForwardVolume(chanOp(chip, ci, 5));
  if (!ENV_SILENT(tcVol)) {
    const tcIndex = (1 + phaseBit) << 8;
    sample += Operator__GetWave(chanOp(chip, ci, 5), tcIndex, tcVol);
  }
  sample <<= 1;
  if (opl3Mode) {
    output[outIdx]     += sample;
    output[outIdx + 1] += sample;
  } else {
    output[outIdx] += sample;
  }
}

// Returns the next channel index to process (self + 1/2/3).
function Channel__BlockTemplate(chip, ci, samples, output, outBase, mode) {
  const self = chip.chan[ci];
  switch (mode) {
    case sm2AM: case sm3AM:
      if (Operator__Silent(chanOp(chip, ci, 0)) && Operator__Silent(chanOp(chip, ci, 1))) {
        self.old[0] = self.old[1] = 0;
        return ci + 1;
      }
      break;
    case sm2FM: case sm3FM:
      if (Operator__Silent(chanOp(chip, ci, 1))) {
        self.old[0] = self.old[1] = 0;
        return ci + 1;
      }
      break;
    case sm3FMFM:
      if (Operator__Silent(chanOp(chip, ci, 3))) {
        self.old[0] = self.old[1] = 0;
        return ci + 2;
      }
      break;
    case sm3AMFM:
      if (Operator__Silent(chanOp(chip, ci, 0)) && Operator__Silent(chanOp(chip, ci, 3))) {
        self.old[0] = self.old[1] = 0;
        return ci + 2;
      }
      break;
    case sm3FMAM:
      if (Operator__Silent(chanOp(chip, ci, 1)) && Operator__Silent(chanOp(chip, ci, 3))) {
        self.old[0] = self.old[1] = 0;
        return ci + 2;
      }
      break;
    case sm3AMAM:
      if (Operator__Silent(chanOp(chip, ci, 0)) && Operator__Silent(chanOp(chip, ci, 2)) && Operator__Silent(chanOp(chip, ci, 3))) {
        self.old[0] = self.old[1] = 0;
        return ci + 2;
      }
      break;
    // sm2Percussion / sm3Percussion fall through (no silent early-out). NOTE:
    // the haleyjd C conversion guards this switch with `default: abort()`, so it
    // crashes if OPL hardware rhythm mode is ever used. We instead handle the
    // percussion modes (faithful to the original DOSBox GeneratePercussion). It
    // is moot for Doom: GENMIDI percussion are ordinary 2-op voices and the
    // regBD rhythm bit is never set, so this path is never reached in practice.
  }
  // Prepare operators with the current vibrato/tremolo values.
  Operator__Prepare(chanOp(chip, ci, 0), chip);
  Operator__Prepare(chanOp(chip, ci, 1), chip);
  if (mode > sm4Start) {
    Operator__Prepare(chanOp(chip, ci, 2), chip);
    Operator__Prepare(chanOp(chip, ci, 3), chip);
  }
  if (mode > sm6Start) {
    Operator__Prepare(chanOp(chip, ci, 4), chip);
    Operator__Prepare(chanOp(chip, ci, 5), chip);
  }
  for (let i = 0; i < samples; i++) {
    // Early out for percussion handlers
    if (mode === sm2Percussion) {
      Channel__GeneratePercussion(chip, ci, output, outBase + i, false);
      continue;
    } else if (mode === sm3Percussion) {
      Channel__GeneratePercussion(chip, ci, output, outBase + i * 2, true);
      continue;
    }
    const mod = (((self.old[0] + self.old[1]) >>> 0) >>> self.feedback) | 0;
    self.old[0] = self.old[1];
    self.old[1] = Operator__GetSample(chanOp(chip, ci, 0), mod);
    let sample = 0;
    const out0 = self.old[0];
    if (mode === sm2AM || mode === sm3AM) {
      sample = out0 + Operator__GetSample(chanOp(chip, ci, 1), 0);
    } else if (mode === sm2FM || mode === sm3FM) {
      sample = Operator__GetSample(chanOp(chip, ci, 1), out0);
    } else if (mode === sm3FMFM) {
      let next = Operator__GetSample(chanOp(chip, ci, 1), out0);
      next = Operator__GetSample(chanOp(chip, ci, 2), next);
      sample = Operator__GetSample(chanOp(chip, ci, 3), next);
    } else if (mode === sm3AMFM) {
      sample = out0;
      let next = Operator__GetSample(chanOp(chip, ci, 1), 0);
      next = Operator__GetSample(chanOp(chip, ci, 2), next);
      sample += Operator__GetSample(chanOp(chip, ci, 3), next);
    } else if (mode === sm3FMAM) {
      sample = Operator__GetSample(chanOp(chip, ci, 1), out0);
      const next = Operator__GetSample(chanOp(chip, ci, 2), 0);
      sample += Operator__GetSample(chanOp(chip, ci, 3), next);
    } else if (mode === sm3AMAM) {
      sample = out0;
      const next = Operator__GetSample(chanOp(chip, ci, 1), 0);
      sample += Operator__GetSample(chanOp(chip, ci, 2), next);
      sample += Operator__GetSample(chanOp(chip, ci, 3), 0);
    }
    switch (mode) {
      case sm2AM: case sm2FM:
        output[outBase + i] += sample;
        break;
      case sm3AM: case sm3FM: case sm3FMFM: case sm3AMFM: case sm3FMAM: case sm3AMAM:
        output[outBase + i * 2 + 0] += sample & self.maskLeft;
        output[outBase + i * 2 + 1] += sample & self.maskRight;
        break;
    }
  }
  switch (mode) {
    case sm2AM: case sm2FM: case sm3AM: case sm3FM:
      return ci + 1;
    case sm3FMFM: case sm3AMFM: case sm3FMAM: case sm3AMAM:
      return ci + 2;
    case sm2Percussion: case sm3Percussion:
      return ci + 3;
  }
  return ci + 1;
}

// ---------------------------------------------------------------------------
// Chip
// ---------------------------------------------------------------------------
class Chip {
  constructor() {
    this.lfoCounter = 0; this.lfoAdd = 0;
    this.noiseCounter = 0; this.noiseAdd = 0; this.noiseValue = 1;
    this.freqMul = new Uint32Array(16);
    this.linearRates = new Uint32Array(76);
    this.attackRates = new Uint32Array(76);
    this.chan = new Array(18);
    for (let i = 0; i < 18; i++) this.chan[i] = new Channel();
    this.reg104 = 0; this.reg08 = 0; this.reg04 = 0; this.regBD = 0;
    this.vibratoIndex = 0; this.tremoloIndex = 0;
    this.vibratoSign = 0; this.vibratoShift = 0;
    this.tremoloValue = 0; this.vibratoStrength = 0; this.tremoloStrength = 0;
    this.waveFormMask = 0;
    this.opl3Active = 0;
  }
}

function Chip__ForwardNoise(self) {
  self.noiseCounter = (self.noiseCounter + self.noiseAdd) >>> 0;
  let count = self.noiseCounter >>> LFO_SH;
  self.noiseCounter &= WAVE_MASK;
  for (; count > 0; --count) {
    self.noiseValue ^= (0x800302 & (0 - (self.noiseValue & 1)));
    self.noiseValue = self.noiseValue >>> 1;
  }
  return self.noiseValue;
}
function Chip__ForwardLFO(self, samples) {
  self.vibratoSign = VibratoTable[self.vibratoIndex >> 2] >> 7;
  self.vibratoShift = (VibratoTable[self.vibratoIndex >> 2] & 7) + self.vibratoStrength;
  self.tremoloValue = TremoloTable[self.tremoloIndex] >> self.tremoloStrength;

  const todo = LFO_MAX - self.lfoCounter;
  let count = ((todo + self.lfoAdd - 1) / self.lfoAdd) | 0;
  if (count > samples) {
    count = samples;
    self.lfoCounter += count * self.lfoAdd;
  } else {
    self.lfoCounter += count * self.lfoAdd;
    self.lfoCounter &= (LFO_MAX - 1);
    self.vibratoIndex = (self.vibratoIndex + 1) & 31;
    if (self.tremoloIndex + 1 < TREMOLO_TABLE) ++self.tremoloIndex;
    else self.tremoloIndex = 0;
  }
  return count;
}
function Chip__WriteBD(self, val) {
  const change = self.regBD ^ val;
  if (!change) return;
  self.regBD = val;
  self.vibratoStrength = (val & 0x40) ? 0x00 : 0x01;
  self.tremoloStrength = (val & 0x80) ? 0x00 : 0x02;
  if (val & 0x20) {
    if (change & 0x20) {
      self.chan[6].synthMode = self.opl3Active ? sm3Percussion : sm2Percussion;
    }
    // Bass Drum
    if (val & 0x10) { Operator__KeyOn(self.chan[6].op[0], 0x2); Operator__KeyOn(self.chan[6].op[1], 0x2); }
    else            { Operator__KeyOff(self.chan[6].op[0], 0x2); Operator__KeyOff(self.chan[6].op[1], 0x2); }
    // Hi-Hat
    if (val & 0x1) Operator__KeyOn(self.chan[7].op[0], 0x2); else Operator__KeyOff(self.chan[7].op[0], 0x2);
    // Snare
    if (val & 0x8) Operator__KeyOn(self.chan[7].op[1], 0x2); else Operator__KeyOff(self.chan[7].op[1], 0x2);
    // Tom-Tom
    if (val & 0x4) Operator__KeyOn(self.chan[8].op[0], 0x2); else Operator__KeyOff(self.chan[8].op[0], 0x2);
    // Top Cymbal
    if (val & 0x2) Operator__KeyOn(self.chan[8].op[1], 0x2); else Operator__KeyOff(self.chan[8].op[1], 0x2);
  } else if (change & 0x20) {
    Channel__ResetC0(self, 6);
    Operator__KeyOff(self.chan[6].op[0], 0x2); Operator__KeyOff(self.chan[6].op[1], 0x2);
    Operator__KeyOff(self.chan[7].op[0], 0x2); Operator__KeyOff(self.chan[7].op[1], 0x2);
    Operator__KeyOff(self.chan[8].op[0], 0x2); Operator__KeyOff(self.chan[8].op[1], 0x2);
  }
}

export function Chip__WriteReg(self, reg, val) {
  val &= 0xff;
  let index;
  switch ((reg & 0xf0) >> 4) {
    case 0x00 >> 4:
      if (reg === 0x01) {
        self.waveFormMask = (val & 0x20) ? 0x7 : 0x0;
      } else if (reg === 0x104) {
        if (!((self.reg104 ^ val) & 0x3f)) return;
        self.reg104 = 0x80 | (val & 0x3f);
      } else if (reg === 0x105) {
        if (!((self.opl3Active ^ val) & 1)) return;
        self.opl3Active = (val & 1) ? 0xff : 0;
        for (let i = 0; i < 18; i++) Channel__ResetC0(self, i);
      } else if (reg === 0x08) {
        self.reg08 = val;
      }
      // fall through
    case 0x10 >> 4:
      break;
    case 0x20 >> 4:
    case 0x30 >> 4:
      index = ((reg >> 3) & 0x20) | (reg & 0x1f);
      if (opForReg[index]) Operator__Write20(self.chan[opForReg[index].chan].op[opForReg[index].op], self, val);
      break;
    case 0x40 >> 4:
    case 0x50 >> 4:
      index = ((reg >> 3) & 0x20) | (reg & 0x1f);
      if (opForReg[index]) Operator__Write40(self.chan[opForReg[index].chan].op[opForReg[index].op], self, val);
      break;
    case 0x60 >> 4:
    case 0x70 >> 4:
      index = ((reg >> 3) & 0x20) | (reg & 0x1f);
      if (opForReg[index]) Operator__Write60(self.chan[opForReg[index].chan].op[opForReg[index].op], self, val);
      break;
    case 0x80 >> 4:
    case 0x90 >> 4:
      index = ((reg >> 3) & 0x20) | (reg & 0x1f);
      if (opForReg[index]) Operator__Write80(self.chan[opForReg[index].chan].op[opForReg[index].op], self, val);
      break;
    case 0xa0 >> 4:
      index = ((reg >> 4) & 0x10) | (reg & 0xf);
      if (chanForReg[index] >= 0) Channel__WriteA0(self, chanForReg[index], val);
      break;
    case 0xb0 >> 4:
      if (reg === 0xbd) {
        Chip__WriteBD(self, val);
      } else {
        index = ((reg >> 4) & 0x10) | (reg & 0xf);
        if (chanForReg[index] >= 0) Channel__WriteB0(self, chanForReg[index], val);
      }
      break;
    case 0xc0 >> 4:
      index = ((reg >> 4) & 0x10) | (reg & 0xf);
      if (chanForReg[index] >= 0) Channel__WriteC0(self, chanForReg[index], val);
      // fall through
    case 0xd0 >> 4:
      break;
    case 0xe0 >> 4:
    case 0xf0 >> 4:
      index = ((reg >> 3) & 0x20) | (reg & 0x1f);
      if (opForReg[index]) Operator__WriteE0(self.chan[opForReg[index].chan].op[opForReg[index].op], self, val);
      break;
  }
}

export function Chip__WriteAddr(self, port, val) {
  switch (port & 3) {
    case 0: return val;
    case 2:
      if (self.opl3Active || (val === 0x05)) return 0x100 | val;
      return val;
  }
  return 0;
}

// OPL2 (mono): fills output[0..total-1] (Int32Array) with summed samples.
export function Chip__GenerateBlock2(self, total, output) {
  let outBase = 0;
  while (total > 0) {
    const samples = Chip__ForwardLFO(self, total);
    for (let i = 0; i < samples; i++) output[outBase + i] = 0;
    for (let ci = 0; ci < 9;) {
      ci = Channel__BlockTemplate(self, ci, samples, output, outBase, self.chan[ci].synthMode);
    }
    total -= samples;
    outBase += samples;
  }
}

// OPL3 (stereo): fills output[0..total*2-1] interleaved L/R.
export function Chip__GenerateBlock3(self, total, output) {
  let outBase = 0;
  while (total > 0) {
    const samples = Chip__ForwardLFO(self, total);
    for (let i = 0; i < samples * 2; i++) output[outBase + i] = 0;
    for (let ci = 0; ci < 18;) {
      ci = Channel__BlockTemplate(self, ci, samples, output, outBase, self.chan[ci].synthMode);
    }
    total -= samples;
    outBase += samples * 2;
  }
}

export function Chip__Setup(self, rate) {
  const original = OPLRATE;
  const scale = original / rate;

  self.noiseAdd = (0.5 + scale * (1 << LFO_SH)) >>> 0;
  self.noiseCounter = 0;
  self.noiseValue = 1;
  self.lfoAdd = (0.5 + scale * (1 << LFO_SH)) >>> 0;
  self.lfoCounter = 0;
  self.vibratoIndex = 0;
  self.tremoloIndex = 0;

  const freqScale = (0.5 + scale * (1 << (WAVE_SH - 1 - 10))) >>> 0;
  for (let i = 0; i < 16; i++) {
    self.freqMul[i] = (freqScale * FreqCreateTable[i]) >>> 0;
  }

  for (let i = 0; i < 76; i++) {
    const [index, shift] = EnvelopeSelect(i);
    self.linearRates[i] = (scale * (EnvelopeIncreaseTable[index] << (RATE_SH + ENV_EXTRA - shift - 3))) >>> 0;
  }
  for (let i = 0; i < 62; i++) {
    const [index, shift] = EnvelopeSelect(i);
    const original2 = ((AttackSamplesTable[index] << shift) / scale) >>> 0;
    let guessAdd = (scale * (EnvelopeIncreaseTable[index] << (RATE_SH - shift - 3))) >>> 0;
    let bestAdd = guessAdd;
    let bestDiff = 1 << 30;
    for (let passes = 0; passes < 16; passes++) {
      let volume = ENV_MAX;
      let samples = 0;
      let count = 0;
      while (volume > 0 && samples < original2 * 2) {
        count = (count + guessAdd) >>> 0;
        const change = count >>> RATE_SH;
        count &= RATE_MASK;
        if (change) volume += (~volume * change) >> 3;
        samples++;
      }
      const diff = original2 - samples;
      const lDiff = Math.abs(diff);
      if (lDiff < bestDiff) {
        bestDiff = lDiff;
        bestAdd = guessAdd;
        if (!bestDiff) break;
      }
      if (diff < 0) {
        const mul = (((original2 - diff) << 12) / original2) | 0;
        guessAdd = ((guessAdd * mul) >> 12) >>> 0;
        guessAdd++;
      } else if (diff > 0) {
        const mul = (((original2 - diff) << 12) / original2) | 0;
        guessAdd = ((guessAdd * mul) >> 12) >>> 0;
        guessAdd--;
      }
    }
    self.attackRates[i] = bestAdd >>> 0;
  }
  for (let i = 62; i < 76; i++) self.attackRates[i] = (8 << RATE_SH) >>> 0;

  // four-op flags (channels appear linear via the offset tables)
  self.chan[0].fourMask = 0x00 | (1 << 0);
  self.chan[1].fourMask = 0x80 | (1 << 0);
  self.chan[2].fourMask = 0x00 | (1 << 1);
  self.chan[3].fourMask = 0x80 | (1 << 1);
  self.chan[4].fourMask = 0x00 | (1 << 2);
  self.chan[5].fourMask = 0x80 | (1 << 2);
  self.chan[9].fourMask  = 0x00 | (1 << 3);
  self.chan[10].fourMask = 0x80 | (1 << 3);
  self.chan[11].fourMask = 0x00 | (1 << 4);
  self.chan[12].fourMask = 0x80 | (1 << 4);
  self.chan[13].fourMask = 0x00 | (1 << 5);
  self.chan[14].fourMask = 0x80 | (1 << 5);
  self.chan[6].fourMask = 0x40;
  self.chan[7].fourMask = 0x40;
  self.chan[8].fourMask = 0x40;

  // Clear everything in opl3 mode, then opl2 mode.
  Chip__WriteReg(self, 0x105, 0x1);
  for (let i = 0; i < 512; i++) {
    if (i === 0x105) continue;
    Chip__WriteReg(self, i, 0xff);
    Chip__WriteReg(self, i, 0x0);
  }
  Chip__WriteReg(self, 0x105, 0x0);
  for (let i = 0; i < 255; i++) {
    Chip__WriteReg(self, i, 0xff);
    Chip__WriteReg(self, i, 0x0);
  }
}

export function Chip__Chip(self) {
  // Channels/operators already constructed; reset chip-level registers.
  self.reg08 = 0;
  self.reg04 = 0;
  self.regBD = 0;
  self.reg104 = 0;
  self.opl3Active = 0;
}

// ---------------------------------------------------------------------------
// Public convenience wrapper
// ---------------------------------------------------------------------------
export class DBOPLChip {
  constructor(rate) {
    DBOPL_InitTables();
    this.chip = new Chip();
    Chip__Chip(this.chip);
    Chip__Setup(this.chip, rate);
  }
  writeReg(reg, val) { Chip__WriteReg(this.chip, reg, val); }
  // output: Int32Array of length >= samples (mono OPL2).
  generate(output, samples) { Chip__GenerateBlock2(this.chip, samples, output); }
  generateStereo(output, samples) { Chip__GenerateBlock3(this.chip, samples, output); }
}
