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
         totalkills, totalitems, totalsecret, leveltime,
         secretexit, set_secretexit,
         players, playeringame, consoleplayer, gamemode, gametic } from './doomstat.js';
import { WI_Start, WI_Stop } from './wi_stuff.js';
import { M_ScreenShot } from './m_misc.js';
import { gameaction_t, BT_SPECIAL, BT_SPECIALMASK, BTS_PAUSE } from './d_event.js';
import { GameMode_t, gamestate_t, skill_t, MAXPLAYERS } from './doomdef.js';
import { P_Random, M_ClearRandom } from './m_random.js';
import { states, mobjinfo, S_SARG_RUN1, S_SARG_PAIN2,
         MT_BRUISERSHOT, MT_HEADSHOT, MT_TROOPSHOT } from './info.js';
import { S_PauseSound, S_ResumeSound } from './s_sound.js';
import { F_StartFinale, F_Stop } from './f_finale.js';
import { F_ShouldStartCommercialFinale } from './f_finale_logic.js';
import { G_SecretExitAvailable } from './g_game_logic.js';
import {
  DEMO_DEFAULT_BUFFER_SIZE,
  DEMO_MARKER,
  DEMO_VERSION,
  G_DecodeDemoTiccmd,
  G_DemoCanWriteTiccmd,
  G_EncodeDemoTiccmd,
  G_ValidateDemoStream,
} from './g_demo.js';
import { G_BeginTimeDemoSample, G_CompleteTimeDemoSample } from './g_timedemo.js';
import { I_Error, I_GetTime } from './i_system.js';
import { M_CheckParm, myargc, myargv } from './m_argv.js';
import { W_CheckNumForName } from './w_wad.js';
import {
  G_DeathMatchSpawnPlayer as G_RunDeathMatchSpawnPlayer,
  G_DoReborn as G_RunDoReborn,
} from './g_multiplayer.js';
import { G_NextDisplayPlayer, G_ShouldCycleDisplayPlayer } from './g_spy_logic.js';
import { G_BuildIntermissionInfo } from './g_completion.js';
import { GGSAVED } from './d_englsh.js';

let _deferred = null; // pending gameaction params

// External hooks (wired by d_main.js). Level setup and save restoration are
// deliberately synchronous: G_Ticker must see the fully restored world before
// it continues the same tic into P_Ticker.
let _loadLevel = null;
let _spawnPlayer = null;
let _checkSpot = null;
let _saveGame = null;
let _readSave = null;
let _restoreSave = null;
let _validateSaveMap = null;
let _loadAfterSetup = null;
export function G_SetExternals(refs) {
  if (refs.loadLevel != null) _loadLevel = refs.loadLevel;
  if (refs.P_SpawnPlayer != null) _spawnPlayer = refs.P_SpawnPlayer;
  if (refs.G_CheckSpot != null) _checkSpot = refs.G_CheckSpot;
  if (refs.saveGame != null) _saveGame = refs.saveGame;
  if (refs.readSave != null) _readSave = refs.readSave;
  if (refs.restoreSave != null) _restoreSave = refs.restoreSave;
  if (refs.validateSaveMap != null) _validateSaveMap = refs.validateSaveMap;
}

// g_game.c:237 — G_BuildTiccmd. Browser port lives in d_keyboard.js, which
// owns the gamekeydown[]/mouse state since the DOM event listeners feed it
// directly. G_BuildTiccmd delegates so external callers (P_Ticker drivers,
// future D_ProcessEvents) get the same input pipeline.
export async function G_BuildTiccmd(player) {
  if (player === null || player === undefined) return;
  const dk = await import('./d_keyboard.js');
  dk.D_KeyboardInput.buildCmd(player);
}

