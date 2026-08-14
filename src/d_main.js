// Ported from: linuxdoom-1.10/d_main.c
// DOOM main program (D_DoomMain) and game loop (D_DoomLoop).

import { I_Init, I_GetTime, I_Error } from './i_system.js';
import {
  I_InitGraphics, I_SetPalette, I_SetPaletteIndex, I_FinishUpdate,
  I_ClearFrame, I_RenderView, renderer, scene, camera,
} from './i_video.js';
import {
  V_Init, V_DrawPatch, V_DecodePatchToCanvas, V_DrawPatchAtCanvas,
  patch_t,
} from './v_video.js';
import { V_PaletteCSS } from './v_palette.js';
import {
  W_InitMultipleFiles, W_CheckNumForName, W_CacheLumpName,
} from './w_wad.js';
import { M_CheckParm, myargv, myargc } from './m_argv.js';
import { M_LoadDefaults } from './m_misc.js';
import { M_RegisterDoomDefaults } from './m_defaults.js';
import { SCREENWIDTH, SCREENHEIGHT, gamestate_t, GameMode_t } from './doomdef.js';
import { mus_intro, mus_dm2ttl, sfx_telept } from './sounds.js';
import * as doomstat from './doomstat.js';
import {
  gamestate, set_gamestate, set_gamemode, set_devparm, set_nomonsters,
  set_respawnparm, set_fastparm, set_gameepisode, set_gamemap, set_gameskill,
  set_startskill, set_startepisode, set_startmap, set_autostart,
} from './doomstat.js';
import {
  R_AnimateTextures, R_InitData, R_TextureNumForName, R_FlatNumForName,
  R_PrecacheLevel,
} from './r_data.js';
import { P_Random } from './m_random.js';
import { ANG45, ANGLETOFINESHIFT, finecosine, finesine } from './tables.js';
import { P_SetupLevel, P_SetExternals as P_SetupSetExternals } from './p_setup.js';
import { R_NewMap, R_SetupFrame, R_Shutdown } from './r_main.js';
import * as _PSaveg from './p_saveg.js';
import {
  P_GetMapFingerprintForLump, P_MapFingerprintsEqual,
} from './p_saveg_fingerprint.js';
import { D_FreeCamera } from './d_freecamera.js';
import { D_KeyboardInput } from './d_keyboard.js';
import { players, consoleplayer } from './doomstat.js';
// Eagerly imported so loadLevel can run synchronously — vanilla's
// G_DoLoadLevel is synchronous and demo determinism relies on the level
// being fully set up before the same tic's P_Ticker runs.
import * as _PU from './p_user.js';
import * as _RB from './r_bsp.js';
import * as _PMobj from './p_mobj.js';
import * as _PTick from './p_tick.js';
import * as _GGame from './g_game.js';
import {
  D_DEFAULT_IWAD_NAMES, D_GuessGameModeFromWad, D_IwadLanguage,
} from './d_iwad.js';
import {
  D_AdvanceSimulationClock,
  D_CreateVisibilitySuspension,
  D_VisibilityFrameState,
} from './d_timing.js';
import { D_DoomRafLoop } from './d_loop.js';
import { D_PausePatchPosition, D_ShouldStartWipe } from './d_display_logic.js';
import { R_CalculateCanvasView, R_GetViewSize } from './r_view.js';
import { R_DrawViewBorder } from './r_border.js';
import { P_FindMapThingType } from './p_mapthing_logic.js';
import { D_FileArgumentPlan } from './d_file_logic.js';
import { D_FetchStartupAsset, D_STARTUP_ASSET_FETCH } from './d_asset_fetch.js';
import {
  D_DemoArgumentPlan, D_LoadGameArgumentPlan, D_StartupArgumentPlan,
} from './d_startup_logic.js';
import { G_ValidateDemoStream } from './g_demo.js';
import {
  G_EnsurePlayerTopology, G_CollectActivePlayers, G_StagePlayerTiccmds,
  G_ReadDemoTiccmds,
  G_WriteDemoTiccmds,
  P_RecordDeathMatchStart, G_CheckSpot as G_RunCheckSpot,
} from './g_multiplayer.js';

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
  // D_StartTitle only queues this transition. Release a retained completion
  // screen here, when the attract loop actually takes ownership of display.
  if (gamestate === gamestate_t.GS_INTERMISSION) _wiStop?.();
  else if (gamestate === gamestate_t.GS_FINALE) _fStop?.();
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
      // DEMO1 (commercial Doom uses its separate 11-second title interval).
      pagetic = isCommercial ? (35 * 11) : 170;
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
  doomstat.set_gameaction(0 /*ga_nothing*/);
  demosequence = -1;
  D_AdvanceDemo();
}

// Overlay canvas + 2D context — looked up once and reused.
let _overlayCanvas = null, _overlayCtx = null;
let _oldDisplayGameState = -1;
function getOverlay() {
  if (_overlayCanvas === null) {
    _overlayCanvas = document.getElementById('overlay');
    _overlayCtx    = _overlayCanvas.getContext('2d');
  }
  return _overlayCtx;
}

function D_DrawPausePatch(overlayCtx) {
  if (doomstat.paused !== true || _overlayCanvas === null) return;
  const pause = V_DecodePatchToCanvas('M_PAUSE');
  if (pause === null) return;
  const scale = Math.min(
    _overlayCanvas.width / SCREENWIDTH,
    _overlayCanvas.height / SCREENHEIGHT,
  );
  const dstX = (_overlayCanvas.width - SCREENWIDTH * scale) * 0.5;
  const dstY = (_overlayCanvas.height - SCREENHEIGHT * scale) * 0.5;
  const position = D_PausePatchPosition(
    doomstat.automapactive,
    doomstat.viewwindowx,
    doomstat.viewwindowy,
    doomstat.scaledviewwidth,
  );
  V_DrawPatchAtCanvas(
    overlayCtx,
    pause,
    dstX + position.x * scale,
    dstY + position.y * scale,
    scale,
    scale,
  );
}

