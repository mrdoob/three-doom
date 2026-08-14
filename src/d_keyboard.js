// Browser-only: build player_t.cmd (ticcmd_t) from keyboard + mouse state
// each tic. Mirrors G_BuildTiccmd in g_game.c.
//
// We expose a `buildCmd(player)` function called from D_DoomLoop's tic step,
// so cmd is written exactly once per tic (in sync with P_PlayerThink).

import { renderer, I_RegisterGraphicsShutdownHook, I_TranslateKey } from './i_video.js';
import { BT_CHANGE, BT_SPECIAL, BTS_PAUSE, BT_WEAPONSHIFT, evtype_t } from './d_event.js';
import { KEY_EQUALS } from './doomdef.js';
import { AM_ResetControls, AM_Responder } from './am_map.js';
import { cht_HandleKey } from './m_cheat.js';
import { G_NextDisplayPlayer, G_ShouldCycleDisplayPlayer } from './g_spy_logic.js';
import {
  D_ComputeMovement,
  D_MouseStrafePressed,
  D_ResetLevelInputState,
  D_ScaleMouseDelta,
  D_ShouldCaptureGameplayPress,
  D_ShouldInterceptDemoInput,
} from './d_input_logic.js';
import * as doomstat from './doomstat.js';

// Cache cross-module references at module load — keystrokes are a hot path
// and `await import()` per event adds microtask latency. The dynamic-import
// dance is only needed at startup to break the i_video ↔ m_menu cycle.
let _mMenu = null;
import('./m_menu.js').then((m) => { _mMenu = m; });
let _fFinale = null;
import('./f_finale.js').then((f) => { _fFinale = f; });

const keys = new Set();
let mouseDX = 0;
let mouseDY = 0;
let mouseButtons = 0;
// g_game.c:262 — two-stage accelerative turning. `turnheld` accumulates the
// number of tics the user has held a turn key; the pure movement helper picks
// the slow rate for the first six, then the normal/fast rate.
let turnheld = 0;
// g_game.c:355 — forward double-click → BT_USE shortcut.
let dclicks = 0;
let dclickstate = 0;
let dclicktime = 0;
let dclicks2 = 0;
let dclickstate2 = 0;
let dclicktime2 = 0;
// g_game.c:G_Responder — KEY_PAUSE latches sendpause; G_BuildTiccmd (buildCmd)
// drains it into the next ticcmd as BT_SPECIAL|BTS_PAUSE.
let sendpause = false;

