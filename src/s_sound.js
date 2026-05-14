// Ported from: linuxdoom-1.10/s_sound.c, s_sound.h
// Sound system: channel allocation, S_StartSound, distance attenuation.
// Backed by Web Audio in i_sound.js.

import * as I from './i_sound.js';
import { S_sfx } from './sounds_data.js';
import { snd_SfxVolume, snd_MusicVolume, set_snd_SfxVolume, set_snd_MusicVolume } from './doomstat.js';
import { ANGLETOFINESHIFT, FINEMASK, finecosine, finesine } from './tables.js';

const NUM_CHANNELS = 16;
// Each channel: { sfxinfo, origin (mobj or null), handle }
const channels = new Array(NUM_CHANNELS);
for (let i = 0; i < NUM_CHANNELS; i++) channels[i] = { sfxinfo: null, origin: null, handle: 0 };

let _listener = null;

export function S_Init(sfxVolume, musicVolume) {
  I.I_InitSound();
  I.I_RegisterSfxInfo(S_sfx);
  // s_sound.c:264 — apply the volumes the menu/config booted with.
  if (typeof sfxVolume   === 'number') S_SetSfxVolume(sfxVolume);
  if (typeof musicVolume === 'number') S_SetMusicVolume(musicVolume);
}

export function S_Start() {
  // Stop everything before level swap.
  for (const ch of channels) {
    if (ch.handle !== 0) I.I_StopSound(ch.handle);
    ch.sfxinfo = null; ch.origin = null; ch.handle = 0;
  }
}

function getFreeChannel(origin, priority) {
  // Prefer free channel.
  for (let i = 0; i < NUM_CHANNELS; i++) {
    if (channels[i].handle === 0 || !I.I_SoundIsPlaying(channels[i].handle)) return i;
  }
  // Otherwise replace lowest-priority.
  let lowest = 0;
  for (let i = 1; i < NUM_CHANNELS; i++) {
    if (channels[i].sfxinfo !== null && channels[lowest].sfxinfo !== null &&
        channels[i].sfxinfo.priority < channels[lowest].sfxinfo.priority) lowest = i;
  }
  if (channels[lowest].sfxinfo === null || channels[lowest].sfxinfo.priority <= priority) {
    if (channels[lowest].handle !== 0) I.I_StopSound(channels[lowest].handle);
    return lowest;
  }
  return -1;
}

// S_AdjustSoundParams — mirror vanilla. Returns null if inaudible, else
// { vol, sep, pitch }. Distance > S_CLIPPING_DIST silences; between
// S_CLOSE_DIST and S_CLIPPING_DIST volume tapers linearly.
const S_CLOSE_DIST    = 160 * 65536;   // ~ vanilla constant in fixed-point
const S_CLIPPING_DIST = 1200 * 65536;
const NORM_PITCH      = 128;
const NORM_SEP        = 128;

function approxDist(dx, dy) {
  dx = Math.abs(dx); dy = Math.abs(dy);
  return dx < dy ? dx + dy - (dx >> 1) : dx + dy - (dy >> 1);
}

function S_AdjustSoundParams(listener, source) {
  if (listener === null || listener.mo === undefined || listener.mo === null) {
    return { vol: snd_SfxVolume * 8, sep: NORM_SEP, pitch: NORM_PITCH };
  }
  const lmo = listener.mo;
  const dx = source.x - lmo.x;
  const dy = source.y - lmo.y;
  const adist = approxDist(dx, dy);
  if (adist > S_CLIPPING_DIST) return null;
  let vol;
  if (adist < S_CLOSE_DIST) {
    vol = snd_SfxVolume * 8;
  } else {
    vol = ((snd_SfxVolume * 8) * (S_CLIPPING_DIST - adist) / (S_CLIPPING_DIST - S_CLOSE_DIST)) | 0;
  }
  // Stereo separation — vanilla S_AdjustSoundParams clamps to [0, 255].
  const angRad = Math.atan2(dy, dx);
  const listenerRad = lmo.angle / 0x100000000 * Math.PI * 2;
  const relRad = angRad - listenerRad;
  let sep = (NORM_SEP - (Math.sin(relRad) * NORM_SEP)) | 0;
  if (sep < 0)   sep = 0;
  if (sep > 255) sep = 255;
  return { vol, sep, pitch: NORM_PITCH };
}

