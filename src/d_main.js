// Ported from: linuxdoom-1.10/d_main.c
// DOOM main program (D_DoomMain) and game loop (D_DoomLoop). Heavily reduced
// while subsystem ports come online — only the boot path through to the title
// screen is wired so far.

import { I_Init, I_GetTime, I_Error } from './i_system.js';
import { I_InitGraphics, I_SetPalette, I_FinishUpdate, I_RenderTint, renderer, scene, camera } from './i_video.js';
import { V_Init, V_DrawPatch, screens, patch_t } from './v_video.js';
import { W_InitMultipleFiles, W_CheckNumForName, W_CacheLumpName, W_CacheLumpNum } from './w_wad.js';
import { M_CheckParm, myargv, myargc } from './m_argv.js';
import { M_LoadDefaults } from './m_misc.js';
import { SCREENWIDTH, SCREENHEIGHT, gamestate_t, GameMode_t } from './doomdef.js';
import { mus_intro, mus_dm2ttl } from './sounds.js';
import * as doomstat from './doomstat.js';
import { gamestate, set_gamestate, set_gamemode, set_devparm, set_nomonsters, set_respawnparm, set_fastparm, set_gameepisode, set_gamemap, set_gameskill } from './doomstat.js';
import { R_InitData, R_TextureNumForName, R_FlatNumForName, R_PrecacheLevel } from './r_data.js';
import { P_Random } from './m_random.js';
import { P_SetupLevel, P_SetExternals as P_SetupSetExternals } from './p_setup.js';
import { R_NewMap, R_RenderPlayerView, R_SetupFrame } from './r_main.js';
import { D_FreeCamera } from './d_freecamera.js';
import { D_KeyboardInput } from './d_keyboard.js';
import { players, consoleplayer } from './doomstat.js';
import * as THREE from 'three';
// Eagerly imported so loadLevel can run synchronously — vanilla's
// G_DoLoadLevel is synchronous and demo determinism relies on the level
// being fully set up before the same tic's P_Ticker runs.
import * as _PU from './p_user.js';
import * as _RB from './r_bsp.js';
import * as _PMobj from './p_mobj.js';
import * as _PTick from './p_tick.js';
import * as _GGame from './g_game.js';

// ---------- Page screen state ----------
let pagename   = null; // lump name to draw as full-screen page
let pagetic    = 0;
let advancedemo = false;
let demosequence = 0;

// ---------- Game loop pieces ----------

// D_PageTicker: tick down page timer; advance demo loop when expired.
function D_PageTicker() {
  if (--pagetic < 0) D_AdvanceDemo();
}

// D_PageDrawer: blit the current page lump to screens[0].
function D_PageDrawer() {
  if (pagename === null) return;
  const lumpBytes = W_CacheLumpName(pagename, 0);
  V_DrawPatch(0, 0, 0, patch_t(lumpBytes));
}

// D_AdvanceDemo: schedule the next demo-screen transition. Full demo loop
// (TITLEPIC -> DEMO1 -> CREDIT -> DEMO2 -> ...) wires in alongside g_game.js.
function D_AdvanceDemo() {
  advancedemo = true;
}