let _listenersInstalled = false;
let _unregisterShutdownHook = null;
let _listenerGeneration = 0;
function listenerIsActive(generation) {
  return _listenersInstalled === true && generation === _listenerGeneration;
}
function demoInputIsIntercepted() {
  return D_ShouldInterceptDemoInput(doomstat);
}
async function onKeyDown(e) {
      const generation = _listenerGeneration;
      // preventDefault must run SYNCHRONOUSLY during dispatch — call it before
      // any awaited dynamic imports below, otherwise the browser's default
      // (e.g. Space scrolling the page) fires first.
      if (e.code === 'Space' || e.code.startsWith('Arrow') ||
          e.code.startsWith('Key') || e.code === 'ShiftLeft' ||
          e.code === 'ControlLeft' || e.code === 'AltLeft' || e.code === 'Tab' ||
          e.code === 'Pause') {
        e.preventDefault?.();
      }
      // d_main.c:D_ProcessEvents gives M_Responder first refusal on every
      // event. Keep this synchronous and before keys.add so a menu-consumed
      // press never appears in a ticcmd (including while a netgame keeps
      // ticking). M_Responder ignores keyups; onKeyUp still clears them below.
      const doomKey = I_TranslateKey(e);
      const menuConsumed = doomKey !== 0 && (_mMenu !== null
        ? _mMenu.M_Responder({ type: evtype_t.ev_keydown, data1: doomKey, data2: 0, data3: 0 }) === true
        : doomstat.menuactive === true);
      if (D_ShouldCaptureGameplayPress(menuConsumed) !== true) {
        e.preventDefault?.();
        return;
      }
      // The event-ring G_Responder is represented directly by these browser
      // handlers. Preserve its F12 spy branch before attract/demo interception
      // and before the key can enter gamekeydown.
      if (G_ShouldCycleDisplayPlayer(
        doomstat.gamestate,
        evtype_t.ev_keydown,
        doomKey,
        doomstat.singledemo,
        doomstat.deathmatch,
      )) {
        doomstat.set_displayplayer(G_NextDisplayPlayer(
          doomstat.displayplayer,
          doomstat.consoleplayer,
          doomstat.playeringame,
        ));
        e.preventDefault?.();
        return;
      }
      // During any demo state, or on an attract page, button presses open the
      // menu and never enter gamekeydown. This precedes state responders in
      // g_game.c and therefore also covers demo intermissions/finales.
      // keypress opens the main menu so the user doesn't have to know which
      // key to press. Esc keeps the menu closed in that state.
      if (doomstat.menuactive !== true &&
          demoInputIsIntercepted()) {
        if (e.code !== 'Escape' && _mMenu !== null) _mMenu.M_StartControlPanel();
        e.preventDefault?.();
        return;
      }
      // g_game.c:G_Responder gives F_Responder precedence over gamekeydown
      // and KEY_PAUSE. During MAP30's cast it consumes every keydown to enter
      // (or remain in) the actor's death sequence.
      if (doomstat.gamestate === 2 /*GS_FINALE*/ && doomstat.menuactive !== true) {
        const finale = _fFinale ?? await import('./f_finale.js');
        _fFinale = finale;
        if (listenerIsActive(generation) !== true) return;
        if (finale.F_Responder({ type: evtype_t.ev_keydown, data1: doomKey, data2: 0, data3: 0 })) {
          e.preventDefault?.();
          return;
        }
      }
      const wasHeld = keys.has(e.code);
      keys.add(e.code);
      // g_game.c:G_Responder handles KEY_PAUSE without a gamestate guard once
      // attract/demo input has been intercepted above. The next complete
      // ticcmd carries BT_SPECIAL|BTS_PAUSE in levels, intermissions, or
      // finales, and G_CheckSpecialButtons drains it before the state ticker.
      if (e.code === 'Pause') {
        sendpause = true;
        return;
      }
      // Intermission input is polled from complete ticcmds by WI_Ticker.
      // M_Responder already had first refusal above (so Escape/F11 still work);
      // swallow the remaining direct handlers to keep letters and arrows out
      // of automap/cheats while retaining their held-key state for buildCmd.
      if (doomstat.gamestate === 1 /*GS_INTERMISSION*/) {
        e.preventDefault?.();
        return;
      }
      // Non-cast finales sample complete ticcmds, but must not route the same
      // DOM keydown into automap, cheats, or direct weapon handlers. Escape
      // was already offered to the global menu responder above.
      if (doomstat.gamestate === 2 /*GS_FINALE*/ && doomstat.menuactive !== true) {
        if (e.code !== 'Escape') {
          e.preventDefault?.();
          return;
        }
      }
      // st_stuff.c's cheat sequencer runs before AM_Responder. Every letter
      // must reach it, including F/M/C that automap may also consume.
      if (e.code.startsWith('Key')) {
        const ch = e.code.charAt(3).toLowerCase().charCodeAt(0);
        cht_HandleKey(ch);
      } else if (e.code.startsWith('Digit')) {
        // Vanilla ST_Responder feeds digits too (e.g. IDMUS parameters).
        const digCh = e.code.slice(5).charCodeAt(0); // '0'..'9'
        cht_HandleKey(digCh);
      }

      // st_stuff.c's cheat responder above precedes AM_Responder, which in
      // turn precedes gamekeydown. Offer every level key to the automap so its
      // arrow ownership can depend on follow mode and held controls receive
      // matching keyups. Browser Equal/NumpadAdd both represent Doom's '='.
      if (doomstat.gamestate === 0 /*GS_LEVEL*/) {
        const mapKey = (e.code === 'Equal' || e.code === 'NumpadAdd')
          ? KEY_EQUALS
          : doomKey;
        if (AM_Responder({ type: evtype_t.ev_keydown, data1: mapKey }) === true) {
          // A newly captured automap press never reaches gamekeydown. An
          // auto-repeat of a key that previously filtered through must leave
          // that older held gameplay state intact until the real keyup.
          if (wasHeld !== true) keys.delete(e.code);
          e.preventDefault?.();
          return;
        }
      }
}

