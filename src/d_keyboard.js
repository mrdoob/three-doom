// Browser-only: build player_t.cmd (ticcmd_t) from keyboard + mouse state
// each tic. Mirrors G_BuildTiccmd in g_game.c.
//
// We expose a `buildCmd(player)` function called from D_DoomLoop's tic step,
// so cmd is written exactly once per tic (in sync with P_PlayerThink).

import { renderer } from './i_video.js';
import { BT_SPECIAL, BTS_PAUSE } from './d_event.js';

// Cache cross-module references at module load — keystrokes are a hot path
// and `await import()` per event adds microtask latency. The dynamic-import
// dance is only needed at startup to break the i_video ↔ m_menu cycle.
let _mMenu = null;
import('./m_menu.js').then((m) => { _mMenu = m; });

const keys = new Set();
let mouseDX = 0;
let mouseButtons = 0;
// g_game.c:262 — two-stage accelerative turning. `turnheld` accumulates the
// number of tics the user has held a turn key; while it's below SLOWTURNTICS
// we use the slow-turn rate, after which we fall through to the normal/fast
// rate. Replaces the previous turnHeld-when-not-moving heuristic.
const SLOWTURNTICS = 6;
let turnheld = 0;
// g_game.c:355 — forward double-click → BT_USE shortcut.
let dclicks = 0;
let dclickstate = 0;
let dclicktime = 0;
// g_game.c:G_Responder — KEY_PAUSE latches sendpause; G_BuildTiccmd (buildCmd)
// drains it into the next ticcmd as BT_SPECIAL|BTS_PAUSE.
let sendpause = false;

let _listenersInstalled = false;
function installListeners() {
  if (_listenersInstalled) return;
  _listenersInstalled = true;
  document.addEventListener('keydown', async (e) => {
      keys.add(e.code);
      // preventDefault must run SYNCHRONOUSLY during dispatch — call it before
      // any awaited dynamic imports below, otherwise the browser's default
      // (e.g. Space scrolling the page) fires first.
      if (e.code === 'Space' || e.code.startsWith('Arrow') ||
          e.code.startsWith('Key') || e.code === 'ShiftLeft' ||
          e.code === 'ControlLeft' || e.code === 'AltLeft' || e.code === 'Tab' ||
          e.code === 'Pause') {
        e.preventDefault?.();
      }
      const ds = await import('./doomstat.js');
      // KEY_PAUSE — toggle pause during live (non-demo) gameplay. Latch the
      // request; buildCmd encodes it into the next ticcmd and G_CheckSpecialButtons
      // performs the paused/music toggle. Ignored outside a level so it can't
      // strand sendpause across a demo (which bypasses buildCmd).
      if (e.code === 'Pause') {
        if (ds.gamestate === 0 /*GS_LEVEL*/ && ds.demoplayback !== true) sendpause = true;
        return;
      }
      // Outside active gameplay (title pages / demo playback), any non-Esc
      // keypress opens the main menu so the user doesn't have to know which
      // key to press. Esc keeps the menu closed in that state.
      if (ds.menuactive !== true &&
          (ds.gamestate === 3 /*GS_DEMOSCREEN*/ ||
           (ds.gamestate === 0 /*GS_LEVEL*/ && ds.demoplayback === true))) {
        if (e.code !== 'Escape' && _mMenu !== null) _mMenu.M_StartControlPanel();
        e.preventDefault?.();
        return;
      }
      // Intermission screen — any keypress advances. Check this before
      // automap / cheats so the press-to-continue gesture isn't mistaken
      // for an in-game action. (gamestate_t.GS_INTERMISSION === 1)
      //
      // ALWAYS consume the key while gamestate==INTERMISSION, even if
      // WI_Responder returns false (it does once WI._active flips off after
      // onDone fires — there's a 1-tic gap before gamestate transitions to
      // GS_LEVEL). Without the unconditional swallow, an Escape pressed in
      // that window falls through to the menu branch below and opens the
      // main menu instead of doing nothing.
      if (ds.gamestate === 1 /*GS_INTERMISSION*/) {
        const wi = await import('./wi_stuff.js');
        wi.WI_Responder({ type: 0, data1: e.keyCode | 0 });
        e.preventDefault?.();
        return;
      }
      // Single-shot automap controls.
      if (e.code === 'Tab') {
        (await import('./am_map.js')).AM_Toggle();
      } else if (e.code === 'Equal' || e.code === 'NumpadAdd') {
        (await import('./am_map.js')).AM_Responder({ type: 0, data1: 0x2b });
      } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
        (await import('./am_map.js')).AM_Responder({ type: 0, data1: 0x2d });
      } else if (e.code === 'KeyF') {
        (await import('./am_map.js')).AM_Responder({ type: 0, data1: 0x66 });
      }
      // Menu — Esc opens/closes; while menu is open or a modal is up, route
      // arrows / Enter / Backspace / y / n through M_Responder.
      else if (e.code === 'Escape' || (await import('./doomstat.js')).menuactive) {
        const m = await import('./m_menu.js');
        const codeToKey = {
          Escape: 27, Enter: 13, NumpadEnter: 13, Backspace: 127 /*KEY_BACKSPACE*/,
          ArrowUp: 0xad, ArrowDown: 0xaf, ArrowLeft: 0xac, ArrowRight: 0xae,
          KeyY: 0x79, KeyN: 0x6e,
        };
        const data1 = codeToKey[e.code];
        if (data1 !== undefined && m.M_Responder({ type: 0, data1 })) {
          e.preventDefault?.();
          return;
        }
      }
      // Cheat sequencer — feed each lowercase letter through the table.
      else if (e.code.startsWith('Key')) {
        const ch = e.code.charAt(3).toLowerCase().charCodeAt(0);
        await import('./m_cheat.js').then(m => m.cht_HandleKey(ch));
      }
      // Weapon switching: digit keys 1..7 -> wp_fist .. wp_bfg.
      if (e.code.startsWith('Digit')) {
        // Vanilla ST_Responder feeds every key (digits included) to the cheat
        // sequencer; without this IDMUS could never collect its 2-digit param.
        const digCh = e.code.slice(5).charCodeAt(0); // '0'..'9'
        await import('./m_cheat.js').then(m => m.cht_HandleKey(digCh));
        const slot = parseInt(e.code.slice(5), 10);
        if (slot >= 1 && slot <= 7) {
          const ds = await import('./doomstat.js');
          const p = ds.players[ds.consoleplayer];
          if (p !== null && p !== undefined && p.mo !== null) {
            const wp = slot - 1;
            if (p.weaponowned[wp]) p.pendingweapon = wp;
          }
        }
      }
    });
  document.addEventListener('keyup', (e) => { keys.delete(e.code); });
  document.addEventListener('mousedown', async (e) => {
    mouseButtons |= (1 << e.button);
    // Recapture pointer lock only during interactive play. Demo playback
    // shouldn't grab the cursor — the user might want to click out.
    const ds = await import('./doomstat.js');
    if (ds.gamestate === 0 /*GS_LEVEL*/ && !ds.demoplayback &&
        document.pointerLockElement !== renderer.domElement) {
      renderer.domElement.requestPointerLock?.();
    }
  });
  document.addEventListener('mouseup', (e) => { mouseButtons &= ~(1 << e.button); });
  document.addEventListener('mousemove', (e) => {
    if (document.pointerLockElement === renderer.domElement) mouseDX += e.movementX;
  });
}

