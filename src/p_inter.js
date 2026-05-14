// Ported from: linuxdoom-1.10/p_inter.c
// Pickups, damage, kill mechanics. Minimum: P_TouchSpecialThing for health
// bonus / stimpack / medikit / clip / shells / cells / rockets / armors,
// triggered when the player overlaps a MF_SPECIAL mobj.

import { mobj_t, MF_SPECIAL, MF_DROPPED, MF_NOTDMATCH } from './p_mobj.js';
import { MT_MISC0, MT_MISC1, MT_MISC2, MT_MISC3, MT_MISC4, MT_MISC5, MT_MISC6,
         MT_MISC7, MT_MISC8, MT_MISC9, MT_MISC10, MT_MISC11, MT_MISC12,
         MT_INV, MT_MISC13, MT_MISC14, MT_MISC15, MT_MISC16, MT_MEGA,
         MT_CLIP, MT_MISC17, MT_MISC18, MT_MISC19, MT_MISC20, MT_MISC21,
         MT_MISC22, MT_MISC23, MT_MISC24, MT_MISC25, MT_CHAINGUN, MT_MISC26,
         MT_MISC27, MT_MISC28, MT_SHOTGUN,
         MT_POSSESSED, MT_SHOTGUY, MT_CHAINGUY, MT_SKULL, MT_VILE } from './info.js';
// Re-export so p_inter.js owns the MT_* constants needed by P_KillMobj's drop logic.
import { ammotype_t, weapontype_t } from './doomdef.js';
import { P_Random } from './m_random.js';

// Externals (wired at init).
let _S = null;
let _PM = null;
export function P_InterSetExternals(refs) { if (refs.S) _S = refs.S; if (refs.PM) _PM = refs.PM; }

export function P_GiveBody(player, num) {
  if (player.health >= 100) return false;
  player.health = Math.min(100, player.health + num);
  if (player.mo) player.mo.health = player.health;
  return true;
}
export function P_GiveArmor(player, armortype) {
  const hits = armortype * 100;
  if (player.armorpoints >= hits) return false;
  player.armortype = armortype;
  player.armorpoints = hits;
  return true;
}
// Per-ammo-type clip size — vanilla p_inter.c's `clipammo[]`. P_GiveAmmo's
// `num` argument is a clip COUNT (1 = full clip, 5 = box of 5 clips); we
// multiply by clipammo[ammo] to get the actual round count. `num === 0` means
// "dropped item / small pickup" → half a clip.
const clipammo = [10, 4, 20, 1]; // am_clip, am_shell, am_cell, am_misl (matches C ammotype enum order)

export function P_GiveAmmo(player, ammo, num) {
  if (ammo === ammotype_t.am_noammo || ammo < 0 || ammo >= 4) return false;
  if (player.ammo[ammo] >= player.maxammo[ammo]) return false;
  num = (num !== 0) ? num * clipammo[ammo] : (clipammo[ammo] >> 1);
  // p_inter.c:95-101 — baby/nightmare get double ammo pickups.
  if (gameskill === 0 /*sk_baby*/ || gameskill === 4 /*sk_nightmare*/) num <<= 1;
  const oldammo = player.ammo[ammo];
  player.ammo[ammo] = Math.min(player.maxammo[ammo], player.ammo[ammo] + num);
  // p_inter.c:113-157 — auto-switch up when we were dry.
  if (oldammo !== 0) return true;
  const RW = player.readyweapon;
  if (ammo === ammotype_t.am_clip) {
    if (RW === weapontype_t.wp_fist) {
      player.pendingweapon = player.weaponowned[weapontype_t.wp_chaingun]
        ? weapontype_t.wp_chaingun : weapontype_t.wp_pistol;
    }
  } else if (ammo === ammotype_t.am_shell) {
    if ((RW === weapontype_t.wp_fist || RW === weapontype_t.wp_pistol) &&
        player.weaponowned[weapontype_t.wp_shotgun]) {
      player.pendingweapon = weapontype_t.wp_shotgun;
    }
  } else if (ammo === ammotype_t.am_cell) {
    if ((RW === weapontype_t.wp_fist || RW === weapontype_t.wp_pistol) &&
        player.weaponowned[weapontype_t.wp_plasma]) {
      player.pendingweapon = weapontype_t.wp_plasma;
    }
  } else if (ammo === ammotype_t.am_misl) {
    if (RW === weapontype_t.wp_fist && player.weaponowned[weapontype_t.wp_missile]) {
      player.pendingweapon = weapontype_t.wp_missile;
    }
  }
  return true;
}
export function P_GiveWeapon(player, weapon, dropped) {
  const wasOwned = player.weaponowned[weapon];
  const clips = (dropped !== 0 && dropped !== false) ? 1 : 2;
  const gaveAmmo = P_GiveAmmo(player, ammoForWeapon(weapon), clips);
  if (wasOwned) return gaveAmmo;
  player.weaponowned[weapon] = true;
  player.pendingweapon = weapon;
  return true;
}
function ammoForWeapon(w) {
  switch (w) {
    case weapontype_t.wp_pistol: case weapontype_t.wp_chaingun: return ammotype_t.am_clip;
    case weapontype_t.wp_shotgun: case weapontype_t.wp_supershotgun: return ammotype_t.am_shell;
    case weapontype_t.wp_plasma: case weapontype_t.wp_bfg: return ammotype_t.am_cell;
    case weapontype_t.wp_missile: return ammotype_t.am_misl;
    default: return ammotype_t.am_noammo;
  }
}

