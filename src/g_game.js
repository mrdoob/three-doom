// Ported from: linuxdoom-1.10/g_game.c, g_game.h
// Game state machine: G_Ticker, demo record/play, level transitions, save/load
// orchestration.
//
// Full C is ~1690 lines, much of which is netgame buffer juggling. The JS port
// keeps the high-level state machine and defers demo recording / play to a
// simpler buffered format.

import * as doomstat from './doomstat.js';
import { gamestate, set_gamestate, gameaction, set_gameaction, gameepisode, gamemap, gameskill,
         set_gameepisode, set_gamemap, set_gameskill, set_levelstarttic, set_leveltime,
         set_totalkills, set_totalitems, set_totalsecret,
         players, playeringame, consoleplayer, gamemode, gametic } from './doomstat.js';
import { gameaction_t } from './d_event.js';
import { GameMode_t, gamestate_t, skill_t } from './doomdef.js';
import { P_Random, M_ClearRandom } from './m_random.js';
import { states, mobjinfo, S_SARG_RUN1, S_SARG_PAIN2,
         MT_BRUISERSHOT, MT_HEADSHOT, MT_TROOPSHOT } from './info.js';

let _deferred = null; // pending gameaction params

// External hooks (wired by d_main.js).
let _loadLevel = null; // async (episode, map, skill) => Promise<void>
export function G_SetExternals(refs) {
  if (refs.loadLevel != null) _loadLevel = refs.loadLevel;
}

export function G_BuildTiccmd(_cmd) {
  // Browser port reads input via d_keyboard.js — this is left as a no-op so
  // upstream callers don't blow up.
}

export function G_Responder(ev) {
  // Forward to UI overlays first (menu / automap / wipe / finale / intermission).
  if (ev === undefined || ev === null) return false;
  return false;
}

export function G_Ticker() {
  // g_game.c:G_Ticker uses `while (gameaction != ga_nothing)` so chained
  // actions (e.g. ga_newgame queues ga_loadlevel) drain in one tic instead
  // of taking N tics to settle. Match that with a drain loop and a guard
  // against infinite cycles.
  let guard = 32;
  while (gameaction !== gameaction_t.ga_nothing && guard-- > 0) {
    const a = gameaction;
    switch (a) {
      case gameaction_t.ga_loadlevel:  G_DoLoadLevel();   break;
      case gameaction_t.ga_newgame:    G_DoNewGame();     break;
      case gameaction_t.ga_loadgame:   G_DoLoadGame();    set_gameaction(gameaction_t.ga_nothing); break;
      case gameaction_t.ga_savegame:   G_DoSaveGame();    set_gameaction(gameaction_t.ga_nothing); break;
      case gameaction_t.ga_playdemo:   G_DoPlayDemo();    break;
      case gameaction_t.ga_completed:  G_DoCompleted();   set_gameaction(gameaction_t.ga_nothing); break;
      case gameaction_t.ga_victory:    G_DoVictory();     set_gameaction(gameaction_t.ga_nothing); break;
      case gameaction_t.ga_worlddone:  G_DoWorldDone();   set_gameaction(gameaction_t.ga_nothing); break;
      case gameaction_t.ga_screenshot: G_ScreenShot();    set_gameaction(gameaction_t.ga_nothing); break;
      default: set_gameaction(gameaction_t.ga_nothing); break;
    }
    // If the handler didn't advance gameaction we'd loop forever; break out.
    if (gameaction === a) break;
  }
  // NB: P_Ticker / M_Ticker / ST_Ticker etc. are dispatched from d_main's
  // 35Hz accumulator instead of from here. Vanilla g_game.c:G_Ticker calls
  // them in sequence based on gamestate; the JS architecture routes those
  // through d_main so this function only handles the gameaction queue.
}

// Player state transitions.
export function G_PlayerFinishLevel(player) {
  for (let i = 0; i < 6; i++) player.powers[i] = 0;
  for (let i = 0; i < 6; i++) player.cards[i] = false;
  if (player.mo !== null) player.mo.flags &= ~0x40000; // MF_SHADOW
  player.extralight = 0; player.fixedcolormap = 0; player.damagecount = 0; player.bonuscount = 0;
}

