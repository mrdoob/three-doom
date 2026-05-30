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

// s_sound.h MAX_CHANNELS = 8 in vanilla. The m_misc.c config default for
// snd_channels is 3 (likely a leftover from DMX tuning); 8 matches the
// release-build cap and what most ports ship with.
const NUM_CHANNELS = 8;
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
  // s_sound.c:214 — clear any held pause before starting the level track.
  _musPaused = false;
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

// s_sound.c S_StopChannel — stop the sound on channel cnum and free the slot.
function S_StopChannel(cnum) {
  const c = channels[cnum];
  if (c.sfxinfo !== null) {
    if (c.handle !== 0 && I.I_SoundIsPlaying(c.handle)) I.I_StopSound(c.handle);
    c.sfxinfo = null; c.origin = null; c.handle = 0;
  }
}

// A channel is free if empty or its sound has already finished. Vanilla frees
// finished channels in S_UpdateSounds; reaping them here too is purely additive
// (it recovers a slot sooner, never plays a wrong sound).
function isChannelFree(cnum) {
  const c = channels[cnum];
  if (c.sfxinfo === null) return true;
  if (c.handle === 0 || !I.I_SoundIsPlaying(c.handle)) {
    c.sfxinfo = null; c.origin = null; c.handle = 0;
    return true;
  }
  return false;
}

// s_sound.c:471 S_StopSound(origin) — stop the FIRST channel sharing this origin,
// regardless of which sfx it is (one sound per origin), then break. Used both as
// the public stop-by-origin and as the pre-step before claiming a channel.
function S_StopSoundOrigin(origin) {
  for (let i = 0; i < NUM_CHANNELS; i++) {
    if (channels[i].sfxinfo !== null && channels[i].origin === origin) {
      S_StopChannel(i);
      break;
    }
  }
}

