// Ported from: linuxdoom-1.10/p_pspr.c, p_pspr.h
// Player sprite ("psprite") = weapon overlay + muzzle flash, drawn on top of
// the view in screen coordinates. Plus the per-weapon action functions
// (A_WeaponReady, A_FirePistol, ...).

import { P_RegisterAction, actionRegistry, states, S_NULL, S_PLAY, S_PLAY_ATK1, S_PLAY_ATK2, S_SAW, S_CHAIN1 } from './info.js';
import { P_Random } from './m_random.js';
import { FixedMul } from './m_fixed.js';
import { finecosine, finesine, FINEMASK } from './tables.js';
import { gamemode, leveltime } from './doomstat.js';
import { GameMode_t } from './doomdef.js';
import { R_PointToAngle2 } from './r_bsp.js';

// Safe wrapper for R_PointToAngle2 — guards against missing imports during init.
function R_PointToAngle2_safe(x1, y1, x2, y2) {
  if (typeof R_PointToAngle2 === 'function') return R_PointToAngle2(x1, y1, x2, y2);
  return 0;
}

// ---------- Frame flags ----------
export const FF_FULLBRIGHT = 0x8000;
export const FF_FRAMEMASK  = 0x7fff;

// ---------- pspdef_t ----------
export const ps_weapon = 0;
export const ps_flash  = 1;
export const NUMPSPRITES = 2;

export class pspdef_t {
  constructor() {
    this.state = null; // index into states[] or null/-1 for inactive
    this.tics  = 0;
    this.sx    = 0;
    this.sy    = 0;
  }
}

// ---------- P_SetPsprite ----------
// p_pspr.c:118 — walks state transitions for a player sprite. After running
// an action the loop must re-read `psp->state->nextstate`, because the
// action may have called P_SetPsprite recursively and replaced psp.state.
export function P_SetPsprite(player, position, stnum) {
  const psp = player.psprites[position];
  while (true) {
    if (stnum === S_NULL || stnum < 0) {
      psp.state = S_NULL;
      psp.tics  = -1;
      break;
    }
    psp.state = stnum;
    const state = states[stnum];
    psp.tics  = state.tics;
    if (state.misc1 !== 0) {
      psp.sx = state.misc1 << 16; // FRACBITS
      psp.sy = state.misc2 << 16;
    }
    // Run the action (per p_pspr.c — action gets `player` and `psp`).
    if (state.action !== null) {
      const fn = actionRegistry[state.action];
      if (fn !== undefined) fn(player, psp);
      if (psp.state === S_NULL) break;
    }
    if (psp.tics !== 0) break;
    // Vanilla: stnum = psp->state->nextstate. Re-read from psp.state so an
    // action that called P_SetPsprite to switch states is respected.
    stnum = states[psp.state].nextstate;
  }
}

// P_MovePsprites — advance both psprite state machines one tic.
// p_pspr.c:550 — C tests `psp->state` as a pointer (NULL means inactive).
// Our port stores state as an integer index; S_NULL (= 0) is the inactive
// sentinel, NOT -1. Using -1 lets a freshly-cleared psprite (state==0) keep
// ticking until tics underflows to -1.
export function P_MovePsprites(player) {
  for (let i = 0; i < 2; i++) {
    const psp = player.psprites[i];
    if (psp.state !== S_NULL && psp.tics !== -1) {
      psp.tics--;
      if (psp.tics === 0) {
        const st = states[psp.state];
        P_SetPsprite(player, i, st.nextstate);
      }
    }
  }
  player.psprites[1].sx = player.psprites[0].sx;
  player.psprites[1].sy = player.psprites[0].sy;
}

// p_pspr.c:265 P_DropWeapon — called when the player dies. Lowers whatever
// weapon they currently hold so the death animation looks right.
export function P_DropWeapon(player) {
  if (_di === null) return;
  P_SetPsprite(player, 0 /*ps_weapon*/, _di.weaponinfo[player.readyweapon].downstate);
}

// p_pspr.c:831 P_SetupPsprites — called at level start for each player.
// Clears both psprites and brings up the pending weapon.
export function P_SetupPsprites(player) {
  for (let i = 0; i < 2 /*NUMPSPRITES*/; i++) player.psprites[i].state = S_NULL;
  player.pendingweapon = player.readyweapon;
  P_BringUpWeapon(player);
}

