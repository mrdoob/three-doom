// Ported from: linuxdoom-1.10/i_sound.c
// Browser Web Audio adapter. Decodes Doom DMX sound lumps (DS* lumps) on
// demand and plays them via AudioBufferSourceNode -> GainNode -> destination.
//
// DMX format header (8 bytes):
//   short format     (always 3)
//   short samplerate (Hz, usually 11025)
//   long  numsamples
// Followed by raw unsigned 8-bit PCM samples.

import { W_CacheLumpNum, W_GetNumForName, W_CheckNumForName } from './w_wad.js';

let _ctx = null;        // AudioContext
let _master = null;     // master GainNode (sfx volume)
let _musicGain = null;  // music GainNode
const _bufferCache = new Map(); // lumpName -> AudioBuffer

function getCtx() {
  if (_ctx === null) {
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
    _master    = _ctx.createGain(); _master.gain.value = 1.0; _master.connect(_ctx.destination);
    _musicGain = _ctx.createGain(); _musicGain.gain.value = 0.5; _musicGain.connect(_ctx.destination);
  }
  return _ctx;
}

function decodeDMX(bytes) {
  // Read header.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format     = view.getUint16(0, true);
  const samplerate = view.getUint16(2, true);
  const numsamples = view.getUint32(4, true);
  if (format !== 3) return null;
  // Most DMX lumps pad with 16 zero-bytes at start and 16 at end. Skip them.
  const sampleStart = 8 + 16;
  const usable = numsamples - 32;
  if (usable <= 0) return null;
  const ctx = getCtx();
  const buf = ctx.createBuffer(1, usable, samplerate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < usable; i++) {
    // Unsigned 8-bit PCM, center is 128.
    ch[i] = (bytes[sampleStart + i] - 128) / 128;
  }
  return buf;
}

function getBuffer(name) {
  let buf = _bufferCache.get(name);
  if (buf !== undefined) return buf;
  const lumpnum = W_CheckNumForName(name);
  if (lumpnum === -1) return null;
  const bytes = W_CacheLumpNum(lumpnum, 0);
  buf = decodeDMX(bytes);
  _bufferCache.set(name, buf);
  return buf;
}

// SFX info table — name + priority. Filled by S_Init from sounds.c.
let _sfxInfo = null;
export function I_RegisterSfxInfo(info) { _sfxInfo = info; }

export function I_InitSound() { getCtx(); }
export function I_UpdateSound() {}
export function I_SubmitSound() {}
export function I_ShutdownSound() {
  if (_ctx !== null) { _ctx.close(); _ctx = null; }
}

// i_sound.c surface area expected by s_sound.c. Web Audio mixes natively,
// so the channel-allocation builder, master volume setter, and music-status
// probe are mostly nops/thin shims, but every name must exist as an export
// or s_sound's wiring breaks at module-load time.

// i_sound.c:I_GetSfxLumpNum — returns the WAD lump index for an sfx.
// s_sound uses this to precache / locate sound data.
export function I_GetSfxLumpNum(sfx) {
  if (sfx === null || sfx === undefined) return -1;
  const name = (sfx.name !== undefined) ? sfx.name : String(sfx);
  return W_CheckNumForName('DS' + name.toUpperCase());
}

// i_sound.c:I_SetChannels — builds steptable / vol_lookup for the software
// mixer. Web Audio handles mixing/pan; nothing to precompute here.
export function I_SetChannels() {}

// i_sound.c:I_SetSfxVolume / I_SetMusicVolume. Master SFX gain is applied
// per-source from S_AdjustSoundParams, so the setter just remembers the
// value (s_sound reads snd_SfxVolume directly).
export function I_SetSfxVolume(_vol) {}

// i_sound.c:I_QrySongPlaying — DMX returned the playing music handle or 0.
export function I_QrySongPlaying(_handle) {
  return _musicScore !== null;
}

