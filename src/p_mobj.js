// Ported from: linuxdoom-1.10/p_mobj.c, p_mobj.h
// Map objects (mobj_t) — actors that move, suffer state changes, interact.
//
// This module exports the MF_* flag constants and the mobj_t class shape.
// The function bodies (P_SetMobjState, P_XYMovement, P_ZMovement, P_MobjThinker,
// P_SpawnMobj, P_RemoveMobj, P_SpawnMissile, ...) are progressively ported
// from p_mobj.c — see in-place comments referencing line numbers.

import { thinker_t } from './d_think.js';
import { FRACUNIT } from './m_fixed.js';
import { states, mobjinfo, S_NULL } from './info.js';
import { P_Random } from './m_random.js';

// ---------- MF_* flags ----------
export const MF_SPECIAL      = 1;
export const MF_SOLID        = 2;
export const MF_SHOOTABLE    = 4;
export const MF_NOSECTOR     = 8;
export const MF_NOBLOCKMAP   = 16;
export const MF_AMBUSH       = 32;
export const MF_JUSTHIT      = 64;
export const MF_JUSTATTACKED = 128;
export const MF_SPAWNCEILING = 256;
export const MF_NOGRAVITY    = 512;
export const MF_DROPOFF      = 0x400;
export const MF_PICKUP       = 0x800;
export const MF_NOCLIP       = 0x1000;
export const MF_SLIDE        = 0x2000;
export const MF_FLOAT        = 0x4000;
export const MF_TELEPORT     = 0x8000;
export const MF_MISSILE      = 0x10000;
export const MF_DROPPED      = 0x20000;
export const MF_SHADOW       = 0x40000;
export const MF_NOBLOOD      = 0x80000;
export const MF_CORPSE       = 0x100000;
export const MF_INFLOAT      = 0x200000;
export const MF_COUNTKILL    = 0x400000;
export const MF_COUNTITEM    = 0x800000;
export const MF_SKULLFLY     = 0x1000000;
export const MF_NOTDMATCH    = 0x2000000;
export const MF_TRANSLATION  = 0xc000000;
export const MF_TRANSSHIFT   = 26;

// ---------- Movement clamps ----------
export const MAXMOVE   = 30 * FRACUNIT;
export const STOPSPEED = 0x1000;
export const FRICTION  = 0xe800;
export const GRAVITY   = FRACUNIT;
export const ONFLOORZ   = -0x80000000; // MININT — z-on-floor sentinel
export const ONCEILINGZ =  0x7fffffff; // MAXINT

// ---------- mobj_t ----------
export class mobj_t {
  constructor() {
    this.thinker = new thinker_t();
    this.x = 0; this.y = 0; this.z = 0;
    this.snext = null; this.sprev = null;
    this.angle = 0;
    this.sprite = 0;
    this.frame  = 0;
    this.bnext = null; this.bprev = null;
    this.subsector = null;
    this.floorz   = 0;
    this.ceilingz = 0;
    this.radius   = 0;
    this.height   = 0;
    this.momx = 0; this.momy = 0; this.momz = 0;
    this.validcount = 0;
    this.type   = 0;
    this.info   = null; // ref to mobjinfo[type]
    this.tics   = 0;
    this.state  = S_NULL; // index into states[]
    this.flags  = 0;
    this.health = 0;
    this.movedir   = 0;
    this.movecount = 0;
    this.target = null;
    this.reactiontime = 0;
    this.threshold    = 0;
    this.player = null;
    this.lastlook = 0;
    this.spawnpoint = null;
    this.tracer = null;
  }
}

// ---------- Function ports (incremental) ----------
// p_mobj.c:53 — P_SetMobjState
import { actionRegistry } from './info.js';