// Vanilla lets keyups fall through M_Responder to G_Responder. Always clear a
// release, even while the menu is active, so pre-menu movement cannot stick in
// a live netgame.
function onKeyUp(e) {
  if (doomstat.gamestate === 0 /*GS_LEVEL*/) {
    const doomKey = I_TranslateKey(e);
    const mapKey = (e.code === 'Equal' || e.code === 'NumpadAdd')
      ? KEY_EQUALS
      : doomKey;
    AM_Responder({ type: evtype_t.ev_keyup, data1: mapKey });
  }
  keys.delete(e.code);
}

function onMouseDown(e) {
    // g_game.c's demo interception consumes mouse-button presses before they
    // can alter gameplay state. i_video opens the menu on this same mousedown
    // so middle/right buttons work as well as the primary button.
    if (demoInputIsIntercepted()) {
      e.preventDefault?.();
      return;
    }
    // i_video owns the actual menu tap on the later click event. Its
    // M_HandleTap path consumes every tap while the menu is active, so mirror
    // D_ProcessEvents precedence here before mutating gameplay button state or
    // asking the browser to recapture the pointer.
    const menuConsumed = doomstat.menuactive === true;
    if (D_ShouldCaptureGameplayPress(menuConsumed) !== true) {
      e.preventDefault?.();
      return;
    }
    mouseButtons |= (1 << e.button);
    // Recapture pointer lock only during interactive play. Demo playback
    // shouldn't grab the cursor — the user might want to click out.
    if (doomstat.gamestate === 2 /*GS_FINALE*/) {
      // Mouse attack remains visible to the per-tic finale command sampler;
      // cast death input is keyboard-only in f_finale.c.
      e.preventDefault?.();
      return;
    }
    if (doomstat.gamestate === 0 /*GS_LEVEL*/ && !doomstat.demoplayback &&
        renderer !== null && document.pointerLockElement !== renderer.domElement) {
      renderer.domElement.requestPointerLock?.();
    }
}

function onMouseUp(e) { mouseButtons &= ~(1 << e.button); }

function onMouseMove(e) {
    // Attract/demo interception applies only to ev_mouse events whose button
    // mask is nonzero.  Zero-button motion still updates the local axes; the
    // tic loop drains those axes before replacing the command from the demo.
    const demoButtonPress = demoInputIsIntercepted() === true && (e.buttons | 0) !== 0;
    if (doomstat.menuactive !== true && demoButtonPress !== true &&
        renderer !== null && document.pointerLockElement === renderer.domElement) {
      // g_game.c:G_Responder applies sensitivity before G_BuildTiccmd consumes
      // the axes. Preserve that per-event truncation while accumulating the
      // browser's pointer-lock movement events until the next 35 Hz tic.
      mouseDX += D_ScaleMouseDelta(e.movementX, doomstat.mouseSensitivity);
      mouseDY += D_ScaleMouseDelta(-e.movementY, doomstat.mouseSensitivity);
    }
}