// g_game.c:800 — reset everything except {frags, killcount, itemcount, secretcount},
// then re-initialise. C does `memset(p, 0, sizeof(*p))` followed by writes; we
// imitate by zeroing each field explicitly (player_t has fixed shape).
export function G_PlayerReborn(playernum) {
  const p = players[playernum];
  if (p === undefined || p === null) return;
  // C does memcpy back into the same array — preserve identity, only snapshot values.
  const fragsSnap = new Int32Array(p.frags);
  const killcount = p.killcount, itemcount = p.itemcount, secretcount = p.secretcount;
  // Zero scalars.
  p.mo = null;
  p.viewz = 0;
  p.viewheight = 41 * 65536 /*VIEWHEIGHT*/;
  p.deltaviewheight = 0;
  p.bob = 0;
  p.armorpoints = 0;
  p.armortype = 0;
  p.backpack = false;
  p.attackdown = 1; // p_user.c: true so it doesn't auto-fire after rebirth
  p.usedown = 1;
  p.cheats = 0;
  p.refire = 0;
  p.message = null;
  p.damagecount = 0;
  p.bonuscount = 0;
  p.attacker = null;
  p.extralight = 0;
  p.fixedcolormap = 0;
  p.colormap = 0;
  p.didsecret = false;
  // Zero arrays.
  for (let i = 0; i < p.powers.length; i++) p.powers[i] = 0;
  for (let i = 0; i < p.cards.length;  i++) p.cards[i]  = false;
  for (let i = 0; i < p.weaponowned.length; i++) p.weaponowned[i] = false;
  for (let i = 0; i < p.ammo.length;    i++) p.ammo[i]    = 0;
  for (let i = 0; i < p.maxammo.length; i++) p.maxammo[i] = 0;
  for (const psp of p.psprites) { psp.state = -1; psp.tics = 0; psp.sx = 0; psp.sy = 32 << 16; }
  // Restore preserved stats (write in place to keep array identity stable).
  for (let i = 0; i < p.frags.length; i++) p.frags[i] = fragsSnap[i];
  p.killcount = killcount; p.itemcount = itemcount; p.secretcount = secretcount;
  // p_user.c MAXHEALTH = 100. Default loadout: fist, pistol, 50 clip; maxammo
  // from d_items.maxammo[] (clip 200, shell 50, cell 300, missile 50).
  p.playerstate = 0 /*PST_LIVE*/;
  p.health = 100;
  p.readyweapon = p.pendingweapon = 1 /*wp_pistol*/;
  p.weaponowned[0 /*wp_fist*/]   = true;
  p.weaponowned[1 /*wp_pistol*/] = true;
  p.ammo[0 /*am_clip*/] = 50;
  p.maxammo[0] = 200; p.maxammo[1] = 50; p.maxammo[2] = 300; p.maxammo[3] = 50;
}

export function G_DoReborn(playernum) { G_PlayerReborn(playernum); }

export function G_DoLoadLevel() {
  set_gamestate(gamestate_t.GS_LEVEL);
  // g_game.c:470 — `levelstarttic = gametic` for par-time math.
  set_levelstarttic(gametic);
  set_leveltime(0);
  set_totalkills(0); set_totalitems(0); set_totalsecret(0);
  if (_deferred !== null && _deferred.kind === 'newgame') {
    G_InitNew(_deferred.skill, _deferred.episode, _deferred.map);
    _deferred = null;
  }
  // g_game.c:477-482 — revive dead players + reset frags.
  for (let i = 0; i < 4 /*MAXPLAYERS*/; i++) {
    if (playeringame[i] && players[i] !== null && players[i].playerstate === 1 /*PST_DEAD*/) {
      players[i].playerstate = 2 /*PST_REBORN*/;
    }
    if (players[i] !== null && players[i] !== undefined && players[i].frags) {
      for (let j = 0; j < players[i].frags.length; j++) players[i].frags[j] = 0;
    }
  }
  set_gameaction(gameaction_t.ga_nothing);
  if (_loadLevel !== null) _loadLevel(gameepisode, gamemap, gameskill);
}

