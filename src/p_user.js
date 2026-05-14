// Ported from: linuxdoom-1.10/p_user.c
// Player thinker: reads player.cmd (ticcmd) and drives player.mo movement.
// Simplified — collision (P_TryMove) isn't online yet, so movement applies
// directly without wall clipping.

import { ticcmd_t } from './d_ticcmd.js';
import { mobj_t, MF_NOCLIP, MF_JUSTATTACKED, ONFLOORZ } from './p_mobj.js';
import { weapontype_t, NUMWEAPONS } from './doomdef.js';
import * as doomstat from './doomstat.js';

export const VIEWHEIGHT = 41 * 65536;
export const MAXBOB     = 0x100000;

// playerstate_t
export const PST_LIVE   = 0;
export const PST_DEAD   = 1;
export const PST_REBORN = 2;

// Build a player_t struct (mirrors d_player.h).
export function makePlayer() {
  // Look up S_PISTOL state index for the default weapon.
  // (Avoid a top-level import cycle by deferring.)
  const p = {
    mo: null,
    playerstate: PST_LIVE,
    cmd: new ticcmd_t(),
    viewz: 0,
    viewheight: VIEWHEIGHT,
    deltaviewheight: 0,
    bob: 0,
    health: 100,
    armorpoints: 0,
    armortype: 0,
    powers: new Int32Array(6),
    cards: [false, false, false, false, false, false],
    backpack: false,
    frags: new Int32Array(4),
    readyweapon: weapontype_t.wp_pistol,
    pendingweapon: weapontype_t.wp_nochange,
    weaponowned: [true, true, false, false, false, false, false, false, false], // fist + pistol
    ammo: [50, 0, 0, 0],
    maxammo: [200, 50, 300, 50],
    attackdown: 0,
    usedown: 0,
    cheats: 0,
    refire: 0,
    killcount: 0,
    itemcount: 0,
    secretcount: 0,
    message: null,
    damagecount: 0,
    bonuscount: 0,
    attacker: null,
    extralight: 0,
    fixedcolormap: 0,
    colormap: 0,
    psprites: [{ state: 0, tics: -1, sx: 0, sy: 32 << 16 }, { state: -1, tics: 0, sx: 0, sy: 32 << 16 }],
    didsecret: false,
  };
  return p;
}

// Set up player sprites at spawn — equivalent to P_SetupPsprites in p_pspr.c.
// Imports done dynamically to avoid import cycles during module load.
export async function P_SetupPsprites(player) {
  const info = await import('./info.js');
  const di = await import('./d_items.js');
  const wi = di.weaponinfo[player.readyweapon];
  // ps_weapon -> ready state for the weapon.
  player.psprites[0].state = wi.readystate;
  player.psprites[0].tics  = info.states[wi.readystate].tics;
  player.psprites[0].sx = 0;
  player.psprites[0].sy = 32 << 16;
  player.psprites[1].state = -1; // no flash by default
}

// P_Thrust — apply a forward-/side- move along an angle.
import { finesine, finecosine, ANGLETOFINESHIFT, FINEMASK } from './tables.js';
import { FixedMul } from './m_fixed.js';
export function P_Thrust(player, angle, move) {
  const fa = (angle >>> ANGLETOFINESHIFT) & FINEMASK;
  player.mo.momx = (player.mo.momx + FixedMul(move, finecosine[fa])) | 0;
  player.mo.momy = (player.mo.momy + FixedMul(move, finesine[fa])) | 0;
}

// p_user.c:77 — P_CalcHeight. View bob, smooth step-up animation, ceiling clamp.
let _onground = true;
export function P_CalcHeight(player) {
  // Bob magnitude from momentum.
  let bob = (FixedMul(player.mo.momx, player.mo.momx) +
             FixedMul(player.mo.momy, player.mo.momy)) | 0;
  bob >>= 2;
  if (bob > MAXBOB) bob = MAXBOB;
  player.bob = bob;
  if (((player.cheats & 4 /*CF_NOMOMENTUM*/) !== 0) || !_onground) {
    player.viewz = player.mo.z + VIEWHEIGHT;
    if (player.viewz > player.mo.ceilingz - 4 * 65536) player.viewz = player.mo.ceilingz - 4 * 65536;
    player.viewz = player.mo.z + player.viewheight;
    return;
  }
  // Sine-bob using leveltime as the phase.
  // C does integer division first: (FINEANGLES/20)=409, then *leveltime. Float
  // division here would silently change the bob phase and desync demos.
  const angle = (((8192 / 20) | 0) * (doomstat.leveltime | 0)) & 8191 /*FINEMASK*/;
  const bobAmp = FixedMul((player.bob / 2) | 0, finesine[angle]);
  if (player.playerstate === PST_LIVE) {
    player.viewheight += player.deltaviewheight;
    if (player.viewheight > VIEWHEIGHT) {
      player.viewheight = VIEWHEIGHT;
      player.deltaviewheight = 0;
    }
    if (player.viewheight < VIEWHEIGHT >> 1) {
      player.viewheight = VIEWHEIGHT >> 1;
      if (player.deltaviewheight <= 0) player.deltaviewheight = 1;
    }
    if (player.deltaviewheight !== 0) {
      player.deltaviewheight += 65536 / 4;
      if (player.deltaviewheight === 0) player.deltaviewheight = 1;
    }
  }
  player.viewz = (player.mo.z + player.viewheight + bobAmp) | 0;
  if (player.viewz > player.mo.ceilingz - 4 * 65536) player.viewz = player.mo.ceilingz - 4 * 65536;
}

