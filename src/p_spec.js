// Ported from: linuxdoom-1.10/p_spec.c
// Line specials dispatcher (manual-use, walk-over, shoot, retrigger variants).

import { EV_VerticalDoor, EV_DoDoor, EV_DoLockedDoor,
         P_SpawnDoorCloseIn30, P_SpawnDoorRaiseIn5Mins } from './p_doors.js';
import { EV_DoFloor, EV_BuildStairs, EV_RaiseDonut,
         lowerFloor, lowerFloorToLowest, turboLower, raiseFloor, raiseFloorToNearest,
         raiseFloor24, raiseFloor24AndChange, raiseFloor512, raiseFloorTurbo,
         raiseToTexture, lowerAndChange, raiseFloorCrush,
         build8, turbo16 } from './p_floor.js';
import { EV_DoPlat, EV_StopPlat,
         downWaitUpStay, blazeDWUS, raiseAndChange, perpetualRaise,
         raiseToNearestAndChange } from './p_plats.js';
import { EV_DoCeiling, EV_CeilingCrushStop,
         lowerToFloor, raiseToHighest, lowerAndCrush, crushAndRaise,
         fastCrushAndRaise, silentCrushAndRaise } from './p_ceilng.js';
import { EV_Teleport } from './p_telept.js';
import { EV_LightTurnOn, EV_StartLightStrobing, EV_TurnTagLightsOff } from './p_lights.js';

import { sectors, numsectors, lines, numlines } from './p_setup.js';
import { P_Random } from './m_random.js';
import * as doomstat from './doomstat.js';

export function P_InitPicAnims() {
  // Real animdef list lives in r_data.js as R_InitDefaultAnims().
}

// At level load, give each special-sector spawn its thinker (light flashes
// etc.) and initialise switches/buttons.
let _PLights = null;
export function P_SpecSetExternals(refs) { if (refs.PLights) _PLights = refs.PLights; }

export function P_SpawnSpecials() {
  for (let i = 0; i < numsectors; i++) {
    const sec = sectors[i];
    if (sec.special === 0) continue;
    switch (sec.special) {
      case 1:  if (_PLights !== null) _PLights.P_SpawnLightFlash(sec); break;
      case 2:  if (_PLights !== null) _PLights.P_SpawnStrobeFlash(sec, 15 /*FASTDARK*/, 0); break;
      case 3:  if (_PLights !== null) _PLights.P_SpawnStrobeFlash(sec, 35 /*SLOWDARK*/, 0); break;
      case 4:
        // p_spec.c: STROBE FAST/DEATH SLIME — spawn strobe but KEEP special==4.
        if (_PLights !== null) _PLights.P_SpawnStrobeFlash(sec, 15, 0);
        sec.special = 4;
        break;
      case 8:  if (_PLights !== null) _PLights.P_SpawnGlowingLight(sec); break;
      case 9:
        // SECRET SECTOR
        doomstat.set_totalsecret(doomstat.totalsecret + 1);
        break;
      case 10: P_SpawnDoorCloseIn30(sec); break;
      case 12: if (_PLights !== null) _PLights.P_SpawnStrobeFlash(sec, 35, 1); break;
      case 13: if (_PLights !== null) _PLights.P_SpawnStrobeFlash(sec, 15, 1); break;
      case 14: P_SpawnDoorRaiseIn5Mins(sec); break;
      case 17: if (_PLights !== null) _PLights.P_SpawnFireFlicker(sec); break;
      // Damage floors (5/7/16/etc.) are handled in P_PlayerInSpecialSector.
      default: break;
    }
  }
}

// Per-tic update — drive switch button countdowns.
let _PSwitch = null;
export function P_SpecSetSwitch(refs) { if (refs.PSwitch) _PSwitch = refs.PSwitch; }
export function P_UpdateSpecials() {
  if (_PSwitch !== null && typeof _PSwitch.P_UpdateButtons === 'function') _PSwitch.P_UpdateButtons();
}