// Bring the weapon back up after a shot or after switching weapons.
// Ported from p_pspr.c:138 P_BringUpWeapon.
function P_BringUpWeapon(player) {
  if (_di === null) return;
  if (player.pendingweapon === 10 /*wp_nochange*/) {
    player.pendingweapon = player.readyweapon;
  }
  if (player.pendingweapon === 7 /*wp_chainsaw*/ && _S !== null) {
    _S.S_StartSound(player.mo, 10 /*sfx_sawup*/);
  }
  const newstate = _di.weaponinfo[player.pendingweapon].upstate;
  player.pendingweapon = 10 /*wp_nochange*/;
  player.psprites[0 /*ps_weapon*/].sy = 128 << 16 /*WEAPONBOTTOM*/;
  P_SetPsprite(player, 0, newstate);
}

// p_pspr.c P_CheckAmmo. Returns true when the player has enough ammo to fire
// their current weapon; on false, vanilla also picks a fallback weapon and
// drops the weapon — we keep that lightweight (just disable firing).
function P_CheckAmmo(player) {
  const wi = _di.weaponinfo[player.readyweapon];
  const ammo = wi.ammo;
  let count = 1;
  if      (player.readyweapon === 6 /*wp_bfg*/) count = 40 /*BFGCELLS*/;
  else if (player.readyweapon === 8 /*wp_supershotgun*/) count = 2;
  if (ammo === 5 /*am_noammo*/ || player.ammo[ammo] >= count) return true;
  // p_pspr.c P_CheckAmmo: fixed-priority cascade. The C code is `do { ... }
  // while (pending == wp_nochange)`, but every branch except the fallback
  // assigns a non-wp_nochange weapon, so the loop runs once.
  const isShareware  = (gamemode === GameMode_t.shareware);
  const isCommercial = (gamemode === GameMode_t.commercial);
  if (player.weaponowned[5 /*wp_plasma*/] && player.ammo[2 /*am_cell*/] > 0 && !isShareware) {
    player.pendingweapon = 5;
  } else if (player.weaponowned[8 /*wp_supershotgun*/] && player.ammo[1 /*am_shell*/] > 2 && isCommercial) {
    player.pendingweapon = 8;
  } else if (player.weaponowned[3 /*wp_chaingun*/] && player.ammo[0 /*am_clip*/] > 0) {
    player.pendingweapon = 3;
  } else if (player.weaponowned[2 /*wp_shotgun*/] && player.ammo[1 /*am_shell*/] > 0) {
    player.pendingweapon = 2;
  } else if (player.ammo[0 /*am_clip*/] > 0) {
    player.pendingweapon = 1 /*wp_pistol*/;
  } else if (player.weaponowned[7 /*wp_chainsaw*/]) {
    player.pendingweapon = 7;
  } else if (player.weaponowned[4 /*wp_missile*/] && player.ammo[3 /*am_misl*/] > 0) {
    player.pendingweapon = 4;
  } else if (player.weaponowned[6 /*wp_bfg*/] && player.ammo[2 /*am_cell*/] > 40 && !isShareware) {
    player.pendingweapon = 6;
  } else {
    player.pendingweapon = 0 /*wp_fist*/;
  }
  P_SetPsprite(player, 0, _di.weaponinfo[player.readyweapon].downstate);
  return false;
}

// p_pspr.c P_FireWeapon — fail on insufficient ammo, alert AI, enter attack.
function P_FireWeapon(player) {
  if (!P_CheckAmmo(player)) return;
  if (_PMobj !== null && typeof _PMobj.P_SetMobjState === 'function' && player.mo !== null) {
    _PMobj.P_SetMobjState(player.mo, 154 /*S_PLAY_ATK1*/);
  }
  const wi = _di.weaponinfo[player.readyweapon];
  P_SetPsprite(player, 0, wi.atkstate);
  if (_PEnemy !== null) _PEnemy.P_NoiseAlert(player.mo, player.mo);
}

// Per-weapon action functions ported from p_pspr.c.
let _S = null, _di = null, _PMap = null, _PEnemy = null;
export function P_PsprSetExternals(refs) {
  if (refs.S)      _S      = refs.S;
  if (refs.di)     _di     = refs.di;
  if (refs.PMap)   _PMap   = refs.PMap;
  if (refs.PEnemy) _PEnemy = refs.PEnemy;
}