// g_game.c:504 — G_Responder. Central event dispatcher: UI overlays get first
// crack, then state-specific handlers, then the play sim. The C source has
// hardcoded `if (X_Responder(ev)) return true` chains; ours dynamic-imports
// the UI modules to avoid circular dependencies at module load time. Caches
// the resolved Responders so steady-state has no async cost.
let _M_Responder = null;
let _AM_Responder = null;
let _WI_Responder = null;
let _F_Responder = null;
let _HU_Responder = null;
let _ST_Responder = null;
async function _ensureResponders() {
  if (_M_Responder === null) _M_Responder  = (await import('./m_menu.js')).M_Responder;
  if (_AM_Responder === null) _AM_Responder = (await import('./am_map.js')).AM_Responder;
  if (_WI_Responder === null) _WI_Responder = (await import('./wi_stuff.js')).WI_Responder;
  if (_F_Responder === null)  _F_Responder  = (await import('./f_finale.js')).F_Responder;
  if (_HU_Responder === null) _HU_Responder = (await import('./hu_stuff.js')).HU_Responder;
  if (_ST_Responder === null) _ST_Responder = (await import('./st_stuff.js')).ST_Responder;
}

export function G_Responder(ev) {
  if (ev === undefined || ev === null) return false;
  // Modules may not be wired on the very first frame; bail safely.
  if (_M_Responder === null) { _ensureResponders(); return false; }

  // Menu first — both vanilla M_Responder and ours own the Esc / arrow / yn
  // dispatch from outside the level too.
  if (_M_Responder(ev) === true) return true;

  // g_game.c:506-519 — after the outer menu responder, F12 cycles the
  // rendered player before attract/demo interception and the level responders.
  // Deathmatch disables normal spying, but single-demo playback is allowed.
  if (G_ShouldCycleDisplayPlayer(
    gamestate,
    ev.type,
    ev.data1,
    doomstat.singledemo,
    doomstat.deathmatch,
  )) {
    doomstat.set_displayplayer(G_NextDisplayPlayer(
      doomstat.displayplayer,
      consoleplayer,
      playeringame,
    ));
    return true;
  }

  if (gamestate === gamestate_t.GS_LEVEL) {
    if (_HU_Responder !== null && _HU_Responder(ev) === true) return true;
    if (_ST_Responder !== null && _ST_Responder(ev) === true) return true;
    if (_AM_Responder !== null && _AM_Responder(ev) === true) return true;
  } else if (gamestate === gamestate_t.GS_INTERMISSION) {
    if (_WI_Responder !== null && _WI_Responder(ev) === true) return true;
  } else if (gamestate === gamestate_t.GS_FINALE) {
    if (_F_Responder !== null && _F_Responder(ev) === true) return true;
  }
  // C funnels keydown into gamekeydown[] here. In the JS port d_keyboard
  // maintains its own keys Set and builds the ticcmd from it, so we just
  // signal 'unhandled' and let the caller continue.
  return false;
}
// Kick off the dynamic imports so the responders are cached by the time
// the first event fires.
_ensureResponders();