// P_TouchSpecialThing — player touched a pickup. `special` is the mobj.
export function P_TouchSpecialThing(special, toucher) {
  // p_inter.c:348-355 — out-of-reach check (tall pickups stacked vertically).
  const delta = special.z - toucher.z;
  if (delta > toucher.height || delta < -8 * 65536) return;
  if (toucher.health <= 0) return;
  const player = toucher.player;
  if (player === null) return;
  let pickedUp = true;
  let sound = 32; // sfx_itemup
  let message = '';
  switch (special.type) {
    case MT_MISC2:    if (player.health < 200) { player.health++; toucher.health = player.health; } message = 'Picked up a health bonus.'; break;
    case MT_MISC10:   P_GiveBody(player, 10); message = 'Picked up a stimpack.'; break;
    case MT_MISC11:   P_GiveBody(player, 25); message = 'Picked up a medikit.'; break;
    case MT_MISC3:
      // p_inter.c:431 — armor bonus also forces armortype=1 if it was 0,
      // otherwise the new armorpoints sit unused (P_DamageMobj only consults
      // armor when armortype > 0). Bug appeared as a 1-armor drift in DEMO2.
      if (player.armorpoints < 200) {
        player.armorpoints++;
        if (player.armortype === 0) player.armortype = 1;
      }
      message = 'Picked up an armor bonus.'; break;
    case MT_MISC0:    P_GiveArmor(player, 1); message = 'Picked up the armor.'; break;
    case MT_MISC1:    P_GiveArmor(player, 2); message = 'Picked up the MegaArmor!'; break;
    case MT_CLIP:     P_GiveAmmo(player, ammotype_t.am_clip,  (special.flags & MF_DROPPED) !== 0 ? 0 : 1); message = 'Picked up a clip.'; break;
    case MT_MISC17:   P_GiveAmmo(player, ammotype_t.am_clip,  5); message = 'Picked up a box of bullets.'; break;
    case MT_MISC22:   P_GiveAmmo(player, ammotype_t.am_shell, 1); message = 'Picked up 4 shotgun shells.'; break;
    case MT_MISC23:   P_GiveAmmo(player, ammotype_t.am_shell, 5); message = 'Picked up a box of shotgun shells.'; break;
    case MT_MISC18:   P_GiveAmmo(player, ammotype_t.am_misl,  1); message = 'Picked up a rocket.'; break;
    case MT_MISC19:   P_GiveAmmo(player, ammotype_t.am_misl,  5); message = 'Picked up a box of rockets.'; break;
    case MT_MISC20:   P_GiveAmmo(player, ammotype_t.am_cell,  1); message = 'Picked up an energy cell.'; break;
    case MT_MISC21:   P_GiveAmmo(player, ammotype_t.am_cell,  5); message = 'Picked up an energy cell pack.'; break;
    case MT_SHOTGUN:  P_GiveWeapon(player, weapontype_t.wp_shotgun,  (special.flags & MF_DROPPED) !== 0); sound = 33; message = 'You got the shotgun!'; break;
    case MT_CHAINGUN: P_GiveWeapon(player, weapontype_t.wp_chaingun, (special.flags & MF_DROPPED) !== 0); sound = 33; message = 'You got the chaingun!'; break;
    case MT_MISC25:   P_GiveWeapon(player, weapontype_t.wp_bfg,      false); sound = 33; message = 'You got the BFG9000!  Oh, yes.'; break;
    case MT_MISC26:   P_GiveWeapon(player, weapontype_t.wp_chainsaw, false); sound = 33; message = 'A chainsaw!  Find some meat!'; break;
    case MT_MISC27:   P_GiveWeapon(player, weapontype_t.wp_missile,  false); sound = 33; message = 'You got the rocket launcher!'; break;
    case MT_MISC28:   P_GiveWeapon(player, weapontype_t.wp_plasma,   false); sound = 33; message = 'You got the plasma gun!'; break;
    // Power-ups (vanilla MT_INV/MEGA etc.).
    case MT_INV:      P_GivePower(player, pw_invulnerability); sound = 93 /*sfx_getpow*/; message = 'Invulnerability!'; break;
    case MT_MISC12:   if (player.health < 200) { player.health = Math.min(200, player.health + 100); if (player.mo) player.mo.health = player.health; } message = 'Supercharge!'; sound = 93 /*sfx_getpow*/; break;
    case MT_MEGA:     P_GiveArmor(player, 2); if (player.health < 200) { player.health = 200; if (player.mo) player.mo.health = 200; } sound = 93 /*sfx_getpow*/; message = 'MegaSphere!'; break;
    case MT_MISC13:   P_GivePower(player, pw_strength); message = 'Berserk!'; if (player.readyweapon !== weapontype_t.wp_fist) player.pendingweapon = weapontype_t.wp_fist; sound = 93 /*sfx_getpow*/; break;
    case MT_MISC14:   P_GivePower(player, pw_ironfeet); message = 'Radiation Shielding Suit'; sound = 93 /*sfx_getpow*/; break;
    case MT_MISC15:   P_GivePower(player, pw_allmap);   message = 'Computer Area Map';      sound = 93 /*sfx_getpow*/; break;
    case MT_MISC16:   P_GivePower(player, pw_infrared); message = 'Light Amplification Visor'; sound = 93 /*sfx_getpow*/; break;
    // Keys.
    case MT_MISC4:    P_GiveCard(player, 0); message = 'Picked up a blue keycard.'; break;
    case MT_MISC5:    P_GiveCard(player, 2); message = 'Picked up a red keycard.'; break;
    case MT_MISC6:    P_GiveCard(player, 1); message = 'Picked up a yellow keycard.'; break;
    case MT_MISC7:    P_GiveCard(player, 4); message = 'Picked up a yellow skull key.'; break;
    case MT_MISC8:    P_GiveCard(player, 5); message = 'Picked up a red skull key.'; break;
    case MT_MISC9:    P_GiveCard(player, 3); message = 'Picked up a blue skull key.'; break;
    case MT_MISC24:   P_GiveBackpack(player); message = 'Picked up a backpack full of ammo!'; break;
    default: pickedUp = false; break;
  }
  if (!pickedUp) return;
  if ((special.flags & 0x800000 /*MF_COUNTITEM*/) !== 0) player.itemcount++;
  if (message !== '') player.message = message;
  if (_S !== null) _S.S_StartSound(null /*player.mo would 3D-pan*/, sound);
  player.bonuscount += 6;
  if (_PM !== null) _PM.P_RemoveMobj(special);
}