P_RegisterAction('A_Light0',   (player) => {
  if (player.player !== undefined) player = player.player;
  if (player !== null && player !== undefined) player.extralight = 0;
});
P_RegisterAction('A_Light1',   (player) => {
  if (player.player !== undefined) player = player.player;
  if (player !== null && player !== undefined) player.extralight = 1;
});
P_RegisterAction('A_Light2',   (player) => {
  if (player.player !== undefined) player = player.player;
  if (player !== null && player !== undefined) player.extralight = 2;
});

// A_Lower — pull weapon down. When at the bottom, switch to pendingweapon
// and bring the new one up.
const WEAPONBOTTOM = 128 << 16;
const WEAPONTOP    =  32 << 16;
const LOWERSPEED   =   6 << 16;
const RAISESPEED   =   6 << 16;
P_RegisterAction('A_Lower', (player) => {
  if (player.player !== undefined) player = player.player;
  if (player === null || player === undefined) return;
  const psp = player.psprites[0];
  psp.sy += LOWERSPEED;
  if (psp.sy < WEAPONBOTTOM) return;
  // Fully lowered.
  if (player.playerstate === 1 /*PST_DEAD*/) {
    psp.sy = WEAPONBOTTOM;
    return;
  }
  if (player.health <= 0) {
    P_SetPsprite(player, 0, 0 /*S_NULL*/);
    return;
  }
  // Switch to pending weapon.
  player.readyweapon = player.pendingweapon;
  player.pendingweapon = 10 /*wp_nochange*/;
  P_BringUpWeapon(player);
});

// A_Raise — bring weapon up.
P_RegisterAction('A_Raise', (player) => {
  if (player.player !== undefined) player = player.player;
  if (player === null || player === undefined) return;
  const psp = player.psprites[0];
  psp.sy -= RAISESPEED;
  if (psp.sy > WEAPONTOP) return;
  psp.sy = WEAPONTOP;
  // Done raising — transition to the ready state for this weapon.
  if (_di === null) return;
  const wi = _di.weaponinfo[player.readyweapon];
  P_SetPsprite(player, 0, wi.readystate);
});

P_RegisterAction('A_WeaponReady', (player, psp) => {
  // The state machine passes (mobj, psp) for mobj actions and (player, psp)
  // for psprite actions. If we got an mobj-like object with .player, unwrap.
  if (player.player !== undefined && player.player !== null) player = player.player;
  if (player === null || player.cmd === undefined) return;
  // p_pspr.c — get out of player attack state.
  if (player.mo !== null && _PMobj !== null &&
      (player.mo.state === S_PLAY_ATK1 || player.mo.state === S_PLAY_ATK2)) {
    _PMobj.P_SetMobjState(player.mo, S_PLAY);
  }
  // p_pspr.c — chainsaw idle hum.
  if (player.readyweapon === 7 /*wp_chainsaw*/ && psp !== undefined && psp.state === S_SAW) {
    if (_S !== null) _S.S_StartSound(player.mo, 11 /*sfx_sawidl*/);
  }
  // Weapon switch pending? Lower the current one. (`health === 0` rather than
  // `<= 0` would miss the death case where health goes negative.)
  if (player.pendingweapon !== 10 /*wp_nochange*/ || player.health <= 0) {
    if (_di !== null) {
      const wi = _di.weaponinfo[player.readyweapon];
      P_SetPsprite(player, 0, wi.downstate);
    }
    return;
  }
  // p_pspr.c — missile launcher and BFG do NOT auto-fire while held.
  if ((player.cmd.buttons & 1 /*BT_ATTACK*/) !== 0) {
    if (player.attackdown === 0 ||
        (player.readyweapon !== 4 /*wp_missile*/ && player.readyweapon !== 6 /*wp_bfg*/)) {
      player.attackdown = 1;
      P_FireWeapon(player);
      return;
    }
  } else {
    player.attackdown = 0;
  }
  // p_pspr.c — bob the weapon based on player.bob and leveltime.
  if (psp !== undefined && psp !== null) {
    let angle = (128 * (leveltime | 0)) & FINEMASK;
    psp.sx = 65536 /*FRACUNIT*/ + FixedMul(player.bob, finecosine[angle]);
    angle &= (FINEMASK >> 1);
    psp.sy = (32 << 16) /*WEAPONTOP*/ + FixedMul(player.bob, finesine[angle]);
  }
});
P_RegisterAction('A_ReFire', (player) => {
  if (player.player !== undefined) player = player.player;
  if ((player.cmd.buttons & 1 /*BT_ATTACK*/) !== 0 &&
      player.pendingweapon === 10 /*wp_nochange*/ &&
      player.health > 0) {
    player.refire++;
    P_FireWeapon(player);
  } else {
    player.refire = 0;
    // p_pspr.c — verify we still have ammo; if not, transition to down-state.
    P_CheckAmmo(player);
  }
});
// p_pspr.c A_FirePistol.
P_RegisterAction('A_FirePistol', (player) => {
  if (player.player !== undefined) player = player.player;
  if (_S !== null) _S.S_StartSound(player.mo, 1 /*sfx_pistol*/);
  if (_PMobj !== null && typeof _PMobj.P_SetMobjState === 'function' && player.mo !== null) {
    _PMobj.P_SetMobjState(player.mo, 155 /*S_PLAY_ATK2*/);
  }
  const ammoIdx = (_di !== null) ? _di.weaponinfo[player.readyweapon].ammo : 0;
  if (ammoIdx !== 5 /*am_noammo*/ && player.ammo[ammoIdx] > 0) player.ammo[ammoIdx]--;
  if (_di !== null) {
    const wi = _di.weaponinfo[player.readyweapon];
    P_SetPsprite(player, ps_flash, wi.flashstate);
  }
  P_BulletSlope(player.mo);
  P_GunShot(player.mo, player.refire === 0);
});