export let P_RemoveMobj_external = null; // wired by SetExternals to avoid cycle
let R_RemoveMobjSprite_external = null;
let R_RegisterMobjSprite_external = null;
export function P_SetExternals(refs) {
  if (refs.P_RemoveMobj != null) P_RemoveMobj_external = refs.P_RemoveMobj;
  if (refs.P_TryMove != null)    P_TryMove_external    = refs.P_TryMove;
  if (refs.P_SlideMove != null)  P_SlideMove_external  = refs.P_SlideMove;
  if (refs.S_StartSound != null) S_StartSound_external = refs.S_StartSound;
  if (refs.S_StopSound != null)  S_StopSound_external  = refs.S_StopSound;
  if (refs.R_RemoveMobjSprite != null) R_RemoveMobjSprite_external = refs.R_RemoveMobjSprite;
  if (refs.R_RegisterMobjSprite != null) R_RegisterMobjSprite_external = refs.R_RegisterMobjSprite;
}
let P_TryMove_external    = null;
let P_SlideMove_external  = null;
let S_StartSound_external = null;
let S_StopSound_external  = null;

// p_mobj.c:53
export function P_SetMobjState(mobj, state) {
  do {
    if (state === S_NULL) {
      mobj.state = S_NULL;
      if (P_RemoveMobj_external !== null) P_RemoveMobj_external(mobj);
      return false;
    }
    const st = states[state];
    mobj.state  = state;
    mobj.tics   = st.tics;
    mobj.sprite = st.sprite;
    mobj.frame  = st.frame;
    if (st.action !== null) {
      const fn = actionRegistry[st.action];
      if (fn !== undefined) fn(mobj);
    }
    state = st.nextstate;
  } while (mobj.tics === 0);
  return true;
}

// p_mobj.c:90 — P_ExplodeMissile
export function P_ExplodeMissile(mo) {
  mo.momx = 0; mo.momy = 0; mo.momz = 0;
  P_SetMobjState(mo, mobjinfo[mo.type].deathstate);
  mo.tics -= P_Random() & 3;
  if (mo.tics < 1) mo.tics = 1;
  mo.flags &= ~MF_MISSILE;
  if (mo.info !== null && mo.info.deathsound !== 0 && S_StartSound_external !== null) {
    S_StartSound_external(mo, mo.info.deathsound);
  }
}

// ---------- P_SetThingPosition / P_UnsetThingPosition ----------
// Links mobj into its sector's thinglist + the blockmap. Ported from
// p_maputl.c:347/396.
import { R_PointInSubsector, R_PointToAngle2 } from './r_bsp.js';
import { P_AddThinker, P_RemoveThinker, P_ThinkerRemoved } from './p_tick.js';
import {
  bmaporgx as _bmaporgx, bmaporgy as _bmaporgy,
  bmapwidth as _bmapwidth, bmapheight as _bmapheight,
  blocklinks as _blocklinks,
} from './p_setup.js';

const MAPBLOCKSHIFT = 16 + 7; // FRACBITS + 7

export function P_SetThingPosition(mo) {
  const ss = R_PointInSubsector(mo.x, mo.y);
  mo.subsector = ss;
  if ((mo.flags & MF_NOSECTOR) === 0) {
    // link into sector.thinglist (doubly-linked via snext/sprev).
    const sec = ss.sector;
    mo.sprev = null;
    mo.snext = sec.thinglist;
    if (sec.thinglist !== null) sec.thinglist.sprev = mo;
    sec.thinglist = mo;
  }
  // link into blockmap
  if ((mo.flags & MF_NOBLOCKMAP) === 0) {
    const blockx = (mo.x - _bmaporgx) >> MAPBLOCKSHIFT;
    const blocky = (mo.y - _bmaporgy) >> MAPBLOCKSHIFT;
    if (blockx >= 0 && blockx < _bmapwidth && blocky >= 0 && blocky < _bmapheight) {
      const idx = blocky * _bmapwidth + blockx;
      const head = _blocklinks[idx];
      mo.bprev = null;
      mo.bnext = head;
      if (head !== null) head.bprev = mo;
      _blocklinks[idx] = mo;
    } else {
      // thing is off the map
      mo.bnext = null;
      mo.bprev = null;
    }
  }
}

