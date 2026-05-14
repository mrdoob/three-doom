// Ported from: linuxdoom-1.10/d_items.c, d_items.h
// Weapon info: sprite states + ammo type per weapon.

import { ammotype_t, NUMWEAPONS } from './doomdef.js';
import {
  S_PUNCHUP, S_PUNCHDOWN, S_PUNCH, S_PUNCH1,
  S_PISTOLUP, S_PISTOLDOWN, S_PISTOL, S_PISTOL1, S_PISTOLFLASH,
  S_SGUNUP, S_SGUNDOWN, S_SGUN, S_SGUN1, S_SGUNFLASH1,
  S_CHAINUP, S_CHAINDOWN, S_CHAIN, S_CHAIN1, S_CHAINFLASH1,
  S_MISSILEUP, S_MISSILEDOWN, S_MISSILE, S_MISSILE1, S_MISSILEFLASH1,
  S_PLASMAUP, S_PLASMADOWN, S_PLASMA, S_PLASMA1, S_PLASMAFLASH1,
  S_BFGUP, S_BFGDOWN, S_BFG, S_BFG1, S_BFGFLASH1,
  S_SAWUP, S_SAWDOWN, S_SAW, S_SAW1,
  S_DSGUNUP, S_DSGUNDOWN, S_DSGUN, S_DSGUN1, S_DSGUNFLASH1,
  S_NULL,
} from './info.js';

export class weaponinfo_t {
  constructor(ammo, upstate, downstate, readystate, atkstate, flashstate) {
    this.ammo       = ammo;
    this.upstate    = upstate;
    this.downstate  = downstate;
    this.readystate = readystate;
    this.atkstate   = atkstate;
    this.flashstate = flashstate;
  }
}

export const weaponinfo = [
  new weaponinfo_t(ammotype_t.am_noammo, S_PUNCHUP,    S_PUNCHDOWN,    S_PUNCH,    S_PUNCH1,    S_NULL),         // fist
  new weaponinfo_t(ammotype_t.am_clip,   S_PISTOLUP,   S_PISTOLDOWN,   S_PISTOL,   S_PISTOL1,   S_PISTOLFLASH),  // pistol
  new weaponinfo_t(ammotype_t.am_shell,  S_SGUNUP,     S_SGUNDOWN,     S_SGUN,     S_SGUN1,     S_SGUNFLASH1),   // shotgun
  new weaponinfo_t(ammotype_t.am_clip,   S_CHAINUP,    S_CHAINDOWN,    S_CHAIN,    S_CHAIN1,    S_CHAINFLASH1),  // chaingun
  new weaponinfo_t(ammotype_t.am_misl,   S_MISSILEUP,  S_MISSILEDOWN,  S_MISSILE,  S_MISSILE1,  S_MISSILEFLASH1),// missile launcher
  new weaponinfo_t(ammotype_t.am_cell,   S_PLASMAUP,   S_PLASMADOWN,   S_PLASMA,   S_PLASMA1,   S_PLASMAFLASH1), // plasma rifle
  new weaponinfo_t(ammotype_t.am_cell,   S_BFGUP,      S_BFGDOWN,      S_BFG,      S_BFG1,      S_BFGFLASH1),    // bfg 9000
  new weaponinfo_t(ammotype_t.am_noammo, S_SAWUP,      S_SAWDOWN,      S_SAW,      S_SAW1,      S_NULL),         // chainsaw
  new weaponinfo_t(ammotype_t.am_shell,  S_DSGUNUP,    S_DSGUNDOWN,    S_DSGUN,    S_DSGUN1,    S_DSGUNFLASH1),  // super shotgun
];