// p_pspr.c P_GunShot.
function P_GunShot(mo, accurate) {
  if (_PMap === null) return;
  const damage = 5 * (P_Random() % 3 + 1);
  let angle = mo.angle;
  if (!accurate) angle = (angle + ((P_Random() - P_Random()) << 18)) >>> 0;
  _PMap.P_LineAttack(mo, angle, _PMap.ATTACKRANGE, bulletslope, damage);
}

// Module-scope so the per-shot spread can use the same slope.
let bulletslope = 0;

// Other weapon actions — minimum ports.
let _PMobj = null;
let _PInter = null;
export function P_PsprSetMobj(refs) {
  if (refs.PMobj)  _PMobj  = refs.PMobj;
  if (refs.PInter) _PInter = refs.PInter;
}

function hitscanPlayer(player, numShots, dmgFn, sound, ammoIdx, accurate) {
  if (_S !== null && sound !== 0) _S.S_StartSound(player.mo, sound);
  // C: P_SetMobjState player.mo S_PLAY_ATK2 — visual: attack pose.
  if (_PMobj !== null && player.mo !== null && typeof _PMobj.P_SetMobjState === 'function') {
    _PMobj.P_SetMobjState(player.mo, 155 /*S_PLAY_ATK2*/);
  }
  if (ammoIdx >= 0 && player.ammo[ammoIdx] > 0) player.ammo[ammoIdx]--;
  // Muzzle flash.
  if (_di !== null) {
    const wi = _di.weaponinfo[player.readyweapon];
    P_SetPsprite(player, ps_flash, wi.flashstate);
  }
  if (_PMap === null) return;
  P_BulletSlope(player.mo);
  for (let i = 0; i < numShots; i++) {
    const spread = accurate ? 0 : ((P_Random() - P_Random()) << 18);
    _PMap.P_LineAttack(player.mo, (player.mo.angle + spread) >>> 0, _PMap.ATTACKRANGE, bulletslope, dmgFn());
  }
}

// MT_* indices needed for projectile spawning (matches info.h order).
const MT_ROCKET = 33, MT_PLASMA = 34, MT_BFG = 35;