// Vanilla attract loop — six-state cycle through TITLEPIC / DEMO1 / CREDIT /
// DEMO2 / CREDIT / DEMO3. Page durations match d_main.c::D_DoAdvanceDemo
// (170 = title @ 35Hz × ~5s, 200 = credit screens). Demos are launched via
// G_DeferedPlayDemo; G_CheckDemoStatus returns control here on end via the
// callback installed at boot.
// d_main.c:485 — D_DoAdvanceDemo. Vanilla cases 1/3/5 ONLY queue a demo (no
// pagetic / pagename), so the demo runs without the page-timer competing for
// gamestate transitions. Mode-conditional title/help screens for retail / commercial.
function D_DoAdvanceDemo() {
  if (players[consoleplayer] !== undefined && players[consoleplayer] !== null) {
    players[consoleplayer].playerstate = 0 /*PST_LIVE*/;
  }
  advancedemo = false;
  doomstat.set_usergame?.(false);
  doomstat.set_paused?.(false);
  doomstat.set_gameaction?.(0 /*ga_nothing*/);
  const isCommercial = doomstat.gamemode === GameMode_t.commercial;
  const isRetail     = doomstat.gamemode === GameMode_t.retail;
  demosequence = (demosequence + 1) % (isRetail ? 7 : 6);
  switch (demosequence) {
    case 0:
      // Vanilla 1.10 holds TITLEPIC for 170 tics (~5 s) before launching
      // DEMO1. In the browser that feels like the splash is hung; trim to
      // 70 tics (~2 s) — long enough to recognize the title, short enough
      // not to look broken.
      pagetic = isCommercial ? (35 * 11) : 70;
      set_gamestate(gamestate_t.GS_DEMOSCREEN);
      pagename = 'TITLEPIC';
      // d_main.c:476 — title music: mus_dm2ttl for Doom 2, mus_intro for Doom 1.
      if (_sStartMusic !== null) _sStartMusic(isCommercial ? mus_dm2ttl : mus_intro);
      break;
    case 1: _playDemo('DEMO1'); break;
    case 2:
      pagetic = 200;
      set_gamestate(gamestate_t.GS_DEMOSCREEN);
      pagename = 'CREDIT';
      break;
    case 3: _playDemo('DEMO2'); break;
    case 4:
      set_gamestate(gamestate_t.GS_DEMOSCREEN);
      // d_main.c:493 — Doom 2 re-shows TITLEPIC with mus_dm2ttl; Doom 1 shows
      // a credit/help still with no music change.
      if (isCommercial) { pagetic = 35 * 11; pagename = 'TITLEPIC'; if (_sStartMusic !== null) _sStartMusic(mus_dm2ttl); }
      else              { pagetic = 200;     pagename = isRetail ? 'CREDIT' : 'HELP2'; }
      break;
    case 5: _playDemo('DEMO3'); break;
    case 6: _playDemo('DEMO4'); break;
  }
}

let _gPlayDemo = null;
function _playDemo(name) {
  if (_gPlayDemo === null) return;
  // Skip if the WAD doesn't have the lump (e.g. shareware has DEMO1..3).
  if (typeof globalThis.__W_CheckNumForName === 'function' &&
      globalThis.__W_CheckNumForName(name) === -1) {
    advancedemo = true; // try the next attract slot
    return;
  }
  _gPlayDemo(name);
}

export function D_StartTitle() {
  // matches d_main.c: gameaction = ga_nothing; demosequence = -1; D_AdvanceDemo();
  demosequence = -1;
  D_AdvanceDemo();
}

// D_Display: per-frame composite. Currently only paints the page screen +
// pumps Three.js. Once r_main.js comes online, GS_LEVEL will call
// Overlay canvas + 2D context — looked up once and reused. Replaces the
// per-frame `document.getElementById` lookups that were in every branch below.
let _overlayCanvas = null, _overlayCtx = null;
function getOverlay() {
  if (_overlayCanvas === null) {
    _overlayCanvas = document.getElementById('overlay');
    _overlayCtx    = _overlayCanvas.getContext('2d');
  }
  return _overlayCtx;
}

