// Ported from: linuxdoom-1.10/i_sound.c
// Browser Web Audio adapter. Decodes Doom DMX sound lumps (DS* lumps) on
// demand and plays them via AudioBufferSourceNode -> GainNode -> destination.
//
// DMX format header (8 bytes):
//   short format     (always 3)
//   short samplerate (Hz, usually 11025)
//   long  numsamples
// Followed by raw unsigned 8-bit PCM samples.

import { W_CacheLumpNum, W_CheckNumForName } from './w_wad.js';
import * as OPL from './i_oplmusic.js';

let _ctx = null;        // AudioContext
let _master = null;     // master GainNode (sfx volume)
let _musicGain = null;  // music GainNode
let _visibilityGain = null; // immediate shared mute for hidden pages
const _bufferCache = new Map(); // lumpName -> AudioBuffer
let _soundShutdownStarted = false;
let _soundShutdownPromise = null;
let _visibilityHandler = null;
let _contextStateHandler = null;
let _visibilityOwnsSuspension = false;
let _visibilitySuspendPending = null;
let _visibilityResumePending = null;
let _visibilityRequestGeneration = 0;
let _visibilityLastRequest = null;

function pageIsHidden() {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

function requestVisibilitySuspend(context) {
  if (_visibilitySuspendPending !== null || context.state === 'closed') return;
  const generation = ++_visibilityRequestGeneration;
  _visibilityOwnsSuspension = true;
  _visibilityLastRequest = 'suspend';
  let request;
  try {
    request = context.suspend();
  } catch {
    _visibilityOwnsSuspension = false;
    _visibilityLastRequest = null;
    return;
  }
  const pending = Promise.resolve(request).then(
    () => true,
    () => false,
  ).then((succeeded) => {
    if (_visibilitySuspendPending === pending) _visibilitySuspendPending = null;
    if (_soundShutdownStarted === true || _ctx !== context) return;
    if (succeeded !== true) {
      if (_visibilityRequestGeneration === generation) {
        _visibilityOwnsSuspension = false;
        _visibilityLastRequest = null;
      }
      return;
    }
    reconcileAudioVisibility();
  });
  _visibilitySuspendPending = pending;
}

function requestVisibilityResume(context) {
  if (_visibilityResumePending !== null || context.state === 'closed') return;
  const generation = ++_visibilityRequestGeneration;
  _visibilityLastRequest = 'resume';
  let request;
  try {
    request = context.resume();
  } catch {
    _visibilityOwnsSuspension = false;
    _visibilityLastRequest = null;
    return;
  }
  const pending = Promise.resolve(request).then(
    () => true,
    () => false,
  ).then((succeeded) => {
    if (_visibilityResumePending === pending) _visibilityResumePending = null;
    if (_soundShutdownStarted === true || _ctx !== context) return;
    // If browser policy rejects this automatic resume, relinquish ownership;
    // the existing foreground gesture handler remains the retry path.
    if (_visibilityRequestGeneration === generation) {
      _visibilityOwnsSuspension = false;
      _visibilityLastRequest = null;
    }
    if (succeeded === true) reconcileAudioVisibility();
  });
  _visibilityResumePending = pending;
}

// Page Visibility already freezes Doom's simulation clock. Mute immediately,
// then suspend the shared Web Audio context so music, in-flight effects, and
// mixer CPU all stop in a background tab. The statechange hook also catches a
// browser changing an autoplay-suspended or interrupted context behind us.
function reconcileAudioVisibility() {
  const context = _ctx;
  if (_soundShutdownStarted === true || context === null) return;
  const hidden = pageIsHidden();
  if (_visibilityGain !== null) _visibilityGain.gain.value = hidden ? 0 : 1;

  if (hidden === true) {
    if (context.state === 'running' ||
        (context.state === 'interrupted' && _visibilityLastRequest !== 'suspend')) {
      requestVisibilitySuspend(context);
    }
    return;
  }
  if (_visibilityOwnsSuspension !== true) return;
  if (context.state === 'suspended' || context.state === 'interrupted') {
    requestVisibilityResume(context);
  } else if (context.state === 'running' && _visibilitySuspendPending === null) {
    _visibilityOwnsSuspension = false;
    _visibilityLastRequest = null;
  }
}

function installVisibilitySuspension(context) {
  if (_visibilityHandler !== null || typeof document === 'undefined') return;
  _visibilityHandler = reconcileAudioVisibility;
  _contextStateHandler = reconcileAudioVisibility;
  document.addEventListener('visibilitychange', _visibilityHandler);
  context.addEventListener('statechange', _contextStateHandler);
  reconcileAudioVisibility();
}

function resumeAudioOnGesture() {
  const context = _ctx;
  if (_soundShutdownStarted === true || context === null || _ctx !== context ||
      pageIsHidden() === true || context.state === 'running') return;
  context.resume().catch(() => {});
}

function getCtx() {
  // Page teardown is terminal. D_DoomMain can still resume
  // from an already-pending import after doom:quit, so never recreate Web
  // Audio once the shutdown path has claimed it.
  if (_soundShutdownStarted === true) return null;
  if (_ctx === null) {
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
    _visibilityGain = _ctx.createGain();
    _visibilityGain.gain.value = pageIsHidden() === true ? 0 : 1;
    _visibilityGain.connect(_ctx.destination);
    _master = _ctx.createGain();
    _master.gain.value = 1.0;
    _master.connect(_visibilityGain);
    // Music bus: the OPL engine (i_oplmusic.js) renders into a ScriptProcessor
    // that feeds this gain. The chip output is pre-tuned to sit below clipping,
    // so no limiter is needed; _musicGain is the volume control. It MUST connect
    // to the destination.
    _musicGain = _ctx.createGain(); _musicGain.gain.value = MUSIC_TRIM * (8 / 15);
    _musicGain.connect(_visibilityGain);
    installResumeOnGesture();
    installVisibilitySuspension(_ctx);
  }
  return _ctx;
}

// Explicitly resume the AudioContext on the first user gesture. Don't rely on
// Chrome silently auto-resuming — it doesn't always, and a suspended context
// means total silence.
let _resumeInstalled = false;
let _resumeHandler = null;
function installResumeOnGesture() {
  if (_resumeInstalled || typeof window === 'undefined') return;
  _resumeInstalled = true;
  _resumeHandler = resumeAudioOnGesture;
  for (const ev of ['pointerdown', 'mousedown', 'keydown', 'touchstart']) {
    window.addEventListener(ev, _resumeHandler, { passive: true });
  }
}

// The browser blocks AudioContext from playing until the user interacts with
// the page; calling .start() on a source before then logs a noisy warning per
// call. canDispatch() gates every audio output behind a running context — the
// browser auto-resumes on first user gesture so the gate flips on its own.
function canDispatch() { return _ctx !== null && _ctx.state === 'running'; }

function stopSourceQuietly(source) {
  try {
    source.stop();
  } catch {
    // Web Audio throws when an already-stopped source is stopped again.
  }
}

function disconnectNodeQuietly(node) {
  try {
    node?.disconnect();
  } catch {
    // Shutdown remains best-effort after the context invalidates its nodes.
  }
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
  let lumpnum = W_CheckNumForName(name);
  // i_sound.c getsfx(): the sound list isn't gamemode-aware, so a DOOM II sfx
  // can be requested even under shareware. Rather than runtime-patching, vanilla
  // substitutes dspistol for any missing DS* lump:
  //   if ( W_CheckNumForName(name) == -1 ) sfxlump = W_GetNumForName("dspistol");
  // This is also what lets linked sfx (sfx_chgun -> dspistol) resolve by id.
  if (lumpnum === -1) lumpnum = W_CheckNumForName('DSPISTOL');
  if (lumpnum === -1) { _bufferCache.set(name, null); return null; }
  const bytes = W_CacheLumpNum(lumpnum, 0);
  buf = decodeDMX(bytes);
  _bufferCache.set(name, buf);
  return buf;
}

// SFX info table — name + priority. Filled by S_Init from sounds.c.
let _sfxInfo = null;
export function I_RegisterSfxInfo(info) {
  if (_soundShutdownStarted === false) _sfxInfo = info;
}

export function I_InitSound() {
  if (_soundShutdownStarted === false) getCtx();
}
export function I_UpdateSound() {}
export function I_SubmitSound() {}
export function I_ShutdownSound() {
  if (_soundShutdownPromise !== null) return _soundShutdownPromise;
  _soundShutdownStarted = true;

  // Claim every owned object synchronously. This makes repeated calls and
  // pending startup continuations harmless even while AudioContext.close()
  // is still settling.
  const ownedContext = _ctx;
  _ctx = null;
  const ownedMusicNode = _musicNode;
  _musicNode = null;
  const ownedMaster = _master;
  _master = null;
  const ownedMusicGain = _musicGain;
  _musicGain = null;
  const ownedVisibilityGain = _visibilityGain;
  _visibilityGain = null;
  _oplReady = false;
  _visibilityOwnsSuspension = false;
  _visibilitySuspendPending = null;
  _visibilityResumePending = null;
  _visibilityRequestGeneration++;
  _visibilityLastRequest = null;

  if (_visibilityHandler !== null && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _visibilityHandler);
  }
  if (_contextStateHandler !== null && ownedContext !== null) {
    ownedContext.removeEventListener('statechange', _contextStateHandler);
  }
  _visibilityHandler = null;
  _contextStateHandler = null;

  if (_resumeHandler !== null && typeof window !== 'undefined') {
    for (const ev of ['pointerdown', 'mousedown', 'keydown', 'touchstart']) {
      window.removeEventListener(ev, _resumeHandler);
    }
  }
  _resumeHandler = null;
  _resumeInstalled = false;

  for (const entry of _activeSources.values()) {
    entry.src.onended = null;
    stopSourceQuietly(entry.src);
    disconnectNodeQuietly(entry.src);
    disconnectNodeQuietly(entry.gain);
    disconnectNodeQuietly(entry.panner);
  }
  _activeSources.clear();
  try {
    if (ownedMusicNode !== null) {
      ownedMusicNode.onaudioprocess = null;
      ownedMusicNode.disconnect();
    }
  } catch {
    // The context may invalidate its processor while shutdown claims it.
  }
  disconnectNodeQuietly(ownedMaster);
  disconnectNodeQuietly(ownedMusicGain);
  disconnectNodeQuietly(ownedVisibilityGain);
  _bufferCache.clear();
  _sfxInfo = null;

  _soundShutdownPromise = (async () => {
    if (ownedContext !== null && ownedContext.state !== 'closed') {
      await ownedContext.close();
    }
  })();
  return _soundShutdownPromise;
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

// i_sound.c addsfx() "Chainsaw troubles": these sfx play only one at a time,
// deduped by sfx id across all mixer channels independent of origin —
// sfx_pistol(1), sfx_sawup(10), sfx_sawidl(11), sfx_sawful(12), sfx_sawhit(13),
// sfx_stnmov(22). Matters most for stnmov: many sectors can move at once but
// only ONE moving-stone sound should play.
// (sfx_chgun stays id 86 and is deliberately absent — not deduped, per s_sound.js.)
const _SINGLE_INSTANCE = new Set([1, 10, 11, 12, 13, 22]);

export function I_StartSound(id, vol, sep, pitch, _priority) {
  if (_sfxInfo === null) return 0;
  if (canDispatch() !== true) return 0;
  const info = _sfxInfo[id];
  if (info === undefined) return 0;
  const name = 'DS' + info.name.toUpperCase();
  const buf = getBuffer(name);
  if (buf === null) return 0;
  // Chainsaw-troubles dedup: cull the existing source with the same id first.
  if (_SINGLE_INSTANCE.has(id) === true) {
    for (const h of _activeSources.keys()) {
      const e = _activeSources.get(h);
      if (e.id === id) {
        stopSourceQuietly(e.src);
        _activeSources.delete(h);
        break;
      }
    }
  }
  const ctx = getCtx();
  const src = ctx.createBufferSource();
  src.buffer = buf;
  // i_sound.c:495 maps pitch through steptable[]: pow(2,(pitch-128)/64). Vanilla's
  // software mixer never used it, but Web Audio applies playbackRate for real, so
  // use the exponential map (64 pitch units = one octave). pitch 128 => 1.0.
  src.playbackRate.value = pitch > 0 ? Math.pow(2, (pitch - 128) / 64) : 1;
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
  _activeSources.set(handle, { src, gain, panner, id });
  src.onended = () => { _activeSources.delete(handle); };
  return handle;
}

export function I_StopSound(handle) {
  const entry = _activeSources.get(handle);
  if (entry !== undefined) {
    stopSourceQuietly(entry.src);
    _activeSources.delete(handle);
  }
}
export function I_SoundIsPlaying(handle) { return _activeSources.has(handle); }
export function I_UpdateSoundParams(handle, vol, sep, _pitch) {
  const entry = _activeSources.get(handle);
  if (entry === undefined) return;
  if (entry.gain)   entry.gain.gain.value = vol / 127;
  if (entry.panner) entry.panner.pan.value = (sep - 128) / 128;
  // i_sound.c I_UpdateSoundParams is a no-op for pitch — a playing sound keeps
  // the playback rate it was started with. Don't reset playbackRate here, or the
  // per-tic re-attenuation would wipe out a sound's pitch perturbation.
}

// ---------- Music (OPL2 FM synthesis via DBOPL + GENMIDI) ----------
// Doom's music is MUS data played through the OPL2 chip using the GENMIDI
// instrument bank — that gritty AdLib/Sound Blaster sound. The full engine
// lives in i_oplmusic.js (DBOPL chip + GENMIDI + a MUS sequencer); here we
// just feed it into Web Audio through a ScriptProcessorNode on the music bus
// and map Doom's music-volume slider to the bus gain.

// Trim so the (pre-tuned) OPL output sits a touch below the sfx bus.
const MUSIC_TRIM = 0.8;

let _oplReady = false;      // OPL engine (chip + GENMIDI) initialised
let _musicNode = null;      // ScriptProcessorNode pulling OPL audio
const MUSIC_BUFSIZE = 4096;

// Lazily initialise the OPL engine (chip + GENMIDI) and its audio node. Safe to
// call repeatedly. By the time a song is registered the WAD (with GENMIDI) and
// the AudioContext both exist. The node may be created while the context is
// still autoplay-suspended; it begins firing once a user gesture resumes the
// context (installResumeOnGesture).
function ensureOpl() {
  if (_soundShutdownStarted === true) return false;
  if (_oplReady) return true;
  const ctx = getCtx();
  if (ctx === null) return false;
  OPL.OPL_InitMusic(ctx.sampleRate);
  const lumpnum = W_CheckNumForName('GENMIDI');
  if (lumpnum === -1) return false; // no instrument bank -> no music (no fallback)
  OPL.OPL_LoadGenmidi(W_CacheLumpNum(lumpnum, 0));
  // ScriptProcessor renders the OPL chip on the main thread, feeding the music
  // bus. (1,1) channels; only the output is connected.
  _musicNode = ctx.createScriptProcessor(MUSIC_BUFSIZE, 1, 1);
  _musicNode.onaudioprocess = (e) => {
    const out = e.outputBuffer.getChannelData(0);
    OPL.I_OPL_FillBuffer(out, out.length);
  };
  _musicNode.connect(_musicGain);
  _oplReady = true;
  return true;
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
  if (ensureOpl() === true) OPL.I_OPL_PlaySong(!!looping);
}
export function I_StopSong(_handle)   { OPL.I_OPL_StopSong(); }
export function I_UnRegisterSong(_handle) { OPL.I_OPL_StopSong(); }

// Register a D_xxx MUS lump for playback.
export function I_RegisterSong(bytes) {
  if (bytes === null || bytes === undefined || bytes.length < 16) return 0;
  if (bytes[0] !== 0x4D || bytes[1] !== 0x55 || bytes[2] !== 0x53 || bytes[3] !== 0x1A) return 0;
  if (ensureOpl() !== true) return 0;
  OPL.I_OPL_RegisterSong(bytes);
  return 1;
}