P_RegisterAction('A_Punch', (player) => {
  if (player.player !== undefined) player = player.player;
  // p_pspr.c A_Punch: damage = (P_Random()%10+1)<<1, doubled if berserk.
  let damage = (P_Random() % 10 + 1) << 1;
  if (player.powers !== undefined && player.powers[1 /*pw_strength*/] !== 0) damage *= 10;
  // RNG ordering matches C: damage first, then angle jitter.
  let angle = player.mo.angle;
  angle = (angle + ((P_Random() - P_Random()) << 18)) >>> 0;
  let slope = 0;
  if (_PMap !== null) slope = _PMap.P_AimLineAttack(player.mo, angle, 64 << 16 /*MELEERANGE*/);
  if (_PMap !== null) _PMap.P_LineAttack(player.mo, angle, 64 << 16, slope, damage);
  // p_pspr.c: sound and face-target only on hit.
  if (_PMap !== null && _PMap.getLinetarget() !== null) {
    if (_S !== null) _S.S_StartSound(player.mo, 83 /*sfx_punch*/);
    const lt = _PMap.getLinetarget();
    player.mo.angle = R_PointToAngle2_safe(player.mo.x, player.mo.y, lt.x, lt.y);
  }
});
P_RegisterAction('A_Saw', (player) => {
  if (player.player !== undefined) player = player.player;
  // p_pspr.c A_Saw: damage = 2*(P_Random()%10+1)
  const damage = 2 * (P_Random() % 10 + 1);
  let angle = player.mo.angle;
  angle = (angle + ((P_Random() - P_Random()) << 18)) >>> 0;
  // MELEERANGE+1 quirk so the puff doesn't skip the flash.
  const range = (64 << 16) + 1;
  let slope = 0;
  if (_PMap !== null) slope = _PMap.P_AimLineAttack(player.mo, angle, range);
  if (_PMap !== null) _PMap.P_LineAttack(player.mo, angle, range, slope, damage);
  if (_PMap === null || _PMap.getLinetarget() === null) {
    if (_S !== null) _S.S_StartSound(player.mo, 14 /*sfx_sawful*/);
    return;
  }
  if (_S !== null) _S.S_StartSound(player.mo, 13 /*sfx_sawhit*/);
  // turn to face target (the C code has a complex angle-clamp; for player-only
  // chainsaw use, the simple R_PointToAngle2 set is the well-tested fallback).
  const lt = _PMap.getLinetarget();
  const targAngle = R_PointToAngle2_safe(player.mo.x, player.mo.y, lt.x, lt.y);
  // Vanilla chainsaw: clamp turn to ANG90/20 step toward target.
  const ANG90c = 0x40000000;
  const ANG180c = 0x80000000;
  const step  = (ANG90c / 20) | 0;
  const step2 = (ANG90c / 21) | 0;
  const da = (targAngle - player.mo.angle) >>> 0;
  if (da > ANG180c) {
    // target is to the left
    const back = (0x100000000 - da) >>> 0;
    if (back > step) player.mo.angle = (targAngle + step2) >>> 0;
    else             player.mo.angle = (player.mo.angle - step) >>> 0;
  } else {
    if (da > step) player.mo.angle = (targAngle - step2) >>> 0;
    else           player.mo.angle = (player.mo.angle + step) >>> 0;
  }
  // MF_JUSTATTACKED — kept here for parity with vanilla.
  player.mo.flags |= 0x10000 /*MF_JUSTATTACKED*/;
});
// p_pspr.c shotgun/super/chaingun all damage 5*(P_Random()%3+1) per pellet.
function shotgunDamage() { return 5 * (P_Random() % 3 + 1); }
P_RegisterAction('A_FireShotgun', (player) => {
  if (player.player !== undefined) player = player.player;
  // p_pspr.c A_FireShotgun — order must match vanilla exactly: sound,
  // SetMobjState, ammo--, SetPsprite flash, P_BulletSlope, then 7×P_GunShot.
  // P_GunShot internally rolls damage FIRST, then spread (1 + 2 P_Random),
  // so we MUST NOT use the hitscanPlayer helper (which inverts that order).
  if (_S !== null) _S.S_StartSound(player.mo, 2 /*sfx_shotgn*/);
  if (_PMobj !== null && player.mo !== null && typeof _PMobj.P_SetMobjState === 'function') {
    _PMobj.P_SetMobjState(player.mo, 155 /*S_PLAY_ATK2*/);
  }
  if (_di !== null) {
    const ammoIdx = _di.weaponinfo[player.readyweapon].ammo;
    if (ammoIdx !== 5 /*am_noammo*/) player.ammo[ammoIdx]--;
    P_SetPsprite(player, ps_flash, _di.weaponinfo[player.readyweapon].flashstate);
  }
  P_BulletSlope(player.mo);
  for (let i = 0; i < 7; i++) P_GunShot(player.mo, false);
});
P_RegisterAction('A_FireShotgun2', (player) => {
  if (player.player !== undefined) player = player.player;
  // C A_FireShotgun2: 20 pellets, 2 shells consumed (via weaponinfo.ammo),
  // (<<19) horizontal spread and slope jitter (P_Random-P_Random)<<5.
  if (_S !== null) _S.S_StartSound(player.mo, 4 /*sfx_dshtgn*/);
  if (_PMobj !== null && player.mo !== null && typeof _PMobj.P_SetMobjState === 'function') {
    _PMobj.P_SetMobjState(player.mo, 155 /*S_PLAY_ATK2*/);
  }
  if (_di !== null) {
    const ammoIdx = _di.weaponinfo[player.readyweapon].ammo;
    if (ammoIdx !== 5 /*am_noammo*/) player.ammo[ammoIdx] -= 2;
    P_SetPsprite(player, ps_flash, _di.weaponinfo[player.readyweapon].flashstate);
  }
  if (_PMap === null) return;
  P_BulletSlope(player.mo);
  for (let i = 0; i < 20; i++) {
    const damage = shotgunDamage();
    const angle = (player.mo.angle + ((P_Random() - P_Random()) << 19)) >>> 0;
    const slope = (bulletslope + ((P_Random() - P_Random()) << 5)) | 0;
    _PMap.P_LineAttack(player.mo, angle, _PMap.ATTACKRANGE, slope, damage);
  }
});
P_RegisterAction('A_FireCGun', (player, psp) => {
  if (player.player !== undefined) player = player.player;
  // C A_FireCGun: S_StartSound, then bail if out of ammo, then P_SetMobjState,
  // ammo--, flash psprite at flashstate + (psp.state - &states[S_CHAIN1]),
  // then P_BulletSlope + P_GunShot(!refire).
  if (_S !== null) _S.S_StartSound(player.mo, 1 /*sfx_pistol*/);
  if (_di === null) return;
  const wi = _di.weaponinfo[player.readyweapon];
  const ammoIdx = wi.ammo;
  if (ammoIdx !== 5 /*am_noammo*/ && player.ammo[ammoIdx] === 0) return;
  if (_PMobj !== null && player.mo !== null && typeof _PMobj.P_SetMobjState === 'function') {
    _PMobj.P_SetMobjState(player.mo, 155 /*S_PLAY_ATK2*/);
  }
  if (ammoIdx !== 5) player.ammo[ammoIdx]--;
  if (psp !== undefined && psp !== null) {
    // p_pspr.c: flashstate + psp->state - &states[S_CHAIN1] — gives the matching
    // CHAINFLASH frame for the current chaingun fire frame.
    const offset = (psp.state - S_CHAIN1) | 0;
    P_SetPsprite(player, ps_flash, wi.flashstate + offset);
  }
  P_BulletSlope(player.mo);
  P_GunShot(player.mo, player.refire === 0);
});
P_RegisterAction('A_FireMissile', (player) => {
  if (player.player !== undefined) player = player.player;
  // p_pspr.c A_FireMissile: player->ammo[weaponinfo[readyweapon].ammo]--
  if (_di !== null) {
    const ammoIdx = _di.weaponinfo[player.readyweapon].ammo;
    if (ammoIdx !== 5 /*am_noammo*/) player.ammo[ammoIdx]--;
  }
  if (_PMobj !== null) _PMobj.P_SpawnPlayerMissile(player.mo, MT_ROCKET);
});
P_RegisterAction('A_FirePlasma', (player) => {
  if (player.player !== undefined) player = player.player;
  // p_pspr.c A_FirePlasma: ammo--; set ps_flash with flashstate + (P_Random()&1).
  if (_di !== null) {
    const ammoIdx = _di.weaponinfo[player.readyweapon].ammo;
    if (ammoIdx !== 5 /*am_noammo*/) player.ammo[ammoIdx]--;
    P_SetPsprite(player, ps_flash,
      _di.weaponinfo[player.readyweapon].flashstate + (P_Random() & 1));
  }
  if (_PMobj !== null) _PMobj.P_SpawnPlayerMissile(player.mo, MT_PLASMA);
});
P_RegisterAction('A_BFGsound', (player) => {
  if (player.player !== undefined) player = player.player;
  if (_S !== null) _S.S_StartSound(player.mo, 9 /*sfx_bfg*/);
});
P_RegisterAction('A_FireBFG', (player) => {
  if (player.player !== undefined) player = player.player;
  // p_pspr.c A_FireBFG: ammo -= BFGCELLS (40).
  if (_di !== null) {
    const ammoIdx = _di.weaponinfo[player.readyweapon].ammo;
    if (ammoIdx !== 5 /*am_noammo*/) player.ammo[ammoIdx] -= 40;
  }
  if (_PMobj !== null) _PMobj.P_SpawnPlayerMissile(player.mo, MT_BFG);
});