// Nightmare item respawn is owned by p_mobj.js — re-export here for callers
// that follow the C ABI.
export function P_RespawnSpecials() { /* implemented in p_mobj.js — see P_RespawnSpecials there */ }

// p_spec.c:1006 — P_PlayerInSpecialSector. Ironfeet (radsuit) shrugs off the
// nukage/slime hits; super-hellslime gets through 5/256 of the time anyway.
export function P_PlayerInSpecialSector(player) {
  if (player.mo === null || player.mo.subsector === null) return;
  const sector = player.mo.subsector.sector;
  if (player.mo.z !== sector.floorheight) return;
  const leveltime = doomstat.leveltime | 0;
  const hasSuit  = player.powers[3 /*pw_ironfeet*/] !== 0;
  switch (sector.special) {
    case 5:
      if (!hasSuit && (leveltime & 0x1f) === 0 && _PMap_dmg !== null) {
        _PMap_dmg.P_DamageMobj(player.mo, null, null, 10);
      }
      break;
    case 7:
      if (!hasSuit && (leveltime & 0x1f) === 0 && _PMap_dmg !== null) {
        _PMap_dmg.P_DamageMobj(player.mo, null, null, 5);
      }
      break;
    case 16:
    case 4:
      if ((!hasSuit || P_Random() < 5) && (leveltime & 0x1f) === 0 && _PMap_dmg !== null) {
        _PMap_dmg.P_DamageMobj(player.mo, null, null, 20);
      }
      break;
    case 9:
      player.secretcount++;
      sector.special = 0;
      break;
    case 11:
      player.cheats &= ~2 /*CF_GODMODE*/;
      if ((leveltime & 0x1f) === 0 && _PMap_dmg !== null) {
        _PMap_dmg.P_DamageMobj(player.mo, null, null, 20);
      }
      if (player.health <= 10 && globalThis.__G_ExitLevel !== undefined) globalThis.__G_ExitLevel();
      break;
  }
}

let _PMap_dmg = null;
export function P_SpecSetInter(refs) { if (refs.PInter) _PMap_dmg = refs.PInter; }

// Gun-shoot triggered line specials (G1/GR — types 24, 46, 47).
export function P_ShootSpecialLine(thing, line) {
  // C: non-player impacts only allowed for special 46 (open door).
  if (thing.player === null) {
    if (line.special !== 46) return;
  }
  switch (line.special) {
    case 24: // RAISE FLOOR (S1)
      EV_DoFloor(line, raiseFloor);
      _PCST(line, 0);
      break;
    case 46: // OPEN DOOR (GR — retriggerable, useAgain=1)
      EV_DoDoor(line, 'open');
      _PCST(line, 1);
      break;
    case 47: // RAISE FLOOR NEAR AND CHANGE (S1)
      EV_DoPlat(line, raiseToNearestAndChange, 0);
      _PCST(line, 0);
      break;
  }
}

// EV_DoDonut — vanilla line-special 9. Outer sector (s2) rises to inner sector
// (s3)'s floor height, while the inner sector (s1) drops to the same height.
export function EV_DoDonut(line) {
  let rtn = 0;
  let secnum = -1;
  while ((secnum = P_FindSectorFromLineTag(line, secnum)) >= 0) {
    const s1 = sectors[secnum];
    if (s1.specialdata !== null) continue;
    rtn = 1;
    // s2 is the sector across the first linedef.
    const ld0 = s1.lines[0];
    const s2 = (ld0.frontsector === s1) ? ld0.backsector : ld0.frontsector;
    if (s2 === null) continue;
    for (let i = 0; i < s2.lines.length; i++) {
      const sl = s2.lines[i];
      // Vanilla bug preserved: C's `(!s2->lines[i]->flags & ML_TWOSIDED)` is
      // (!flags) & 4 due to operator precedence, which is almost always 0 —
      // so the two-sided check is effectively disabled. Match that behaviour.
      if (sl.backsector === s1) continue;
      const s3 = sl.backsector;
      if (s3 === null) continue;
      // Spawn rising "slime" floor on s2.
      if (_PFloor !== null && typeof _PFloor.EV_RaiseDonut === 'function') {
        _PFloor.EV_RaiseDonut(s1, s2, s3);
      }
      break;
    }
  }
  return rtn;
}