// p_user.c:148 — P_MovePlayer.
export function P_MovePlayer(player) {
  const cmd = player.cmd;
  player.mo.angle = (player.mo.angle + (cmd.angleturn << 16)) >>> 0;
  _onground = (player.mo.z <= player.mo.floorz);
  if (cmd.forwardmove !== 0 && _onground) {
    P_Thrust(player, player.mo.angle, cmd.forwardmove * 2048);
  }
  if (cmd.sidemove !== 0 && _onground) {
    P_Thrust(player, (player.mo.angle - 0x40000000) >>> 0, cmd.sidemove * 2048);
  }
  if ((cmd.forwardmove !== 0 || cmd.sidemove !== 0) && player.mo.state === 149 /*S_PLAY*/) {
    if (_PMobjMod !== null) _PMobjMod.P_SetMobjState(player.mo, 150 /*S_PLAY_RUN1*/);
  }
}

// p_user.c:182 — P_DeathThink. Decreasing viewheight + turn toward attacker.
const ANG5 = (0x40000000 / 18) | 0;  // ANG90/18 with integer truncation (C semantics)
export function P_DeathThink(player) {
  P_MovePsprites(player);
  if (player.viewheight > 6 * 65536) player.viewheight -= 65536;
  if (player.viewheight < 6 * 65536) player.viewheight = 6 * 65536;
  player.deltaviewheight = 0;
  _onground = (player.mo.z <= player.mo.floorz);
  P_CalcHeight(player);
  if (player.attacker !== null && player.attacker !== player.mo) {
    const a = _r_bsp !== null
      ? _r_bsp.R_PointToAngle2(player.mo.x, player.mo.y, player.attacker.x, player.attacker.y)
      : 0;
    const delta = ((a - player.mo.angle) >>> 0);
    if (delta < ANG5 || delta > (0x100000000 - ANG5)) {
      player.mo.angle = a;
      if (player.damagecount > 0) player.damagecount--;
    } else if (delta < 0x80000000) {
      player.mo.angle = (player.mo.angle + ANG5) >>> 0;
    } else {
      player.mo.angle = (player.mo.angle - ANG5) >>> 0;
    }
  } else if (player.damagecount > 0) {
    player.damagecount--;
  }
  if ((player.cmd.buttons & 2 /*BT_USE*/) !== 0) player.playerstate = PST_REBORN;
}

