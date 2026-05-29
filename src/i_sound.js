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
import * as OPL from './i_oplmusic.js';

let _ctx = null;        // AudioContext
let _master = null;     // master GainNode (sfx volume)
let _musicGain = null;  // music GainNode
const _bufferCache = new Map(); // lumpName -> AudioBuffer

function getCtx() {
  if (_ctx === null) {
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
    _master    = _ctx.createGain(); _master.gain.value = 1.0; _master.connect(_ctx.destination);
    // Music bus: the OPL engine (i_oplmusic.js) renders into a ScriptProcessor
    // that feeds this gain. The chip output is pre-tuned to sit below clipping,
    // so no limiter is needed; _musicGain is the volume control.
    _musicGain = _ctx.createGain(); _musicGain.gain.value = MUSIC_TRIM * (8 / 15);
  }
  return _ctx;
}

// The browser blocks AudioContext from playing until the user interacts with
// the page; calling .start() on a source before then logs a noisy warning per
// call. canDispatch() gates every audio output behind a running context — the
// browser auto-resumes on first user gesture so the gate flips on its own.
function canDispatch() { return _ctx !== null && _ctx.state === 'running'; }

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

// i_sound.c:I_QrySongPlaying — true while a song is playing.
export function I_QrySongPlaying(_handle) {
  return OPL.I_OPL_SongPlaying();
}

// i_sound.c init/shutdown for the music subsystem.
export function I_InitMusic() { ensureOpl(); }
export function I_ShutdownMusic() {
  OPL.I_OPL_StopSong();
}

// `id` is sfx_xxx index into _sfxInfo. vol 0..127, sep 0..255 (stereo), pitch
// is pitch shift in 1/64 semitones — Doom uses 128 as "normal".
// Returns a handle (used by I_StopSound to cancel).
let _nextHandle = 1;
const _activeSources = new Map();
export function I_StartSound(id, vol, sep, pitch, _priority) {
  if (_sfxInfo === null) return 0;
  if (canDispatch() !== true) return 0;
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

// ---------- Music (OPL2 FM synthesis via DBOPL + GENMIDI) ----------
// Doom's music is MUS data played through the OPL2 chip using the GENMIDI
// instrument bank — that gritty AdLib/Sound Blaster sound. The full engine
// lives in i_oplmusic.js (DBOPL chip + GENMIDI + a MUS sequencer); here we
// just feed it into Web Audio through a ScriptProcessorNode on the music bus
// and map Doom's music-volume slider to the bus gain.

// Trim so the (pre-tuned) OPL output sits a touch below the sfx bus.
const MUSIC_TRIM = 0.8;

let _oplReady = false;
let _musicNode = null;     // ScriptProcessorNode pulling OPL audio
const MUSIC_BUFSIZE = 4096;

// Lazily initialise the OPL engine + audio node. Safe to call repeatedly.
// By the time a song is registered the WAD (with GENMIDI) and the AudioContext
// both exist.
function ensureOpl() {
  if (_oplReady) return;
  const ctx = getCtx();
  OPL.OPL_InitMusic(ctx.sampleRate);
  const lumpnum = W_CheckNumForName('GENMIDI');
  if (lumpnum === -1) return; // no instrument bank -> no music (no fallback)
  OPL.OPL_LoadGenmidi(W_CacheLumpNum(lumpnum, 0));
  // ScriptProcessor renders the OPL chip on the main thread. (1,1) channels for
  // broad firing compatibility; only the output is used/connected.
  _musicNode = ctx.createScriptProcessor(MUSIC_BUFSIZE, 1, 1);
  _musicNode.onaudioprocess = (e) => {
    const out = e.outputBuffer.getChannelData(0);
    OPL.I_OPL_FillBuffer(out, out.length);
  };
  _musicNode.connect(_musicGain);
  _oplReady = true;
}

// Doom drives music volume on the 0..15 menu scale; map it to the bus gain.
export function I_SetMusicVolume(vol) {
  if (_musicGain === null) return;
  if (vol < 0) vol = 0; if (vol > 15) vol = 15;
  _musicGain.gain.value = MUSIC_TRIM * (vol / 15);
}
export function I_PauseSong(_handle)  { OPL.I_OPL_PauseSong(); }
export function I_ResumeSong(_handle) { OPL.I_OPL_ResumeSong(); }
export function I_PlaySong(_handle, looping) {
  ensureOpl();
  OPL.I_OPL_PlaySong(!!looping);
}
export function I_StopSong(_handle)   { OPL.I_OPL_StopSong(); }
export function I_UnRegisterSong(_handle) { OPL.I_OPL_StopSong(); }

// Register a D_xxx MUS lump for playback.
export function I_RegisterSong(bytes) {
  if (bytes === null || bytes === undefined || bytes.length < 16) return 0;
  if (bytes[0] !== 0x4D || bytes[1] !== 0x55 || bytes[2] !== 0x53 || bytes[3] !== 0x1A) return 0;
  ensureOpl();
  OPL.I_OPL_RegisterSong(bytes);
  return 1;
}