function D_Display() {
  // d_main.c:223-230 — capture the last fully composed frame before drawing
  // the new state.  f_wipe retains that frame because WebGL's drawing buffer
  // is not preserved between browser composites.
  const wipeWasActive = _fwipeActive !== null && _fwipeActive();
  const startWipe = _fwipeStart !== null && _fwipeEnd !== null &&
    D_ShouldStartWipe(gamestate, doomstat.wipegamestate, wipeWasActive);
  if (startWipe) _fwipeStart(0, 0, SCREENWIDTH, SCREENHEIGHT);

  // d_main.c:273-275 — leaving the level restores PLAYPAL 0. Otherwise a
  // last-tic damage/bonus/radsuit palette can leak into intermission/finale.
  // Keep this after StartScreen to preserve the reference capture order.
  if (gamestate !== _oldDisplayGameState && gamestate !== gamestate_t.GS_LEVEL) {
    I_SetPaletteIndex(0);
  }
  _oldDisplayGameState = gamestate;

  if (gamestate === gamestate_t.GS_DEMOSCREEN) {
    D_PageDrawer();
    I_ClearFrame();
    I_FinishUpdate(); // paints TITLEPIC to the same overlay canvas
  } else if (gamestate === gamestate_t.GS_LEVEL) {
    // d_main.c renders the spied player and that player's weapon psprites.
    // Status/HU/automap and positional sound remain bound to consoleplayer in
    // their own modules, exactly as the original globals do.
    const p = players[doomstat.displayplayer];
    // d_main.c calls R_RenderPlayerView only while viewactive; reference
    // AM_Start clears that flag. Mirror the same gate from our authoritative
    // automap binding so no first-person setup reveals the current subsector,
    // updates view sprites/sky, or submits WebGL rendering.
    if (doomstat.automapactive !== true) {
      if (p !== undefined && p !== null && p.mo !== null) {
        R_SetupFrame(p);
      } else {
        D_FreeCamera.update();
      }
      // Sync sprite billboards + sky to the current first-person view.
      if (_updateSprites !== null) _updateSprites();
      if (_updateSky !== null) _updateSky();
      if (renderer !== null) {
        I_RenderView(scene, camera);
      }
    }
    // Overlay: weapon view-sprite (HUD/status to come).
    const o = getOverlay();
    const overlay = _overlayCanvas;
    o.clearRect(0, 0, overlay.width, overlay.height);
    o.imageSmoothingEnabled = false;
    if (_drawPlayerSprites !== null && p !== undefined && p !== null) {
      const cw = overlay.width, ch = overlay.height;
      const view = R_GetViewSize();
      const layout = R_CalculateCanvasView(cw, ch, view);
      const { screenX: dx, screenY: dy, screenWidth: dw, screenHeight: dh } = layout;
      if (doomstat.automapactive !== true) {
        R_DrawViewBorder(o, layout, view, doomstat.gamemode);
      }
      // am_map.c uses the top 320x168 framebuffer; the status bar owns the
      // bottom 32 pixels of the centered/scaled logical 320x200 screen.
      if (_amDrawer !== null) _amDrawer(o, dx, dy, dw, 168 * layout.scale);
      // d_main.c:D_Display only calls R_RenderPlayerView when the automap is
      // closed. R_DrawPlayerSprites lives inside that render path, so weapon
      // and muzzle-flash psprites must not be composited over the automap.
      if (doomstat.automapactive !== true) {
        _drawPlayerSprites(o, p, dx, dy, dw, dh, view);
      }
      // Pickup / item messages + level title (drawn in the letterboxed 320x200 area
      // so positions match the C source's screen coords).
      if (_huDrawer !== null) _huDrawer(o, dx, dy, dw, dh);
      // The fullscreen first-person size hides STBAR, but vanilla forces it
      // back on whenever automapactive is true.
      if (_stDrawer !== null && (_isStatusBarVisible === null || _isStatusBarVisible() === true)) {
        _stDrawer(o, dx, dy, dw, dh);
      }
    }
  } else if (gamestate === gamestate_t.GS_INTERMISSION) {
    // Black background under the intermission widgets.
    I_ClearFrame();
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
  } else if (gamestate === gamestate_t.GS_FINALE) {
    I_ClearFrame();
    const o = getOverlay();
    const cw = _overlayCanvas.width, ch = _overlayCanvas.height;
    o.imageSmoothingEnabled = false;
    o.fillStyle = V_PaletteCSS(0);
    o.fillRect(0, 0, cw, ch);
    if (_fDrawer !== null) {
      const scale = Math.min(cw / 320, ch / 200);
      const dw = 320 * scale, dh = 200 * scale;
      _fDrawer(o, (cw - dw) * 0.5, (ch - dh) * 0.5, dw, dh);
    }
  } else {
    I_ClearFrame();
    I_FinishUpdate();
  }

  // d_main.c records the displayed state before pause/menu composition. A
  // forced -1 written by the finale is therefore consumed by this draw too.
  if (wipeWasActive !== true || startWipe) {
    doomstat.set_wipegamestate(gamestate);
  }

  // d_main.c:D_Display draws M_PAUSE after every game-state drawer, then
  // draws the menu on top of it. Keeping both here also makes that ordering
  // identical for levels, intermissions, finales, and demo/title pages.
  const overlay = getOverlay();
  overlay.imageSmoothingEnabled = false;
  D_DrawPausePatch(overlay);
  if (_menuDrawer !== null) {
    _menuDrawer(overlay, 0, 0, _overlayCanvas.width, _overlayCanvas.height);
  }

  // Capture the complete destination (including pause/menu), then advance and
  // draw the melt.  M_Drawer is repeated over each wipe frame in d_main.c so
  // an open menu remains stationary while the captured screens melt below it.
  if (startWipe) {
    _fwipeEnd(0, 0, SCREENWIDTH, SCREENHEIGHT);
    _wipeLastTime = I_GetTime() - 1;
  }
  const advanceWipe = _fwipeActive !== null && _fwipeActive();
  if (advanceWipe) {
    const now = I_GetTime();
    const tics = Math.max(0, now - _wipeLastTime);
    if (tics > 0 && _fwipeStep !== null) {
      _fwipeStep(0, 0, 0, SCREENWIDTH, SCREENHEIGHT, tics);
      _wipeLastTime = now;
    }
    const wipeStillActive = _fwipeActive !== null && _fwipeActive();
    const cw = _overlayCanvas.width, ch = _overlayCanvas.height;
    if (wipeStillActive && _fwipeDraw !== null) {
      // The retained pixels stay at presentation resolution, while the melt
      // geometry remains Doom's canonical 320x200 model. Confine it to the
      // logical-screen rectangle so browser letterbox bars are untouched.
      const layout = R_CalculateCanvasView(cw, ch);
      _fwipeDraw(
        overlay,
        layout.screenX,
        layout.screenY,
        layout.screenWidth,
        layout.screenHeight,
      );
    }
    if (wipeStillActive && _menuDrawer !== null) {
      _menuDrawer(overlay, 0, 0, _overlayCanvas.width, _overlayCanvas.height);
    }
  }

  // Preserve the last fully presented composed frame for the next
  // wipe_StartScreen.  Record the final all-destination wipe frame too.
  if (_fwipeActive === null || _fwipeActive() !== true) {
    _wipeLastTime = -1;
    if (_fwipeRecord !== null) _fwipeRecord();
  }
}