// Called when a level starts — captures the mouse for look-around. Falls back
// silently if the browser refuses (e.g. requires a user gesture in some flows).
export function D_AcquirePointerLock() {
  try { renderer.domElement.requestPointerLock?.(); } catch { /* ignore */ }
}

export const D_KeyboardInput = {
  init(_player) { installListeners(); },
  installEarly() { installListeners(); },

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
    const fwd  = fast ? 50 : 25;
    const side = fast ? 40 : 24;

    // g_game.c:262 — accumulative turnheld. Slow turn only for the first
    // SLOWTURNTICS tics of the press, then accelerate.
    const turning = keys.has('ArrowLeft') || keys.has('ArrowRight');
    if (turning === true) turnheld++;
    else                  turnheld = 0;
    const tspeed = (turnheld < SLOWTURNTICS) ? 320 : (fast ? 1280 : 640);

    if (keys.has('KeyW') || keys.has('ArrowUp'))    cmd.forwardmove =  fwd;
    if (keys.has('KeyS') || keys.has('ArrowDown'))  cmd.forwardmove = -fwd;
    if (keys.has('KeyD'))                            cmd.sidemove    =  side;
    if (keys.has('KeyA'))                            cmd.sidemove    = -side;
    if (keys.has('ArrowLeft'))  cmd.angleturn =  tspeed;
    if (keys.has('ArrowRight')) cmd.angleturn = -tspeed;

    // Mouse contribution. Clamp to a 16-bit-safe range so cmd.angleturn
    // (stored as a signed short in demo recordings) doesn't wrap on big spins.
    let mouseTurn = (mouseDX * 8) | 0;
    if (mouseTurn >  0x7fff) mouseTurn =  0x7fff;
    if (mouseTurn < -0x8000) mouseTurn = -0x8000;
    cmd.angleturn -= mouseTurn;
    if (cmd.angleturn >  0x7fff) cmd.angleturn =  0x7fff;
    if (cmd.angleturn < -0x8000) cmd.angleturn = -0x8000;
    mouseDX = 0;

    // Buttons.
    const attack = (mouseButtons & 1) !== 0 || keys.has('ControlLeft');
    const use    = keys.has('Space');
    if (attack === true) cmd.buttons |= 1; // BT_ATTACK
    if (use === true) {
      cmd.buttons |= 2; // BT_USE
      dclicks = 0;       // pressing Use cancels any pending forward dclick
    }

    // g_game.c:354 — forward double-click (forward mouse button or W/Up
    // tapped twice within 20 tics) latches BT_USE. Lets you door-bump
    // without taking your hand off the move keys.
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

    // g_game.c:430 — a queued pause overrides all other buttons this tic.
    if (sendpause === true) {
      sendpause = false;
      cmd.buttons = BT_SPECIAL | BTS_PAUSE;
    }
  },
};