export function S_StartSound(origin, sfxid) {
  if (sfxid <= 0 || sfxid >= S_sfx.length) return;
  const sfx = S_sfx[sfxid];
  let vol = snd_SfxVolume * 8, sep = NORM_SEP, pitch = NORM_PITCH;
  if (origin !== null && origin !== undefined && _listener !== null && origin !== _listener.mo) {
    const p = S_AdjustSoundParams(_listener, origin);
    if (p === null) return; // out of range
    vol = p.vol; sep = p.sep; pitch = p.pitch;
  }
  if (vol <= 0) return;
  const ch = getFreeChannel(origin, sfx.priority);
  if (ch === -1) return;
  channels[ch].sfxinfo = sfx;
  channels[ch].origin  = origin;
  channels[ch].handle  = I.I_StartSound(sfxid, vol, sep, pitch, sfx.priority);
}

export function S_StartSoundAtVolume(origin, sfxid, _volume) {
  // _volume override would scale snd_SfxVolume; minimum port just routes.
  S_StartSound(origin, sfxid);
}

export function S_StopSound(origin) {
  for (const ch of channels) {
    if (ch.origin === origin && ch.handle !== 0) {
      I.I_StopSound(ch.handle);
      ch.handle = 0; ch.origin = null; ch.sfxinfo = null;
    }
  }
}

export function S_SetListener(player) { _listener = player; }

// ---------- Music ----------
import { W_CheckNumForName, W_CacheLumpNum } from './w_wad.js';

const _musicNames = [
  'NONE','E1M1','E1M2','E1M3','E1M4','E1M5','E1M6','E1M7','E1M8','E1M9',
  'E2M1','E2M2','E2M3','E2M4','E2M5','E2M6','E2M7','E2M8','E2M9',
  'E3M1','E3M2','E3M3','E3M4','E3M5','E3M6','E3M7','E3M8','E3M9',
  'INTER','INTRO','BUNNY','VICTOR','INTROA',
];
let _musicHandle = 0;

export function S_StartMusic(id) { S_ChangeMusic(id, false); }
export function S_ChangeMusic(musicnum, looping) {
  if (musicnum <= 0 || musicnum >= _musicNames.length) return;
  const name = 'D_' + _musicNames[musicnum];
  const lumpnum = W_CheckNumForName(name);
  if (lumpnum === -1) return;
  const bytes = W_CacheLumpNum(lumpnum, 0);
  I.I_StopSong(_musicHandle);
  I.I_UnRegisterSong(_musicHandle);
  _musicHandle = I.I_RegisterSong(bytes);
  I.I_PlaySong(_musicHandle, !!looping);
}
export function S_StopMusic()   { I.I_StopSong(_musicHandle); }
export function S_PauseSound()  { I.I_PauseSong(_musicHandle); }
export function S_ResumeSound() { I.I_ResumeSong(_musicHandle); }

// S_UpdateSounds — per-tic. Re-evaluate distance attenuation for each live
// channel; stop channels whose source is now out of range, push updated
// vol/sep to channels that are still audible.
export function S_UpdateSounds(listener) {
  _listener = listener;
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const c = channels[i];
    if (c.sfxinfo === null || c.handle === 0) continue;
    if (!I.I_SoundIsPlaying(c.handle)) {
      c.sfxinfo = null; c.origin = null; c.handle = 0;
      continue;
    }
    if (c.origin === null || c.origin === listener?.mo) continue;
    const p = S_AdjustSoundParams(listener, c.origin);
    if (p === null) {
      I.I_StopSound(c.handle);
      c.sfxinfo = null; c.origin = null; c.handle = 0;
    } else {
      I.I_UpdateSoundParams?.(c.handle, p.vol, p.sep, p.pitch);
    }
  }
}
export function S_SetMusicVolume(v) {
  if (v < 0) v = 0; if (v > 127) v = 127;
  I.I_SetMusicVolume(v);
  set_snd_MusicVolume(v);
}
export function S_SetSfxVolume(v) {
  if (v < 0) v = 0; if (v > 127) v = 127;
  set_snd_SfxVolume(v);
  // Re-evaluate every live channel at the next S_UpdateSounds.
}