// D_DoomLoop: the C version blocks forever; in the browser we drive it with
// requestAnimationFrame and a 35Hz tic accumulator.
let _lastTime = 0;
let _ticAccum = 0;
let _visibilitySuspension = null;
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
let _fwipeDraw = null;
let _fwipeActive = null;
let _fwipeStep = null;
let _fwipeStart = null;
let _fwipeEnd = null;
let _fwipeRecord = null;
let _wipeLastTime = -1;
let _gTicker = null;
let _gCheckSpecial = null;
let _huTicker = null;
let _sUpdate = null;
let _sStartMusic = null;
let _menuTicker = null;
let _gReadDemoCmd = null;
let _gWriteDemoCmd = null;
let _wiDrawer  = null;
let _wiTicker  = null;
let _wiResponder = null;
let _wiStop = null;
let _fDrawer = null;
let _fTicker = null;
let _fStop = null;
let _isStatusBarVisible = null;

// d_main.c builds the console command before TryRunTics enters G_Ticker.
// Keep that command separate from player_t so a game action may rebuild the
// player topology (and reset browser input state) without erasing this tic.
const _localCommandPlayer = { cmd: doomstat.localcmds[0] };

function D_ClearLoopReferences() {
  _lastTime = 0;
  _ticAccum = 0;
  _visibilitySuspension?.dispose();
  _visibilitySuspension = null;
  _overlayCanvas = null;
  _overlayCtx = null;
  _oldDisplayGameState = -1;
  _pTicker = null;
  _updateSprites = null;
  _drawPlayerSprites = null;
  _huDrawer = null;
  _stDrawer = null;
  _stTicker = null;
  _updateSky = null;
  _stPalette = null;
  _amDrawer = null;
  _amTicker = null;
  _menuDrawer = null;
  _fwipeDraw = null;
  _fwipeActive = null;
  _fwipeStep = null;
  _fwipeStart = null;
  _fwipeEnd = null;
  _fwipeRecord = null;
  _wipeLastTime = -1;
  _gTicker = null;
  _gCheckSpecial = null;
  _gPlayDemo = null;
  _gReadDemoCmd = null;
  _gWriteDemoCmd = null;
  _huTicker = null;
  _sUpdate = null;
  _sStartMusic = null;
  _menuTicker = null;
  _wiDrawer = null;
  _wiTicker = null;
  _wiResponder = null;
  _wiStop = null;
  _fDrawer = null;
  _fTicker = null;
  _fStop = null;
  _isStatusBarVisible = null;
}

export function D_ShutdownDoomLoop() {
  D_DoomRafLoop.close();
  D_ClearLoopReferences();
}