function resetLevelInput() {
  const state = D_ResetLevelInputState({
    keys,
    mouseDX,
    mouseDY,
    mouseButtons,
    sendpause,
  });
  mouseDX = state.mouseDX;
  mouseDY = state.mouseDY;
  mouseButtons = state.mouseButtons;
  sendpause = state.sendpause;
}

// Browsers do not guarantee matching keyup/mouseup events after focus leaves
// the page. Drop every transient command input at that ownership boundary so
// a held movement, attack, or accumulated pointer delta cannot stick when the
// player returns. Reset the gesture counters as well: unlike a level load,
// focus loss must not join clicks or turn acceleration across tabs.
function resetFocusInput() {
  // A finale keydown may currently be suspended on its first dynamic import.
  // Advancing the generation prevents that continuation from adding its key
  // after this reset; newly dispatched events capture the new generation.
  _listenerGeneration++;
  resetLevelInput();
  AM_ResetControls();
  turnheld = 0;
  dclicks = 0;
  dclickstate = 0;
  dclicktime = 0;
  dclicks2 = 0;
  dclickstate2 = 0;
  dclicktime2 = 0;
}

function onWindowBlur() { resetFocusInput(); }
function onVisibilityChange() {
  if (document.visibilityState === 'hidden') resetFocusInput();
}

function installListeners() {
  if (_listenersInstalled) return;
  _listenersInstalled = true;
  _listenerGeneration++;
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);
  document.addEventListener('mousedown', onMouseDown);
  document.addEventListener('mouseup', onMouseUp);
  document.addEventListener('mousemove', onMouseMove);
  window.addEventListener('blur', onWindowBlur);
  document.addEventListener('visibilitychange', onVisibilityChange);
  _unregisterShutdownHook = I_RegisterGraphicsShutdownHook(shutdownListeners);
}

function shutdownListeners() {
  _listenerGeneration++;
  if (_listenersInstalled === true) {
    document.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('keyup', onKeyUp);
    document.removeEventListener('mousedown', onMouseDown);
    document.removeEventListener('mouseup', onMouseUp);
    document.removeEventListener('mousemove', onMouseMove);
    window.removeEventListener('blur', onWindowBlur);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    _listenersInstalled = false;
  }
  if (_unregisterShutdownHook !== null) {
    const unregister = _unregisterShutdownHook;
    _unregisterShutdownHook = null;
    unregister();
  }
  keys.clear();
  mouseDX = 0;
  mouseDY = 0;
  mouseButtons = 0;
  turnheld = 0;
  dclicks = 0;
  dclickstate = 0;
  dclicktime = 0;
  dclicks2 = 0;
  dclickstate2 = 0;
  dclicktime2 = 0;
  sendpause = false;
}

// Called when a level starts — captures the mouse for look-around. Falls back
// silently if the browser refuses (e.g. requires a user gesture in some flows).
export function D_AcquirePointerLock() {
  try { renderer?.domElement.requestPointerLock?.(); } catch { /* ignore */ }
}

