// Ported from: linuxdoom-1.10/s_sound.c, s_sound.h
// Sound system: channel allocation, S_StartSound, distance attenuation.
// Backed by Web Audio in i_sound.js.

import * as I from './i_sound.js';
import { S_sfx } from './sounds_data.js';
import { snd_SfxVolume, snd_MusicVolume, set_snd_SfxVolume, set_snd_MusicVolume,
  gameepisode, gamemap, gamemode } from './doomstat.js';
import { ANG90, ANGLETOFINESHIFT, FINEMASK, finecosine, finesine } from './tables.js';
import { R_PointToAngle2 } from './r_bsp.js';
import { M_Random } from './m_random.js';
import { GameMode_t } from './doomdef.js';

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

// s_sound.c — Doom 1 E4 substitute music (E4 reuses the E2/E3 tracks).
const _spmus = [
  1 /*mus_e3m4*/, 2 /*mus_e3m2*/, 3 /*mus_e3m3*/, 4 /*mus_e1m5*/,
  5 /*mus_e2m7*/, 6 /*mus_e2m4*/, 7 /*mus_e2m6*/, 8 /*mus_e2m5*/,
  9 /*mus_e1m9*/,
];

export function S_Start() {
  // s_sound.c:159 — stop everything before level swap.
  for (let i = 0; i < NUM_CHANNELS; i++) {
    const ch = channels[i];
    if (ch.handle !== 0) I.I_StopSound(ch.handle);
    ch.sfxinfo = null; ch.origin = null; ch.handle = 0;
  }
  // s_sound.c:172 — pick the level music. mus enum order in sounds.h
  // matches our _musicNames indexing.
  let mnum;
  if (gamemode === GameMode_t.commercial) {
    mnum = 33 /*mus_runnin*/ + gamemap - 1;
  } else {
    // Doom 1 uses (ep-1)*9 + map. E4 routes through the spmus[] substitution
    // table (E4 reuses tracks from E1-E3 since the IWAD has no D_E4M* lumps).
    if (gameepisode < 4) {
      mnum = 1 /*mus_e1m1*/ + (gameepisode - 1) * 9 + gamemap - 1;
    } else {
      mnum = _spmus[gamemap - 1];
    }
  }
  S_ChangeMusic(mnum, true);
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

// s_sound.c:559 — bit-exact stereo math. R_PointToAngle2 + finesine produces
// the same separation curve as vanilla; Math.atan2 + Math.sin do not (the
// double-precision path drifts by a few BAM and breaks demo determinism).
const S_STEREO_SWING = 96 * 65536;

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
  // BAM separation: angle from listener to source minus listener angle.
  // angle > ANG180 means the source is to the LEFT; vanilla subtracts so
  // we end up sweeping sep across [NORM_SEP - SWING, NORM_SEP + SWING].
  let angle = R_PointToAngle2(lmo.x, lmo.y, source.x, source.y) >>> 0;
  if (angle > lmo.angle >>> 0) angle = (angle - lmo.angle) >>> 0;
  else                         angle = (angle + (0xffffffff - lmo.angle) + 1) >>> 0;
  const fa = (angle >>> ANGLETOFINESHIFT) & FINEMASK;
  let sep = NORM_SEP - (((finesine[fa] * S_STEREO_SWING) >> 24) | 0);
  if (sep < 0)   sep = 0;
  if (sep > 255) sep = 255;
  return { vol, sep, pitch: NORM_PITCH };
}

// sfx ids that bypass pitch perturbation — itemup and tink stay clean.
const _SFX_ITEMUP = 32;
const _SFX_TINK   = 33; // sfx_tink — vanilla actually fixes only itemup/tink.

export function S_StartSound(origin, sfxid) {
  if (sfxid <= 0 || sfxid >= S_sfx.length) return;
  let sfx = S_sfx[sfxid];
  let priority = sfx.priority;
  let volBoost = 0;
  let pitch = NORM_PITCH;

  // s_sound.c:362 — honor sfx->link. The linked entry's priority/pitch/volume
  // override the originally-requested sfx. Used by sfx_chgun -> sfx_pistol so
  // the chaingun fires the pistol's sample at pitch 150.
  if (sfx.link !== undefined && sfx.link !== null) {
    const linked = S_sfx[sfx.link];
    pitch    = (sfx.pitch  !== undefined && sfx.pitch  !== 0) ? sfx.pitch  : NORM_PITCH;
    volBoost = (sfx.volume !== undefined) ? sfx.volume : 0;
    priority = linked.priority;
    sfxid    = sfx.link;
    sfx      = linked;
  }

  // s_sound.c:326 — pitch perturbation uses M_Random, NOT P_Random.
  // M_Random has a separate counter from P_Random precisely so cosmetic
  // jitter like sound pitch doesn't consume demo-deterministic RNG. Using
  // P_Random here desyncs every demo on the first sfx played.
  if (sfxid >= 11 /*sfx_sawup*/ && sfxid <= 14 /*sfx_sawhit*/) {
    pitch = (pitch + 8 - (M_Random() & 15)) | 0;
    if (pitch < 0)   pitch = 0;
    if (pitch > 255) pitch = 255;
  } else if (sfxid !== _SFX_ITEMUP && sfxid !== _SFX_TINK) {
    pitch = (pitch + 16 - (M_Random() & 31)) | 0;
    if (pitch < 0)   pitch = 0;
    if (pitch > 255) pitch = 255;
  }

  let vol = snd_SfxVolume * 8 + volBoost, sep = NORM_SEP;
  if (origin !== null && origin !== undefined && _listener !== null && origin !== _listener.mo) {
    const p = S_AdjustSoundParams(_listener, origin);
    if (p === null) return; // out of range
    vol = p.vol + volBoost; sep = p.sep;
  }
  if (vol <= 0) return;
  // s_sound.c:483 — same-origin replacement: kill any existing channel from
  // this origin so we don't stack chainsaw-on-chainsaw etc.
  if (origin !== null && origin !== undefined) {
    for (let i = 0; i < NUM_CHANNELS; i++) {
      if (channels[i].origin === origin && channels[i].sfxinfo !== null &&
          (sfx.singularity === true || channels[i].sfxinfo === sfx)) {
        if (channels[i].handle !== 0) I.I_StopSound(channels[i].handle);
        channels[i].sfxinfo = null; channels[i].origin = null; channels[i].handle = 0;
        break;
      }
    }
  }
  const ch = getFreeChannel(origin, priority);
  if (ch === -1) return;
  channels[ch].sfxinfo = sfx;
  channels[ch].origin  = origin;
  channels[ch].handle  = I.I_StartSound(sfxid, vol, sep, pitch, priority);
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