export function P_UnsetThingPosition(mo) {
  if ((mo.flags & MF_NOSECTOR) === 0 && mo.subsector !== null) {
    const sec = mo.subsector.sector;
    if (mo.snext !== null) mo.snext.sprev = mo.sprev;
    if (mo.sprev !== null) mo.sprev.snext = mo.snext;
    else sec.thinglist = mo.snext;
  }
  if ((mo.flags & MF_NOBLOCKMAP) === 0) {
    if (mo.bnext !== null) mo.bnext.bprev = mo.bprev;
    if (mo.bprev !== null) mo.bprev.bnext = mo.bnext;
    else {
      const blockx = (mo.x - _bmaporgx) >> MAPBLOCKSHIFT;
      const blocky = (mo.y - _bmaporgy) >> MAPBLOCKSHIFT;
      if (blockx >= 0 && blockx < _bmapwidth && blocky >= 0 && blocky < _bmapheight) {
        _blocklinks[blocky * _bmapwidth + blockx] = mo.bnext;
      }
    }
  }
}

// ---------- P_SpawnMobj ----------
// p_mobj.c:485
export function P_SpawnMobj(x, y, z, type) {
  const mo = new mobj_t();
  const info = mobjinfo[type];
  mo.type  = type;
  mo.info  = info;
  mo.x = x; mo.y = y;
  mo.radius = info.radius;
  mo.height = info.height;
  mo.flags  = info.flags;
  mo.health = info.spawnhealth;
  // p_mobj.c:503 — nightmare gets reactiontime 0 for faster monsters.
  if (_doomstat === null || _doomstat.gameskill !== 4 /*sk_nightmare*/) {
    mo.reactiontime = info.reactiontime;
  }
  mo.lastlook = P_Random() % 4 /*MAXPLAYERS*/;
  const st = states[info.spawnstate];
  mo.state  = info.spawnstate;
  mo.tics   = st.tics;
  mo.sprite = st.sprite;
  mo.frame  = st.frame;
  P_SetThingPosition(mo);
  mo.floorz   = mo.subsector.sector.floorheight;
  mo.ceilingz = mo.subsector.sector.ceilingheight;
  if (z === ONFLOORZ)        mo.z = mo.floorz;
  else if (z === ONCEILINGZ) mo.z = mo.ceilingz - info.height;
  else                       mo.z = z;
  mo.thinker.function = P_MobjThinker;
  P_AddThinker(mo.thinker);
  // Back-link thinker to its mobj_t so the thinker tick can find it.
  mo.thinker.__mobj = mo;
  // Renderer registration — vanilla r_things.c walks each visible sector's
  // thinglist per frame, so every spawned mobj is naturally drawn. We need
  // an explicit hook because the JS port pre-creates THREE.Sprite billboards
  // and updates them in place. Without this, mid-game spawns (dropped clips,
  // projectiles, blood, puffs, gibs, teleport fog) would be invisible.
  if (R_RegisterMobjSprite_external !== null) R_RegisterMobjSprite_external(mo);
  return mo;
}

// Expose P_SpawnMobj for save/load via globalThis (avoids import cycles).
if (typeof globalThis !== 'undefined') globalThis.__P_SpawnMobj = P_SpawnMobj;

// ---------- Nightmare respawn queue ----------
const ITEMQUESIZE = 128;
const itemrespawnque  = new Array(ITEMQUESIZE);
const itemrespawntime = new Int32Array(ITEMQUESIZE);
let iquehead = 0, iquetail = 0;