// A_GunFlash — transition player to attack-2 frame and set the weapon flash psprite.
P_RegisterAction('A_GunFlash', (player) => {
  if (player.player !== undefined) player = player.player;
  if (player.mo === null || _di === null) return;
  const { P_SetMobjState } = _PMobj || {};
  if (typeof P_SetMobjState === 'function') P_SetMobjState(player.mo, 155 /*S_PLAY_ATK2*/);
  const wi = _di.weaponinfo[player.readyweapon];
  P_SetPsprite(player, ps_flash, wi.flashstate);
});

// A_BFGSpray — spawn 40 tracer attacks in a 90° fan, dealing 15d8 damage per hit
// and a green explosion (MT_EXTRABFG) on every target.
P_RegisterAction('A_BFGSpray', (mo) => {
  if (_PMap === null || mo.target === null) return;
  const ANG90 = 0x40000000;
  for (let i = 0; i < 40; i++) {
    const an = ((mo.angle - (ANG90 >>> 1) + ((ANG90 / 40) | 0) * i) >>> 0);
    const linetarget = _PMap.P_AimLineAttack(mo.target, an, 16 * 64 * 65536);
    if (linetarget === null || linetarget === undefined) continue;
    if (_PMobj !== null && typeof _PMobj.P_SpawnMobj === 'function') {
      _PMobj.P_SpawnMobj(linetarget.x, linetarget.y, linetarget.z + (linetarget.height >> 2), 42 /*MT_EXTRABFG*/);
    }
    let damage = 0;
    for (let j = 0; j < 15; j++) damage += (P_Random() & 7) + 1;
    if (_PInter !== null && typeof _PInter.P_DamageMobj === 'function') {
      _PInter.P_DamageMobj(linetarget, mo.target, mo.target, damage);
    }
  }
});