// s_sound.c:827 S_getChannel — returns a channel index for {origin, sfx}, or -1
// if none is free and nothing lower-priority can be evicted. NOTE: in Doom a
// LOWER priority NUMBER means a MORE important sound; a new sound may only evict
// a channel whose number is >= its own (vanilla breaks on the FIRST such
// channel in index order — it does NOT hunt for the global minimum).
function S_getChannel(origin, sfx) {
  let cnum;
  // Find an open channel (or reuse one already playing from this origin).
  for (cnum = 0; cnum < NUM_CHANNELS; cnum++) {
    if (isChannelFree(cnum)) break;
    else if (origin !== null && channels[cnum].origin === origin) {
      S_StopChannel(cnum);
      break;
    }
  }
  // None available: kick the first equally-or-less-important channel.
  if (cnum === NUM_CHANNELS) {
    for (cnum = 0; cnum < NUM_CHANNELS; cnum++) {
      if (channels[cnum].sfxinfo.priority >= sfx.priority) break;
    }
    if (cnum === NUM_CHANNELS) return -1; // every channel is strictly more important
    S_StopChannel(cnum);
  }
  channels[cnum].sfxinfo = sfx;
  channels[cnum].origin  = origin;
  return cnum;
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

// Stereo math is kept bit-exact: R_PointToAngle2 + finesine reproduces vanilla's
// separation curve; Math.atan2 + Math.sin would drift by a few BAM.
function S_AdjustSoundParams(listener, source) {
  if (listener === null || listener.mo === undefined || listener.mo === null) {
    return { vol: snd_SfxVolume * 8, sep: NORM_SEP, pitch: NORM_PITCH };
  }
  const lmo = listener.mo;
  const dx = source.x - lmo.x;
  const dy = source.y - lmo.y;
  let adist = approxDist(dx, dy);
  // s_sound.c:773 — map 8 (the episode boss arena) never clips by distance.
  if (gamemap !== 8 && adist > S_CLIPPING_DIST) return null;
  // Volume is computed in snd_SfxVolume units (0..15) then scaled *8 to the
  // 0..127 range i_sound.js expects (15*8 = 120 ~= 127 peak).
  let vol;
  if (adist < S_CLOSE_DIST) {
    vol = snd_SfxVolume * 8;
  } else if (gamemap === 8) {
    // s_sound.c:800 — boss-arena taper floored at 15/15 so it stays loud.
    if (adist > S_CLIPPING_DIST) adist = S_CLIPPING_DIST;
    vol = (120 + (snd_SfxVolume * 8 - 120) *
          (S_CLIPPING_DIST - adist) / (S_CLIPPING_DIST - S_CLOSE_DIST)) | 0;
  } else {
    vol = ((snd_SfxVolume * 8) * (S_CLIPPING_DIST - adist) / (S_CLIPPING_DIST - S_CLOSE_DIST)) | 0;
  }
  // s_sound.c:600 — if source and listener share the same XY, pin sep to
  // NORM_SEP so the centre-pan stays stable. Otherwise R_PointToAngle2 of
  // a zero vector returns 0 and the angle-relative sin landed on whatever
  // -listener_angle happened to be, producing a non-centre pan.
  let sep;
  if (source.x === lmo.x && source.y === lmo.y) {
    sep = NORM_SEP;
  } else {
    // BAM separation: angle from listener to source minus listener angle.
    // Vanilla's else branch adds (0xffffffff - listener->angle), i.e. subtracts
    // (listener->angle + 1) mod 2^32 — keep it byte-exact (no extra +1).
    let angle = R_PointToAngle2(lmo.x, lmo.y, source.x, source.y) >>> 0;
    if (angle > (lmo.angle >>> 0)) angle = (angle - lmo.angle) >>> 0;
    else                           angle = (angle + (0xffffffff - lmo.angle)) >>> 0;
    const fa = (angle >>> ANGLETOFINESHIFT) & FINEMASK;
    // s_sound.c:793  *sep = 128 - (FixedMul(S_STEREO_SWING,finesine[angle])>>16)
    //  with S_STEREO_SWING = 96*FRACUNIT, so the offset is (96*finesine)>>16.
    //  96*finesine stays within int32 (96*65536 = 6291456), so a single >>16 is exact.
    sep = NORM_SEP - ((96 * finesine[fa]) >> 16);
    if (sep < 0)   sep = 0;
    if (sep > 255) sep = 255;
  }
  return { vol, sep, pitch: NORM_PITCH };
}

// sfx ids that bypass the wide pitch perturbation — only itemup and tink stay
// clean. The chainsaw band (sawup..sawhit) instead gets the narrow ±8 jitter.
const _SFX_ITEMUP = 32; // sfx_itemup
const _SFX_TINK   = 87; // sfx_tink
const _SFX_SAWUP  = 10; // sfx_sawup
const _SFX_SAWHIT = 13; // sfx_sawhit
const NORM_PRIORITY = 64;

// s_sound.c:397 — S_StartSound plays sfxid at the menu's current SFX volume.
export function S_StartSound(origin, sfxid) {
  S_StartSoundAtVolume(origin, sfxid, snd_SfxVolume);
}

// s_sound.c:254 — S_StartSoundAtVolume. `volume` is in snd_SfxVolume units
// (0..15). Positional sounds discard it and re-derive volume from distance
// (vanilla quirk); non-positional sounds play at `volume` directly.
export function S_StartSoundAtVolume(origin, sfxid, volume) {
  if (origin === undefined) origin = null;
  // s_sound.c:277 — bogus sfx # guard (vanilla I_Errors; we just bail).
  if (sfxid <= 0 || sfxid >= S_sfx.length) return;
  const sfx = S_sfx[sfxid];

  // s_sound.c:283 — honor sfx->link. The link's pitch/volume bias the request
  // (sfx_chgun -> sfx_pistol at pitch 150). We do NOT substitute the sfx id:
  // vanilla passes the ORIGINAL id to I_StartSound (the data alias resolves the
  // sample), and our i_sound dspistol fallback resolves the absent DSCHGUN lump
  // the same way — so the chaingun keeps id sfx_chgun (out of the i_sound
  // single-instance dedup list, exactly like vanilla).
  let pitch, priority;
  if (sfx.link !== undefined && sfx.link !== null) {
    pitch    = sfx.pitch;     // sfx_chgun: 150
    priority = sfx.priority;  // original sfx's priority field
    volume  += (sfx.volume !== undefined) ? sfx.volume : 0;
    if (volume < 1) return;
    if (volume > snd_SfxVolume) volume = snd_SfxVolume;
  } else {
    pitch    = NORM_PITCH;
    priority = NORM_PRIORITY;
  }

  // s_sound.c:302 — positional sounds re-derive vol/sep from distance; an
  // out-of-range source is dropped BEFORE any M_Random is rolled (vanilla tests
  // audibility only on this path — s_sound.c:817 `return (*vol>0)`).
  let vol = volume * 8, sep = NORM_SEP;
  if (origin !== null && _listener !== null && origin !== _listener.mo) {
    const p = S_AdjustSoundParams(_listener, origin);
    if (p === null) return;   // out of range
    vol = p.vol; sep = p.sep;
    if (vol <= 0) return;
  }

  // s_sound.c:326 — pitch perturbation via M_Random (NOT P_Random: cosmetic
  // jitter must not consume demo-deterministic RNG). The chainsaw band gets ±8;
  // everything except itemup/tink gets ±16. Uses the ORIGINAL sfxid, so
  // sfx_chgun (86) correctly falls in the ±16 branch like vanilla.
  if (sfxid >= _SFX_SAWUP && sfxid <= _SFX_SAWHIT) {
    pitch = (pitch + 8 - (M_Random() & 15)) | 0;
    if (pitch < 0)   pitch = 0;
    if (pitch > 255) pitch = 255;
  } else if (sfxid !== _SFX_ITEMUP && sfxid !== _SFX_TINK) {
    pitch = (pitch + 16 - (M_Random() & 31)) | 0;
    if (pitch < 0)   pitch = 0;
    if (pitch > 255) pitch = 255;
  }

  // s_sound.c:349 — kill any sound already playing from this origin (one sound
  // per origin), then claim a channel (priority preemption is inside S_getChannel).
  S_StopSoundOrigin(origin);
  const cnum = S_getChannel(origin, sfx);
  if (cnum === -1) return;
  channels[cnum].handle = I.I_StartSound(sfxid, vol, sep, pitch, priority);
}

export function S_StopSound(origin) {
  // s_sound.c:471 — stop the first channel from this origin, then break.
  S_StopSoundOrigin(origin);
}

export function S_SetListener(player) { _listener = player; }

// ---------- Music ----------
import { W_CheckNumForName, W_CacheLumpNum } from './w_wad.js';

// sounds.c S_music[] — name (sans "D_" prefix) indexed by the mus_* enum in
// sounds.js. Index 0 is mus_None. The Doom 2 tracks (33+) are unreachable from
// shareware doom1.wad, but the table mirrors vanilla so commercial/finale
// music (mus_evil etc.) resolves on a full IWAD.
const _musicNames = [
  'NONE','E1M1','E1M2','E1M3','E1M4','E1M5','E1M6','E1M7','E1M8','E1M9',
  'E2M1','E2M2','E2M3','E2M4','E2M5','E2M6','E2M7','E2M8','E2M9',
  'E3M1','E3M2','E3M3','E3M4','E3M5','E3M6','E3M7','E3M8','E3M9',
  'INTER','INTRO','BUNNY','VICTOR','INTROA',
  'RUNNIN','STALKS','COUNTD','BETWEE','DOOM','THE_DA','SHAWN','DDTBLU','IN_CIT','DEAD',
  'STLKS2','THEDA2','DOOM2','DDTBL2','RUNNI2','DEAD2','STLKS3','ROMERO','SHAWN2','MESSAG',
  'COUNT2','DDTBL3','AMPIE','THEDA3','ADRIAN','MESSG2','ROMER2','TENSE','SHAWN3','OPENIN',
  'EVIL','ULTIMA','READ_M','DM2TTL','DM2INT',
];
let _musicHandle = 0;
// s_sound.c:124 — `static musicinfo_t* mus_playing`. We track the currently
// playing music number (0 = none) so S_ChangeMusic can early-out when the
// requested track is already playing.
let _musPlaying = 0;
// s_sound.c:121 — `static boolean mus_paused`. Guards S_PauseSound/S_ResumeSound
// so a double-pause (e.g. menu pause + KEY_PAUSE) can't double-toggle the song.
let _musPaused = false;

export function S_StartMusic(id) { S_ChangeMusic(id, false); }
export function S_ChangeMusic(musicnum, looping) {
  if (musicnum <= 0 || musicnum >= _musicNames.length) return;
  // s_sound.c:665 — `if (mus_playing == music) return;`. Re-requesting the
  // track that's already playing leaves it running instead of restarting it.
  if (_musPlaying === musicnum) return;
  // s_sound.c:669 — shutdown the old music before loading the new lump.
  S_StopMusic();
  const name = 'D_' + _musicNames[musicnum];
  const lumpnum = W_CheckNumForName(name);
  if (lumpnum === -1) return;
  const bytes = W_CacheLumpNum(lumpnum, 0);
  _musicHandle = I.I_RegisterSong(bytes);
  I.I_PlaySong(_musicHandle, !!looping);
  _musPlaying = musicnum;
}
export function S_StopMusic() {
  // s_sound.c:689 — stop + unregister the song and clear mus_playing.
  if (_musPlaying !== 0) {
    if (_musPaused === true) I.I_ResumeSong(_musicHandle); // s_sound.c:693
    I.I_StopSong(_musicHandle);
    I.I_UnRegisterSong(_musicHandle);
    _musPaused = false;
    _musPlaying = 0;
  }
}
// s_sound.c:497 / :506 — pause/resume the playing song during game PAUSE.
export function S_PauseSound() {
  if (_musPlaying !== 0 && _musPaused === false) {
    I.I_PauseSong(_musicHandle);
    _musPaused = true;
  }
}
export function S_ResumeSound() {
  if (_musPlaying !== 0 && _musPaused === true) {
    I.I_ResumeSong(_musicHandle);
    _musPaused = false;
  }
}

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