function D_Display() {
  if (gamestate === gamestate_t.GS_DEMOSCREEN) {
    D_PageDrawer();
    if (renderer !== null) renderer.render(scene, camera);
    I_FinishUpdate(); // paints TITLEPIC to the same overlay canvas
    // Title-screen menu overlay — draw on top of TITLEPIC (do NOT clear first
    // or we'd wipe what I_FinishUpdate just put down).
    if (_menuDrawer !== null) {
      const o = getOverlay();
      o.imageSmoothingEnabled = false;
      _menuDrawer(o, 0, 0, _overlayCanvas.width, _overlayCanvas.height);
    }
  } else if (gamestate === gamestate_t.GS_LEVEL) {
    const p = players[consoleplayer];
    if (p !== undefined && p !== null && p.mo !== null) {
      R_SetupFrame(p);
    } else {
      D_FreeCamera.update();
    }
    // Sync sprite billboards + sky to current view.
    if (_updateSprites !== null) _updateSprites();
    if (_updateSky !== null) _updateSky();
    if (renderer !== null) {
      renderer.render(scene, camera);
      I_RenderTint(); // palette flash quad (damage / pickup / radsuit)
    }
    // Overlay: weapon view-sprite (HUD/status to come).
    const o = getOverlay();
    const overlay = _overlayCanvas;
    o.clearRect(0, 0, overlay.width, overlay.height);
    o.imageSmoothingEnabled = false;
    // Screen wipe takes priority — paint melt frames, skip the normal HUD.
    if (_fwipeActive !== null && _fwipeActive()) {
      const cw = overlay.width, ch = overlay.height;
      const scale = Math.min(cw / 320, ch / 200);
      const dw = 320 * scale, dh = 200 * scale;
      const dx = (cw - dw) * 0.5;
      const dy = (ch - dh) * 0.5;
      if (_fwipeDraw !== null) _fwipeDraw(o, dx, dy, dw, dh);
      return;
    }
    if (_drawPlayerSprites !== null && p !== undefined && p !== null) {
      const cw = overlay.width, ch = overlay.height;
      const scale = Math.min(cw / 320, ch / 200);
      const dw = 320 * scale, dh = 200 * scale;
      const dx = (cw - dw) * 0.5;
      const dy = (ch - dh) * 0.5;
      // Automap covers the whole overlay (not letterboxed) — Doom drew it
      // over the entire view-area; we mirror that by painting full-canvas.
      if (_amDrawer !== null) _amDrawer(o, 0, 0, overlay.width, overlay.height);
      _drawPlayerSprites(o, p, dx, dy, dw, dh);
      // Pickup / item messages + level title (drawn in the letterboxed 320x200 area
      // so positions match the C source's screen coords).
      if (_huDrawer !== null) _huDrawer(o, dx, dy, dw, dh);
      // STBAR is anchored to the very bottom of the screen (not the letterboxed
      // 320x200 viewport). ST_Drawer expects a 320x200-relative box and draws
      // the bar at y=168..200 inside it; we pick a virtual box such that the
      // bar lands flush at the bottom of the actual canvas.
      // Status bar — hidden when screen-size slider is at max (screenblocks
      // === 11), matching vanilla. Other sizes always show the bar.
      if (_stDrawer !== null && (_isStatusBarVisible === null || _isStatusBarVisible() === true)) {
        const cw = overlay.width;
        const barScale = cw / 320;
        const virtH = 200 * barScale;
        const virtY = overlay.height - virtH;
        _stDrawer(o, 0, virtY, cw, virtH);
      }
      if (_menuDrawer !== null) _menuDrawer(o, 0, 0, overlay.width, overlay.height);
    }
  } else if (gamestate === gamestate_t.GS_INTERMISSION) {
    // Black background under the intermission widgets.
    if (renderer !== null) renderer.render(scene, camera);
    const o = getOverlay();
    o.imageSmoothingEnabled = false;
    o.clearRect(0, 0, _overlayCanvas.width, _overlayCanvas.height);
    if (_wiDrawer !== null) {
      const cw = _overlayCanvas.width, ch = _overlayCanvas.height;
      const scale = Math.min(cw / 320, ch / 200);
      const dw = 320 * scale, dh = 200 * scale;
      const dx = (cw - dw) * 0.5;
      const dy = (ch - dh) * 0.5;
      _wiDrawer(o, dx, dy, dw, dh);
    }
    if (_menuDrawer !== null) _menuDrawer(o, 0, 0, _overlayCanvas.width, _overlayCanvas.height);
  } else {
    if (renderer !== null) renderer.render(scene, camera);
    I_FinishUpdate();
  }
}

