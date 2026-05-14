// Browser-only: build player_t.cmd (ticcmd_t) from keyboard + mouse state
// each tic. Mirrors G_BuildTiccmd in g_game.c.
//
// We expose a `buildCmd(player)` function called from D_DoomLoop's tic step,
// so cmd is written exactly once per tic (in sync with P_PlayerThink).

import { renderer } from './i_video.js';

const keys = new Set();
let mouseDX = 0;
let mouseButtons = 0;

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
          e.code === 'ControlLeft' || e.code === 'AltLeft' || e.code === 'Tab') {
        e.preventDefault?.();
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
          Escape: 27, Enter: 13, NumpadEnter: 13, Backspace: 0x08,
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
    const fast = keys.has('ShiftLeft') || keys.has('ShiftRight');
    const fwd = fast ? 50 : 25;
    const side = fast ? 40 : 24;
    // Slow turn when only turning (no movement) — matches vanilla's
    // `turnheld < SLOWTURNTICS` short-circuit.
    const turnHeld = (keys.has('ArrowLeft') || keys.has('ArrowRight'));
    const moving = (keys.has('KeyW') || keys.has('KeyS') ||
                    keys.has('ArrowUp') || keys.has('ArrowDown') ||
                    keys.has('KeyA') || keys.has('KeyD'));
    const turn = (turnHeld && !moving) ? 320 : (fast ? 1280 : 640);
    if (keys.has('KeyW') || keys.has('ArrowUp'))    cmd.forwardmove =  fwd;
    if (keys.has('KeyS') || keys.has('ArrowDown'))  cmd.forwardmove = -fwd;
    if (keys.has('KeyD'))                            cmd.sidemove    =  side;
    if (keys.has('KeyA'))                            cmd.sidemove    = -side;
    if (keys.has('ArrowLeft'))  cmd.angleturn =  turn;
    if (keys.has('ArrowRight')) cmd.angleturn = -turn;
    // Mouse contribution. Clamp to a 16-bit-safe range so cmd.angleturn
    // (stored as a signed short in demo recordings) doesn't wrap on big spins.
    let mouseTurn = (mouseDX * 8) | 0;
    if (mouseTurn >  0x7fff) mouseTurn =  0x7fff;
    if (mouseTurn < -0x8000) mouseTurn = -0x8000;
    cmd.angleturn -= mouseTurn;
    if (cmd.angleturn >  0x7fff) cmd.angleturn =  0x7fff;
    if (cmd.angleturn < -0x8000) cmd.angleturn = -0x8000;
    mouseDX = 0;
    if (mouseButtons & 1)        cmd.buttons |= 1; // BT_ATTACK
    if (keys.has('ControlLeft')) cmd.buttons |= 1;
    if (keys.has('Space'))       cmd.buttons |= 2; // BT_USE
  },
};