export function G_DeferedInitNew(skill, episode, map) {
  _deferred = { kind: 'newgame', skill, episode, map };
  set_gameaction(gameaction_t.ga_newgame);
}

export function G_DoNewGame() {
  // Vanilla g_game.c::G_DoNewGame clears the playback/netgame flags before
  // initialising the new level — otherwise a demo interrupted by `New Game`
  // keeps feeding the player's ticcmd from the demo bytes.
  doomstat.set_demoplayback(false);
  doomstat.set_netgame?.(false);
  if (_deferred !== null && _deferred.kind === 'newgame') {
    G_InitNew(_deferred.skill, _deferred.episode, _deferred.map);
    _deferred = null; // consumed; G_DoLoadLevel shouldn't re-run G_InitNew.
  }
  set_gameaction(gameaction_t.ga_loadlevel);
}

export function G_InitNew(skill, episode, map) {
  if (skill > 4) skill = 4;
  if (skill < 0) skill = 0;
  if (episode < 1) episode = 1;
  if (gamemode === GameMode_t.retail) {
    if (episode > 4) episode = 4;
  } else if (gamemode === GameMode_t.shareware) {
    episode = 1;
  } else if (episode > 3) episode = 3;
  if (map < 1) map = 1;
  // C only clamps to 9 outside commercial (g_game.c:1410-1412); Doom 2 has 32 maps.
  if (gamemode !== GameMode_t.commercial && map > 9) map = 9;
  // g_game.c:1414 — M_ClearRandom resets both prndindex (play sim) and
  // rndindex (misc effects) so demos stay deterministic.
  M_ClearRandom();

  // g_game.c:1416 — respawnmonsters is forced on for Nightmare or -respawn.
  doomstat.set_respawnmonsters(skill === skill_t.sk_nightmare || doomstat.respawnparm);

  // g_game.c:1421 — fastparm / Nightmare speed up demons and projectiles.
  // The adjustment is applied relative to the PREVIOUS gameskill so toggling
  // Nightmare on/off doesn't double-mutate the tables.
  const prevSkill = doomstat.gameskill;
  const goFast = (doomstat.fastparm || skill === skill_t.sk_nightmare) &&
                 prevSkill !== skill_t.sk_nightmare;
  const goSlow = !doomstat.fastparm && skill !== skill_t.sk_nightmare &&
                 prevSkill === skill_t.sk_nightmare;
  if (goFast) {
    for (let i = S_SARG_RUN1; i <= S_SARG_PAIN2; i++) states[i].tics >>= 1;
    mobjinfo[MT_BRUISERSHOT].speed = 20 * 65536;
    mobjinfo[MT_HEADSHOT].speed    = 20 * 65536;
    mobjinfo[MT_TROOPSHOT].speed   = 20 * 65536;
  } else if (goSlow) {
    for (let i = S_SARG_RUN1; i <= S_SARG_PAIN2; i++) states[i].tics <<= 1;
    mobjinfo[MT_BRUISERSHOT].speed = 15 * 65536;
    mobjinfo[MT_HEADSHOT].speed    = 10 * 65536;
    mobjinfo[MT_TROOPSHOT].speed   = 10 * 65536;
  }

  // g_game.c:1440 — force every active player to respawn on first map load.
  for (let i = 0; i < players.length; i++) {
    if (players[i] !== null && players[i] !== undefined) {
      players[i].playerstate = 2 /*PST_REBORN*/;
    }
  }
  doomstat.set_usergame(true);
  doomstat.set_paused(false);
  doomstat.set_demoplayback(false);
  doomstat.set_automapactive(false);

  set_gameskill(skill);
  set_gameepisode(episode);
  set_gamemap(map);
  // NB: vanilla does NOT touch levelstarttic here — it's set in G_DoLoadLevel
  // to `gametic` so par-time math measures from level start, not session start.
}

