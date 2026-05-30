// Ported from: linuxdoom-1.10/p_enemy.c
// Monster AI: A_Look, A_Chase, A_FaceTarget, A_*Attack, A_Pain, A_Fall, etc.
// This port wires the core idle/chase loop, a generic attack hook, the boss
// specials, and the per-monster action functions (including A_VileChase's
// corpse resurrection).

import { P_RegisterAction, states, mobjinfo, actionRegistry, S_BRAINEXPLODE1, S_VILE_HEAL1 } from './info.js';
import { P_SetMobjState, MF_SHOOTABLE, MF_AMBUSH, MF_JUSTHIT, MF_JUSTATTACKED, MF_SOLID, MF_SKULLFLY, MF_CORPSE, P_SpawnMissile, P_SpawnMobj, P_SpawnPuff, P_RemoveMobj } from './p_mobj.js';
import { P_TeleportMove, P_CheckPosition } from './p_map.js';
import { P_BlockThingsIterator } from './p_maputl.js';
import { bmaporgx, bmaporgy } from './p_setup.js';
import { players, consoleplayer, playeringame, gameepisode, gamemap, gamemode, gameskill, gametic } from './doomstat.js';
import { GameMode_t } from './doomdef.js';
import { ANGLETOFINESHIFT, FINEMASK, finecosine, finesine } from './tables.js';
import { P_CheckSight } from './p_sight.js';
import { R_PointToAngle2 } from './r_bsp.js';
import { MT_BRUISER, MT_CYBORG, MT_SPIDER, MT_HEADSHOT, MT_TROOPSHOT, MT_BRUISERSHOT, MT_FATSO, MT_FATSHOT, MT_VILE, MT_UNDEAD, MT_FIRE, MT_TRACER, MT_SKULL, MT_BABY, MT_PAIN, MT_BOSSBRAIN, MT_BOSSSPIT, MT_BOSSTARGET, MT_SPAWNSHOT, MT_SPAWNFIRE, MT_ROCKET, MT_ARACHPLAZ, MT_TROOP, MT_SERGEANT, MT_SHADOWS, MT_HEAD, MT_KNIGHT } from './info.js';
import { sfx_claw, sfx_slop } from './sounds.js';
import { EV_DoFloor, lowerFloorToLowest, raiseToTexture } from './p_floor.js';
import { EV_DoDoor } from './p_doors.js';
import { P_Random } from './m_random.js';

// External wiring.
let _S = null;
export function P_EnemySetExternals(refs) { if (refs.S != null) _S = refs.S; }

const MELEERANGE = 64 << 16;
const MISSILERANGE = 32 * 64 << 16;

function distApprox(dx, dy) {
  dx = Math.abs(dx); dy = Math.abs(dy);
  return dx < dy ? dx + dy - (dx >> 1) : dx + dy - (dy >> 1);
}