async function D_DoomLoop() {
  const loopToken = D_DoomRafLoop.begin();
  if (loopToken === null) {
    D_ClearLoopReferences();
    return;
  }
  _lastTime = 0;
  _ticAccum = 0;
  _visibilitySuspension?.dispose();
  _visibilitySuspension = D_CreateVisibilitySuspension(
    typeof document === 'undefined' ? null : document,
  );
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
  mMenu.M_SetExternals({ D_StartTitle, listSaves: _PSaveg.P_ListSaves });
  _menuDrawer = mMenu.M_Drawer;
  _menuTicker = mMenu.M_Ticker;
  _isStatusBarVisible = mMenu.isStatusBarVisible;
  const fw = await import('./f_wipe.js');
  _fwipeDraw   = fw.wipe_Draw;
  _fwipeActive = fw.wipe_isActive;
  _fwipeStep   = fw.wipe_ScreenWipe;
  _fwipeStart  = fw.wipe_StartScreen;
  _fwipeEnd    = fw.wipe_EndScreen;
  _fwipeRecord = fw.wipe_RecordScreen;
  const gMod = await import('./g_game.js');
  _gTicker      = gMod.G_Ticker;
  _gCheckSpecial = gMod.G_CheckSpecialButtons;
  _gPlayDemo    = gMod.G_DeferedPlayDemo;
  _gReadDemoCmd = gMod.G_ReadDemoTiccmd;
  _gWriteDemoCmd = gMod.G_WriteDemoTiccmd;
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
  _wiStop      = wi.WI_Stop;
  const finale = await import('./f_finale.js');
  _fDrawer = finale.F_Drawer;
  _fTicker = finale.F_Ticker;
  _fStop = finale.F_Stop;
  // Shutdown may have happened while the dynamic imports above were pending.
  if (D_DoomRafLoop.active(loopToken) !== true) {
    D_ClearLoopReferences();
    return;
  }
  function frame(now) {
    if (D_DoomRafLoop.active(loopToken) !== true) return;
    if (_lastTime === 0) _lastTime = now;
    const dt = (now - _lastTime) / 1000;
    _lastTime = now;
    // d_main.c:331-344 performs the complete wipe inside D_Display, before its
    // outer loop can reach M_Ticker/G_Ticker again.  Our melt spans RAFs, so
    // freeze the whole tic pipeline while it is active.  _lastTime still moves
    // forward and the helper retains only the sub-tic wall-clock phase, rather
    // than replaying whole wipe tics as a post-wipe catch-up burst.
    const wipeActive = _fwipeActive !== null && _fwipeActive() === true;
    const visibilityState = _visibilitySuspension?.frameState() ??
      D_VisibilityFrameState.active;
    const clock = D_AdvanceSimulationClock(_ticAccum, dt, wipeActive,
      doomstat.singletics, visibilityState);
    _ticAccum = clock.remainder;
    let dueTics = clock.due;
    while (dueTics-- > 0) {
      // d_main.c:378-379 — sample the complete local command before
      // D_DoAdvanceDemo, M_Ticker, and G_Ticker.  This also runs during demo
      // playback: G_Ticker copies the live netcmd first and only then replaces
      // it with G_ReadDemoTiccmd, so mouse axes and double-click state advance.
      D_KeyboardInput.buildCmd(_localCommandPlayer);

      // d_main.c:380-383 order — D_DoAdvanceDemo runs BEFORE G_Ticker so cases
      // 1/3/5 (G_DeferedPlayDemo) queue gameaction=ga_playdemo and G_Ticker
      // dispatches it INSIDE the same tic. With the matching G_DoLoadLevel
      // chain in G_DoPlayDemo, gamestate flips to GS_LEVEL before the
      // D_PageTicker check below runs — so the just-fired advancedemo from
      // the title-screen page-ticker can't race a second case-step.
      if (advancedemo) D_DoAdvanceDemo();
      if (_menuTicker !== null) _menuTicker();
      if (_gTicker !== null) _gTicker();

      // g_game.c:654-710 — after game actions settle, copy the already-built
      // local command, then let demo playback overwrite it. Commands remain
      // populated through intermissions/finales so those tickers see buttons.
      // Capture the command-phase console slot before a terminal demo marker
      // resets consoleplayer to zero. In the single-node browser, remote base
      // netcmds are neutral; the captured local slot receives the live cmd.
      const commandConsoleplayer = consoleplayer;
      const commandPlayers = G_StagePlayerTiccmds(
        players,
        doomstat.playeringame,
        commandConsoleplayer,
        _localCommandPlayer.cmd,
        doomstat.demoplayback,
      );
      if (commandPlayers !== null) {
        if (doomstat.demoplayback && _gReadDemoCmd !== null) {
          G_ReadDemoTiccmds(commandPlayers, _gReadDemoCmd);
        }
        if (doomstat.demorecording && _gWriteDemoCmd !== null) {
          // g_game.c:G_WriteDemoTiccmd checks the live 'q' key before each
          // command. A false result stops a multiplayer tic immediately, so
          // no later player's command is appended after finalization.
          const quitRecording = D_KeyboardInput.isPressed('KeyQ');
          G_WriteDemoTiccmds(
            commandPlayers,
            (cmd) => _gWriteDemoCmd(cmd, quitRecording),
          );
        }
      }

      // G_ReadDemoTiccmd may have reached DEMOMARKER. G_CheckDemoStatus then
      // clears player slots 1..3 and resets consoleplayer, and vanilla's next
      // special-button loop re-tests playeringame[] instead of reusing the
      // command-loop snapshot. The state ticker readiness check must use that
      // same post-marker topology.
      const activePlayers = G_CollectActivePlayers(players, doomstat.playeringame);
      if (activePlayers !== null && _gCheckSpecial !== null) {
        for (const activePlayer of activePlayers) _gCheckSpecial(activePlayer);
      }

      if (gamestate === gamestate_t.GS_LEVEL && _pTicker !== null) {
        const p = players[consoleplayer];
        // Wait until synchronous loadLevel has spawned the complete topology.
        // P_Ticker visits every active slot, so letting one null player through
        // would fail even when the non-zero consoleplayer itself was ready.
        if (activePlayers === null ||
            doomstat.playeringame[consoleplayer] !== true ||
            p === undefined || p === null || p.mo === null ||
            activePlayers.some((activePlayer) =>
              activePlayer.mo === null || activePlayer.mo === undefined)) {
          // Loading is synchronous in vanilla, so this transient exists only
          // in the browser port. Consume the scheduler tic without running an
          // incomplete player topology; gametic still advances below.
        } else {
          _pTicker();
          if (_amTicker !== null) _amTicker();
          if (_stTicker !== null) _stTicker();
          if (_huTicker !== null) _huTicker();
          if (_stPalette !== null) _stPalette();
          // Re-attenuate live sounds based on the listener's position.
          if (_sUpdate !== null) _sUpdate(p);
        }
      } else if (gamestate === gamestate_t.GS_INTERMISSION && _wiTicker !== null) {
        // Drive the intermission counters + 'press key to continue' timer.
        _wiTicker();
      } else if (gamestate === gamestate_t.GS_FINALE && _fTicker !== null) {
        _fTicker();
      } else if (gamestate === gamestate_t.GS_DEMOSCREEN) {
        D_PageTicker();
      }
      // I_Quit synchronously reaches graphics shutdown from inside a ticker.
      if (D_DoomRafLoop.active(loopToken) !== true) return;
      // d_net.c:735-746 — D_DoAdvanceDemo, M_Ticker, and G_Ticker (which
      // contains the state-specific tickers in vanilla) all observe the
      // current gametic. Advance it only after the completed tic.
      doomstat.set_gametic(doomstat.gametic + 1);
    }
    if (D_DoomRafLoop.active(loopToken) !== true) return;
    D_Display();
    D_DoomRafLoop.schedule(loopToken, frame);
  }
  D_DoomRafLoop.schedule(loopToken, frame);
}