let _PFloor = null;
export function P_SpecSetFloor(refs) { if (refs.PFloor) _PFloor = refs.PFloor; }

export function P_FindSectorFromLineTag(line, start) {
  for (let i = start + 1; i < numsectors; i++) if (sectors[i].tag === line.tag) return i;
  return -1;
}
export function P_FindLineFromLineTag(line, start) {
  for (let i = start + 1; i < numlines; i++) if (lines[i].tag === line.tag && lines[i] !== line) return i;
  return -1;
}

// p_spec.c:492 — P_CrossSpecialLine. Walk-over (W1/WR) activation. The first
// arg can be either a `line_t` object or an integer line index (vanilla passes
// `line - lines`); we accept both for ABI parity. Non-player movers can only
// trigger a small whitelist.
export function P_CrossSpecialLine(lineOrIdx, side, thing) {
  const line = typeof lineOrIdx === 'number' ? lines[lineOrIdx] : lineOrIdx;
  if (line === undefined || line === null) return;

  // Non-player triggers: only doors / teleports / lifts, and only for
  // non-projectile mobjs.
  if (thing.player === null) {
    // MT_ROCKET=33, MT_PLASMA=34, MT_BFG=35, MT_BRUISERSHOT=16,
    // MT_TROOPSHOT=31, MT_HEADSHOT=32 — these never trigger lines.
    if (thing.type === 33 || thing.type === 34 || thing.type === 35 ||
        thing.type === 16 || thing.type === 31 || thing.type === 32) return;
    switch (line.special) {
      case 4: case 10: case 39: case 88: case 97: case 125: case 126: break;
      default: return;
    }
  }

  // p_spec.c:539-927 — the giant case ladder. W1 specials zero `line.special`
  // after firing so they don't retrigger; WR (72+) leave it untouched.
  switch (line.special) {
    // ----- W1 TRIGGERS -----
    case 2:   EV_DoDoor(line, 'open');                        line.special = 0; break;
    case 3:   EV_DoDoor(line, 'close');                       line.special = 0; break;
    case 4:   EV_DoDoor(line, 'normal');                      line.special = 0; break;
    case 5:   EV_DoFloor(line, raiseFloor);                   line.special = 0; break;
    case 6:   EV_DoCeiling(line, fastCrushAndRaise);          line.special = 0; break;
    case 8:   EV_BuildStairs(line, build8);                   line.special = 0; break;
    case 10:  EV_DoPlat(line, downWaitUpStay, 0);             line.special = 0; break;
    case 12:  EV_LightTurnOn(line, 0);                        line.special = 0; break;
    case 13:  EV_LightTurnOn(line, 255);                      line.special = 0; break;
    case 16:  EV_DoDoor(line, 'close30ThenOpen');             line.special = 0; break;
    case 17:  EV_StartLightStrobing(line);                    line.special = 0; break;
    case 19:  EV_DoFloor(line, lowerFloor);                   line.special = 0; break;
    case 22:  EV_DoPlat(line, raiseToNearestAndChange, 0);    line.special = 0; break;
    case 25:  EV_DoCeiling(line, crushAndRaise);              line.special = 0; break;
    case 30:  EV_DoFloor(line, raiseToTexture);               line.special = 0; break;
    case 35:  EV_LightTurnOn(line, 35);                       line.special = 0; break;
    case 36:  EV_DoFloor(line, turboLower);                   line.special = 0; break;
    case 37:  EV_DoFloor(line, lowerAndChange);               line.special = 0; break;
    case 38:  EV_DoFloor(line, lowerFloorToLowest);           line.special = 0; break;
    case 39:  EV_Teleport(line, side, thing);                 line.special = 0; break;
    case 40:  EV_DoCeiling(line, raiseToHighest);
              EV_DoFloor(line, lowerFloorToLowest);           line.special = 0; break;
    case 44:  EV_DoCeiling(line, lowerAndCrush);              line.special = 0; break;
    case 52:  if (globalThis.__G_ExitLevel) globalThis.__G_ExitLevel(); break;
    case 53:  EV_DoPlat(line, perpetualRaise, 0);             line.special = 0; break;
    case 54:  EV_StopPlat(line);                              line.special = 0; break;
    case 56:  EV_DoFloor(line, raiseFloorCrush);              line.special = 0; break;
    case 57:  EV_CeilingCrushStop(line);                      line.special = 0; break;
    case 58:  EV_DoFloor(line, raiseFloor24);                 line.special = 0; break;
    case 59:  EV_DoFloor(line, raiseFloor24AndChange);        line.special = 0; break;
    case 100: EV_BuildStairs(line, turbo16);                  line.special = 0; break;
    case 104: EV_TurnTagLightsOff(line);                      line.special = 0; break;
    case 108: EV_DoDoor(line, 'blazeRaise');                  line.special = 0; break;
    case 109: EV_DoDoor(line, 'blazeOpen');                   line.special = 0; break;
    case 110: EV_DoDoor(line, 'blazeClose');                  line.special = 0; break;
    case 119: EV_DoFloor(line, raiseFloorToNearest);          line.special = 0; break;
    case 121: EV_DoPlat(line, blazeDWUS, 0);                  line.special = 0; break;
    case 124: if (globalThis.__G_SecretExitLevel) globalThis.__G_SecretExitLevel(); break;
    case 125: if (thing.player === null) { EV_Teleport(line, side, thing); line.special = 0; } break;
    case 130: EV_DoFloor(line, raiseFloorTurbo);              line.special = 0; break;
    case 141: EV_DoCeiling(line, silentCrushAndRaise);        line.special = 0; break;
    // ----- WR RETRIGGERS -----
    case 72:  EV_DoCeiling(line, lowerAndCrush);  break;
    case 73:  EV_DoCeiling(line, crushAndRaise);  break;
    case 74:  EV_CeilingCrushStop(line); break;
    case 75:  EV_DoDoor(line, 'close');           break;
    case 76:  EV_DoDoor(line, 'close30ThenOpen'); break;
    case 77:  EV_DoCeiling(line, fastCrushAndRaise); break;
    case 79:  EV_LightTurnOn(line, 35);  break;
    case 80:  EV_LightTurnOn(line, 0);   break;
    case 81:  EV_LightTurnOn(line, 255); break;
    case 82:  EV_DoFloor(line, lowerFloorToLowest); break;
    case 83:  EV_DoFloor(line, lowerFloor);         break;
    case 84:  EV_DoFloor(line, lowerAndChange);     break;
    case 86:  EV_DoDoor(line, 'open');              break;
    case 87:  EV_DoPlat(line, perpetualRaise, 0);   break;
    case 88:  EV_DoPlat(line, downWaitUpStay, 0);   break;
    case 89:  EV_StopPlat(line);                    break;
    case 90:  EV_DoDoor(line, 'normal');            break;
    case 91:  EV_DoFloor(line, raiseFloor);         break;
    case 92:  EV_DoFloor(line, raiseFloor24);       break;
    case 93:  EV_DoFloor(line, raiseFloor24AndChange); break;
    case 94:  EV_DoFloor(line, raiseFloorCrush);    break;
    case 95:  EV_DoPlat(line, raiseToNearestAndChange, 0); break;
    case 96:  EV_DoFloor(line, raiseToTexture);     break;
    case 97:  EV_Teleport(line, side, thing);       break;
    case 98:  EV_DoFloor(line, turboLower); break;
    case 105: EV_DoDoor(line, 'blazeRaise');  break;
    case 106: EV_DoDoor(line, 'blazeOpen');   break;
    case 107: EV_DoDoor(line, 'blazeClose');  break;
    case 120: EV_DoPlat(line, blazeDWUS, 0);  break;
    case 126: if (thing.player === null) EV_Teleport(line, side, thing); break;
    case 128: EV_DoFloor(line, raiseFloorToNearest); break;
    case 129: EV_DoFloor(line, raiseFloorTurbo);     break;
  }
}