// P_PlayerThink — p_user.c:236. P_MovePlayer only applies thrust; the actual
// position update happens in the player mobj's thinker via P_XYMovement,
// which now relinks the thing via P_TryMove → P_SetThingPosition.
import { P_UseLines } from './p_map.js';
import { P_MovePsprites } from './p_pspr.js';
export function P_PlayerThink(player) {
  if (player.mo === null) return;
  // NOCLIP cheat reflects to mobj flag.
  if ((player.cheats & 1 /*CF_NOCLIP*/) !== 0) player.mo.flags |= MF_NOCLIP;
  else                                          player.mo.flags &= ~MF_NOCLIP;
  // Chainsaw run-forward: vanilla quirks.
  if ((player.mo.flags & MF_JUSTATTACKED) !== 0) {
    player.cmd.angleturn = 0;
    player.cmd.forwardmove = 0xc800 / 512;
    player.cmd.sidemove = 0;
    player.mo.flags &= ~MF_JUSTATTACKED;
  }
  if (player.playerstate === PST_DEAD) {
    P_DeathThink(player);
    return;
  }
  if (player.mo.reactiontime > 0) {
    player.mo.reactiontime--;
  } else {
    P_MovePlayer(player);
  }
  P_CalcHeight(player);
  // Sector special damage (slime, lava, nukage, end-of-game).
  if (player.mo.subsector !== null && player.mo.subsector.sector.special !== 0 && _PSpec !== null &&
      typeof _PSpec.P_PlayerInSpecialSector === 'function') {
    _PSpec.P_PlayerInSpecialSector(player);
  }
  // Weapon change (BT_CHANGE).
  if ((player.cmd.buttons & 128 /*BT_SPECIAL*/) !== 0) player.cmd.buttons = 0;
  if ((player.cmd.buttons & 4 /*BT_CHANGE*/) !== 0) {
    let newweapon = (player.cmd.buttons & 0x38 /*BT_WEAPONMASK*/) >> 3 /*BT_WEAPONSHIFT*/;
    if (newweapon === 0 /*wp_fist*/ && player.weaponowned[7 /*wp_chainsaw*/] &&
        !(player.readyweapon === 7 && player.powers[1] !== 0)) {
      newweapon = 7;
    }
    // Doom 2 super shotgun upgrade.
    if (_gamemode === 2 /*commercial*/ &&
        newweapon === 2 /*wp_shotgun*/ &&
        player.weaponowned[8 /*wp_supershotgun*/] &&
        player.readyweapon !== 8) {
      newweapon = 8;
    }
    if (player.weaponowned[newweapon] && newweapon !== player.readyweapon) {
      // Block plasma/BFG in shareware even if cheated.
      if ((newweapon !== 5 /*wp_plasma*/ && newweapon !== 6 /*wp_bfg*/) ||
          _gamemode !== 0 /*shareware*/) {
        player.pendingweapon = newweapon;
      }
    }
  }
  // BT_USE.
  if ((player.cmd.buttons & 2 /*BT_USE*/) !== 0) {
    if (player.usedown === 0) {
      P_UseLines(player);
      player.usedown = 1;
    }
  } else {
    player.usedown = 0;
  }
  // Cycle psprites.
  P_MovePsprites(player);
  // Power-up timers.
  if (player.powers[1 /*pw_strength*/]        !== 0) player.powers[1]++;
  if (player.powers[0 /*pw_invulnerability*/] !== 0) player.powers[0]--;
  if (player.powers[2 /*pw_invisibility*/]    !== 0) {
    if (--player.powers[2] === 0) player.mo.flags &= ~0x40000 /*MF_SHADOW*/;
  }
  if (player.powers[5 /*pw_infrared*/] !== 0) player.powers[5]--;
  if (player.powers[3 /*pw_ironfeet*/] !== 0) player.powers[3]--;
  if (player.damagecount > 0) player.damagecount--;
  if (player.bonuscount   > 0) player.bonuscount--;
  // Handling colormaps (p_user.c:362).
  if (player.powers[0 /*pw_invulnerability*/] !== 0) {
    if (player.powers[0] > 4 * 32 || (player.powers[0] & 8) !== 0) {
      player.fixedcolormap = 32 /*INVERSECOLORMAP*/;
    } else {
      player.fixedcolormap = 0;
    }
  } else if (player.powers[5 /*pw_infrared*/] !== 0) {
    if (player.powers[5] > 4 * 32 || (player.powers[5] & 8) !== 0) {
      player.fixedcolormap = 1;
    } else {
      player.fixedcolormap = 0;
    }
  } else {
    player.fixedcolormap = 0;
  }
  // Pickup overlap fallback. P_TryMove → PIT_CheckThing handles pickups on move
  // but if the player stands still on top of an item the fallback ensures it
  // still gets picked up next tic.
  if (player.mo.subsector !== null && player.mo.subsector.sector !== null && _pInter !== null) {
    const sec = player.mo.subsector.sector;
    let mo = sec.thinglist;
    while (mo !== null) {
      const next = mo.snext;
      if (mo !== player.mo && (mo.flags & 1 /*MF_SPECIAL*/) !== 0) {
        const dx = mo.x - player.mo.x;
        const dy = mo.y - player.mo.y;
        const r = mo.radius + player.mo.radius;
        if (Math.abs(dx) < r && Math.abs(dy) < r) {
          _pInter.P_TouchSpecialThing(mo, player.mo);
        }
      }
      mo = next;
    }
  }
}

// Externals for sector specials.
let _PSpec = null;
export function P_UserSetSpec(refs) { if (refs.PSpec) _PSpec = refs.PSpec; }

let _pInter = null;
export function P_UserSetInter(refs) { if (refs.p_inter) _pInter = refs.p_inter; }

let _r_bsp = null;
let _PMobjMod = null;
let _gamemode = 0; // shareware by default; doomstat sets this at init
export function P_UserSetExternals(refs) {
  if (refs.r_bsp)  _r_bsp     = refs.r_bsp;
  if (refs.p_mobj) _PMobjMod  = refs.p_mobj;
  if (refs.gamemode != null) _gamemode = refs.gamemode;
}