// Choose the nearest live player.
function findClosestPlayer(actor) {
  let best = null, bestDist = Infinity;
  for (let i = 0; i < players.length; i++) {
    if (playeringame[i] !== true) continue;
    const p = players[i];
    if (p === null || p === undefined || p.mo === null || p.health <= 0) continue;
    const d = distApprox(p.mo.x - actor.x, p.mo.y - actor.y) / 65536;
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

// p_enemy.c:499 — P_LookForPlayers. Round-robin through playeringame[]
// starting at actor.lastlook. Stops after seeing 2 valid candidates OR
// cycling back to lastlook-1. If !allaround, ignore targets behind the actor
// unless they're in melee range.
function P_LookForPlayers(actor, allaround) {
  // C can't hit this because G_DoLoadLevel marks playeringame before spawning
  // monsters; our async loadLevel has a brief window where no player is in
  // game, and the `for (;;) { if (!playeringame[..]) continue; }` loop below
  // would spin forever. Bail out explicitly.
  let _any = false;
  for (let _i = 0; _i < playeringame.length; _i++) {
    if (playeringame[_i] === true) { _any = true; break; }
  }
  if (_any === false) return false;
  let c = 0;
  const stop = (actor.lastlook - 1) & 3;
  for (;; actor.lastlook = (actor.lastlook + 1) & 3) {
    if (playeringame[actor.lastlook] !== true) continue;
    if (c++ === 2 || actor.lastlook === stop) return false;
    const player = players[actor.lastlook];
    if (player === null || player === undefined) continue;
    if (player.health <= 0) continue;
    if (!P_CheckSight(actor, player.mo)) continue;
    if (!allaround) {
      const an = ((R_PointToAngle2(actor.x, actor.y, player.mo.x, player.mo.y) - actor.angle) >>> 0);
      if (an > 0x40000000 /*ANG90*/ && an < 0xc0000000 /*ANG270*/) {
        const dist = distApprox(player.mo.x - actor.x, player.mo.y - actor.y);
        if (dist > MELEERANGE) continue;
      }
    }
    actor.target = player.mo;
    return true;
  }
}

// p_enemy.c:570 — A_Look.
P_RegisterAction('A_Look', (actor) => {
  actor.threshold = 0;
  const sec = actor.subsector !== null ? actor.subsector.sector : null;
  let seeyou = false;
  if (sec !== null && sec.soundtarget !== null && (sec.soundtarget.flags & 4 /*MF_SHOOTABLE*/) !== 0) {
    actor.target = sec.soundtarget;
    if ((actor.flags & 32 /*MF_AMBUSH*/) !== 0) {
      if (P_CheckSight(actor, actor.target)) seeyou = true;
    } else {
      seeyou = true;
    }
  }
  if (!seeyou) {
    if (!P_LookForPlayers(actor, false)) return;
  }
  if (actor.info !== null && actor.info.seesound !== 0 && _S !== null) {
    // p_enemy.c:635 — sergeants and former humans pick a random voice variant.
    let sound = actor.info.seesound;
    if      (sound === 36 /*sfx_posit1*/ || sound === 37 /*sfx_posit2*/ || sound === 38 /*sfx_posit3*/) {
      sound = 36 + (P_Random() % 3);
    } else if (sound === 39 /*sfx_bgsit1*/ || sound === 40 /*sfx_bgsit2*/) {
      sound = 39 + (P_Random() % 2);
    }
    // Spider and Cyberdemon scream at full volume (decoupled from origin).
    if (actor.type === MT_SPIDER || actor.type === MT_CYBORG) {
      _S.S_StartSound(null, sound);
    } else {
      _S.S_StartSound(actor, sound);
    }
  }
  P_SetMobjState(actor, actor.info.seestate);
});

// A_FaceTarget — point actor at target. Vanilla also clears MF_AMBUSH so the
// monster will pursue on subsequent damage, and adds a small random angle
// jitter if the target is invisible (MF_SHADOW).
P_RegisterAction('A_FaceTarget', (actor) => {
  if (actor.target === null) return;
  actor.flags &= ~MF_AMBUSH;
  actor.angle = R_PointToAngle2(actor.x, actor.y, actor.target.x, actor.target.y);
  if ((actor.target.flags & 0x40000 /*MF_SHADOW*/) !== 0) {
    // p_enemy.c A_FaceTarget: actor->angle += (P_Random()-P_Random())<<21
    const jitter = (P_Random() - P_Random()) << 21;
    actor.angle = (actor.angle + jitter) >>> 0;
  }
});

// 8-direction monster movement (Doom uses DI_EAST=0..DI_SOUTHEAST=7, DI_NODIR=8).
const xspeed = [65536, 47000, 0, -47000, -65536, -47000, 0,  47000];
const yspeed = [0,     47000, 65536, 47000, 0,     -47000, -65536, -47000];
const MF_FLOAT_   = 0x4000;
const MF_INFLOAT_ = 0x200000;
const FLOATSPEED_ = 4 * 65536;

// p_enemy.c:260 — P_Move. Returns false if the move is blocked. On block,
// floaters bob to clear the obstacle, and monsters open doors via the spechit
// list.
function P_Move(actor) {
  if (actor.movedir === 8 /*DI_NODIR*/) return false;
  if (actor.movedir >= 8) return false; // weird movedir
  if (_PMap === null) return false;
  const speed = actor.info.speed | 0;
  if (speed === 0) return false;
  const tryx = (actor.x + speed * xspeed[actor.movedir]) | 0;
  const tryy = (actor.y + speed * yspeed[actor.movedir]) | 0;
  const ok = _PMap.P_TryMove(actor, tryx, tryy);
  if (!ok) {
    // Float around obstacle.
    if ((actor.flags & MF_FLOAT_) !== 0 && _PMap.floatok) {
      if (actor.z < _PMap.get_tmfloorz()) actor.z += FLOATSPEED_;
      else                                 actor.z -= FLOATSPEED_;
      actor.flags |= MF_INFLOAT_;
      return true;
    }
    if (_PMap.numspechit === 0) return false;
    actor.movedir = 8;
    let good = false;
    let n = _PMap.numspechit;
    while (n-- > 0) {
      const ld = _PMap.spechit[n];
      if (_PSpec !== null && typeof _PSpec.P_UseSpecialLine === 'function') {
        if (_PSpec.P_UseSpecialLine(actor, ld, 0)) good = true;
      }
    }
    return good;
  }
  actor.flags &= ~MF_INFLOAT_;
  if ((actor.flags & MF_FLOAT_) === 0) actor.z = actor.floorz;
  return true;
}

// p_enemy.c:328 — P_TryWalk.
function P_TryWalk(actor) {
  if (!P_Move(actor)) return false;
  actor.movecount = P_Random() & 15;
  return true;
}

// p_enemy.c:60 — opposite[] and diags[] LUTs.
const DI_EAST = 0, DI_NORTHEAST = 1, DI_NORTH = 2, DI_NORTHWEST = 3,
      DI_WEST = 4, DI_SOUTHWEST = 5, DI_SOUTH = 6, DI_SOUTHEAST = 7, DI_NODIR = 8;
const opposite = [DI_WEST, DI_SOUTHWEST, DI_SOUTH, DI_SOUTHEAST,
                  DI_EAST, DI_NORTHEAST, DI_NORTH, DI_NORTHWEST, DI_NODIR];
const diags = [DI_NORTHWEST, DI_NORTHEAST, DI_SOUTHWEST, DI_SOUTHEAST];

// p_enemy.c:362 — P_NewChaseDir. Called from A_Chase for every monster
// every other tic; the scratch `d` array is hoisted to module scope so the
// hot path doesn't allocate. (Reading [0] / [1] / [2] only — no concurrent
// invocation issue under the 35Hz tic loop.)
const _ncdScratch = [8 /*DI_NODIR*/, 8 /*DI_NODIR*/, 8 /*DI_NODIR*/];
function P_NewChaseDir(actor) {
  if (actor.target === null) return;
  const olddir = actor.movedir;
  const turnaround = opposite[olddir];
  const deltax = actor.target.x - actor.x;
  const deltay = actor.target.y - actor.y;
  const d = _ncdScratch;
  d[0] = DI_NODIR; d[1] = DI_NODIR; d[2] = DI_NODIR;
  if      (deltax >  10 * 65536) d[1] = DI_EAST;
  else if (deltax < -10 * 65536) d[1] = DI_WEST;
  if      (deltay < -10 * 65536) d[2] = DI_SOUTH;
  else if (deltay >  10 * 65536) d[2] = DI_NORTH;
  // Try direct diagonal.
  if (d[1] !== DI_NODIR && d[2] !== DI_NODIR) {
    actor.movedir = diags[((deltay < 0 ? 1 : 0) << 1) + (deltax > 0 ? 1 : 0)];
    if (actor.movedir !== turnaround && P_TryWalk(actor)) return;
  }
  // Vanilla coin-flip: try Y direction first if RNG > 200 OR |dy|>|dx|.
  if (P_Random() > 200 || Math.abs(deltay) > Math.abs(deltax)) {
    const tdir = d[1]; d[1] = d[2]; d[2] = tdir;
  }
  if (d[1] === turnaround) d[1] = DI_NODIR;
  if (d[2] === turnaround) d[2] = DI_NODIR;
  if (d[1] !== DI_NODIR) {
    actor.movedir = d[1];
    if (P_TryWalk(actor)) return;
  }
  if (d[2] !== DI_NODIR) {
    actor.movedir = d[2];
    if (P_TryWalk(actor)) return;
  }
  // No direct path — try old direction.
  if (olddir !== DI_NODIR) {
    actor.movedir = olddir;
    if (P_TryWalk(actor)) return;
  }
  // Sweep all 8 directions, forward or backward by coin-flip.
  if ((P_Random() & 1) !== 0) {
    for (let tdir = DI_EAST; tdir <= DI_SOUTHEAST; tdir++) {
      if (tdir === turnaround) continue;
      actor.movedir = tdir;
      if (P_TryWalk(actor)) return;
    }
  } else {
    for (let tdir = DI_SOUTHEAST; tdir >= DI_EAST; tdir--) {
      if (tdir === turnaround) continue;
      actor.movedir = tdir;
      if (P_TryWalk(actor)) return;
    }
  }
  // Final fallback: turn around.
  if (turnaround !== DI_NODIR) {
    actor.movedir = turnaround;
    if (P_TryWalk(actor)) return;
  }
  actor.movedir = DI_NODIR;
}

// p_enemy.c:174 — P_CheckMeleeRange.
function P_CheckMeleeRange(actor) {
  if (actor.target === null) return false;
  const pl = actor.target;
  const dist = distApprox(pl.x - actor.x, pl.y - actor.y);
  if (dist >= MELEERANGE - 20 * 65536 + pl.info.radius) return false;
  if (!P_CheckSight(actor, actor.target)) return false;
  return true;
}

// p_enemy.c:197 — P_CheckMissileRange.
function P_CheckMissileRange(actor) {
  if (!P_CheckSight(actor, actor.target)) return false;
  if ((actor.flags & 64 /*MF_JUSTHIT*/) !== 0) {
    actor.flags &= ~64;
    return true;
  }
  if (actor.reactiontime > 0) return false;
  let dist = distApprox(actor.x - actor.target.x, actor.y - actor.target.y) - 64 * 65536;
  if (actor.info.meleestate === 0) dist -= 128 * 65536;
  dist >>= 16;
  if (actor.type === MT_VILE && dist > 14 * 64) return false;
  if (actor.type === MT_UNDEAD) {
    if (dist < 196) return false;
    dist >>= 1;
  }
  if (actor.type === MT_CYBORG || actor.type === MT_SPIDER || actor.type === MT_SKULL) {
    dist >>= 1;
  }
  if (dist > 200) dist = 200;
  if (actor.type === MT_CYBORG && dist > 160) dist = 160;
  if (P_Random() < dist) return false;
  return true;
}

// p_enemy.c — A_Chase.
const ANG90_C = 0x40000000;
P_RegisterAction('A_Chase', (actor) => {
  if (actor.reactiontime > 0) actor.reactiontime--;
  // Threshold tick.
  if (actor.threshold > 0) {
    if (actor.target === null || actor.target.health <= 0) actor.threshold = 0;
    else actor.threshold--;
  }
  // Turn toward movedir (snap by 22.5° each tic — vanilla angle &= 7<<29 trick).
  if (actor.movedir < 8) {
    actor.angle = (actor.angle & ((7 << 29) >>> 0)) >>> 0;
    const delta = ((actor.angle - ((actor.movedir << 29) >>> 0)) | 0);
    if (delta > 0) actor.angle = (actor.angle - (ANG90_C >>> 1)) >>> 0;
    else if (delta < 0) actor.angle = (actor.angle + (ANG90_C >>> 1)) >>> 0;
  }
  // Acquire / re-acquire target. Vanilla calls P_LookForPlayers(allaround=true).
  if (actor.target === null || (actor.target.flags & MF_SHOOTABLE) === 0) {
    if (P_LookForPlayers(actor, true)) return;
    P_SetMobjState(actor, actor.info.spawnstate);
    return;
  }
  // Don't attack twice in a row.
  if ((actor.flags & MF_JUSTATTACKED) !== 0) {
    actor.flags &= ~MF_JUSTATTACKED;
    // Vanilla: !sk_nightmare && !fastparm → re-pick chase dir.
    if (gameskill !== 4 /*sk_nightmare*/) P_NewChaseDir(actor);
    return;
  }
  // Melee attack.
  if (actor.info.meleestate !== 0 && P_CheckMeleeRange(actor)) {
    if (actor.info.attacksound !== 0 && _S !== null) _S.S_StartSound(actor, actor.info.attacksound);
    P_SetMobjState(actor, actor.info.meleestate);
    return;
  }
  // Missile attack.
  let didMissile = false;
  if (actor.info.missilestate !== 0) {
    // Vanilla p_enemy.c:719 — `gameskill < sk_nightmare && !fastparm && actor->movecount`
    // skips the missile check. The C `actor->movecount` is a non-zero test, so
    // movecount === -1 (after the previous tic's --movecount underflow) still
    // skips. Using `> 0` excludes that case and makes our actor call
    // P_CheckMissileRange when vanilla doesn't — desyncs DEMO1 around tic 4189.
    const movecountGate = (gameskill !== 4 && actor.movecount !== 0);
    if (!movecountGate && P_CheckMissileRange(actor)) {
      P_SetMobjState(actor, actor.info.missilestate);
      actor.flags |= MF_JUSTATTACKED;
      return;
    }
    // movecountGate or missilerange failed → fall through to chase.
  }
  // Chase toward target.
  if (--actor.movecount < 0 || !P_Move(actor)) {
    P_NewChaseDir(actor);
  }
  // Active sound (random).
  if (actor.info.activesound !== 0 && _S !== null && P_Random() < 3) {
    _S.S_StartSound(actor, actor.info.activesound);
  }
});

// A_Pain — play pain sound.
P_RegisterAction('A_Pain', (actor) => {
  if (actor.info !== null && actor.info.painsound !== 0 && _S !== null) _S.S_StartSound(actor, actor.info.painsound);
});

// A_Fall — make corpse non-solid so player can walk over it.
P_RegisterAction('A_Fall', (actor) => { actor.flags &= ~MF_SOLID; });

// A_Scream / A_XScream — death sounds.
P_RegisterAction('A_Scream', (actor) => {
  if (actor.info === null || actor.info.deathsound === 0 || _S === null) return;
  // p_enemy.c:1539 — variant pick for zombie / sergeant deaths.
  let sound = actor.info.deathsound;
  if      (sound === 59 /*sfx_podth1*/ || sound === 60 /*sfx_podth2*/ || sound === 61 /*sfx_podth3*/) {
    sound = 59 + (P_Random() % 3);
  } else if (sound === 62 /*sfx_bgdth1*/ || sound === 63 /*sfx_bgdth2*/) {
    sound = 62 + (P_Random() % 2);
  }
  if (actor.type === MT_SPIDER || actor.type === MT_CYBORG) {
    _S.S_StartSound(null, sound);
  } else {
    _S.S_StartSound(actor, sound);
  }
});
P_RegisterAction('A_XScream', (actor) => {
  if (_S !== null) _S.S_StartSound(actor, 31 /*sfx_slop*/);
});
P_RegisterAction('A_PlayerScream', (actor) => {
  if (_S === null) return;
  // p_enemy.c:2003 — gibbed dying scream is louder in commercial (Doom 2).
  // Doom 1 always uses sfx_pldeth.
  const sound = (gamemode === GameMode_t.commercial && actor.health < -50)
    ? 58 /*sfx_pdiehi*/ : 57 /*sfx_pldeth*/;
  _S.S_StartSound(actor, sound);
});

// External: P_LineAttack (hitscan) and P_DamageMobj (direct damage).
let _PMap = null, _PInter = null, _PSpec = null;
export function P_EnemySetMap(refs) {
  if (refs.PMap != null)   _PMap   = refs.PMap;
  if (refs.PInter != null) _PInter = refs.PInter;
  if (refs.PSpec != null)  _PSpec  = refs.PSpec;
}

// P_RecursiveSound / P_NoiseAlert — wake up monsters in adjacent sectors when
// something noisy happens. Stops at ML_SOUNDBLOCK lines (two in a row hush
// the alert per Doom convention) and at closed doors.
let _validcount = 0;
let _soundtarget = null;
function P_RecursiveSound(sec, soundblocks) {
  if (sec === null) return;
  if (sec.validcount === _validcount && sec.soundtraversed <= soundblocks + 1) return;
  sec.validcount = _validcount;
  sec.soundtraversed = soundblocks + 1;
  sec.soundtarget = _soundtarget;
  for (const ld of sec.lines) {
    if ((ld.flags & 4 /*ML_TWOSIDED*/) === 0) continue;
    const front = ld.frontsector, back = ld.backsector;
    if (front === null || back === null) continue;
    if (Math.min(front.ceilingheight, back.ceilingheight) <=
        Math.max(front.floorheight,   back.floorheight)) continue;
    const other = (front === sec) ? back : front;
    if ((ld.flags & 64 /*ML_SOUNDBLOCK*/) !== 0) {
      if (soundblocks === 0) P_RecursiveSound(other, 1);
    } else {
      P_RecursiveSound(other, soundblocks);
    }
  }
}

export function P_NoiseAlert(target, emitter) {
  if (emitter === null || emitter.subsector === null) return;
  _soundtarget = target;
  _validcount++;
  P_RecursiveSound(emitter.subsector.sector, 0);
}

const MISSILERANGE_FX = 32 * 64 << 16;

// Mirrors A_FaceTarget exactly (clears MF_AMBUSH + MF_SHADOW P_Random jitter)
// so monster attacks that face their target consume the same RNG as vanilla.
function faceTarget(actor) {
  if (actor.target === null) return;
  actor.flags &= ~MF_AMBUSH;
  actor.angle = R_PointToAngle2(actor.x, actor.y, actor.target.x, actor.target.y);
  if ((actor.target.flags & 0x40000 /*MF_SHADOW*/) !== 0) {
    const jitter = (P_Random() - P_Random()) << 21;
    actor.angle = (actor.angle + jitter) >>> 0;
  }
}

function hitscanAttack(actor, numShots, damageFn, sound) {
  if (actor.target === null) return;
  faceTarget(actor);
  // Autoaim slope so the bullet rises/falls to reach an enemy on a different
  // floor (matches vanilla A_PosAttack, A_SPosAttack, A_CPosAttack).
  let slope = 0;
  if (_PMap !== null) slope = _PMap.P_AimLineAttack(actor, actor.angle, MISSILERANGE_FX);
  if (sound !== undefined && sound !== 0 && _S !== null) _S.S_StartSound(actor, sound);
  for (let i = 0; i < numShots; i++) {
    // p_enemy.c: angle += (P_Random()-P_Random())<<20
    const spread = (P_Random() - P_Random()) << 20;
    const angle = (actor.angle + spread) >>> 0;
    if (_PMap !== null) _PMap.P_LineAttack(actor, angle, MISSILERANGE_FX, slope, damageFn());
  }
}

function meleeAttack(actor, baseDamage, randMul, sound) {
  if (actor.target === null) return;
  faceTarget(actor);
  // p_enemy.c uses P_CheckMeleeRange (fixed-point distApprox), not float sqrt —
  // critical for demo determinism.
  if (!P_CheckMeleeRange(actor)) return;
  if (sound !== undefined && sound !== 0 && _S !== null) _S.S_StartSound(actor, sound);
  // p_enemy.c melee attacks: damage = (P_Random()%N+1)*M; randMul is N, base is *M.
  const damage = baseDamage * (P_Random() % randMul + 1);
  if (_PInter !== null) _PInter.P_DamageMobj(actor.target, actor, actor, damage);
}

// Shared damage roll for hitscan zombies (vanilla 1d5 × 3 = 3..15).
function zombieHitscanDamage() { return ((P_Random() % 5) + 1) * 3; }
P_RegisterAction('A_PosAttack',    (a) => hitscanAttack(a, 1, zombieHitscanDamage, 1));
P_RegisterAction('A_SPosAttack',   (a) => hitscanAttack(a, 3, zombieHitscanDamage, 2));
P_RegisterAction('A_CPosAttack',   (a) => hitscanAttack(a, 1, zombieHitscanDamage, 2 /*sfx_shotgn*/)); // p_enemy.c:855 (was 84=sfx_hoof)

// A_CPosRefire — keep firing unless target lost or out of sight.
P_RegisterAction('A_CPosRefire', (actor) => {
  faceTarget(actor);
  // p_enemy.c A_CPosRefire: 40/256 chance to keep firing.
  if (P_Random() < 40) return;
  if (actor.target === null || actor.target.health <= 0 || !P_CheckSight(actor, actor.target)) {
    P_SetMobjState(actor, actor.info.seestate);
  }
});

// p_enemy.c:913 A_TroopAttack — Imp: claw bite in melee, else MT_TROOPSHOT fireball.
P_RegisterAction('A_TroopAttack', (actor) => {
  if (actor.target === null) return;
  faceTarget(actor);
  if (P_CheckMeleeRange(actor)) {
    if (_S !== null) _S.S_StartSound(actor, sfx_claw);
    const damage = (P_Random() % 8 + 1) * 3;
    if (_PInter !== null) _PInter.P_DamageMobj(actor.target, actor, actor, damage);
    return;
  }
  P_SpawnMissile(actor, actor.target, MT_TROOPSHOT);
});

P_RegisterAction('A_SargAttack',   (a) => meleeAttack(a, 4, 10, 0));

// p_enemy.c:979 A_BruisAttack — Baron/Knight: NO A_FaceTarget (vanilla quirk).
// Claw bite in melee, else MT_BRUISERSHOT fireball.
P_RegisterAction('A_BruisAttack', (actor) => {
  if (actor.target === null) return;
  if (P_CheckMeleeRange(actor)) {
    if (_S !== null) _S.S_StartSound(actor, sfx_claw);
    const damage = (P_Random() % 8 + 1) * 10;
    if (_PInter !== null) _PInter.P_DamageMobj(actor.target, actor, actor, damage);
    return;
  }
  P_SpawnMissile(actor, actor.target, MT_BRUISERSHOT);
});

// A_HeadAttack — Cacodemon: bite if in melee range else spit fireball.
P_RegisterAction('A_HeadAttack', (actor) => {
  if (actor.target === null) return;
  faceTarget(actor);
  // p_enemy.c uses P_CheckMeleeRange (fixed-point distApprox).
  if (P_CheckMeleeRange(actor)) {
    // p_enemy.c A_HeadAttack: damage = (P_Random()%6+1)*10
    const damage = (P_Random() % 6 + 1) * 10;
    if (_PInter !== null) _PInter.P_DamageMobj(actor.target, actor, actor, damage);
    return;
  }
  P_SpawnMissile(actor, actor.target, MT_HEADSHOT);
});

// A_SkullAttack — Lost Soul: enter MF_SKULLFLY and charge toward target.
const SKULLSPEED = 20 * 65536;
P_RegisterAction('A_SkullAttack', (actor) => {
  if (actor.target === null) return;
  actor.flags |= MF_SKULLFLY;
  if (actor.info.attacksound !== 0 && _S !== null) _S.S_StartSound(actor, actor.info.attacksound);
  faceTarget(actor);
  const fa = (actor.angle >>> ANGLETOFINESHIFT) & FINEMASK;
  actor.momx = ((SKULLSPEED / 65536) * finecosine[fa]) | 0;
  actor.momy = ((SKULLSPEED / 65536) * finesine[fa])   | 0;
  const dist = Math.max(1, (distApprox(actor.target.x - actor.x, actor.target.y - actor.y) / SKULLSPEED) | 0);
  actor.momz = (((actor.target.z + (actor.target.height >> 1) - actor.z) / dist) | 0);
});

// p_enemy.c:1609 — A_BossDeath. When the last boss-class monster on the
// canonical boss level dies, fire the level finale. Covers Doom 1 ExM8,
// Doom 2 MAP07 (Mancubus → tag 666 lower-floor, Arachno → tag 667 raise-
// to-texture), and Ultimate Doom E4M6 / E4M8.
P_RegisterAction('A_BossDeath', (mo) => {
  // Episode/map filter.
  if (gamemode === GameMode_t.commercial) {
    if (gamemap !== 7) return;
    if (mo.type !== MT_FATSO && mo.type !== MT_BABY) return;
  } else {
    switch (gameepisode) {
      case 1:
        if (gamemap !== 8) return;
        if (mo.type !== MT_BRUISER) return;
        break;
      case 2:
        if (gamemap !== 8) return;
        if (mo.type !== MT_CYBORG) return;
        break;
      case 3:
        if (gamemap !== 8) return;
        if (mo.type !== MT_SPIDER) return;
        break;
      case 4:
        if (gamemap === 6) { if (mo.type !== MT_CYBORG) return; }
        else if (gamemap === 8) { if (mo.type !== MT_SPIDER) return; }
        else return;
        break;
      default:
        if (gamemap !== 8) return;
    }
  }

  // At least one player alive.
  let anyAlive = false;
  for (let i = 0; i < players.length; i++) {
    if (playeringame[i] === true && players[i] !== null && players[i] !== undefined && players[i].health > 0) {
      anyAlive = true; break;
    }
  }
  if (anyAlive === false) return;

  // All other monsters of the same type must be dead.
  const cap = globalThis.__doom_thinkercap;
  if (cap !== undefined) {
    let th = cap.next;
    while (th !== cap) {
      if (th.__mobj !== undefined && th.__mobj !== mo && th.__mobj.type === mo.type && th.__mobj.health > 0) return;
      th = th.next;
    }
  }

  // Fire the finale.
  const junk = { tag: 0, sidenum: [-1, -1] };
  if (gamemode === GameMode_t.commercial) {
    if (mo.type === MT_FATSO) {
      junk.tag = 666;
      EV_DoFloor(junk, lowerFloorToLowest);
      return;
    }
    if (mo.type === MT_BABY) {
      junk.tag = 667;
      EV_DoFloor(junk, raiseToTexture);
      return;
    }
  } else if (gameepisode === 1) {
    junk.tag = 666;
    EV_DoFloor(junk, lowerFloorToLowest);
    return;
  } else if (gameepisode === 4) {
    if (gamemap === 6) {
      junk.tag = 666;
      EV_DoDoor(junk, 'blazeOpen');
      return;
    }
    if (gamemap === 8) {
      junk.tag = 666;
      EV_DoFloor(junk, lowerFloorToLowest);
      return;
    }
  }
  // E2M8 / E3M8 / fallthrough — just exit the level.
  if (typeof globalThis.__G_ExitLevel === 'function') globalThis.__G_ExitLevel();
});

// ---------- Doom 2 monster actions ----------
// These monsters/bosses don't appear in Doom 1 shareware but are ported here so
// the action table is complete. Each one is ported directly from
// linuxdoom-1.10/p_enemy.c so a Doom 2 IWAD would play correctly.

const FATSPREAD = 0x08000000; // ANG90/8 = 11.25° (BAM)
const ANG90  = 0x40000000;
const ANG180 = 0x80000000;
const ANG270 = 0xc0000000;

// Revenant (MT_UNDEAD): homing missile + melee.
P_RegisterAction('A_SkelMissile', (a) => {
  if (a.target === null) return;
  faceTarget(a);
  a.z += 16 * 65536;
  const mo = P_SpawnMissile(a, a.target, MT_TRACER);
  a.z -= 16 * 65536;
  if (mo !== null) { mo.x = (mo.x + mo.momx) | 0; mo.y = (mo.y + mo.momy) | 0; mo.tracer = a.target; }
});
P_RegisterAction('A_SkelWhoosh', (a) => { if (a.target === null) return; faceTarget(a); if (_S !== null) _S.S_StartSound(a, 56 /*sfx_skeswg*/); });
P_RegisterAction('A_SkelFist', (a) => {
  if (a.target === null) return;
  faceTarget(a);
  // p_enemy.c uses P_CheckMeleeRange (fixed-point distApprox), not float hypot.
  if (!P_CheckMeleeRange(a)) return;
  if (_S !== null) _S.S_StartSound(a, 53 /*sfx_skepch*/);
  // p_enemy.c A_SkelFist: damage = ((P_Random()%10)+1)*6
  const dmg = (P_Random() % 10 + 1) * 6;
  if (_PInter !== null) _PInter.P_DamageMobj(a.target, a, a, dmg);
});
// p_enemy.c:1019 — TRACEANGLE ~ 11.25° per 4 tics (vanilla update gate).
const TRACEANGLE = 0x0c000000;
P_RegisterAction('A_Tracer', (actor) => {
  // Vanilla updates every 4 tics — gametic & 3 returns true 3 of 4 tics.
  if ((gametic & 3) !== 0) return;

  // Spawn a puff of smoke at the missile head and a tracer-smoke trail behind.
  P_SpawnPuff(actor.x, actor.y, actor.z);
  const th = P_SpawnMobj(actor.x - actor.momx, actor.y - actor.momy, actor.z, 7 /*MT_SMOKE*/);
  if (th !== null && th !== undefined) {
    th.momz = 65536; // FRACUNIT
    th.tics -= P_Random() & 3;
    if (th.tics < 1) th.tics = 1;
  }

  const dest = actor.tracer;
  if (dest === null || dest === undefined) return;
  if (dest.health <= 0) return;

  // Adjust angle toward the target using R_PointToAngle2 + tantoangle so the
  // homing curve is demo-deterministic. Compare with the unsigned-32 wrap
  // trick from the C source: if exact-angle > 0x80000000, the short way is
  // backward (decrement); else forward.
  const exact = R_PointToAngle2(actor.x, actor.y, dest.x, dest.y) >>> 0;
  if (exact !== actor.angle) {
    if (((exact - actor.angle) >>> 0) > 0x80000000) {
      actor.angle = (actor.angle - TRACEANGLE) >>> 0;
      if (((exact - actor.angle) >>> 0) < 0x80000000) actor.angle = exact;
    } else {
      actor.angle = (actor.angle + TRACEANGLE) >>> 0;
      if (((exact - actor.angle) >>> 0) > 0x80000000) actor.angle = exact;
    }
  }

  const fa = (actor.angle >>> ANGLETOFINESHIFT) & FINEMASK;
  actor.momx = ((actor.info.speed * finecosine[fa]) / 65536) | 0;
  actor.momy = ((actor.info.speed * finesine[fa])   / 65536) | 0;

  // Change slope (vertical homing).
  let dist = distApprox(dest.x - actor.x, dest.y - actor.y);
  dist = (dist / actor.info.speed) | 0;
  if (dist < 1) dist = 1;
  const slope = ((dest.z + 40 * 65536 - actor.z) / dist) | 0;
  if (slope < actor.momz) actor.momz -= 65536 / 8;
  else                    actor.momz += 65536 / 8;
});

// Mancubus (MT_FATSO).
P_RegisterAction('A_FatRaise', (a) => { faceTarget(a); if (_S !== null) _S.S_StartSound(a, 99 /*sfx_manatk*/); });
function fatFire(a, spread) {
  const mo = P_SpawnMissile(a, a.target, MT_FATSHOT);
  if (mo === null) return;
  mo.angle = (mo.angle + spread) >>> 0;
  const fa = (mo.angle >>> ANGLETOFINESHIFT) & FINEMASK;
  mo.momx = ((mo.info.speed * finecosine[fa]) / 65536) | 0;
  mo.momy = ((mo.info.speed * finesine[fa])   / 65536) | 0;
}
P_RegisterAction('A_FatAttack1', (a) => {
  if (a.target === null) return;
  faceTarget(a);
  a.angle = (a.angle + FATSPREAD) >>> 0;
  P_SpawnMissile(a, a.target, MT_FATSHOT);
  fatFire(a, FATSPREAD);
});
P_RegisterAction('A_FatAttack2', (a) => {
  if (a.target === null) return;
  faceTarget(a);
  a.angle = (a.angle - FATSPREAD) >>> 0;
  P_SpawnMissile(a, a.target, MT_FATSHOT);
  fatFire(a, -FATSPREAD * 2);
});
P_RegisterAction('A_FatAttack3', (a) => {
  if (a.target === null) return;
  faceTarget(a);
  fatFire(a, -FATSPREAD / 2);
  fatFire(a,  FATSPREAD / 2);
});

// Arachnotron (MT_BABY) + footstep.
P_RegisterAction('A_BspiAttack', (a) => {
  if (a.target === null) return;
  faceTarget(a);
  P_SpawnMissile(a, a.target, MT_ARACHPLAZ);
});
P_RegisterAction('A_BabyMetal', (a) => {
  if (_S !== null) _S.S_StartSound(a, 79 /*sfx_bspwlk*/);
  actionRegistry['A_Chase']?.(a);
});

// Cyberdemon footsteps.
P_RegisterAction('A_Hoof', (a) => {
  if (_S !== null) _S.S_StartSound(a, 84 /*sfx_hoof*/);
  actionRegistry['A_Chase']?.(a);
});
P_RegisterAction('A_Metal', (a) => {
  if (_S !== null) _S.S_StartSound(a, 85 /*sfx_metal*/);
  actionRegistry['A_Chase']?.(a);
});

// p_enemy.c A_CyberAttack — Cyberdemon fires a rocket.
P_RegisterAction('A_CyberAttack', (a) => {
  if (a.target === null) return;
  faceTarget(a);
  P_SpawnMissile(a, a.target, MT_ROCKET);
});

// p_enemy.c A_Explode — radius attack 128 damage at thingy's position.
P_RegisterAction('A_Explode', (thingy) => {
  if (_PMap !== null && typeof _PMap.P_RadiusAttack === 'function') {
    _PMap.P_RadiusAttack(thingy, thingy.target, 128);
  }
});

// Spider Mastermind refire — like A_CPosRefire with looser threshold.
P_RegisterAction('A_SpidRefire', (a) => {
  faceTarget(a);
  // p_enemy.c A_SpidRefire: 10/256 chance to keep firing.
  if (P_Random() < 10) return;
  if (a.target === null || a.target.health <= 0 || !P_CheckSight(a, a.target)) {
    P_SetMobjState(a, a.info.seestate);
  }
});

// Pain Elemental — spawns Lost Souls. Uses the same A_SkullAttack we ported earlier.
function painShootSkull(actor, angle) {
  const cap = globalThis.__doom_thinkercap;
  let count = 0;
  if (cap) { let th = cap.next; while (th !== cap) { if (th.__mobj && th.__mobj.type === MT_SKULL) count++; th = th.next; } }
  if (count > 20) return;
  const an = (angle >>> ANGLETOFINESHIFT) & FINEMASK;
  const skullInfo = mobjinfo[MT_SKULL];
  const prestep = 4 * 65536 + (3 * (actor.info.radius + skullInfo.radius) / 2);
  const x = (actor.x + ((prestep * finecosine[an]) / 65536)) | 0;
  const y = (actor.y + ((prestep * finesine[an])   / 65536)) | 0;
  const z = actor.z + 8 * 65536;
  // Spawn via global hook (we don't import p_mobj for full P_SpawnMobj).
  if (typeof globalThis.__P_SpawnMobj === 'function') {
    const sk = globalThis.__P_SpawnMobj(x, y, z, MT_SKULL);
    if (sk !== null) {
      // p_enemy.c:1496 — if the new skull doesn't fit, kill it for 10000 damage.
      if (_PMap !== null && typeof _PMap.P_TryMove === 'function') {
        if (!_PMap.P_TryMove(sk, sk.x, sk.y)) {
          if (_PInter !== null && typeof _PInter.P_DamageMobj === 'function') {
            _PInter.P_DamageMobj(sk, actor, actor, 10000);
          }
          return;
        }
      }
      sk.target = actor.target;
      actionRegistry['A_SkullAttack']?.(sk);
    }
  }
}
P_RegisterAction('A_PainAttack', (a) => {
  if (a.target === null) return;
  faceTarget(a);
  painShootSkull(a, a.angle);
});
P_RegisterAction('A_PainDie', (a) => {
  a.flags &= ~MF_SOLID; // A_Fall
  painShootSkull(a, (a.angle + ANG90)  >>> 0);
  painShootSkull(a, (a.angle + ANG180) >>> 0);
  painShootSkull(a, (a.angle + ANG270) >>> 0);
});
// Arch-vile (MT_VILE) corpse-raise scan. PIT_VileCheck communicates its hit
// back through these module-scope statics, mirroring p_enemy.c's globals.
const VILE_MAXRADIUS = 32 * 65536;   // p_local.h MAXRADIUS
const VILE_MAPBLOCKSHIFT = 23;       // FRACBITS + 7
let _viletryx = 0, _viletryy = 0, _corpsehit = null;

// p_enemy.c:PIT_VileCheck — true to keep scanning, false when a raisable
// corpse is found (and stored in _corpsehit).
function PIT_VileCheck(thing) {
  if ((thing.flags & MF_CORPSE) === 0) return true;          // not a monster
  if (thing.tics !== -1) return true;                        // not lying still
  if (thing.info.raisestate === 0 /*S_NULL*/) return true;   // no raise state
  const maxdist = thing.info.radius + mobjinfo[MT_VILE].radius;
  if (Math.abs(thing.x - _viletryx) > maxdist ||
      Math.abs(thing.y - _viletryy) > maxdist) return true;  // not touching
  _corpsehit = thing;
  _corpsehit.momx = _corpsehit.momy = 0;
  _corpsehit.height <<= 2;
  const check = P_CheckPosition(_corpsehit, _corpsehit.x, _corpsehit.y);
  _corpsehit.height >>= 2;
  if (check !== true) return true;                           // doesn't fit
  return false;                                              // got one
}

// p_enemy.c:A_VileChase — scan for a corpse to resurrect; otherwise chase.
P_RegisterAction('A_VileChase', (actor) => {
  if (actor.movedir !== 8 /*DI_NODIR*/) {
    const speed = actor.info.speed;
    _viletryx = (actor.x + speed * xspeed[actor.movedir]) | 0;
    _viletryy = (actor.y + speed * yspeed[actor.movedir]) | 0;
    const xl = (_viletryx - bmaporgx - VILE_MAXRADIUS * 2) >> VILE_MAPBLOCKSHIFT;
    const xh = (_viletryx - bmaporgx + VILE_MAXRADIUS * 2) >> VILE_MAPBLOCKSHIFT;
    const yl = (_viletryy - bmaporgy - VILE_MAXRADIUS * 2) >> VILE_MAPBLOCKSHIFT;
    const yh = (_viletryy - bmaporgy + VILE_MAXRADIUS * 2) >> VILE_MAPBLOCKSHIFT;
    for (let bx = xl; bx <= xh; bx++) {
      for (let by = yl; by <= yh; by++) {
        if (P_BlockThingsIterator(bx, by, PIT_VileCheck) === false) {
          // got one — resurrect it.
          const temp = actor.target;
          actor.target = _corpsehit;
          faceTarget(actor);
          actor.target = temp;
          P_SetMobjState(actor, S_VILE_HEAL1);
          if (_S !== null) _S.S_StartSound(_corpsehit, sfx_slop);
          const info = _corpsehit.info;
          P_SetMobjState(_corpsehit, info.raisestate);
          _corpsehit.height <<= 2;
          _corpsehit.flags = info.flags;
          _corpsehit.health = info.spawnhealth;
          _corpsehit.target = null;
          return;
        }
      }
    }
  }
  // Return to normal attack.
  actionRegistry['A_Chase']?.(actor);
});
P_RegisterAction('A_VileStart',   (a) => { if (_S !== null) _S.S_StartSound(a, 54 /*sfx_vilatk*/); });
P_RegisterAction('A_StartFire',   (a) => { if (_S !== null) _S.S_StartSound(a, 92 /*sfx_flamst*/); actionRegistry['A_Fire']?.(a); });
P_RegisterAction('A_FireCrackle', (a) => { if (_S !== null) _S.S_StartSound(a, 91 /*sfx_flame*/);  actionRegistry['A_Fire']?.(a); });
P_RegisterAction('A_Fire', (a) => {
  const dest = a.tracer;
  if (dest === null || dest === undefined) return;
  if (a.target === null || !P_CheckSight(a.target, dest)) return;
  const fa = (dest.angle >>> ANGLETOFINESHIFT) & FINEMASK;
  a.x = (dest.x + (24 * finecosine[fa])) | 0;
  a.y = (dest.y + (24 * finesine[fa]))   | 0;
  a.z = dest.z;
});
P_RegisterAction('A_VileTarget', (actor) => {
  if (actor.target === null) return;
  faceTarget(actor);
  if (typeof globalThis.__P_SpawnMobj === 'function') {
    const fog = globalThis.__P_SpawnMobj(actor.target.x, actor.target.y, actor.target.z, MT_FIRE);
    if (fog !== null) {
      actor.tracer = fog;
      fog.target = actor;
      fog.tracer = actor.target;
      actionRegistry['A_Fire']?.(fog);
    }
  }
});
P_RegisterAction('A_VileAttack', (actor) => {
  if (actor.target === null) return;
  faceTarget(actor);
  if (!P_CheckSight(actor, actor.target)) return;
  if (_S !== null) _S.S_StartSound(actor, 82 /*sfx_barexp*/);
  if (_PInter !== null) _PInter.P_DamageMobj(actor.target, actor, actor, 20);
  actor.target.momz = ((1000 * 65536) / Math.max(1, actor.target.info.mass)) | 0;
  const an = (actor.angle >>> ANGLETOFINESHIFT) & FINEMASK;
  const fire = actor.tracer;
  if (fire === null || fire === undefined) return;
  fire.x = (actor.target.x - (24 * finecosine[an])) | 0;
  fire.y = (actor.target.y - (24 * finesine[an]))   | 0;
  if (_PMap && _PMap.P_RadiusAttack) _PMap.P_RadiusAttack(fire, actor, 70);
});

// Commander Keen (Doom 2 secret) — same shape as A_BossDeath but opens tag-666 door.
P_RegisterAction('A_KeenDie', (mo) => {
  mo.flags &= ~MF_SOLID; // A_Fall
  const cap = globalThis.__doom_thinkercap;
  if (cap) {
    let th = cap.next;
    while (th !== cap) {
      if (th.__mobj && th.__mobj !== mo && th.__mobj.type === mo.type && th.__mobj.health > 0) return;
      th = th.next;
    }
  }
  // p_enemy.c:A_KeenDie — open every sector tagged 666. Use a synthetic
  // line {tag: 666} so EV_DoDoor's iteration finds the matching sectors.
  EV_DoDoor({ tag: 666, sidenum: [-1, -1] }, 'open');
});

// Icon of Sin (boss brain) — minimum behaviour to play through MAP30.
const _brainState = { targets: [], targetOn: 0, easy: 0 };
P_RegisterAction('A_BrainAwake', (_mo) => {
  _brainState.targets = []; _brainState.targetOn = 0;
  const cap = globalThis.__doom_thinkercap;
  if (cap) {
    let th = cap.next;
    while (th !== cap) {
      if (th.__mobj && th.__mobj.type === MT_BOSSTARGET) _brainState.targets.push(th.__mobj);
      th = th.next;
    }
  }
  if (_S !== null) _S.S_StartSound(null, 96 /*sfx_bossit*/);
});
P_RegisterAction('A_BrainPain',   (_mo) => { if (_S !== null) _S.S_StartSound(null, 97 /*sfx_bospn*/); });
P_RegisterAction('A_BrainScream', (mo) => {
  if (typeof globalThis.__P_SpawnMobj !== 'function') return;
  for (let x = mo.x - 196 * 65536; x < mo.x + 320 * 65536; x += 65536 * 8) {
    const y = mo.y - 320 * 65536;
    const z = 128 + (P_Random() << 1) * 65536;
    const th = globalThis.__P_SpawnMobj(x, y, z, MT_ROCKET);
    if (th !== null) {
      th.momz = P_Random() * 512;
      P_SetMobjState(th, S_BRAINEXPLODE1);
      th.tics -= P_Random() & 7;
      if (th.tics < 1) th.tics = 1;
    }
  }
  if (_S !== null) _S.S_StartSound(null, 98 /*sfx_bosdth*/);
});
P_RegisterAction('A_BrainExplode', (mo) => {
  if (typeof globalThis.__P_SpawnMobj !== 'function') return;
  const x = mo.x + (P_Random() - P_Random()) * 2048;
  const y = mo.y;
  const z = 128 + (P_Random() << 1) * 65536;
  const th = globalThis.__P_SpawnMobj(x, y, z, MT_ROCKET);
  if (th !== null) {
    th.momz = P_Random() * 512;
    // p_enemy.c:1888 — set to S_BRAINEXPLODE1.
    P_SetMobjState(th, S_BRAINEXPLODE1);
    th.tics -= P_Random() & 7;
    if (th.tics < 1) th.tics = 1;
  }
});
P_RegisterAction('A_BrainDie', (_mo) => {
  if (typeof globalThis.__G_ExitLevel === 'function') globalThis.__G_ExitLevel();
});
P_RegisterAction('A_BrainSpit', (mo) => {
  // C (p_enemy.c:1909): toggle then skip on easy/baby unless toggle says fire.
  _brainState.easy ^= 1;
  if (gameskill <= 1 /* sk_easy */ && _brainState.easy === 0) return;
  if (_brainState.targets.length === 0) return;
  const targ = _brainState.targets[_brainState.targetOn];
  _brainState.targetOn = (_brainState.targetOn + 1) % _brainState.targets.length;
  const newmobj = P_SpawnMissile(mo, targ, MT_SPAWNSHOT);
  if (newmobj !== null) {
    newmobj.target = targ;
    // C: newmobj->reactiontime = ((targ->y - mo->y)/newmobj->momy) / newmobj->state->tics;
    // Integer truncation at each step matches C semantics.
    const stTics = states[newmobj.state].tics;
    const tflight = ((targ.y - mo.y) / newmobj.momy) | 0;
    newmobj.reactiontime = (tflight / stTics) | 0;
  }
  if (_S !== null) _S.S_StartSound(null, 94 /*sfx_bospit*/);
});
P_RegisterAction('A_SpawnFly', (mo) => {
  // C: `if (--mo->reactiontime) return;` — returns on any nonzero result.
  if (--mo.reactiontime !== 0) return;
  const targ = mo.target;
  if (targ === null || targ === undefined) return;

  // First spawn teleport fog at the destination.
  const fog = P_SpawnMobj(targ.x, targ.y, targ.z, MT_SPAWNFIRE);
  if (fog !== null && fog !== undefined && _S !== null) _S.S_StartSound(fog, 35 /*sfx_telept*/);

  // Random monster selection with the C probability distribution.
  const r = P_Random();
  let type;
  if      (r < 50)  type = MT_TROOP;
  else if (r < 90)  type = MT_SERGEANT;
  else if (r < 120) type = MT_SHADOWS;
  else if (r < 130) type = MT_PAIN;
  else if (r < 160) type = MT_HEAD;
  else if (r < 162) type = MT_VILE;
  else if (r < 172) type = MT_UNDEAD;
  else if (r < 192) type = MT_BABY;
  else if (r < 222) type = MT_FATSO;
  else if (r < 246) type = MT_KNIGHT;
  else              type = MT_BRUISER;

  const newmobj = P_SpawnMobj(targ.x, targ.y, targ.z, type);
  if (newmobj !== null && newmobj !== undefined) {
    if (P_LookForPlayers(newmobj, true) === true) {
      P_SetMobjState(newmobj, newmobj.info.seestate);
    }
    // Telefrag anything occupying the destination.
    P_TeleportMove(newmobj, newmobj.x, newmobj.y);
  }

  // Remove the cube.
  P_RemoveMobj(mo);
});
P_RegisterAction('A_SpawnSound', (mo) => {
  if (_S !== null) _S.S_StartSound(mo, 95 /*sfx_boscub*/);
  actionRegistry['A_SpawnFly']?.(mo);
});