// ---------- IWAD detection ----------

async function findIwad() {
  // Allow -iwad <name> URL param to override the default.
  const i = M_CheckParm('-iwad');
  if (i !== 0 && i < myargc - 1) {
    const name = myargv[i + 1];
    return await D_FetchStartupAsset(name, D_STARTUP_ASSET_FETCH.requiredIwad);
  }
  for (const name of D_DEFAULT_IWAD_NAMES) {
    const wad = await D_FetchStartupAsset(name, D_STARTUP_ASSET_FETCH.defaultIwadProbe);
    if (wad !== null) return wad;
  }
  I_Error(`No IWAD found (tried ${D_DEFAULT_IWAD_NAMES.join(', ')})`);
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
  const detectedMode = D_GuessGameModeFromWad(iwad.buffer);
  if (detectedMode === GameMode_t.indetermined) {
    I_Error('Unable to determine IWAD game mode: no MAP01 or ExM1 map marker found');
  }
  set_gamemode(detectedMode);
  // Linux Doom selects its French intermission assets specifically when the
  // chosen commercial IWAD is named doom2f.wad. Publish English explicitly
  // for every other boot so a repeated embedded startup cannot retain it.
  doomstat.set_language(D_IwadLanguage(iwad.name, detectedMode));
  const startupPlan = D_StartupArgumentPlan(myargv, detectedMode);
  set_startskill(startupPlan.skill);
  set_startepisode(startupPlan.episode);
  set_startmap(startupPlan.map);
  set_autostart(startupPlan.autostart);
  const demoPlan = D_DemoArgumentPlan(myargv);
  const loadGamePlan = D_LoadGameArgumentPlan(myargv, _PSaveg.SAVEGAME_SLOTS);
  // d_main.c appends every argument after the first -file until the next
  // option. Fetch them concurrently, but retain argument order so later PWADs
  // win W_CheckNumForName's backwards override search.
  const filePlan = D_FileArgumentPlan(myargv);
  // Command-line PWADs are optional: an unavailable file is reported and
  // skipped without preventing later overlays from loading. External demos
  // are optional here because their derived lump may already exist in the IWAD.
  const [overlayResults, demoFile] = await Promise.all([
    Promise.all(filePlan.paths.map((path) =>
      D_FetchStartupAsset(path, D_STARTUP_ASSET_FETCH.optionalPwad)
    )),
    demoPlan === null
      ? null
      : D_FetchStartupAsset(demoPlan.path, D_STARTUP_ASSET_FETCH.externalDemo),
  ]);
  const overlays = overlayResults.filter((wad) => wad !== null);
  // Vanilla rejected -file when using the shareware IWAD. This browser port
  // deliberately permits overlays so bundled doom1.wad can run user-supplied
  // E1 content; modifiedgame still records that the option was present.
  doomstat.set_modifiedgame(filePlan.present);
  W_InitMultipleFiles([
    { name: iwad.name, buffer: iwad.buffer },
    ...overlays.map((wad) => ({ name: wad.name, buffer: wad.buffer })),
    ...(demoFile === null ? [] : [{ name: demoFile.name, buffer: demoFile.buffer }]),
  ]);
  // An unavailable external file may still name DEMO1..3 in the IWAD. If
  // neither source exists, fail here with a useful startup diagnostic instead
  // of leaving a queued demo on an empty demo screen.
  if (demoPlan !== null && W_CheckNumForName(demoPlan.lump) < 0) {
    I_Error(`Demo ${demoPlan.argument} not found`);
  }
  if (demoPlan !== null) {
    const validation = G_ValidateDemoStream(W_CacheLumpName(demoPlan.lump, 0));
    if (validation.valid !== true) {
      I_Error(`Demo ${demoPlan.argument} is invalid: ${validation.error}`);
    }
  }

  // m_misc.c:M_LoadDefaults resets and loads every registered binding before
  // the settings are consumed by graphics or input initialization.
  M_RegisterDoomDefaults();
  M_LoadDefaults();

  // System init.
  I_Init();

  // Video & screens.
  V_Init();
  I_InitGraphics();

  // Doom keeps 14 palettes in PLAYPAL. R_InitData needs the palette to create
  // its shared shader texture; I_SetPalette immediately replaces that initial
  // upload with the selected Doom gamma table for every compositor.
  const playpal = W_CacheLumpName('PLAYPAL', 0);

  // Init rendering data (textures/flats/sprites/colormaps).
  R_InitData();
  I_SetPalette(playpal);
  (await import('./r_data.js')).R_InitDefaultAnims();
  // Build sprite definitions (one entry per SPR_* name).
  const RT = await import('./r_things.js');
  RT.R_InitSprites();
  // Init sound + wire to p_mobj.
  const S = await import('./s_sound.js');
  S.S_Init(doomstat.snd_SfxVolume, doomstat.snd_MusicVolume);
  const PM = await import('./p_mobj.js');
  PM.P_MobjSetDoomstat(doomstat);
  PM.P_SetExternals({
    S_StartSound: S.S_StartSound,
    S_StopSound:  S.S_StopSound,
    R_RemoveMobjSprite:   RT.R_RemoveMobjSprite,
    R_RegisterMobjSprite: RT.R_RegisterMobjSprite,
    R_PrecacheMobjState:  RT.R_PrecacheMobjState,
  });
  // Wire p_pspr → sound + d_items + p_map + p_enemy (for noise alerts).
  const pp = await import('./p_pspr.js');
  const di = await import('./d_items.js');
  const pMap = await import('./p_map.js');
  const pEnemyEarly = await import('./p_enemy.js');
  pp.P_PsprSetExternals({ S, di, PMap: pMap, PEnemy: pEnemyEarly });
  // Wire p_user → p_inter, p_inter → sound/mobj/psprite, p_map → p_inter + thinkercap.
  const pInter = await import('./p_inter.js');
  pInter.P_InterSetExternals({ S, PM, P_DropWeapon: pp.P_DropWeapon });
  const mCheat = await import('./m_cheat.js');
  mCheat.M_CheatSetExternals({
    P_GivePower: pInter.P_GivePower,
    G_DeferedInitNew: _GGame.G_DeferedInitNew,
  });
  pp.P_PsprSetMobj({ PMobj: PM, PInter: pInter });
  const pTick = await import('./p_tick.js');
  pMap.P_MapSetExternals({ PInter: pInter, PMobj: PM, thinkercap: pTick.thinkercap });
  // Wire p_mobj → p_map for immediate missile collision and player autoaim.
  PM.P_SetExternals({ P_TryMove: pMap.P_TryMove });
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
  const rSegs = await import('./r_segs.js');
  pSwitch.P_SwitchSetExternals({ S, R_SetSwitchTexture: rSegs.R_SetSwitchTexture });
  // p_setup.c:P_Init calls P_InitSwitchList — builds the switch off/on texture
  // pairs. Episode gates the set (shareware=1, registered/retail=2,
  // commercial=3). Without this switchlist stays empty and no switch flips.
  pSwitch.P_InitSwitchList(
    doomstat.gamemode === GameMode_t.commercial ? 3
    : (doomstat.gamemode === GameMode_t.registered ||
       doomstat.gamemode === GameMode_t.retail) ? 2 : 1);
  pSpec.P_SpecSetExternals({
    PLights: pLights,
    R_AnimateTextures,
    R_UpdateLineTextureOffset: rSegs.R_UpdateLineTextureOffset,
  });
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
  const huStuff = await import('./hu_stuff.js');
  const iv = await import('./i_video.js');
  stStuff.ST_SetExternals({ I_SetPaletteIndex: iv.I_SetPaletteIndex });

  // Wire p_setup -> r_data + p_mobj.
  const { P_SpawnMobj, ONFLOORZ, ONCEILINGZ, MF_SPAWNCEILING, MF_COUNTKILL, MF_COUNTITEM, MF_NOTDMATCH } = await import('./p_mobj.js');
  const { mobjinfo, NUMMOBJTYPES, NUMSPRITES, NUMSTATES, MT_TFOG } =
    await import('./info.js');
  // Save restoration constructs archived actors/specials directly, without
  // gameplay spawn functions or dynamic imports. Supply every live engine
  // type/callback needed to rebuild ownership, spatial links, and movers.
  _PSaveg.P_SaveGameSetExternals({
    makePlayer: _PU.makePlayer,
    mobj_t: _PMobj.mobj_t,
    mobjinfo,
    NUMMOBJTYPES,
    NUMSPRITES,
    NUMSTATES,
    P_MobjThinker: _PMobj.P_MobjThinker,
    P_RemoveMobj: _PMobj.P_RemoveMobj,
    P_SetThingPosition: _PMobj.P_SetThingPosition,
    T_VerticalDoor: pDoors.T_VerticalDoor,
    T_MoveCeiling: pCeil.T_MoveCeiling,
    T_MoveFloor: pFloor.T_MoveFloor,
    T_PlatRaise: pPlats.T_PlatRaise,
    T_LightFlash: pLights.T_LightFlash,
    T_StrobeFlash: pLights.T_StrobeFlash,
    T_Glow: pLights.T_Glow,
    T_FireFlicker: pLights.T_FireFlicker,
    P_AddActiveCeiling: pCeil.P_AddActiveCeiling,
    P_AddActivePlat: pPlats.P_AddActivePlat,
  });
  const mobjsByMapThing = new Map();
  const bodyqueue = new Array(32); // g_game.c:210 — BODYQUESIZE
  if (typeof window !== 'undefined') window.__mobjsByMapThing = mobjsByMapThing;
  const MTF_AMBUSH = 8;
  const MTF_MULTI  = 16;
  // ds module (pre-imported so the spawn callback stays synchronous).
  const ds = await import('./doomstat.js');
  // p_mobj.c:642 — P_SpawnPlayer. Most of the player structure stays
  // unchanged between levels.
  const P_SpawnPlayer = (mt) => {
    // not playing?
    if (doomstat.playeringame[mt.type - 1] !== true) return;
    const p = doomstat.players[mt.type - 1];
    if (p === null || p === undefined) return;
    if (p.playerstate === 2 /*PST_REBORN*/) _GGame.G_PlayerReborn(mt.type - 1);
    const mobj = P_SpawnMobj(mt.x << 16, mt.y << 16, ONFLOORZ, 0 /*MT_PLAYER*/);
    // set color translations for player sprites (netgame/co-op only)
    if (mt.type > 1) mobj.flags |= (mt.type - 1) << _PMobj.MF_TRANSSHIFT;
    mobj.angle = (((mt.angle / 45) | 0) * 0x20000000) >>> 0;
    mobj.player = p;
    mobj.health = p.health;
    p.mo = mobj;
    p.playerstate = 0 /*PST_LIVE*/;
    p.refire = 0;
    p.message = null;
    p.damagecount = 0;
    p.bonuscount = 0;
    p.extralight = 0;
    p.fixedcolormap = 0;
    p.viewheight = _PU.VIEWHEIGHT;
    pp.P_SetupPsprites(p);
    // p_mobj.c:688-691 — deathmatch players can operate every keyed door even
    // though MF_NOTDMATCH keeps the key pickups themselves out of the map.
    if (ds.deathmatch !== 0) {
      for (let i = 0; i < p.cards.length; i++) p.cards[i] = true;
    }
    // p_mobj.c:693-699 — spawning the console player immediately wakes both
    // local UI modules. Waiting for their first ticker leaves the first rendered
    // frame with stale face/title state and differs from the synchronous C path.
    if (mt.type - 1 === doomstat.consoleplayer) {
      stStuff.ST_Start();
      huStuff.HU_Start();
    }
  };
  // g_game.c:843 — full initial/respawn spot check, including the corpse queue
  // and teleport fog that consumes the RNG value immediately before the new mo.
  const G_CheckSpot = (playernum, mt) => G_RunCheckSpot(playernum, mt, {
    players: doomstat.players,
    playeringame: doomstat.playeringame,
    consoleplayer: doomstat.consoleplayer,
    bodyqueue,
    getBodyqueSlot: () => doomstat.bodyqueslot,
    setBodyqueSlot: doomstat.set_bodyqueslot,
    P_CheckPosition: pMap.P_CheckPosition,
    P_RemoveMobj: PM.P_RemoveMobj,
    R_PointInSubsector: _RB.R_PointInSubsector,
    P_SpawnMobj,
    S_StartSound: S.S_StartSound,
    finecosine,
    finesine,
    ANG45,
    ANGLETOFINESHIFT,
    MT_TFOG,
    sfx_telept,
  });
  // p_mobj.c:704 — P_SpawnMapThing.
  const P_SpawnMapThing = (mt) => {
    // Player starts (1..4): playerstarts[] are recorded in P_LoadThings; spawn
    // the player mobj (single-player) at the type-1 mapthing moment so its
    // thinker lands at the same list position as vanilla.
    if (mt.type >= 1 && mt.type <= 4) {
      if (ds.deathmatch === 0) P_SpawnPlayer(mt); // p_mobj.c:733 — !deathmatch
      return null;
    }
    // Deathmatch start (type 11) — retain up to vanilla's ten slots. The
    // numeric deathmatch_p mirrors C's one-past-the-end pointer.
    if (mt.type === 11) {
      ds.set_deathmatch_p(P_RecordDeathMatchStart(
        ds.deathmatchstarts, ds.deathmatch_p, mt));
      return null;
    }
    // Skill-bit filter. sk_baby (0) uses bit1, sk_nightmare (4) uses bit4,
    // else 1 << (gameskill-1).
    let bit;
    if (ds.gameskill === 0 /*sk_baby*/)        bit = 1;
    else if (ds.gameskill === 4 /*sk_nightmare*/) bit = 4;
    else                                           bit = 1 << (ds.gameskill - 1);
    if ((mt.options & bit) === 0) return null;
    // Multiplayer-only flag.
    if (ds.netgame === false && (mt.options & MTF_MULTI) !== 0) return null;
    // Find which mobjtype to spawn by doomednum. Unknown eligible things are
    // malformed map data and abort exactly as p_mobj.c:P_SpawnMapThing does.
    const i = P_FindMapThingType(mt, mobjinfo, I_Error);
    // -nomonsters: skip monsters + lost souls.
    if (ds.nomonsters === true &&
        (i === 19 /*MT_SKULL*/ || (mobjinfo[i].flags & MF_COUNTKILL) !== 0)) return null;
    // Deathmatch hides keys/players (MF_NOTDMATCH).
    if (ds.deathmatch !== 0 && (mobjinfo[i].flags & MF_NOTDMATCH) !== 0) return null;
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
    G_DeathMatchSpawnPlayer: _GGame.G_DeathMatchSpawnPlayer,
    P_ResetRespawnQueue: PM.P_ResetRespawnQueue,
    P_SpawnSpecials: pSpec.P_SpawnSpecials,
    S_Start:         S.S_Start,
  });
  _GGame.G_SetExternals({ P_SpawnPlayer, G_CheckSpot });
  // skyflatnum = R_FlatNumForName("F_SKY1") — used by r_plane.js to skip
  // drawing ceiling/floor flats that should show sky.
  if (W_CheckNumForName('F_SKY1') !== -1) {
    (await import('./doomstat.js')).set_skyflatnum(R_FlatNumForName('F_SKY1'));
  }

  // A graphics shutdown is terminal for this page. It may have happened at
  // any awaited import above; do not install new handlers, build a level, or
  // restart RAF against the disposed renderer.
  if (D_DoomRafLoop.isClosed() === true) return;

  // Install keyboard listeners early so the title-screen menu (Escape /
  // arrows / Enter) works before any level is loaded.
  D_KeyboardInput.installEarly();
  // Hoist the level-load sequence so both the URL warp path and menu /
  // G_DoLoadLevel can drive it.
  const loadLevel = (episode, map, skill, afterSetup = null) => {
    // Retire the old retained scene before P_SetupLevel spawns the base map.
    // P_SpawnMobj's renderer hook then sees no active things group, so neither
    // base setup nor save restoration can register transient sprites into the
    // old level. R_NewMap below discovers only the final thinker list once.
    R_Shutdown();
    mobjsByMapThing.clear();
    set_gameepisode(episode);
    set_gamemap(map);
    set_gameskill(skill);
    set_gamestate(gamestate_t.GS_LEVEL);
    // Pre-create every active player_t so P_SpawnMapThing can spawn co-op
    // players at the moment each numbered start is processed. Deathmatch
    // players are spawned after THINGS, as in p_setup.c:666-676.
    _PU.P_UserSetExternals({ r_bsp: _RB, p_mobj: _PMobj, gamemode: doomstat.gamemode });
    // p_mobj.c:638 — reuse existing structs so inventory carries between maps.
    // Only an entirely empty local topology defaults to player 0; demo header
    // topology (including a non-zero consoleplayer) must remain unchanged.
    G_EnsurePlayerTopology(doomstat.players, doomstat.playeringame, _PU.makePlayer);
    // P_SetupLevel internally runs P_InitThinkers BEFORE P_LoadThings and
    // P_SpawnSpecials AFTER, matching p_setup.c's ordering.
    P_SetupLevel(episode, map, 0, skill);
    if (afterSetup !== null) {
      const result = afterSetup();
      if (result !== null && result !== undefined &&
          (typeof result === 'object' || typeof result === 'function') &&
          typeof result.then === 'function') {
        I_Error('loadLevel: afterSetup must be synchronous');
      }
      // P_SetupLevel associates source mapthings with its temporary base
      // mobjs. Save restoration replaces that thinker population, so none of
      // those stale object references may survive into later level logic.
      mobjsByMapThing.clear();
    }
    // Corrupt-map fallback: a valid co-op map has one numbered start per active
    // player, while deathmatch spawned everyone just after P_LoadThings.
    for (let i = 0; i < doomstat.playeringame.length; i++) {
      if (doomstat.playeringame[i] !== true) continue;
      const activePlayer = doomstat.players[i];
      if (activePlayer.mo === null || activePlayer.mo === undefined) {
        const ps = doomstat.playerstarts[i];
        if (ps !== undefined) P_SpawnPlayer({ ...ps, type: i + 1 });
      }
    }
    // Build exactly once, after an optional save callback has replaced the base
    // world/thinkers and the corrupt-map fallback has supplied any missing mo.
    R_NewMap();
    _PTick.P_SetExternals({
      P_PlayerThink: _PU.P_PlayerThink,
      P_RespawnSpecials: PM.P_RespawnSpecials,
      P_UpdateSpecials: pSpec.P_UpdateSpecials,
    });
    // g_game.c:G_DoLoadLevel clears gamekeydown, mouse axes/buttons, and the
    // queued pause after P_SetupLevel. Do this on every load without removing
    // the early-installed DOM listeners.
    D_KeyboardInput.resetForLevel();
    const localPlayer = doomstat.players[doomstat.consoleplayer];
    if (localPlayer !== null && localPlayer !== undefined) D_KeyboardInput.init(localPlayer);
  };
  const validateSaveMap = (blob) => {
    const fingerprint = blob?.mapFingerprint;
    if (fingerprint === null || fingerprint === undefined ||
        !Number.isInteger(blob.episode) || !Number.isInteger(blob.map)) return false;
    // Reject values G_InitNew would clamp. Otherwise preflight could approve
    // (for example) a PWAD E1M10, mutate the live game, and then set up E1M9.
    if (doomstat.gamemode !== GameMode_t.commercial && blob.map > 9) return false;
    if (doomstat.gamemode === GameMode_t.shareware && blob.episode !== 1) return false;
    if (doomstat.gamemode !== GameMode_t.commercial &&
        doomstat.gamemode !== GameMode_t.retail && blob.episode > 3) return false;
    const mapName = doomstat.gamemode === GameMode_t.commercial ?
      `${blob.map < 10 ? 'MAP0' : 'MAP'}${blob.map}` :
      `E${blob.episode}M${blob.map}`;
    const lumpnum = W_CheckNumForName(mapName);
    if (lumpnum < 0) return false;
    try {
      return P_MapFingerprintsEqual(
        fingerprint,
        P_GetMapFingerprintForLump(lumpnum),
      );
    } catch (_) {
      // A truncated or otherwise malformed target map must be rejected before
      // G_InitNew tears down the currently playable world.
      return false;
    }
  };
  // Expose to G_DoLoadLevel callers (menu New Game) — see g_game.js setExternals.
  if (_GGame.G_SetExternals) {
    _GGame.G_SetExternals({
      loadLevel,
      saveGame: _PSaveg.P_SaveGame,
      readSave: _PSaveg.P_ReadSaveGame,
      restoreSave: _PSaveg.P_RestoreGame,
      validateSaveMap,
    });
  }

  // Command-line demo playback owns startup ahead of a saved/autostarted game.
  // G_PlayDemo/G_TimeDemo queue ga_playdemo for the first loop tic, matching
  // the regular attract-loop path without bypassing demo header setup.
  if (demoPlan !== null) {
    if (demoPlan.kind === 'playdemo') _GGame.G_PlayDemo(demoPlan.lump);
    else _GGame.G_TimeDemo(demoPlan.lump);
  } else if (loadGamePlan !== null) {
    // Browser save restoration is synchronous. Consume the queued action now
    // so a missing/corrupt slot can explicitly fall back to the title instead
    // of leaving GS_DEMOSCREEN without an owned page.
    _GGame.G_LoadGame(loadGamePlan.slot);
    if (_GGame.G_DoLoadGame() !== true) {
      console.warn(`Unable to load startup save slot ${loadGamePlan.slot}`);
      D_StartTitle();
    }
  } else if (startupPlan.autostart) {
    // Native -skill / -episode / -warp and the browser -map alias autostart a
    // real new game after the synchronous level-load hook has been installed.
    // d_main.c:1163-1164 — command-line autostart is a real new game, not a
    // raw map setup. G_InitNew applies -fast/-respawn state and marks the
    // session as a user game; G_DoLoadLevel then enters through the same
    // synchronous level-load path used by the game state machine.
    _GGame.G_InitNew(startupPlan.skill, startupPlan.episode, startupPlan.map);
    _GGame.G_DoLoadLevel();
  } else {
    // Kick off the title screen demo loop.
    D_StartTitle();
  }
  D_DoomLoop();
}