export function G_Ticker() {
  // g_game.c:612 — do player reborns if needed.
  for (let i = 0; i < MAXPLAYERS; i++) {
    if (playeringame[i] && players[i] !== null && players[i] !== undefined &&
        players[i].playerstate === 2 /*PST_REBORN*/) {
      G_DoReborn(i);
    }
  }
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
      case gameaction_t.ga_loadgame:   G_DoLoadGame();    break;
      case gameaction_t.ga_savegame:   G_DoSaveGame();    break;
      case gameaction_t.ga_playdemo:   G_DoPlayDemo();    break;
      case gameaction_t.ga_completed:  G_DoCompleted();   break;
      case gameaction_t.ga_victory:    G_DoVictory();     break;
      case gameaction_t.ga_worlddone:  G_DoWorldDone();   break;
      case gameaction_t.ga_screenshot: M_ScreenShot();    set_gameaction(gameaction_t.ga_nothing); break;
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

// g_game.c:697 — the "check for special buttons" block from G_Ticker, split
// out so d_main can run it the instant the ticcmd is built. Vanilla runs it in
// G_Ticker (before the gamestate switch calls P_Ticker -> P_PlayerThink, which
// clears BT_SPECIAL at p_user.c:280); our tic loop builds the cmd after
// G_Ticker, so we invoke this between buildCmd and P_Ticker. Single-player:
// console player only. BTS_SAVEGAME is a netgame flag — saves go via the menu.
export function G_CheckSpecialButtons(player) {
  if (player === null || player === undefined || player.cmd === undefined) return;
  const cmd = player.cmd;
  if ((cmd.buttons & BT_SPECIAL) === 0) return;
  switch (cmd.buttons & BT_SPECIALMASK) {
    case BTS_PAUSE:
      doomstat.set_paused(!doomstat.paused);
      if (doomstat.paused) S_PauseSound();
      else                 S_ResumeSound();
      break;
  }
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

// g_game.c:922 — G_DoReborn.
export function G_DoReborn(playernum) {
  if (doomstat.netgame !== false && (_spawnPlayer === null || _checkSpot === null)) return false;
  return G_RunDoReborn(playernum, {
    netgame: doomstat.netgame,
    deathmatch: doomstat.deathmatch,
    players,
    playerstarts: doomstat.playerstarts,
    queueLoadLevel: () => set_gameaction(gameaction_t.ga_loadlevel),
    G_CheckSpot: _checkSpot,
    G_DeathMatchSpawnPlayer,
    P_SpawnPlayer: _spawnPlayer,
  });
}

export function G_DoLoadLevel() {
  const afterSetup = _loadAfterSetup;
  _loadAfterSetup = null;
  // A queued world transition is processed one tic after the non-level ticker
  // requests it. Retire that still-drawable screen only at the actual exit.
  WI_Stop();
  F_Stop();
  // g_game.c:472-473 — restarting while already displaying a level still
  // melts from the old map into the freshly loaded one.
  if (doomstat.wipegamestate === gamestate_t.GS_LEVEL) {
    doomstat.set_wipegamestate(-1);
  }
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
  for (let i = 0; i < MAXPLAYERS; i++) {
    if (playeringame[i] && players[i] !== null && players[i] !== undefined &&
        players[i].playerstate === 1 /*PST_DEAD*/) {
      players[i].playerstate = 2 /*PST_REBORN*/;
    }
    if (players[i] !== null && players[i] !== undefined && players[i].frags) {
      for (let j = 0; j < players[i].frags.length; j++) players[i].frags[j] = 0;
    }
  }
  set_gameaction(gameaction_t.ga_nothing);
  // g_game.c:494 — a level load clears any pause held over from the menu or a
  // prior level. d_main's load hook clears d_keyboard's queued sendpause with
  // the rest of its browser-local command state after level setup.
  doomstat.set_paused(false);
  if (_loadLevel !== null) _loadLevel(gameepisode, gamemap, gameskill, afterSetup);
  // g_game.c:485 — spying never carries across a level load.
  doomstat.set_displayplayer(consoleplayer);
  // g_game.c sets starttime after P_SetupLevel. Capture both clocks because a
  // browser timedemo can begin after the attract loop has already advanced
  // gametic; its useful result is the number of demo tics, not page lifetime.
  if (doomstat.timingdemo === true) {
    _timeDemoSample = G_BeginTimeDemoSample(_demoName, gametic, I_GetTime());
  }
}

export function G_DeferedInitNew(skill, episode, map) {
  _deferred = { kind: 'newgame', skill, episode, map };
  set_gameaction(gameaction_t.ga_newgame);
}

export function G_DoNewGame() {
  // g_game.c:1373 G_DoNewGame — restore the global flags vanilla resets so a
  // demo or netgame interrupted by 'New Game' doesn't leak its mode into
  // the fresh game.
  doomstat.set_demoplayback(false);
  doomstat.set_singledemo(false);
  if (doomstat.timingdemo === true) {
    doomstat.set_timingdemo(false);
    doomstat.set_singletics(false);
    _timeDemoSample = null;
  }
  doomstat.set_netgame?.(false);
  doomstat.set_deathmatch?.(0);
  doomstat.set_respawnparm?.(false);
  doomstat.set_fastparm?.(false);
  doomstat.set_nomonsters?.(false);
  for (let i = 1; i < MAXPLAYERS; i++) {
    if (doomstat.playeringame !== undefined) doomstat.playeringame[i] = false;
  }
  doomstat.set_consoleplayer?.(0);
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
  // g_game.c:1375 — if starting a new game while paused, resume the song first.
  if (doomstat.paused === true) S_ResumeSound();
  doomstat.set_paused(false);
  doomstat.set_demoplayback(false);
  doomstat.set_automapactive(false);
  doomstat.set_viewactive(true);

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
//    {forwardmove, sidemove, angleturn>>8, buttons}* , DEMO_MARKER(0x80)]

let _demoBytes = null;
let _demoPos = 0;
let _demoName = '';
let _onDemoEnd = null;
let _timeDemoSample = null;
let _timeDemoResult = null;
let _onTimeDemoEnd = null;

function G_CancelPendingTimeDemo() {
  if (doomstat.timingdemo !== true) return;
  doomstat.set_timingdemo(false);
  doomstat.set_singletics(false);
  _timeDemoSample = null;
}

// Caller passes either a lump-name string ("DEMO1") OR a Uint8Array.
export function G_DeferedPlayDemo(nameOrBytes) {
  _deferred = { kind: 'playdemo', source: nameOrBytes };
  set_gameaction(gameaction_t.ga_playdemo);
}

export function G_DoPlayDemo() {
  if (_deferred === null || _deferred.kind !== 'playdemo') return;
  set_gameaction(gameaction_t.ga_nothing);
  const pending = _deferred;
  _deferred = null;
  let bytes;
  if (typeof pending.source === 'string') {
    _demoName = pending.source;
    if (typeof globalThis.__W_CacheLumpName === 'function') {
      bytes = globalThis.__W_CacheLumpName(_demoName);
    } else {
      // Fall back to dynamic import — synchronous WAD cache hits don't need
      // to await, but we need a sync handle. Best-effort.
      bytes = null;
    }
  } else {
    _demoName = '';
    bytes = pending.source;
  }
  const validation = G_ValidateDemoStream(bytes);
  if (validation.valid !== true) {
    console.warn(`Demo ${_demoName || '<memory>'} is invalid: ${validation.error}`);
    _demoBytes = null;
    _demoPos = 0;
    G_CancelPendingTimeDemo();
    doomstat.set_singledemo(false);
    if (_onDemoEnd !== null) _onDemoEnd();
    return false;
  }
  _demoBytes = bytes;
  _demoPos = validation.commandOffset;
  const header = validation.header;
  doomstat.set_deathmatch(header.deathmatch);
  doomstat.set_respawnparm(header.respawn);
  doomstat.set_fastparm(header.fast);
  doomstat.set_nomonsters(header.nomonsters);
  doomstat.set_consoleplayer(header.consoleplayer);
  for (let i = 0; i < MAXPLAYERS; i++) {
    playeringame[i] = header.playeringame[i];
  }
  doomstat.set_netgame(playeringame[1] === true);
  G_InitNew(header.skill, header.episode, header.map);
  G_DoLoadLevel();
  doomstat.set_usergame(false);
  doomstat.set_demoplayback(true);
  return true;
}

export function G_ReadDemoTiccmd(cmd) {
  if (!doomstat.demoplayback || _demoBytes === null) return false;
  if (_demoPos < _demoBytes.length && _demoBytes[_demoPos] === DEMO_MARKER) {
    G_CheckDemoStatus();
    return false;
  }
  if (_demoPos >= _demoBytes.length || _demoPos + 4 > _demoBytes.length) {
    console.warn(`Demo ${_demoName || '<memory>'} ended with a truncated ticcmd`);
    G_CheckDemoStatus('truncated');
    return false;
  }
  _demoPos = G_DecodeDemoTiccmd(_demoBytes, _demoPos, cmd);
  return true;
}

export function G_PlayDemo(nameOrBytes) {
  G_CancelPendingTimeDemo();
  doomstat.set_singledemo(true);
  G_DeferedPlayDemo(nameOrBytes);
}

export function G_TimeDemo(nameOrBytes) {
  _timeDemoResult = null;
  _timeDemoSample = null;
  doomstat.set_singledemo(false);
  doomstat.set_timingdemo(true);
  doomstat.set_singletics(true);
  G_DeferedPlayDemo(nameOrBytes);
}

export function G_GetTimeDemoResult() { return _timeDemoResult; }
export function G_SetTimeDemoEndCallback(fn) { _onTimeDemoEnd = fn; }

// G_CheckDemoStatus — the single playback/recording finalizer. A playback
// marker resets the session flags and returns to the attract loop; recording
// stop paths append their one marker and publish the browser-owned result.
export function G_CheckDemoStatus(reason = 'status') {
  if (doomstat.demoplayback === true) {
    let timeDemoResult = null;
    if (doomstat.timingdemo === true && _timeDemoSample !== null) {
      timeDemoResult = G_CompleteTimeDemoSample(_timeDemoSample, gametic, I_GetTime());
      _timeDemoResult = timeDemoResult;
    }
    if (doomstat.timingdemo === true) {
      doomstat.set_timingdemo(false);
      doomstat.set_singletics(false);
      _timeDemoSample = null;
    }
    doomstat.set_demoplayback(false);
    doomstat.set_netgame?.(false);
    doomstat.set_deathmatch?.(0);
    doomstat.set_respawnparm?.(false);
    doomstat.set_fastparm?.(false);
    doomstat.set_nomonsters?.(false);
    if (doomstat.playeringame !== undefined) {
      for (let i = 1; i < MAXPLAYERS; i++) doomstat.playeringame[i] = false;
    }
    doomstat.set_consoleplayer?.(0);
    doomstat.set_singledemo(false);
    _demoBytes = null; _demoPos = 0;
    if (timeDemoResult !== null) {
      console.info(timeDemoResult.message);
      if (_onTimeDemoEnd !== null) _onTimeDemoEnd(timeDemoResult);
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' &&
          typeof CustomEvent === 'function') {
        window.dispatchEvent(new CustomEvent('doom:timedemo', { detail: timeDemoResult }));
      }
    }
    if (_onDemoEnd !== null) _onDemoEnd();
    return true;
  }

  if (doomstat.demorecording === true && _recordBuf !== null) {
    G_FinalizeDemoRecording(reason);
  }
  return false;
}
export function G_SetDemoEndCallback(fn) { _onDemoEnd = fn; }

// Demo recording — append ticcmd bytes to a buffer; callers can retrieve the
// last finalized result through G_StopDemo() or G_GetDemoRecordingResult().
// Mirrors vanilla g_game.c::G_WriteDemoTiccmd/G_CheckDemoStatus.
let _recordBuf = null, _recordName = '';
let _recordMaxBytes = DEMO_DEFAULT_BUFFER_SIZE;
let _recordResult = null;
let _onRecordingEnd = null;

function G_CommandLineDemoMaxBytes() {
  const parm = M_CheckParm('-maxdemo');
  if (parm !== 0 && parm < myargc - 1) {
    const kibibytes = Number.parseInt(myargv[parm + 1], 10);
    if (Number.isFinite(kibibytes) && kibibytes > 0) return kibibytes * 1024;
  }
  return DEMO_DEFAULT_BUFFER_SIZE;
}

function G_FinalizeDemoRecording(reason = 'status') {
  if (doomstat.demorecording !== true || _recordBuf === null) return _recordResult;
  // Clear ownership before callbacks: a re-entrant stop/status check must see
  // an already-finalized recording and cannot append a second marker.
  doomstat.set_demorecording(false);
  const buffer = _recordBuf;
  _recordBuf = null;
  buffer.push(DEMO_MARKER);
  const normalizedReason = ['manual', 'quit', 'overflow', 'replaced'].includes(reason)
    ? reason
    : 'status';
  _recordResult = Object.freeze({
    name: _recordName,
    filename: `${_recordName}.lmp`,
    reason: normalizedReason,
    bytes: new Uint8Array(buffer),
  });
  if (_onRecordingEnd !== null) _onRecordingEnd(_recordResult);
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' &&
      typeof CustomEvent === 'function') {
    window.dispatchEvent(new CustomEvent('doom:demorecorded', { detail: _recordResult }));
  }
  return _recordResult;
}

export function G_RecordDemo(name, maxBytes = null) {
  if (doomstat.demorecording === true) G_CheckDemoStatus('replaced');
  doomstat.set_usergame(false);
  doomstat.set_demorecording(true);
  _recordName = String(name ?? 'demo');
  const configuredMax = maxBytes === null ? G_CommandLineDemoMaxBytes() : Number(maxBytes);
  _recordMaxBytes = Number.isFinite(configuredMax)
    ? Math.max(14, Math.trunc(configuredMax))
    : DEMO_DEFAULT_BUFFER_SIZE;
  _recordResult = null;
  _recordBuf = [];
  _recordBuf.push(DEMO_VERSION, gameskill, gameepisode, gamemap,
                  doomstat.deathmatch,
                  doomstat.respawnparm ? 1 : 0,
                  doomstat.fastparm ? 1 : 0,
                  doomstat.nomonsters ? 1 : 0,
                  consoleplayer);
  for (let i = 0; i < MAXPLAYERS; i++) _recordBuf.push(playeringame[i] ? 1 : 0);
}
export function G_WriteDemoTiccmd(cmd, quitRequested = false) {
  if (doomstat.demorecording !== true || _recordBuf === null) return false;
  // Native checks gamekeydown['q'] before touching demo_p, then exits through
  // I_Error after finalization. The browser keeps running, so report `quit`
  // and return false to prevent this or any later player command being added.
  if (quitRequested === true) {
    G_CheckDemoStatus('quit');
    return false;
  }
  if (G_DemoCanWriteTiccmd(_recordBuf.length, _recordMaxBytes) !== true) {
    // Native's fixed allocation terminates the process here. Finalize the
    // valid prefix and expose an overflow result instead.
    G_CheckDemoStatus('overflow');
    return false;
  }
  // g_game.c:1506-1522 writes four bytes, rewinds demo_p, then reads those
  // bytes back into the live command. Besides rounding angleturn to the
  // nearest 256, that round-trip applies signed char/short narrowing before
  // this same tic reaches P_Ticker.
  const offset = _recordBuf.length;
  _recordBuf.push(...G_EncodeDemoTiccmd(cmd));
  G_DecodeDemoTiccmd(_recordBuf, offset, cmd);
  return true;
}
export function G_StopDemo() {
  if (doomstat.demorecording === true) G_CheckDemoStatus('manual');
  return _recordResult;
}
export function G_GetDemoRecordingResult() { return _recordResult; }
export function G_SetDemoRecordingEndCallback(fn) { _onRecordingEnd = fn; }

// Save/Load orchestration — defer to p_saveg.
let _savegSlot = 0, _savegDesc = '';
export function G_SaveGame(slot, description) {
  _savegSlot = slot; _savegDesc = description;
  set_gameaction(gameaction_t.ga_savegame);
}
export function G_DoSaveGame() {
  set_gameaction(gameaction_t.ga_nothing);
  const saved = _saveGame !== null && _saveGame(_savegSlot, _savegDesc) === true;
  if (saved) {
    const player = players[consoleplayer];
    if (player !== null && player !== undefined) player.message = GGSAVED;
  }
  return saved;
}
let _loadName = 0;
export function G_LoadGame(slot) { _loadName = slot; set_gameaction(gameaction_t.ga_loadgame); }
export function G_DoLoadGame() {
  // Parse and validate before touching the live level. A missing, corrupt, or
  // wrong-map save must leave the current simulation and renderer intact.
  set_gameaction(gameaction_t.ga_nothing);
  if (_readSave === null || _restoreSave === null || _loadLevel === null) return false;
  const blob = _readSave(_loadName);
  if (blob === false || blob === null || blob === undefined) return false;
  if (_validateSaveMap !== null && _validateSaveMap(blob) !== true) return false;

  // The saved topology controls which player starts P_SetupLevel spawns. It
  // must therefore be installed before G_InitNew and the base-map load.
  if (!Array.isArray(blob.playeringame) || blob.playeringame.length < MAXPLAYERS) {
    return false;
  }
  for (let i = 0; i < MAXPLAYERS; i++) playeringame[i] = blob.playeringame[i] === true;

  // Match g_game.c:G_DoLoadGame: initialize a deterministic base level first,
  // then dearchive all saved mutations before anything renders or ticks.
  _deferred = null;
  G_InitNew(blob.skill, blob.episode, blob.map);
  let restored = false;
  _loadAfterSetup = () => {
    set_leveltime(blob.leveltime);
    const result = _restoreSave(blob);
    if (result !== null && result !== undefined &&
        typeof result === 'object' && typeof result.then === 'function') {
      I_Error('G_DoLoadGame: save restore must be synchronous');
    }
    restored = result === true;
    if (!restored) I_Error('G_DoLoadGame: save restore failed after level setup');
  };
  try {
    G_DoLoadLevel();
  } finally {
    _loadAfterSetup = null;
  }
  return restored;
}

// Level completion / world transitions.
// g_game.c:G_DoCompleted — build wbstartstruct from the level's tallies,
// transition to GS_INTERMISSION, and start WI_*. The intermission screen
// presses-any-key callback fires ga_worlddone, which G_DoWorldDone advances
// to the next map. Handles secret-exit routing (E_M9 ↔ E_M4, MAP15 ↔ MAP31,
// MAP31 ↔ MAP32, MAP32 → MAP16) and ExM8 → ga_victory for Doom 1.
export function G_DoCompleted() {
  // g_game.c:1024 — consume ga_completed before calculating a possible chained
  // ga_victory. Clearing it in the dispatcher would erase that chained action.
  set_gameaction(gameaction_t.ga_nothing);
  // p_user: take away cards/powers from each player.
  for (let i = 0; i < players.length; i++) {
    if (playeringame[i] === true && players[i] !== null && players[i] !== undefined) {
      G_PlayerFinishLevel(players[i]);
    }
  }
  // g_game.c:1026-1027 — stop the automap before either the episode-victory
  // early return or the intermission path. Otherwise its active flag survives
  // into the next map.
  doomstat.set_automapactive(false);

  // ExM8 (Doom 1 episode boss) → finale instead of intermission.
  if (gamemode !== GameMode_t.commercial && gamemap === 8) {
    set_gameaction(gameaction_t.ga_victory);
    return;
  }
  // ExM9 (Doom 1 secret level): mark didsecret on every player so future
  // secret-exit attempts know we've been here. (Vanilla also breaks here
  // and falls through, so we keep iterating.)
  if (gamemode !== GameMode_t.commercial && gamemap === 9) {
    for (let i = 0; i < players.length; i++) {
      if (players[i] !== null && players[i] !== undefined) players[i].didsecret = true;
    }
  }

  // wminfo.next is 0-biased (vanilla: next+1 = real map). Translate.
  let nextMap;
  if (gamemode === GameMode_t.commercial) {
    if (secretexit === true) {
      // MAP15 → MAP31 (Wolfenstein); MAP31 → MAP32 (Grosse).
      switch (gamemap) {
        case 15: nextMap = 30; break;
        case 31: nextMap = 31; break;
        default: nextMap = gamemap; break;
      }
    } else {
      // MAP31 / MAP32 normal exit returns to MAP16.
      switch (gamemap) {
        case 31: case 32: nextMap = 15; break;
        default:           nextMap = gamemap; break;
      }
    }
  } else {
    if (secretexit === true) {
      // Doom 1 secret-exit → ExM9.
      nextMap = 8;
    } else if (gamemap === 9) {
      // Returning from secret level — episode-specific re-entry point.
      switch (gameepisode) {
        case 1: nextMap = 3; break;
        case 2: nextMap = 5; break;
        case 3: nextMap = 6; break;
        case 4: nextMap = 2; break;
        default: nextMap = 0; break;
      }
    } else {
      nextMap = gamemap;
    }
  }

  // g_game.c:1064-1130 — snapshot the complete wbstartstruct, including each
  // player's four frag counters. Intermission code must not read mutable live
  // level tallies after this point.
  const wbs = G_BuildIntermissionInfo({
    gamemode,
    gameepisode,
    gamemap,
    next: nextMap,
    maxkills: totalkills,
    maxitems: totalitems,
    maxsecret: totalsecret,
    leveltime,
    consoleplayer,
    players,
    playeringame,
  });
  doomstat.set_wminfo(wbs);
  set_gamestate(gamestate_t.GS_INTERMISSION);
  doomstat.set_viewactive(false);
  doomstat.set_automapactive(false);
  // Tell G_DoWorldDone where to go on press-key.
  set_wmNext(nextMap);
  WI_Start(wbs, () => {
    // Player pressed past the intermission. G_WorldDone owns Doom II chapter
    // finale routing before the queued map can be loaded.
    G_WorldDone();
  });
}
export function G_DoVictory() {
  F_StartFinale();
}
export function G_WorldDone() {
  set_gameaction(gameaction_t.ga_worlddone);
  if (secretexit === true) {
    const p = players[consoleplayer];
    if (p !== null && p !== undefined) p.didsecret = true;
  }
  if (F_ShouldStartCommercialFinale(gamemode, gamemap, secretexit)) {
    // F_StartFinale consumes ga_worlddone. Non-MAP30 Doom II finales restore it
    // through this callback once the player advances the text screen.
    WI_Stop();
    F_StartFinale(() => set_gameaction(gameaction_t.ga_worlddone));
  }
}
// G_DoCompleted stashes `wmNext` (0-biased) so G_DoWorldDone knows where to
// jump. Falls back to gamemap+1 if nothing is queued.
let _wmNext = -1;
export function set_wmNext(n) { _wmNext = n; }
export function G_DoWorldDone() {
  set_gamestate(gamestate_t.GS_LEVEL);
  if (_wmNext >= 0) {
    set_gamemap(_wmNext + 1);
    _wmNext = -1;
  } else {
    set_gamemap(gamemap + 1);
  }
  // g_game.c:G_DoWorldDone calls G_DoLoadLevel directly.
  G_DoLoadLevel();
  set_gameaction(gameaction_t.ga_nothing);
  doomstat.set_viewactive(true);
}
// g_game.c:897 — random DM spawn (vanilla uses P_Random).
export function G_DeathMatchSpawnPlayer(playernum) {
  if (_spawnPlayer === null || _checkSpot === null) return false;
  return G_RunDeathMatchSpawnPlayer(playernum, {
    deathmatchstarts: doomstat.deathmatchstarts,
    deathmatchCount: doomstat.deathmatch_p,
    playerstarts: doomstat.playerstarts,
    P_Random,
    G_CheckSpot: _checkSpot,
    P_SpawnPlayer: _spawnPlayer,
    I_Error,
  });
}

export function G_ExitLevel() {
  set_secretexit(false);
  set_gameaction(gameaction_t.ga_completed);
}
// g_game.c:G_SecretExitLevel — the censored commercial IWAD has no Wolf3D
// maps, so its secret exits fall back to normal exits.
export function G_SecretExitLevel() {
  set_secretexit(G_SecretExitAvailable(gamemode, W_CheckNumForName));
  set_gameaction(gameaction_t.ga_completed);
}
// Expose to non-importing call sites (p_spec.js, p_enemy.js) to avoid cycles.
if (typeof globalThis !== 'undefined') {
  globalThis.__G_ExitLevel       = G_ExitLevel;
  globalThis.__G_SecretExitLevel = G_SecretExitLevel;
}
// g_game.c:970 — G_ScreenShot just queues the action; G_Ticker dispatches
// it to M_ScreenShot which actually writes the image.
export function G_ScreenShot() { set_gameaction(gameaction_t.ga_screenshot); }