// p_switch.c:276 — P_UseSpecialLine. Switch / manual activation. Switches call
// P_ChangeSwitchTexture(line, useAgain) so the texture flips and (for S1) the
// special is consumed.
import { P_ChangeSwitchTexture as _PCST } from './p_switch.js';
const ML_SECRET = 0x20;
export function P_UseSpecialLine(thing, line, side) {
  // Back sides of lines are only usable for special 124 (unused slide door).
  if (side !== 0) {
    if (line.special !== 124) return false;
  }
  // Non-player triggers: never open secret doors, and only a handful of
  // manual / locked manual doors are allowed.
  if (thing.player === null) {
    if ((line.flags & ML_SECRET) !== 0) return false;
    switch (line.special) {
      case 1: case 32: case 33: case 34: break;
      default: return false;
    }
  }
  switch (line.special) {
    // ---- Manual doors (D1 / DR) ----
    case 1: case 26: case 27: case 28:
    case 31: case 32: case 33: case 34:
    case 117: case 118:
      EV_VerticalDoor(line, thing); break;
    // ---- S1 (one-shot switch) — fire effect, P_ChangeSwitchTexture(line,0) ----
    case 7:  if (EV_BuildStairs(line, build8)               !== 0) _PCST(line, 0); break;
    case 9:  if (EV_DoDonut(line)                            !== 0) _PCST(line, 0); break;
    case 11: _PCST(line, 0);
             if (globalThis.__G_ExitLevel) globalThis.__G_ExitLevel(); break;
    case 14: if (EV_DoPlat (line, raiseAndChange, 32)        !== 0) _PCST(line, 0); break;
    case 15: if (EV_DoPlat (line, raiseAndChange, 24)        !== 0) _PCST(line, 0); break;
    case 18: if (EV_DoFloor(line, raiseFloorToNearest)       !== 0) _PCST(line, 0); break;
    case 20: if (EV_DoPlat (line, raiseToNearestAndChange,0) !== 0) _PCST(line, 0); break;
    case 21: if (EV_DoPlat (line, downWaitUpStay, 0)         !== 0) _PCST(line, 0); break;
    case 23: if (EV_DoFloor(line, lowerFloorToLowest)        !== 0) _PCST(line, 0); break;
    case 29: if (EV_DoDoor (line, 'normal')                  !== 0) _PCST(line, 0); break;
    case 41: if (EV_DoCeiling(line, lowerToFloor)            !== 0) _PCST(line, 0); break;
    case 49: if (EV_DoCeiling(line, crushAndRaise)           !== 0) _PCST(line, 0); break;
    case 50: if (EV_DoDoor (line, 'close')                   !== 0) _PCST(line, 0); break;
    case 51: _PCST(line, 0);
             if (globalThis.__G_SecretExitLevel) globalThis.__G_SecretExitLevel(); break;
    case 55: if (EV_DoFloor(line, raiseFloorCrush)           !== 0) _PCST(line, 0); break;
    case 71: if (EV_DoFloor(line, turboLower)                !== 0) _PCST(line, 0); break;
    case 101: if (EV_DoFloor(line, raiseFloor)               !== 0) _PCST(line, 0); break;
    case 102: if (EV_DoFloor(line, lowerFloor)               !== 0) _PCST(line, 0); break;
    case 103: if (EV_DoDoor (line, 'open')                   !== 0) _PCST(line, 0); break;
    case 111: if (EV_DoDoor (line, 'blazeRaise')             !== 0) _PCST(line, 0); break;
    case 112: if (EV_DoDoor (line, 'blazeOpen')              !== 0) _PCST(line, 0); break;
    case 113: if (EV_DoDoor (line, 'blazeClose')             !== 0) _PCST(line, 0); break;
    case 122: if (EV_DoPlat (line, blazeDWUS, 0)             !== 0) _PCST(line, 0); break;
    case 127: if (EV_BuildStairs(line, turbo16)              !== 0) _PCST(line, 0); break;
    case 131: if (EV_DoFloor(line, raiseFloorTurbo)          !== 0) _PCST(line, 0); break;
    case 133: case 135: case 137:
              if (EV_DoLockedDoor(line, 'blazeOpen', thing)  !== 0) _PCST(line, 0); break;
    case 140: if (EV_DoFloor(line, raiseFloor512)            !== 0) _PCST(line, 0); break;
    // ---- SR (retriggerable switch) — P_ChangeSwitchTexture(line,1) ----
    case 42: if (EV_DoDoor (line, 'close')                   !== 0) _PCST(line, 1); break;
    case 43: if (EV_DoCeiling(line, lowerToFloor)            !== 0) _PCST(line, 1); break;
    case 45: if (EV_DoFloor(line, lowerFloor)                !== 0) _PCST(line, 1); break;
    case 60: if (EV_DoFloor(line, lowerFloorToLowest)        !== 0) _PCST(line, 1); break;
    case 61: if (EV_DoDoor (line, 'open')                    !== 0) _PCST(line, 1); break;
    case 62: if (EV_DoPlat (line, downWaitUpStay, 1)         !== 0) _PCST(line, 1); break;
    case 63: if (EV_DoDoor (line, 'normal')                  !== 0) _PCST(line, 1); break;
    case 64: if (EV_DoFloor(line, raiseFloor)                !== 0) _PCST(line, 1); break;
    case 65: if (EV_DoFloor(line, raiseFloorCrush)           !== 0) _PCST(line, 1); break;
    case 66: if (EV_DoPlat (line, raiseAndChange, 24)        !== 0) _PCST(line, 1); break;
    case 67: if (EV_DoPlat (line, raiseAndChange, 32)        !== 0) _PCST(line, 1); break;
    case 68: if (EV_DoPlat (line, raiseToNearestAndChange,0) !== 0) _PCST(line, 1); break;
    case 69: if (EV_DoFloor(line, raiseFloorToNearest)       !== 0) _PCST(line, 1); break;
    case 70: if (EV_DoFloor(line, turboLower)                !== 0) _PCST(line, 1); break;
    case 114: if (EV_DoDoor(line, 'blazeRaise')              !== 0) _PCST(line, 1); break;
    case 115: if (EV_DoDoor(line, 'blazeOpen')               !== 0) _PCST(line, 1); break;
    case 116: if (EV_DoDoor(line, 'blazeClose')              !== 0) _PCST(line, 1); break;
    case 123: if (EV_DoPlat(line, blazeDWUS, 0)              !== 0) _PCST(line, 1); break;
    case 132: if (EV_DoFloor(line, raiseFloorTurbo)          !== 0) _PCST(line, 1); break;
    case 99: case 134: case 136:
              if (EV_DoLockedDoor(line, 'blazeOpen', thing)  !== 0) _PCST(line, 1); break;
    case 138: EV_LightTurnOn(line, 255); _PCST(line, 1); break;
    case 139: EV_LightTurnOn(line, 35);  _PCST(line, 1); break;
    default: return false;
  }
  return true;
}