// p_mobj.c:546
export function P_RemoveMobj(mo) {
  // Queue pickupable items for nightmare-respawn unless dropped / forbidden.
  if ((mo.flags & MF_SPECIAL) !== 0 &&
      (mo.flags & MF_DROPPED) === 0 &&
      mo.type !== 56 /*MT_INV*/ &&
      mo.type !== 58 /*MT_INS*/ &&
      mo.spawnpoint !== null) {
    itemrespawnque[iquehead] = mo.spawnpoint;
    // leveltime is on doomstat — keep this module light by reading from globalThis.
    itemrespawntime[iquehead] = (globalThis.__doom_leveltime | 0);
    iquehead = (iquehead + 1) & (ITEMQUESIZE - 1);
    if (iquehead === iquetail) iquetail = (iquetail + 1) & (ITEMQUESIZE - 1);
  }
  // unlink from sector and block lists
  P_UnsetThingPosition(mo);
  // stop any playing sound (p_mobj.c:566) — otherwise positional/looping sfx
  // attached to this mobj (chaingunner attack, plat/door loops) outlive it.
  if (S_StopSound_external !== null) S_StopSound_external(mo);
  // free block
  P_RemoveThinker(mo.thinker);
  // Detach the renderer's sprite billboard (vanilla r_things.c walks
  // sec->thinglist, which P_UnsetThingPosition just unlinked us from; our
  // parallel _liveSprites list needs an explicit prune).
  if (R_RemoveMobjSprite_external !== null) R_RemoveMobjSprite_external(mo);
}

// p_mobj.c:578 — P_RespawnSpecials. Called every tic from P_Ticker.
// Vanilla: gated on `deathmatch == 2` (altdeath). Without this guard, level
// pickups queued by P_RemoveMobj start respawning 30 seconds in regardless
// of game mode — which spawns extra mobjs (with the lastlook+tics P_Random
// pair) mid-demo, breaking demo determinism.
export function P_RespawnSpecials() {
  // Vanilla p_mobj.c:582 — `deathmatch != 2` short-circuits the entire body.
  // Read from doomstat through globalThis to avoid an import-cycle: doomstat
  // is the source of truth for the deathmatch byte (set from the demo
  // header, default false for normal play).
  if ((globalThis.__doom_deathmatch | 0) !== 2) return;
  if (iquehead === iquetail) return;
  const leveltime = globalThis.__doom_leveltime | 0;
  if (leveltime - itemrespawntime[iquetail] < 30 * 35) return;
  const mthing = itemrespawnque[iquetail];
  if (mthing === undefined || mthing === null) {
    iquetail = (iquetail + 1) & (ITEMQUESIZE - 1);
    return;
  }
  // p_mobj.c:607-610 — spawn a teleport fog at the respawn spot and play
  // sfx_itmbk before respawning the item itself.
  const x = mthing.x << 16;
  const y = mthing.y << 16;
  const ss = R_PointInSubsector(x, y);
  const fog = P_SpawnMobj(x, y, ss.sector.floorheight, 40 /*MT_IFOG*/);
  if (S_StartSound_external !== null) S_StartSound_external(fog, 90 /*sfx_itmbk*/);
  if (globalThis.__P_SpawnMapThing !== undefined) {
    globalThis.__P_SpawnMapThing(mthing);
  }
  iquetail = (iquetail + 1) & (ITEMQUESIZE - 1);
}

// Wire as the external reference so P_SetMobjState can call P_RemoveMobj.
P_RemoveMobj_external = P_RemoveMobj;

// ---------- P_XYMovement / P_ZMovement ----------
// Faithful ports of p_mobj.c:114 (P_XYMovement) and p_mobj.c:246 (P_ZMovement).
import { FixedMul } from './m_fixed.js';
import { P_TryMove, P_SlideMove, P_CheckPosition } from './p_map.js';
import * as _pmap from './p_map.js';
const FLOATSPEED = 4 * FRACUNIT;
const _S_PLAY        = 149;
const _S_PLAY_RUN1   = 150;