// P_KillMobj — transition target to its death state. p_inter.c:667
import { mobjinfo, states } from './info.js';
import { P_SetMobjState, MF_SHOOTABLE, MF_FLOAT, MF_SKULLFLY,
         MF_NOGRAVITY, MF_CORPSE, MF_DROPOFF, MF_SOLID, MF_NOCLIP,
         MF_COUNTKILL, MF_JUSTHIT, ONFLOORZ } from './p_mobj.js';
import { ANGLETOFINESHIFT, FINEMASK, finecosine, finesine, ANG180 } from './tables.js';
import { R_PointToAngle2 } from './r_bsp.js';
import { FixedMul } from './m_fixed.js';
import { gameskill, players as _players, consoleplayer, netgame } from './doomstat.js';

const sk_baby = 0;

export function P_KillMobj(source, target) {
  if (target.info === null) return;
  target.flags &= ~(MF_SHOOTABLE | MF_FLOAT | MF_SKULLFLY);
  if (target.type !== MT_SKULL) target.flags &= ~MF_NOGRAVITY;
  target.flags |= MF_CORPSE | MF_DROPOFF;
  target.height >>= 2;
  // Counters / frags
  if (source !== null && source.player !== null) {
    if ((target.flags & MF_COUNTKILL) !== 0) source.player.killcount++;
    if (target.player !== null) {
      const idx = _players.indexOf(target.player);
      if (idx >= 0) source.player.frags[idx]++;
    }
  } else if (netgame === false && (target.flags & MF_COUNTKILL) !== 0) {
    _players[0].killcount++;
  }
  if (target.player !== null) {
    if (source === null) {
      const idx = _players.indexOf(target.player);
      if (idx >= 0) target.player.frags[idx]++;
    }
    target.flags &= ~MF_SOLID;
    target.player.playerstate = 1 /*PST_DEAD*/;
    // P_DropWeapon — simplified: drop pending+ready to a "lower" state.
    if (typeof globalThis.__P_DropWeapon === 'function') globalThis.__P_DropWeapon(target.player);
  }
  if (target.info.xdeathstate !== 0 && target.health < -target.info.spawnhealth) {
    P_SetMobjState(target, target.info.xdeathstate);
  } else {
    P_SetMobjState(target, target.info.deathstate);
  }
  target.tics -= P_Random() & 3;
  if (target.tics < 1) target.tics = 1;
  // Drop stuff for the human enemies that carry pickups.
  let item = -1;
  if (target.type === MT_POSSESSED) item = MT_CLIP;
  else if (target.type === MT_SHOTGUY)  item = MT_SHOTGUN;
  else if (target.type === MT_CHAINGUY) item = MT_CHAINGUN;
  if (item >= 0 && typeof globalThis.__P_SpawnMobj === 'function') {
    const mo = globalThis.__P_SpawnMobj(target.x, target.y, ONFLOORZ, item);
    if (mo !== null) mo.flags |= 0x20000 /*MF_DROPPED*/;
  }
}