// D_DoomLoop: the C version blocks forever; in the browser we drive it with
// requestAnimationFrame and a 35Hz tic accumulator.
let _lastTime = 0;
let _ticAccum = 0;
let _pTicker = null;
let _updateSprites = null;
let _drawPlayerSprites = null;
let _huDrawer = null;
let _stDrawer = null;
let _stTicker = null;
let _updateSky = null;
let _stPalette = null;
let _amDrawer = null;
let _amTicker = null;
let _menuDrawer = null;
let _animTextures = null;
let _fwipeDraw = null;
let _fwipeActive = null;
let _fwipeStep = null;
let _gTicker = null;
let _huTicker = null;
let _sUpdate = null;
let _sStartMusic = null;
let _menuTicker = null;
let _gReadDemoCmd = null;
let _wiDrawer  = null;
let _wiTicker  = null;
let _wiResponder = null;
let _isStatusBarVisible = null;
async function D_DoomLoop() {
  _pTicker = (await import('./p_tick.js')).P_Ticker;
  _updateSprites = (await import('./r_things.js')).R_UpdateSprites;
  _drawPlayerSprites = (await import('./r_psprite.js')).R_DrawPlayerSprites;
  _huDrawer = (await import('./hu_stuff.js')).HU_Drawer;
  _stDrawer = (await import('./st_stuff.js')).ST_Drawer;
  _stTicker = (await import('./st_stuff.js')).ST_Ticker;
  _updateSky = (await import('./r_sky.js')).R_UpdateSky;
  _stPalette = (await import('./st_stuff.js')).ST_doPaletteStuff;
  const am = await import('./am_map.js');
  _amDrawer = am.AM_Drawer;
  _amTicker = am.AM_Ticker;
  const mMenu = await import('./m_menu.js');
  _menuDrawer = mMenu.M_Drawer;
  _menuTicker = mMenu.M_Ticker;
  _isStatusBarVisible = mMenu.isStatusBarVisible;
  _animTextures = (await import('./r_data.js')).R_AnimateTextures;
  const fw = await import('./f_wipe.js');
  _fwipeDraw   = fw.wipe_Draw;
  _fwipeActive = fw.wipe_isActive;
  _fwipeStep   = fw.wipe_ScreenWipe;
  const gMod = await import('./g_game.js');
  _gTicker      = gMod.G_Ticker;
  _gPlayDemo    = gMod.G_DeferedPlayDemo;
  _gReadDemoCmd = gMod.G_ReadDemoTiccmd;
  gMod.G_SetDemoEndCallback(() => {
    // After a demo ends, drop straight back to the attract sequence. The
    // current page step will pick up the next slot.
    advancedemo = true;
  });
  _huTicker = (await import('./hu_stuff.js')).HU_Ticker;
  const sMod = await import('./s_sound.js');
  _sUpdate     = sMod.S_UpdateSounds;
  _sStartMusic = sMod.S_StartMusic;
  const wi = await import('./wi_stuff.js');
  _wiDrawer    = wi.WI_Drawer;
  _wiTicker    = wi.WI_Ticker;
  _wiResponder = wi.WI_Responder;
  function frame(now) {
    if (_lastTime === 0) _lastTime = now;
    const dt = (now - _lastTime) / 1000;
    _lastTime = now;
    _ticAccum += dt * 35;
    let ticsRun = 0;
    while (_ticAccum >= 1 && ticsRun < 4) {
      _ticAccum -= 1;
      // d_net.c:746 — gametic is incremented once per tic, before any per-tic
      // logic runs. Used for ambient sound scheduling, levelstarttic offsets,
      // demo timing, etc.
      doomstat.set_gametic(doomstat.gametic + 1);
      // d_main.c:380-383 order — D_DoAdvanceDemo runs BEFORE G_Ticker so cases
      // 1/3/5 (G_DeferedPlayDemo) queue gameaction=ga_playdemo and G_Ticker
      // dispatches it INSIDE the same tic. With the matching G_DoLoadLevel
      // chain in G_DoPlayDemo, gamestate flips to GS_LEVEL before the
      // D_PageTicker check below runs — so the just-fired advancedemo from
      // the title-screen page-ticker can't race a second case-step.
      if (advancedemo) D_DoAdvanceDemo();
      if (_menuTicker !== null) _menuTicker();
      if (_gTicker !== null) _gTicker();
      if (gamestate === gamestate_t.GS_DEMOSCREEN) D_PageTicker();
      // Advance wipe even while in level transition.
      if (_fwipeStep !== null && _fwipeActive !== null && _fwipeActive()) {
        _fwipeStep(0, 0, 0, 320, 200, 1);
      }
      if (gamestate === gamestate_t.GS_LEVEL && _pTicker !== null) {
        // Build ticcmd from either keyboard input or the active demo lump.
        const p = players[consoleplayer];
        // Wait until the async loadLevel has finished spawning the player
        // before ticking the play sim. Without this, monsters' P_LookForPlayers
        // sees all-false playeringame[] and infinite-loops on its for(;;) cycle.
        if (p === undefined || p === null || p.mo === null) {
          ticsRun++;
          continue;
        }
        if (doomstat.demoplayback && _gReadDemoCmd !== null) {
          _gReadDemoCmd(p.cmd);
        } else {
          D_KeyboardInput.buildCmd(p);
        }
        _pTicker();
        if (_amTicker !== null) _amTicker();
        if (_stTicker !== null) _stTicker();
        if (_huTicker !== null) _huTicker();
        if (_stPalette !== null) _stPalette();
        // Re-attenuate live sounds based on the listener's position.
        if (_sUpdate !== null) _sUpdate(p);
        // Animate wall/flat textures every tic.
        if (_animTextures !== null) _animTextures(doomstat.leveltime);
      } else if (gamestate === gamestate_t.GS_INTERMISSION && _wiTicker !== null) {
        // Drive the intermission counters + 'press key to continue' timer.
        _wiTicker();
      }
      ticsRun++;
    }
    D_Display();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ---------- IWAD detection ----------

async function findIwad() {
  // Allow -iwad <name> URL param to override the default.
  const i = M_CheckParm('-iwad');
  if (i !== 0 && i < myargc - 1) {
    const name = myargv[i + 1];
    return await fetchWad(name, GameMode_t.indetermined);
  }
  return await fetchWad('doom1.wad', GameMode_t.shareware);
}

async function fetchWad(path, mode) {
  console.log('Fetching', path);
  const r = await fetch(path);
  if (!r.ok) I_Error('Failed to load ' + path + ': ' + r.status);
  const buffer = await r.arrayBuffer();
  return { name: path, buffer, mode };
}

// ---------- D_DoomMain ----------

export async function D_DoomMain() {
  // Command-line equivalents (URL params): -devparm, -nomonsters, -respawn, -fast.
  // M_CheckParm returns 0 when absent (argv[0] is reserved); use explicit
  // !== 0 per Golden Rule 2 (no falsy checks on numeric-valid-zero data).
  if (M_CheckParm('-devparm')    !== 0) set_devparm(true);
  if (M_CheckParm('-nomonsters') !== 0) set_nomonsters(true);
  if (M_CheckParm('-respawn')    !== 0) set_respawnparm(true);
  if (M_CheckParm('-fast')       !== 0) set_fastparm(true);

  // Locate and load the IWAD.
  const iwad = await findIwad();
  set_gamemode(iwad.mode === GameMode_t.indetermined ? guessModeFromWad(iwad.buffer) : iwad.mode);
  W_InitMultipleFiles([{ name: iwad.name, buffer: iwad.buffer }]);

  // Defaults / config (localStorage).
  M_LoadDefaults();

  // System init.
  I_Init();

  // Video & screens.
  V_Init();
  I_InitGraphics();

  // Palette — Doom keeps 14 palettes in PLAYPAL; I_SetPalette handles both
  // the single-palette and full-PLAYPAL forms.
  const playpal = W_CacheLumpName('PLAYPAL', 0);
  I_SetPalette(playpal);

  // Init rendering data (textures/flats/sprites/colormaps).
  R_InitData();
  (await import('./r_data.js')).R_InitDefaultAnims();
  // Build sprite definitions (one entry per SPR_* name).
  const RT = await import('./r_things.js');
  RT.R_InitSprites();
  // Init sound + wire to p_mobj.
  const S = await import('./s_sound.js');
  S.S_Init(8, 8);
  const PM = await import('./p_mobj.js');
  PM.P_SetExternals({
    S_StartSound: S.S_StartSound,
    S_StopSound:  S.S_StopSound,
    R_RemoveMobjSprite:   RT.R_RemoveMobjSprite,
    R_RegisterMobjSprite: RT.R_RegisterMobjSprite,
  });
  // Wire p_pspr → sound + d_items + p_map + p_enemy (for noise alerts).
  const pp = await import('./p_pspr.js');
  const di = await import('./d_items.js');
  const pMap = await import('./p_map.js');
  const pEnemyEarly = await import('./p_enemy.js');
  pp.P_PsprSetExternals({ S, di, PMap: pMap, PEnemy: pEnemyEarly });
  // Wire p_user → p_inter, p_inter → S + PM, p_map → p_inter + thinkercap.
  const pInter = await import('./p_inter.js');
  pInter.P_InterSetExternals({ S, PM });
  pp.P_PsprSetMobj({ PMobj: PM, PInter: pInter });
  const pTick = await import('./p_tick.js');
  pMap.P_MapSetExternals({ PInter: pInter, PMobj: PM, thinkercap: pTick.thinkercap });
  // Wire p_mobj → p_map so P_SpawnPlayerMissile can autoaim.
  PM.P_MobjSetMap({ P_AimLineAttack: pMap.P_AimLineAttack, getLinetarget: pMap.getLinetarget });
  const pUser = await import('./p_user.js');
  pUser.P_UserSetInter({ p_inter: pInter });
  // pUser.P_UserSetSpec wired after pSpec is imported below.
  // Wire p_enemy → S + p_map (hitscan) + p_inter (damage).
  const pEnemy = await import('./p_enemy.js');
  pEnemy.P_EnemySetExternals({ S });
  pEnemy.P_EnemySetMap({ PMap: pMap, PInter: pInter });
  // p_enemy needs p_spec for door-opening via P_UseSpecialLine.
  // We import pSpec here lazily so it's available before the call.
  // Wire p_doors + p_spec + r_plane for door opening on Use.
  const pDoors = await import('./p_doors.js');
  const pSpec  = await import('./p_spec.js');
  const rPlane = await import('./r_plane.js');
  pDoors.P_DoorsSetExternals({
    R_UpdateSectorPlanes: rPlane.R_UpdateSectorPlanes,
    P_AddThinker:    pTick.P_AddThinker,
    P_RemoveThinker: pTick.P_RemoveThinker,
    S,
  });
  // Floors / lifts / ceilings — same dynamic-mesh wiring as doors.
  const pFloor = await import('./p_floor.js');
  pFloor.P_FloorSetExternals({
    R_UpdateSectorPlanes: rPlane.R_UpdateSectorPlanes,
    P_AddThinker: pTick.P_AddThinker, P_RemoveThinker: pTick.P_RemoveThinker, S,
  });
  pFloor.P_FloorSetMap({ P_ChangeSector: pMap.P_ChangeSector });
  const pPlats = await import('./p_plats.js');
  pPlats.P_PlatsSetExternals({
    R_UpdateSectorPlanes: rPlane.R_UpdateSectorPlanes,
    P_AddThinker: pTick.P_AddThinker, P_RemoveThinker: pTick.P_RemoveThinker, S,
  });
  const pCeil = await import('./p_ceilng.js');
  pCeil.P_CeilingSetExternals({
    R_UpdateSectorPlanes: rPlane.R_UpdateSectorPlanes,
    P_AddThinker: pTick.P_AddThinker, P_RemoveThinker: pTick.P_RemoveThinker, S,
  });
  // Teleport.
  const pTel = await import('./p_telept.js');
  pTel.P_TeleptSetExternals({ S, PMobj: PM, PMap: pMap, thinkercap: pTick.thinkercap });
  pMap.P_MapSetExternals({ PInter: pInter, PMobj: PM, thinkercap: pTick.thinkercap, PSpec: pSpec, S });
  // p_lights externals.
  const pLights = await import('./p_lights.js');
  pLights.P_LightsSetExternals({
    P_AddThinker:    pTick.P_AddThinker,
    P_RemoveThinker: pTick.P_RemoveThinker,
    R_UpdateSectorLight: rPlane.R_UpdateSectorLight,
  });
  const pSwitch = await import('./p_switch.js');
  pSwitch.P_SwitchSetExternals({ S });
  // p_setup.c:P_Init calls P_InitSwitchList — builds the switch off/on texture
  // pairs. Episode gates the set (shareware=1, registered/retail=2,
  // commercial=3). Without this switchlist stays empty and no switch flips.
  pSwitch.P_InitSwitchList(
    doomstat.gamemode === GameMode_t.commercial ? 3
    : (doomstat.gamemode === GameMode_t.registered ||
       doomstat.gamemode === GameMode_t.retail) ? 2 : 1);
  pSpec.P_SpecSetExternals({ PLights: pLights });
  pSpec.P_SpecSetFloor({ PFloor: pFloor });
  pSpec.P_SpecSetInter({ PInter: pInter });
  // Wire p_user → p_spec for P_PlayerInSpecialSector.
  pUser.P_UserSetSpec({ PSpec: pSpec });
  // Wire p_enemy → p_spec for door-opening on blocked monster moves.
  pEnemy.P_EnemySetMap({ PMap: pMap, PInter: pInter, PSpec: pSpec });
  // Expose P_Random globally for p_spec strobe-damage RNG.
  const _mr = await import('./m_random.js');
  globalThis.__doom_P_Random = _mr.P_Random;
  pSpec.P_SpecSetSwitch({ PSwitch: pSwitch });
  // P_SpawnSpecials moved into loadLevel — it needs sectors[] loaded first.
  // st_stuff palette flashes.
  const stStuff = await import('./st_stuff.js');
  const iv = await import('./i_video.js');
  stStuff.ST_SetExternals({ I_SetPaletteIndex: iv.I_SetPaletteIndex });

  // Wire p_setup -> r_data + p_mobj.
  const { P_SpawnMobj, ONFLOORZ, ONCEILINGZ, MF_SPAWNCEILING, MF_COUNTKILL, MF_COUNTITEM, MF_NOTDMATCH } = await import('./p_mobj.js');
  const { mobjinfo, NUMMOBJTYPES } = await import('./info.js');
  // Make P_InitThinkers visible in loadLevel scope.
  const { P_InitThinkers } = await import('./p_tick.js');

  const mobjsByMapThing = new Map();
  if (typeof window !== 'undefined') window.__mobjsByMapThing = mobjsByMapThing;
  // Hook for P_RespawnSpecials to call us during nightmare respawn ticks.
  if (typeof globalThis !== 'undefined') globalThis.__P_SpawnMapThing = (mt) => P_SpawnMapThing(mt);
  const MTF_AMBUSH = 8;
  const MTF_MULTI  = 16;
  // ds module (pre-imported so the spawn callback stays synchronous).
  const ds = await import('./doomstat.js');
  // p_mobj.c:704 — P_SpawnMapThing.
  const P_SpawnMapThing = (mt) => {
    // Player starts (1..4) — spawn the mobj for player 1 here so its thinker
    // lands at the same list position as vanilla. Other player slots only
    // record the start position (for respawn / netgame).
    if (mt.type >= 1 && mt.type <= 4) {
      if (mt.type === 1) {
        const p = globalThis.__doom_playerForSpawn;
        if (p !== null && p !== undefined && p.mo === null) {
          const playerMo = P_SpawnMobj(mt.x << 16, mt.y << 16, ONFLOORZ, 0 /*MT_PLAYER*/);
          playerMo.angle = (((mt.angle / 45) | 0) * 0x20000000) >>> 0;
          playerMo.player = p;
          p.mo = playerMo;
          p.health = 100;
        }
      }
      return null;
    }
    // Deathmatch start (type 11) — recorded elsewhere.
    if (mt.type === 11) return null;
    // Skill-bit filter. sk_baby (0) uses bit1, sk_nightmare (4) uses bit4,
    // else 1 << (gameskill-1).
    let bit;
    if (ds.gameskill === 0 /*sk_baby*/)        bit = 1;
    else if (ds.gameskill === 4 /*sk_nightmare*/) bit = 4;
    else                                           bit = 1 << (ds.gameskill - 1);
    if ((mt.options & bit) === 0) return null;
    // Multiplayer-only flag.
    if (ds.netgame === false && (mt.options & MTF_MULTI) !== 0) return null;
    // Find which mobjtype to spawn by doomednum.
    let i = -1;
    for (let k = 0; k < NUMMOBJTYPES; k++) {
      if (mobjinfo[k].doomednum === mt.type) { i = k; break; }
    }
    if (i === -1) return null;
    // -nomonsters: skip monsters + lost souls.
    if (ds.nomonsters === true &&
        (i === 19 /*MT_SKULL*/ || (mobjinfo[i].flags & MF_COUNTKILL) !== 0)) return null;
    // Deathmatch hides keys/players (MF_NOTDMATCH).
    if (ds.deathmatch === true && (mobjinfo[i].flags & MF_NOTDMATCH) !== 0) return null;
    const x = mt.x << 16;
    const y = mt.y << 16;
    const z = (mobjinfo[i].flags & MF_SPAWNCEILING) !== 0 ? ONCEILINGZ : ONFLOORZ;
    const mo = P_SpawnMobj(x, y, z, i);
    mo.spawnpoint = mt;
    if (mo.tics > 0) mo.tics = 1 + (P_Random() % mo.tics);
    if ((mo.flags & MF_COUNTKILL) !== 0) ds.set_totalkills(ds.totalkills + 1);
    if ((mo.flags & MF_COUNTITEM) !== 0) ds.set_totalitems(ds.totalitems + 1);
    // C: mo->angle = ANG45 * (mthing->angle/45) — integer division truncates.
    mo.angle = (((mt.angle / 45) | 0) * 0x20000000) >>> 0;
    if ((mt.options & MTF_AMBUSH) !== 0) mo.flags |= 32 /*MF_AMBUSH*/;
    mobjsByMapThing.set(mt, mo);
    return mo;
  };
  P_SetupSetExternals({
    R_TextureNumForName,
    R_FlatNumForName,
    R_PrecacheLevel,
    P_SpawnMapThing,
    P_SpawnSpecials: pSpec.P_SpawnSpecials,
    S_Start:         S.S_Start,
  });
  // skyflatnum = R_FlatNumForName("F_SKY1") — used by r_plane.js to skip
  // drawing ceiling/floor flats that should show sky.
  const { W_CheckNumForName } = await import('./w_wad.js');
  if (W_CheckNumForName('F_SKY1') !== -1) {
    (await import('./doomstat.js')).set_skyflatnum(R_FlatNumForName('F_SKY1'));
  }

  // Install keyboard listeners early so the title-screen menu (Escape /
  // arrows / Enter) works before any level is loaded.
  D_KeyboardInput.installEarly();
  // Hoist the level-load sequence so both the URL warp path and menu /
  // G_DoLoadLevel can drive it.
  const loadLevel = (episode, map, skill) => {
    set_gameepisode(episode);
    set_gamemap(map);
    set_gameskill(skill);
    set_gamestate(gamestate_t.GS_LEVEL);
    // Pre-create the player_t struct so P_SpawnMapThing can spawn its mobj
    // at the moment the player start (type 1) mapthing is processed — keeping
    // the player early in the thinker list, exactly as vanilla does. (Adding
    // the player mobj LAST diverges monster→player thinker ordering, which
    // shifts P_Random consumption and desyncs demos.)
    _PU.P_UserSetExternals({ r_bsp: _RB, p_mobj: _PMobj, gamemode: doomstat.gamemode });
    const player = _PU.makePlayer();
    doomstat.players[0] = player;
    doomstat.playeringame[0] = true;
    // Stash the player_t so P_SpawnMapThing can find it when type==1 is hit.
    globalThis.__doom_playerForSpawn = player;
    // P_SetupLevel internally runs P_InitThinkers BEFORE P_LoadThings and
    // P_SpawnSpecials AFTER, matching p_setup.c's ordering.
    P_SetupLevel(episode, map, 0, skill);
    R_NewMap();
    // Fallback: if P_LoadThings didn't contain a player-1 mapthing (corrupt
    // map?), spawn at playerstarts[0] now so the rest of the boot doesn't
    // crash on a null player.mo.
    if (player.mo === null) {
      const ps = doomstat.playerstarts[0];
      if (ps !== undefined) {
        const playerMo = PM.P_SpawnMobj(ps.x << 16, ps.y << 16, PM.ONFLOORZ, 0);
        playerMo.angle = (((ps.angle / 45) | 0) * 0x20000000) >>> 0;
        playerMo.player = player;
        player.mo = playerMo;
        player.health = 100;
      }
    }
    _PTick.P_SetExternals({
      P_PlayerThink: _PU.P_PlayerThink,
      P_RespawnSpecials: PM.P_RespawnSpecials,
      P_UpdateSpecials: pSpec.P_UpdateSpecials,
    });
    // P_SetupPsprites is still async (it imports info.js / d_items.js); fire
    // it but don't block — psprites are visual only, not part of the play sim.
    _PU.P_SetupPsprites(player);
    D_KeyboardInput.init(player);
    globalThis.__doom_playerForSpawn = null;
  };
  // Expose to G_DoLoadLevel callers (menu New Game) — see g_game.js setExternals.
  if (_GGame.G_SetExternals) _GGame.G_SetExternals({ loadLevel });

  // -warp E1M3 / ?map=E1M1 launches straight into a level.
  const warp = parseMapParam();
  if (warp !== null) {
    loadLevel(warp.episode, warp.map, 2);
  } else {
    // Kick off the title screen demo loop.
    D_StartTitle();
  }
  D_DoomLoop();
}

function parseMapParam() {
  const i = M_CheckParm('-warp');
  if (i !== 0 && i < myargc - 1) {
    const arg = myargv[i + 1].toUpperCase();
    const m = arg.match(/^E(\d+)M(\d+)$/) || arg.match(/^MAP(\d+)$/);
    if (m !== null) {
      if (m.length === 3) return { episode: parseInt(m[1], 10), map: parseInt(m[2], 10) };
      return { episode: 1, map: parseInt(m[1], 10) };
    }
  }
  const j = M_CheckParm('-map');
  if (j !== 0 && j < myargc - 1) {
    const arg = myargv[j + 1].toUpperCase();
    const m = arg.match(/^E(\d+)M(\d+)$/) || arg.match(/^MAP(\d+)$/);
    if (m !== null) {
      if (m.length === 3) return { episode: parseInt(m[1], 10), map: parseInt(m[2], 10) };
      return { episode: 1, map: parseInt(m[1], 10) };
    }
  }
  return null;
}

// Best-effort mode guess from IWAD identifier + presence of specific lumps.
function guessModeFromWad(buffer) {
  // For now treat unknown as shareware.
  return GameMode_t.shareware;
}