// A_CheckReload — chaingun & super-shotgun re-fire check. p_pspr.c A_CheckReload
// is just a thin wrapper around P_CheckAmmo.
P_RegisterAction('A_CheckReload', (player) => {
  if (player.player !== undefined) player = player.player;
  P_CheckAmmo(player);
});

// Super-shotgun (Doom 2) reload animation hooks — sound effects only here.
P_RegisterAction('A_OpenShotgun2',  (p) => { p = p.player ?? p; if (_S !== null) _S.S_StartSound(p.mo, 5 /*sfx_dbopn*/); });
P_RegisterAction('A_LoadShotgun2',  (p) => { p = p.player ?? p; if (_S !== null) _S.S_StartSound(p.mo, 7 /*sfx_dbload*/); });
P_RegisterAction('A_CloseShotgun2', (p) => { p = p.player ?? p; if (_S !== null) _S.S_StartSound(p.mo, 6 /*sfx_dbcls*/); });

// ---------- P_BulletSlope / P_CalcSwing (ported from p_pspr.c) ----------
// p_pspr.c P_BulletSlope. Autoaim sweep: straight, +5.6°, -5.6°.
export function P_BulletSlope(mo) {
  if (_PMap === null) return;
  let an = mo.angle;
  bulletslope = _PMap.P_AimLineAttack(mo, an, 16 * 64 * 65536);
  if (_PMap.getLinetarget() === null) {
    an = (an + (1 << 26)) >>> 0;
    bulletslope = _PMap.P_AimLineAttack(mo, an, 16 * 64 * 65536);
    if (_PMap.getLinetarget() === null) {
      an = (an - (2 << 26)) >>> 0;
      bulletslope = _PMap.P_AimLineAttack(mo, an, 16 * 64 * 65536);
    }
  }
}

// P_CalcSwing — weapon-bob magnitude from player momentum. Output is in
// fixed-point and is consumed by A_WeaponReady to write player.psprites[0].sx.
export function P_CalcSwing(player) {
  const m = player.mo;
  if (m === null) return 0;
  const mx = m.momx, my = m.momy;
  const swing = ((mx >> 8) * (mx >> 8) + (my >> 8) * (my >> 8)) >> 14;
  const MAXBOB = 16 * 65536;
  return swing > MAXBOB ? MAXBOB : swing;
}