// p_inter.c:775 — P_DamageMobj.
export function P_DamageMobj(target, inflictor, source, damage) {
  if ((target.flags & MF_SHOOTABLE) === 0) return;
  if (target.health <= 0) return;
  if ((target.flags & MF_SKULLFLY) !== 0) {
    target.momx = 0; target.momy = 0; target.momz = 0;
  }
  const player = target.player;
  if (player !== null && gameskill === sk_baby) damage >>= 1;
  // Damage thrust (knock-back). Skipped for chainsaw to keep target in reach.
  if (inflictor !== null && (target.flags & MF_NOCLIP) === 0 &&
      (source === null || source.player === null ||
       (source.player.readyweapon !== 7 /*wp_chainsaw*/))) {
    let ang = R_PointToAngle2(inflictor.x, inflictor.y, target.x, target.y);
    const mass = (target.info !== null && target.info.mass > 0) ? target.info.mass : 100;
    let thrust = ((damage * (65536 >> 3) * 100) / mass) | 0;
    // Falls forward sometimes (vanilla quirk).
    if (damage < 40 && damage > target.health &&
        (target.z - inflictor.z) > 64 * 65536 && (P_Random() & 1) !== 0) {
      ang = (ang + ANG180) >>> 0;
      thrust *= 4;
    }
    const fa = (ang >>> ANGLETOFINESHIFT) & FINEMASK;
    target.momx = (target.momx + FixedMul(thrust, finecosine[fa])) | 0;
    target.momy = (target.momy + FixedMul(thrust, finesine[fa]))   | 0;
  }
  // Player-specific handling.
  if (player !== null) {
    // End-of-game hell hack: special-11 sectors cap damage at health-1.
    if (target.subsector !== null && target.subsector.sector.special === 11 &&
        damage >= target.health) {
      damage = target.health - 1;
    }
    // God-mode / Invulnerability — ignore non-instakill damage.
    if (damage < 1000 &&
        (((player.cheats | 0) & 2 /*CF_GODMODE*/) !== 0 ||
         player.powers[0 /*pw_invulnerability*/] > 0)) {
      return;
    }
    // Armor absorbs a fraction of damage. type 1 = 1/3, type 2 = 1/2.
    if (player.armortype > 0) {
      let saved = (player.armortype === 1) ? ((damage / 3) | 0) : ((damage / 2) | 0);
      if (player.armorpoints <= saved) {
        saved = player.armorpoints;
        player.armortype = 0;
      }
      player.armorpoints -= saved;
      damage -= saved;
    }
    player.health -= damage;
    if (player.health < 0) player.health = 0;
    player.attacker = source;
    player.damagecount += damage;
    if (player.damagecount > 100) player.damagecount = 100;
  }
  target.health -= damage;
  if (target.health <= 0) { P_KillMobj(source, target); return; }
  // Pain state.
  if (P_Random() < (target.info.painchance | 0) && (target.flags & MF_SKULLFLY) === 0) {
    target.flags |= MF_JUSTHIT;
    P_SetMobjState(target, target.info.painstate);
  }
  target.reactiontime = 0;
  // Hostility threshold: ignore everything else for a few seconds to focus on
  // the attacker. Skipped if source is the same species (infighting cooldown
  // would otherwise let monsters keep mauling each other forever).
  if ((target.threshold === 0 || target.type === MT_VILE) &&
      source !== null && source !== target &&
      source.type !== MT_VILE) {
    target.target = source;
    target.threshold = 100 /*BASETHRESHOLD*/;
    if (target.state === target.info.spawnstate && target.info.seestate !== 0) {
      P_SetMobjState(target, target.info.seestate);
    }
  }
}