// p_mobj.c:114
export function P_XYMovement(mo) {
  if (mo.momx === 0 && mo.momy === 0) {
    if ((mo.flags & MF_SKULLFLY) !== 0) {
      // The Skull slammed into something — clear flag, zero momentum, drop to spawnstate.
      mo.flags &= ~MF_SKULLFLY;
      mo.momx = 0; mo.momy = 0; mo.momz = 0;
      P_SetMobjState(mo, mo.info.spawnstate);
    }
    return;
  }

  const player = mo.player;
  // Clamp to MAXMOVE.
  if (mo.momx > MAXMOVE)       mo.momx = MAXMOVE;
  else if (mo.momx < -MAXMOVE) mo.momx = -MAXMOVE;
  if (mo.momy > MAXMOVE)       mo.momy = MAXMOVE;
  else if (mo.momy < -MAXMOVE) mo.momy = -MAXMOVE;

  let xmove = mo.momx, ymove = mo.momy;
  do {
    let ptryx, ptryy;
    if (xmove > MAXMOVE / 2 || ymove > MAXMOVE / 2) {
      // Half-step iteration prevents fast missiles tunnelling through walls.
      ptryx = (mo.x + (xmove / 2 | 0)) | 0;
      ptryy = (mo.y + (ymove / 2 | 0)) | 0;
      xmove = xmove >> 1;
      ymove = ymove >> 1;
    } else {
      ptryx = (mo.x + xmove) | 0;
      ptryy = (mo.y + ymove) | 0;
      xmove = 0; ymove = 0;
    }
    if (!P_TryMove(mo, ptryx, ptryy)) {
      if (player !== null) {
        // Try to slide along the wall (vanilla P_SlideMove).
        P_SlideMove(mo);
      } else if ((mo.flags & MF_MISSILE) !== 0) {
        // Sky-hack: a missile striking a sky-ceiling line disappears silently.
        const cl = _pmap.ceilingline;
        const sky = (globalThis.__doom_skyflatnum | 0);
        if (cl !== null && cl.backsector !== null &&
            sky !== -1 && cl.backsector.ceilingpic === sky) {
          P_RemoveMobj(mo);
          return;
        }
        P_ExplodeMissile(mo);
      } else {
        mo.momx = 0; mo.momy = 0;
      }
    }
  } while (xmove !== 0 || ymove !== 0);

  // CF_NOMOMENTUM: debug cheat — slide off entirely.
  if (player !== null && (player.cheats & 4 /*CF_NOMOMENTUM*/) !== 0) {
    mo.momx = 0; mo.momy = 0;
    return;
  }

  // Friction.
  if ((mo.flags & (MF_MISSILE | MF_SKULLFLY)) !== 0) return; // no friction
  if (mo.z > mo.floorz) return;                              // airborne
  if ((mo.flags & MF_CORPSE) !== 0) {
    // Corpses keep sliding if halfway off a step.
    if (mo.momx > FRACUNIT / 4 || mo.momx < -FRACUNIT / 4 ||
        mo.momy > FRACUNIT / 4 || mo.momy < -FRACUNIT / 4) {
      if (mo.subsector !== null && mo.floorz !== mo.subsector.sector.floorheight) return;
    }
  }

  if (mo.momx > -STOPSPEED && mo.momx < STOPSPEED &&
      mo.momy > -STOPSPEED && mo.momy < STOPSPEED &&
      (player === null || (player.cmd.forwardmove === 0 && player.cmd.sidemove === 0))) {
    // STOPSPEED snap: walking frame returns to S_PLAY, momentum cleared.
    if (player !== null && (mo.state - _S_PLAY_RUN1) >>> 0 < 4) {
      P_SetMobjState(mo, _S_PLAY);
    }
    mo.momx = 0; mo.momy = 0;
  } else {
    mo.momx = FixedMul(mo.momx, FRICTION);
    mo.momy = FixedMul(mo.momy, FRICTION);
  }
}