// i_sound.c init/shutdown for the music subsystem. Web Audio doesn't need
// separate music init.
export function I_InitMusic() {}
export function I_ShutdownMusic() {
  if (_musicTimer !== null) { clearInterval(_musicTimer); _musicTimer = null; }
}

// `id` is sfx_xxx index into _sfxInfo. vol 0..127, sep 0..255 (stereo), pitch
// is pitch shift in 1/64 semitones — Doom uses 128 as "normal".
// Returns a handle (used by I_StopSound to cancel).
let _nextHandle = 1;
const _activeSources = new Map();
export function I_StartSound(id, vol, sep, pitch, _priority) {
  if (_sfxInfo === null) return 0;
  const info = _sfxInfo[id];
  if (info === undefined) return 0;
  const name = 'DS' + info.name.toUpperCase();
  const buf = getBuffer(name);
  if (buf === null) return 0;
  const ctx = getCtx();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.playbackRate.value = pitch > 0 ? pitch / 128 : 1;
  const gain = ctx.createGain();
  gain.gain.value = vol / 127;
  const panner = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
  if (panner !== null) {
    panner.pan.value = ((sep - 128) / 128);
    src.connect(gain).connect(panner).connect(_master);
  } else {
    src.connect(gain).connect(_master);
  }
  src.start();
  const handle = _nextHandle++;
  _activeSources.set(handle, { src, gain, panner });
  src.onended = () => { _activeSources.delete(handle); };
  return handle;
}

export function I_StopSound(handle) {
  const entry = _activeSources.get(handle);
  if (entry !== undefined) { try { entry.src.stop(); } catch (_) {} _activeSources.delete(handle); }
}
export function I_SoundIsPlaying(handle) { return _activeSources.has(handle); }
export function I_UpdateSoundParams(handle, vol, sep, pitch) {
  const entry = _activeSources.get(handle);
  if (entry === undefined) return;
  if (entry.gain)   entry.gain.gain.value = vol / 127;
  if (entry.panner) entry.panner.pan.value = (sep - 128) / 128;
  if (entry.src && pitch > 0) entry.src.playbackRate.value = pitch / 128;
}

// ---------- Music ----------
// MUS lump format (Doom's compressed MIDI variant):
//   header[0..4]   = "MUS\x1a"
//   header[4..6]   = scoreLen
//   header[6..8]   = scoreStart
//   header[8..10]  = numChannels
//   header[10..12] = numSecondaryChannels
//   header[12..14] = numInstrumentPatches
// Followed by `numInstrumentPatches` 2-byte instrument indices, then
// `scoreLen` bytes of events.
//
// Events: each byte =  (last<<7) | (event_type<<4) | channel
//   event types: 0 release, 1 play, 2 pitch, 3 sys, 4 ctlr, 6 end, 5/7 unused
//
// For the browser port we synthesize each playing note as a soft sine using
// Web Audio's OscillatorNode + GainNode. It's a far cry from the OPL2/MIDI
// fidelity of vanilla Doom but conveys the melody.

let _musicCtx = null;
const _activeNotes = new Map();   // channel -> { osc, gain, freq, vel }
let   _musicPos = 0;
let   _musicScore = null;
let   _musicScoreStart = 0;
let   _musicScoreEnd   = 0;
let   _musicWaiting = 0;
let   _musicTimer = null;
let   _musicLooping = false;

function midiNoteToFreq(n) { return 440 * Math.pow(2, (n - 69) / 12); }

function _stopNote(channel) {
  const n = _activeNotes.get(channel);
  if (n !== undefined) {
    try { n.gain.gain.cancelScheduledValues(_musicCtx.currentTime); n.gain.gain.setValueAtTime(0, _musicCtx.currentTime + 0.02); n.osc.stop(_musicCtx.currentTime + 0.05); } catch (_) {}
    _activeNotes.delete(channel);
  }
}