// Demo playback. Ports g_game.c::G_ReadDemoTiccmd / G_DoPlayDemo /
// G_CheckDemoStatus. The lump format is:
//   [VERSION, skill, episode, map, deathmatch, respawnparm, fastparm,
//    nomonsters, consoleplayer, playeringame[0..3],
//    {forwardmove, sidemove, angleturn>>8, buttons}* , DEMOMARKER(0x80)]
const DEMOMARKER = 0x80;
const DEMO_VERSION = 109; // Doom v1.9 — what the shareware DEMO1..3 lumps were recorded as.

let _demoBytes = null;
let _demoPos = 0;
let _demoName = '';
let _onDemoEnd = null;

// Caller passes either a lump-name string ("DEMO1") OR a Uint8Array.
export function G_DeferedPlayDemo(nameOrBytes) {
  _deferred = { kind: 'playdemo', source: nameOrBytes };
  set_gameaction(gameaction_t.ga_playdemo);
}

export function G_DoPlayDemo() {
  if (_deferred === null || _deferred.kind !== 'playdemo') return;
  set_gameaction(gameaction_t.ga_nothing);
  let bytes;
  if (typeof _deferred.source === 'string') {
    _demoName = _deferred.source;
    if (typeof globalThis.__W_CacheLumpName === 'function') {
      bytes = globalThis.__W_CacheLumpName(_demoName);
    } else {
      // Fall back to dynamic import — synchronous WAD cache hits don't need
      // to await, but we need a sync handle. Best-effort.
      bytes = null;
    }
  } else {
    _demoName = '';
    bytes = _deferred.source;
  }
  if (bytes === null || bytes === undefined || bytes.length < 13) return;
  _demoBytes = bytes;
  _demoPos = 0;
  // Header: skip & validate VERSION byte (vanilla bails on mismatch).
  const v = _demoBytes[_demoPos++];
  if (v !== DEMO_VERSION) {
    console.warn(`Demo ${_demoName} version ${v} != engine ${DEMO_VERSION}; aborting.`);
    _demoBytes = null;
    return;
  }
  const skill   = _demoBytes[_demoPos++];
  const episode = _demoBytes[_demoPos++];
  const map     = _demoBytes[_demoPos++];
  _demoPos++; // deathmatch
  _demoPos++; // respawnparm
  _demoPos++; // fastparm
  _demoPos++; // nomonsters
  _demoPos++; // consoleplayer
  _demoPos += 4; // playeringame[0..3]
  G_InitNew(skill, episode, map);
  doomstat.set_demoplayback(true);
  // Match C g_game.c::G_DoPlayDemo — G_InitNew ends with G_DoLoadLevel, so
  // gamestate flips to GS_LEVEL synchronously, stopping D_PageTicker from
  // racing the next-tic advancedemo and clobbering the queued level load.
  G_DoLoadLevel();
}

export function G_ReadDemoTiccmd(cmd) {
  if (!doomstat.demoplayback || _demoBytes === null) return false;
  if (_demoBytes[_demoPos] === DEMOMARKER) { G_CheckDemoStatus(); return false; }
  cmd.forwardmove = (_demoBytes[_demoPos++] << 24) >> 24;
  cmd.sidemove    = (_demoBytes[_demoPos++] << 24) >> 24;
  cmd.angleturn   = (_demoBytes[_demoPos++] & 0xff) << 8;
  cmd.buttons     =  _demoBytes[_demoPos++] & 0xff;
  return true;
}

export function G_PlayDemo(nameOrBytes) { G_DeferedPlayDemo(nameOrBytes); }
export function G_TimeDemo(nameOrBytes) { G_DeferedPlayDemo(nameOrBytes); }

// G_CheckDemoStatus — called when the DEMOMARKER is hit. Stop playback and
// hand control back to the title-screen attract sequence.
export function G_CheckDemoStatus() {
  if (!doomstat.demoplayback) return false;
  doomstat.set_demoplayback(false);
  _demoBytes = null; _demoPos = 0;
  if (_onDemoEnd !== null) _onDemoEnd();
  return true;
}
export function G_SetDemoEndCallback(fn) { _onDemoEnd = fn; }