// p_mobj.c:246
export function P_ZMovement(mo) {
  // Smooth step-up: when the floor pops up under the player, animate the
  // viewheight drop so it's not jarring (gradually returns to VIEWHEIGHT).
  if (mo.player !== null && mo.z < mo.floorz) {
    mo.player.viewheight -= (mo.floorz - mo.z);
    mo.player.deltaviewheight = ((41 * FRACUNIT) - mo.player.viewheight) >> 3;
  }

  // Adjust height.
  mo.z = (mo.z + mo.momz) | 0;

  // MF_FLOAT: cacodemons/lost souls drift toward their target's height.
  if ((mo.flags & MF_FLOAT) !== 0 && mo.target !== null) {
    if ((mo.flags & MF_SKULLFLY) === 0 && (mo.flags & MF_INFLOAT) === 0) {
      const ddx = Math.abs(mo.x - mo.target.x);
      const ddy = Math.abs(mo.y - mo.target.y);
      const dist = ddx < ddy ? ddx + ddy - (ddx >> 1) : ddx + ddy - (ddy >> 1);
      const delta = (mo.target.z + (mo.height >> 1)) - mo.z;
      if      (delta < 0 && dist < (-delta) * 3) mo.z -= FLOATSPEED;
      else if (delta > 0 && dist <   delta  * 3) mo.z += FLOATSPEED;
    }
  }

  // Clip against floor.
  if (mo.z <= mo.floorz) {
    if ((mo.flags & MF_SKULLFLY) !== 0) mo.momz = -mo.momz; // bounce
    if (mo.momz < 0) {
      if (mo.player !== null && mo.momz < -GRAVITY * 8) {
        // Hard landing: squat + oof.
        mo.player.deltaviewheight = mo.momz >> 3;
        if (S_StartSound_external !== null) S_StartSound_external(mo, 34 /*sfx_oof*/);
      }
      mo.momz = 0;
    }
    mo.z = mo.floorz;
    if ((mo.flags & MF_MISSILE) !== 0 && (mo.flags & MF_NOCLIP) === 0) {
      P_ExplodeMissile(mo);
      return;
    }
  } else if ((mo.flags & MF_NOGRAVITY) === 0) {
    if (mo.momz === 0) mo.momz = -GRAVITY * 2;
    else               mo.momz -= GRAVITY;
  }

  // Clip against ceiling.
  if (mo.z + mo.height > mo.ceilingz) {
    if (mo.momz > 0) mo.momz = 0;
    mo.z = mo.ceilingz - mo.height;
    if ((mo.flags & MF_SKULLFLY) !== 0) mo.momz = -mo.momz; // bounce
    if ((mo.flags & MF_MISSILE) !== 0 && (mo.flags & MF_NOCLIP) === 0) {
      P_ExplodeMissile(mo);
      return;
    }
  }
}

// p_mobj.c:415 — P_MobjThinker. Order is XY then Z; after each, bail if the
// mobj got removed (e.g., P_ExplodeMissile → P_SetMobjState → P_RemoveMobj).
export function P_MobjThinker(thinker) {
  const mo = thinker.__mobj;
  if (mo === undefined) return;
  // Vanilla also runs XYMovement when SKULLFLY is set even if momentum is zero,
  // so the bounce-out-of-stuck behaviour fires.
  if (mo.momx !== 0 || mo.momy !== 0 || (mo.flags & MF_SKULLFLY) !== 0) {
    P_XYMovement(mo);
    if (P_ThinkerRemoved(mo.thinker)) return;
  }
  if (mo.momz !== 0 || mo.z !== mo.floorz) {
    P_ZMovement(mo);
    if (P_ThinkerRemoved(mo.thinker)) return;
  }
  if (mo.tics !== -1) {
    mo.tics--;
    if (mo.tics === 0) {
      const st = states[mo.state];
      if (!P_SetMobjState(mo, st.nextstate)) return;
    }
  } else {
    // Nightmare respawn check.
    if ((mo.flags & MF_COUNTKILL) === 0) return;
    if (_doomstat == null || _doomstat.respawnmonsters !== true) return;
    mo.movecount++;
    if (mo.movecount < 12 * 35) return;
    if (((globalThis.__doom_leveltime | 0) & 31) !== 0) return;
    if (P_Random() > 4) return;
    P_NightmareRespawn(mo);
  }
}