function _playNote(channel, note, vel) {
  if (_musicCtx === null) return;
  _stopNote(channel);
  const osc = _musicCtx.createOscillator();
  const gain = _musicCtx.createGain();
  osc.type = channel === 9 ? 'square' : 'triangle'; // percussion channel uses square
  osc.frequency.value = midiNoteToFreq(note);
  gain.gain.value = (vel / 127) * 0.05; // overall music quiet
  osc.connect(gain).connect(_musicGain);
  osc.start();
  _activeNotes.set(channel, { osc, gain, freq: midiNoteToFreq(note), vel });
}

function _processOneEvent() {
  if (_musicScore === null) return false;
  if (_musicPos >= _musicScoreEnd) {
    if (_musicLooping) { _musicPos = _musicScoreStart; }
    else return false;
  }
  const eb = _musicScore[_musicPos++];
  const last = (eb & 0x80) !== 0;
  const type = (eb >> 4) & 7;
  const channel = eb & 0x0F;
  if (type === 0) { // release note
    _musicPos++; // note number byte
    _stopNote(channel);
  } else if (type === 1) { // play note
    let note = _musicScore[_musicPos++];
    let vel = 100;
    if (note & 0x80) { note &= 0x7F; vel = _musicScore[_musicPos++] & 0x7F; }
    _playNote(channel, note, vel);
  } else if (type === 2) { // pitch bend (one byte)
    _musicPos++;
  } else if (type === 3) { // system event (one byte)
    _musicPos++;
  } else if (type === 4) { // controller (two bytes)
    _musicPos += 2;
  } else if (type === 6) { // end of score
    if (_musicLooping) _musicPos = _musicScoreStart;
    else return false;
  }
  if (last) {
    // Read variable-length delay.
    let delay = 0, b;
    do { b = _musicScore[_musicPos++]; delay = (delay << 7) | (b & 0x7F); } while (b & 0x80);
    _musicWaiting = delay;
  }
  return true;
}

function _musicTick() {
  if (_musicCtx === null || _musicScore === null) return;
  if (_musicWaiting > 0) { _musicWaiting--; return; }
  for (let safety = 0; safety < 64; safety++) {
    if (!_processOneEvent()) return;
    if (_musicWaiting > 0) return;
  }
}

// Vanilla i_sound passes 0..127 from S_SetMusicVolume. Linear scale so peak
// volume doesn't clip — keep a headroom factor.
export function I_SetMusicVolume(vol) {
  if (_musicGain === null) return;
  if (vol < 0) vol = 0; if (vol > 127) vol = 127;
  _musicGain.gain.value = (vol / 127) * 0.4;
}
export function I_PauseSong(_handle)  { if (_musicTimer !== null) { clearInterval(_musicTimer); _musicTimer = null; } }
export function I_ResumeSong(_handle) { if (_musicTimer === null && _musicScore !== null) _musicTimer = setInterval(_musicTick, 1000 / 140); }
export function I_PlaySong(_handle, looping) {
  _musicLooping = !!looping;
  _musicPos = _musicScoreStart;
  _musicWaiting = 0;
  for (const ch of Array.from(_activeNotes.keys())) _stopNote(ch);
  I_ResumeSong(_handle);
}
export function I_StopSong(_handle)   {
  I_PauseSong(_handle);
  for (const ch of Array.from(_activeNotes.keys())) _stopNote(ch);
}
export function I_UnRegisterSong(_handle) { _musicScore = null; }

// Decode a D_xxx MUS lump and store its score for playback.
export function I_RegisterSong(bytes) {
  if (bytes === null || bytes === undefined || bytes.length < 16) return 0;
  if (bytes[0] !== 0x4D || bytes[1] !== 0x55 || bytes[2] !== 0x53 || bytes[3] !== 0x1A) return 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scoreLen   = view.getUint16(4, true);
  const scoreStart = view.getUint16(6, true);
  _musicScore = bytes;
  _musicScoreStart = scoreStart;
  _musicScoreEnd   = scoreStart + scoreLen;
  _musicPos = scoreStart;
  _musicCtx = _ctx; // (created on demand by getCtx())
  return 1;
}