// Demo recording — append ticcmd bytes to a buffer; user can pull the result
// via G_StopDemo(). Mirrors vanilla g_game.c::G_WriteDemoTiccmd.
let _recordBuf = null, _recordName = '';
export function G_RecordDemo(name) {
  _recordName = name;
  _recordBuf = [];
  // Header: vmajor, vminor (Doom v1.9 = 109), skill, ep, map, dm, respawn,
  // fast, nomonsters, consoleplayer, players[0..3] active.
  _recordBuf.push(109, gameskill, gameepisode, gamemap,
                  0 /*deathmatch*/, 0 /*respawnparm*/, 0 /*fastparm*/, 0 /*nomonsters*/, 0 /*consoleplayer*/);
  for (let i = 0; i < 4; i++) _recordBuf.push(i === 0 ? 1 : 0);
}
export function G_WriteDemoTiccmd(cmd) {
  if (_recordBuf === null) return;
  // g_game.c:1512 — angleturn is rounded to nearest 256 before packing:
  // ((angleturn + 128) >> 8). The matching G_ReadDemoTiccmd left-shifts the
  // stored byte back into the high bits (<<8), so without the +128 the
  // playback angle is always biased one low-byte step below the recorded
  // value, causing cumulative demo desync.
  _recordBuf.push(cmd.forwardmove & 0xff, cmd.sidemove & 0xff,
                  ((cmd.angleturn + 128) >> 8) & 0xff, cmd.buttons & 0xff);
}
export function G_StopDemo() {
  if (_recordBuf === null) return null;
  _recordBuf.push(0x80 /*DEMOMARKER*/);
  const out = new Uint8Array(_recordBuf);
  _recordBuf = null;
  return { name: _recordName, bytes: out };
}

// Save/Load orchestration — defer to p_saveg.
let _savegSlot = 0, _savegDesc = '';
export function G_SaveGame(slot, description) {
  _savegSlot = slot; _savegDesc = description;
  set_gameaction(gameaction_t.ga_savegame);
}
export function G_DoSaveGame() {
  // p_saveg.P_SaveGame called by the host that has loaded that module.
  if (typeof globalThis !== 'undefined' && globalThis.__P_SaveGame !== undefined) {
    globalThis.__P_SaveGame(_savegSlot, _savegDesc);
  }
}
let _loadName = '';
export function G_LoadGame(name) { _loadName = name; set_gameaction(gameaction_t.ga_loadgame); }
export function G_DoLoadGame() {
  if (typeof globalThis !== 'undefined' && globalThis.__P_LoadGame !== undefined) {
    globalThis.__P_LoadGame(_loadName);
  }
}

// Level completion / world transitions.
export function G_DoCompleted() {
  // wbstartstruct construction would go here; for now jump to intermission.
  set_gamestate(gamestate_t.GS_INTERMISSION);
}
export function G_DoVictory() {
  set_gamestate(gamestate_t.GS_FINALE);
}
export function G_WorldDone() {
  set_gameaction(gameaction_t.ga_worlddone);
}
export function G_DoWorldDone() {
  set_gamestate(gamestate_t.GS_LEVEL);
  set_gamemap(gamemap + 1);
  set_gameaction(gameaction_t.ga_loadlevel);
}
// g_game.c:897 — random DM spawn (vanilla uses P_Random).
export function G_DeathMatchSpawnPlayer(playernum) {
  const ds = doomstat;
  const dms = ds.deathmatchstarts || [];
  const choice = dms.length > 0
    ? dms[P_Random() % dms.length]
    : (ds.playerstarts && ds.playerstarts[playernum]);
  if (choice === undefined || typeof globalThis.__P_SpawnPlayer !== 'function') return;
  globalThis.__P_SpawnPlayer(choice);
}

export function G_ExitLevel()       { set_gameaction(gameaction_t.ga_completed); }
export function G_SecretExitLevel() { set_gameaction(gameaction_t.ga_completed); }
// Expose to non-importing call sites (p_spec.js, p_enemy.js) to avoid cycles.
if (typeof globalThis !== 'undefined') {
  globalThis.__G_ExitLevel       = G_ExitLevel;
  globalThis.__G_SecretExitLevel = G_SecretExitLevel;
}
export function G_ScreenShot()     { /* hooked elsewhere */ }