// p_mobj.c:356 — P_NightmareRespawn
let _doomstat = null;
export function P_MobjSetDoomstat(ds) { _doomstat = ds; }

export function P_NightmareRespawn(mobj) {
  if (mobj.spawnpoint === null) return;
  const x = mobj.spawnpoint.x << 16;
  const y = mobj.spawnpoint.y << 16;
  if (!P_CheckPosition(mobj, x, y)) return;
  // Teleport fog at the old spot.
  let mo = P_SpawnMobj(mobj.x, mobj.y, mobj.subsector.sector.floorheight, 39 /*MT_TFOG*/);
  if (S_StartSound_external !== null) S_StartSound_external(mo, 35 /*sfx_telept*/);
  // Teleport fog at new spot.
  const ss = R_PointInSubsector(x, y);
  mo = P_SpawnMobj(x, y, ss.sector.floorheight, 39 /*MT_TFOG*/);
  if (S_StartSound_external !== null) S_StartSound_external(mo, 35 /*sfx_telept*/);
  // Spawn the new monster.
  const z = (mobj.info.flags & MF_SPAWNCEILING) !== 0 ? ONCEILINGZ : ONFLOORZ;
  const newmo = P_SpawnMobj(x, y, z, mobj.type);
  newmo.spawnpoint = mobj.spawnpoint;
  // C: mo->angle = ANG45 * (mthing->angle/45); — integer division.
  // >>> 0 normalises to unsigned 32-bit (angle_t).
  newmo.angle = (((mobj.spawnpoint.angle / 45) | 0) * 0x20000000) >>> 0;
  if ((mobj.spawnpoint.options & 8 /*MTF_AMBUSH*/) !== 0) newmo.flags |= MF_AMBUSH;
  newmo.reactiontime = 18;
  P_RemoveMobj(mobj);
}

// ---------- P_SpawnPuff / P_SpawnBlood ----------
// Visible impact decorations for hitscan attacks. p_mobj.c:813-852.
// `attackRange` controls puff-vs-fist (S_PUFF3 = sparkle-less melee state).
export function P_SpawnPuff(x, y, z, attackRange) {
  const jitter = ((P_Random() - P_Random()) << 10);
  const th = P_SpawnMobj(x, y, z + jitter, 37 /*MT_PUFF*/);
  th.momz = 65536;
  th.tics -= P_Random() & 3;
  if (th.tics < 1) th.tics = 1;
  // Melee hits don't spark on walls — drop straight to S_PUFF3.
  if (attackRange === 64 * 65536) P_SetMobjState(th, 95 /*S_PUFF3*/);
  return th;
}

export function P_SpawnBlood(x, y, z, damage) {
  const jitter = ((P_Random() - P_Random()) << 10);
  const th = P_SpawnMobj(x, y, z + jitter, 38 /*MT_BLOOD*/);
  th.momz = 2 * 65536;
  th.tics -= P_Random() & 3;
  if (th.tics < 1) th.tics = 1;
  if (damage <= 12 && damage >= 9) P_SetMobjState(th, 91 /*S_BLOOD2*/);
  else if (damage <  9)            P_SetMobjState(th, 92 /*S_BLOOD3*/);
  return th;
}

// ---------- P_SpawnMissile / P_SpawnPlayerMissile ----------
// p_mobj.c:886
import { ANGLETOFINESHIFT as _AF, FINEMASK as _FM, finecosine as _FCOS, finesine as _FSIN } from './tables.js';