export function P_GiveCard(player, card) {
  if (player.cards[card]) return;
  player.bonuscount = 6 /*BONUSADD*/;
  player.cards[card] = true;
}

// Backpack — doubles max-ammo capacity and gives one clip of each.
export function P_GiveBackpack(player) {
  if (!player.backpack) {
    for (let i = 0; i < 4; i++) player.maxammo[i] *= 2;
    player.backpack = true;
  }
  for (let i = 0; i < 4; i++) P_GiveAmmo(player, i, 1);
}

// Power-up tic durations (vanilla doomdef.h constants).
export const pw_invulnerability = 0;
export const pw_strength        = 1;
export const pw_invisibility    = 2;
export const pw_ironfeet        = 3;
export const pw_allmap          = 4;
export const pw_infrared        = 5;
const INVULNTICS = 30 * 35;
const INVISTICS  = 60 * 35;
const INFRATICS  = 120 * 35;
const IRONTICS   = 60 * 35;

// P_GivePower — ported from p_inter.c. Returns false if the player already
// had the power and it's a single-shot (allmap), true otherwise.
export function P_GivePower(player, power) {
  if (power === pw_invulnerability) { player.powers[power] = INVULNTICS; return true; }
  if (power === pw_invisibility)    { player.powers[power] = INVISTICS; if (player.mo) player.mo.flags |= 0x40000 /*MF_SHADOW*/; return true; }
  if (power === pw_infrared)        { player.powers[power] = INFRATICS; return true; }
  if (power === pw_ironfeet)        { player.powers[power] = IRONTICS;  return true; }
  if (power === pw_strength)        { P_GiveBody(player, 100); player.powers[power] = 1; return true; }
  if (player.powers[power] > 0) return false;
  player.powers[power] = 1;
  return true;
}