export const D_KeyboardInput = {
  init(_player) { installListeners(); },
  installEarly() { installListeners(); },
  resetForLevel() { resetLevelInput(); },
  shutdown() { shutdownListeners(); },
  isPressed(code) { return keys.has(code); },

  // Build the ticcmd from current input. Called once per 35Hz tic.
  // Mirrors g_game.c::G_BuildTiccmd using vanilla's movement tables:
  //   forwardmove[2] = { 25, 50 }
  //   sidemove[2]    = { 24, 40 }
  //   angleturn[3]   = { 640, 1280, 320 }   // [normal, fast, slow]
  buildCmd(player) {
    const cmd = player.cmd;
    cmd.forwardmove = 0;
    cmd.sidemove    = 0;
    cmd.angleturn   = 0;
    cmd.buttons     = 0;
    // g_game.c:328 — vanilla pulls a queued chat character every tic. We
    // don't ship chat, but match the byte layout so demos record/play with
    // a deterministic chatchar slot.
    cmd.chatchar    = 0;
    // g_game.c:175 — vanilla movement tables.
    //   forwardmove[2] = { 25, 50 }
    //   sidemove[2]    = { 24, 40 }
    //   angleturn[3]   = { 640, 1280, 320 }  // [normal, fast, slow]
    const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
    // g_game.c:262 — accumulative turnheld. Slow turn only for the first
    // SLOWTURNTICS tics of the press, then accelerate.
    const turning = keys.has('ArrowLeft') || keys.has('ArrowRight');
    if (turning === true) turnheld++;
    else                  turnheld = 0;
    const mouseStrafe = D_MouseStrafePressed(mouseButtons);
    const strafe = keys.has('AltLeft') || keys.has('AltRight') || mouseStrafe;
    const movement = D_ComputeMovement({
      fast,
      forward: keys.has('KeyW') || keys.has('ArrowUp'),
      backward: keys.has('KeyS') || keys.has('ArrowDown'),
      strafeRight: keys.has('KeyD') || keys.has('Period'),
      strafeLeft: keys.has('KeyA') || keys.has('Comma'),
      turnRight: keys.has('ArrowRight'),
      turnLeft: keys.has('ArrowLeft'),
      strafe,
      mouseForward: (mouseButtons & 4) !== 0,
      mouseX: mouseDX,
      mouseY: mouseDY,
    }, turnheld);
    cmd.forwardmove = movement.forwardmove;
    cmd.sidemove = movement.sidemove;
    cmd.angleturn = movement.angleturn;
    mouseDX = mouseDY = 0;

    // Buttons.
    const attack = (mouseButtons & 1) !== 0 || keys.has('ControlLeft') || keys.has('ControlRight');
    const use    = keys.has('Space');
    if (attack === true) cmd.buttons |= 1; // BT_ATTACK
    if (use === true) {
      cmd.buttons |= 2; // BT_USE
      dclicks = 0;       // pressing Use cancels any pending forward dclick
    }

    // g_game.c:340 — weapon changes are part of the ticcmd (and therefore
    // demo/net data), not an immediate pendingweapon side effect.
    for (let slot = 1; slot <= 8; slot++) {
      if (!keys.has(`Digit${slot}`)) continue;
      cmd.buttons |= BT_CHANGE | ((slot - 1) << BT_WEAPONSHIFT);
      break;
    }

    // g_game.c:354 — double-clicking the forward mouse button within 20 tics
    // latches BT_USE. Lets you door-bump without leaving the mouse.
    const forwardDC = (mouseButtons & 4) !== 0; // right-mouse here = forward
    if (forwardDC !== (dclickstate !== 0) && dclicktime > 1) {
      dclickstate = forwardDC ? 1 : 0;
      if (dclickstate === 1) dclicks++;
      if (dclicks === 2) { cmd.buttons |= 2 /*BT_USE*/; dclicks = 0; }
      else dclicktime = 0;
    } else {
      dclicktime++;
      if (dclicktime > 20) { dclicks = 0; dclickstate = 0; }
    }
    // Middle-mouse strafe double-click uses the original second BT_USE state
    // machine. Keyboard Alt changes movement mode but contributes no click.
    if (mouseStrafe !== (dclickstate2 !== 0) && dclicktime2 > 1) {
      dclickstate2 = mouseStrafe ? 1 : 0;
      if (dclickstate2 === 1) dclicks2++;
      if (dclicks2 === 2) { cmd.buttons |= 2 /*BT_USE*/; dclicks2 = 0; }
      else dclicktime2 = 0;
    } else {
      dclicktime2++;
      if (dclicktime2 > 20) { dclicks2 = 0; dclickstate2 = 0; }
    }

    // g_game.c:430 — a queued pause overrides all other buttons this tic.
    if (sendpause === true) {
      sendpause = false;
      cmd.buttons = BT_SPECIAL | BTS_PAUSE;
    }
  },
};