function _ApproxDist(dx, dy) {
  dx = Math.abs(dx); dy = Math.abs(dy);
  return dx < dy ? dx + dy - (dx >> 1) : dx + dy - (dy >> 1);
}

// p_mobj.c:888
export function P_SpawnMissile(source, dest, type) {
  const th = P_SpawnMobj(source.x, source.y, (source.z + 4 * 8 * 65536) | 0, type);
  if (th.info !== null && th.info.seesound !== 0 && S_StartSound_external !== null) {
    S_StartSound_external(th, th.info.seesound);
  }
  th.target = source;
  let an = R_PointToAngle2(source.x, source.y, dest.x, dest.y);
  // Fuzzy player — add jitter for invisibility.
  if ((dest.flags & 0x40000 /*MF_SHADOW*/) !== 0) {
    an = (an + ((P_Random() - P_Random()) << 20)) >>> 0;
  }
  th.angle = an;
  const fa = (an >>> _AF) & _FM;
  th.momx = FixedMul(th.info.speed, _FCOS[fa]);
  th.momy = FixedMul(th.info.speed, _FSIN[fa]);
  let dist = _ApproxDist(dest.x - source.x, dest.y - source.y);
  dist = (dist / th.info.speed) | 0;
  if (dist < 1) dist = 1;
  th.momz = ((dest.z - source.z) / dist) | 0;
  P_CheckMissileSpawn(th);
  return th;
}

// p_mobj.c:870 — P_CheckMissileSpawn.
export function P_CheckMissileSpawn(th) {
  th.tics -= P_Random() & 3;
  if (th.tics < 1) th.tics = 1;
  // Move a little forward so an angle can be computed if it immediately
  // explodes against something.
  th.x = (th.x + (th.momx >> 1)) | 0;
  th.y = (th.y + (th.momy >> 1)) | 0;
  th.z = (th.z + (th.momz >> 1)) | 0;
  if (P_TryMove_external !== null) {
    if (!P_TryMove_external(th, th.x, th.y)) P_ExplodeMissile(th);
  }
}

// p_mobj.c:935 — P_SpawnPlayerMissile (autoaim sweep + 0-slope fallback).
export function P_SpawnPlayerMissile(source, type) {
  let an = source.angle;
  let slope = 0;
  if (P_AimLineAttack_external !== null) {
    slope = P_AimLineAttack_external(source, an, 16 * 64 * 65536);
    if (getLinetarget_external() === null) {
      an = (an + (1 << 26)) >>> 0;
      slope = P_AimLineAttack_external(source, an, 16 * 64 * 65536);
      if (getLinetarget_external() === null) {
        an = (an - (2 << 26)) >>> 0;
        slope = P_AimLineAttack_external(source, an, 16 * 64 * 65536);
      }
      if (getLinetarget_external() === null) {
        an = source.angle;
        slope = 0;
      }
    }
  }
  const x = source.x, y = source.y, z = (source.z + 4 * 8 * 65536) | 0;
  const th = P_SpawnMobj(x, y, z, type);
  if (th.info !== null && th.info.seesound !== 0 && S_StartSound_external !== null) {
    S_StartSound_external(th, th.info.seesound);
  }
  th.target = source;
  th.angle = an;
  const fa = (an >>> _AF) & _FM;
  th.momx = FixedMul(th.info.speed, _FCOS[fa]);
  th.momy = FixedMul(th.info.speed, _FSIN[fa]);
  th.momz = FixedMul(th.info.speed, slope);
  P_CheckMissileSpawn(th);
  return th;
}

let P_AimLineAttack_external = null;
let getLinetarget_external   = () => null;
export function P_MobjSetMap(refs) {
  if (refs.P_AimLineAttack != null) P_AimLineAttack_external = refs.P_AimLineAttack;
  if (refs.getLinetarget != null)   getLinetarget_external   = refs.getLinetarget;
}
