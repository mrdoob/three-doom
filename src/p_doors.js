// Ported from: linuxdoom-1.10/p_doors.c
// Vertical door state machine. Vanilla door types:
//   normal           — open, wait, close.
//   close            — close.
//   open             — open and stay.
//   close30ThenOpen  — close immediately, wait 30s, open.
//   blazeRaise/blazeOpen/blazeClose — 4x speed.
//   raiseIn5Mins     — wait 5 minutes, then open.

import { sectors, sides, numsectors } from './p_setup.js';
import { T_MovePlane, RESULT_OK, RESULT_CRUSHED, RESULT_PASTDEST } from './p_floor.js';

const FRACUNIT       = 65536;
const VDOORSPEED     = 2 * FRACUNIT;
const VDOORSPEED_BLZ = VDOORSPEED * 4;
const VDOORWAIT      = 150;

// door type codes (vldoor_e)
export const DT_NORMAL          = 0;
export const DT_CLOSE30THENOPEN = 1;
export const DT_CLOSE           = 2;
export const DT_OPEN            = 3;
export const DT_RAISEIN5MINS    = 4;
export const DT_BLAZERAISE      = 5;
export const DT_BLAZEOPEN       = 6;
export const DT_BLAZECLOSE      = 7;

function typeOf(s) {
  switch (s) {
    case 'normal':           return DT_NORMAL;
    case 'close':            return DT_CLOSE;
    case 'open':             return DT_OPEN;
    case 'close30ThenOpen':  return DT_CLOSE30THENOPEN;
    case 'raiseIn5Mins':     return DT_RAISEIN5MINS;
    case 'blazeRaise':       return DT_BLAZERAISE;
    case 'blazeOpen':        return DT_BLAZEOPEN;
    case 'blazeClose':       return DT_BLAZECLOSE;
    default: return typeof s === 'number' ? s : DT_NORMAL;
  }
}

let _R_UpdateSectorPlanes = null;
let _P_AddThinker = null, _P_RemoveThinker = null;
let _S = null;
export function P_DoorsSetExternals(refs) {
  if (refs.R_UpdateSectorPlanes) _R_UpdateSectorPlanes = refs.R_UpdateSectorPlanes;
  if (refs.P_AddThinker)         _P_AddThinker         = refs.P_AddThinker;
  if (refs.P_RemoveThinker)      _P_RemoveThinker      = refs.P_RemoveThinker;
  if (refs.S)                    _S                    = refs.S;
}

// p_doors.c:27 — P_FindLowestCeilingSurrounding.
function P_FindLowestCeilingSurrounding(sec) {
  let h = 0x7fffffff;
  for (const li of sec.lines) {
    let other = null;
    if (li.frontsector === sec && li.backsector !== null) other = li.backsector;
    else if (li.backsector === sec && li.frontsector !== null) other = li.frontsector;
    if (other !== null && other.ceilingheight < h) h = other.ceilingheight;
  }
  return h;
}

// p_doors.c:63 — T_VerticalDoor.
export function T_VerticalDoor(thinker) {
  const door = thinker.__door;
  if (door === undefined) return;
  const sec = door.sector;
  let res;
  switch (door.direction) {
    case 0: // WAITING
      // C: if (!--door->topcountdown)
      if (--door.topcountdown === 0) {
        switch (door.type) {
          case DT_BLAZERAISE:
            door.direction = -1;
            if (_S !== null) _S.S_StartSound(sec.soundorg, 89 /*sfx_bdcls*/);
            break;
          case DT_NORMAL:
            door.direction = -1;
            if (_S !== null) _S.S_StartSound(sec.soundorg, 21 /*sfx_dorcls*/);
            break;
          case DT_CLOSE30THENOPEN:
            door.direction = 1;
            if (_S !== null) _S.S_StartSound(sec.soundorg, 20 /*sfx_doropn*/);
            break;
          default: break;
        }
      }
      break;
    case 2: // INITIAL WAIT (raiseIn5Mins)
      // C: if (!--door->topcountdown)
      if (--door.topcountdown === 0) {
        if (door.type === DT_RAISEIN5MINS) {
          door.direction = 1;
          door.type = DT_NORMAL;
          if (_S !== null) _S.S_StartSound(sec.soundorg, 20 /*sfx_doropn*/);
        }
      }
      break;
    case -1: // CLOSING
      res = T_MovePlane(sec, door.speed, sec.floorheight, false, 1 /*ceiling*/, -1);
      if (res === RESULT_PASTDEST) {
        switch (door.type) {
          case DT_BLAZERAISE: case DT_BLAZECLOSE:
            sec.specialdata = null;
            if (_P_RemoveThinker !== null) _P_RemoveThinker(thinker);
            if (_S !== null) _S.S_StartSound(sec.soundorg, 89 /*sfx_bdcls*/);
            break;
          case DT_NORMAL: case DT_CLOSE:
            sec.specialdata = null;
            if (_P_RemoveThinker !== null) _P_RemoveThinker(thinker);
            break;
          case DT_CLOSE30THENOPEN:
            door.direction = 0;
            door.topcountdown = 35 * 30;
            break;
          default: break;
        }
      } else if (res === RESULT_CRUSHED) {
        switch (door.type) {
          case DT_BLAZECLOSE: case DT_CLOSE: break; // do not retract
          default:
            door.direction = 1;
            if (_S !== null) _S.S_StartSound(sec.soundorg, 20 /*sfx_doropn*/);
            break;
        }
      }
      break;
    case 1: // OPENING
      res = T_MovePlane(sec, door.speed, door.topheight, false, 1, 1);
      if (res === RESULT_PASTDEST) {
        switch (door.type) {
          case DT_BLAZERAISE: case DT_NORMAL:
            door.direction = 0;
            door.topcountdown = door.topwait;
            break;
          case DT_CLOSE30THENOPEN: case DT_BLAZEOPEN: case DT_OPEN:
            sec.specialdata = null;
            if (_P_RemoveThinker !== null) _P_RemoveThinker(thinker);
            break;
          default: break;
        }
      }
      break;
  }
  if (_R_UpdateSectorPlanes !== null) _R_UpdateSectorPlanes(sec);
}

function makeDoor(sec, type) {
  return {
    sector: sec, type, topwait: VDOORWAIT, speed: VDOORSPEED,
    topheight: 0, topcountdown: 0, direction: 0,
  };
}

// p_doors.c:266 — EV_DoDoor.
export function EV_DoDoor(line, typeArg) {
  const t = typeOf(typeArg);
  let rtn = 0;
  for (let i = 0; i < numsectors; i++) {
    const sec = sectors[i];
    if (sec.tag !== line.tag) continue;
    if (sec.specialdata !== null) continue;
    rtn = 1;
    const door = makeDoor(sec, t);
    sec.specialdata = door;
    const thinker = { prev: null, next: null, function: T_VerticalDoor, __door: door };
    switch (t) {
      case DT_BLAZECLOSE:
        door.topheight = P_FindLowestCeilingSurrounding(sec) - 4 * FRACUNIT;
        door.direction = -1;
        door.speed = VDOORSPEED_BLZ;
        if (_S !== null) _S.S_StartSound(sec.soundorg, 89 /*sfx_bdcls*/);
        break;
      case DT_CLOSE:
        door.topheight = P_FindLowestCeilingSurrounding(sec) - 4 * FRACUNIT;
        door.direction = -1;
        if (_S !== null) _S.S_StartSound(sec.soundorg, 21 /*sfx_dorcls*/);
        break;
      case DT_CLOSE30THENOPEN:
        door.topheight = sec.ceilingheight;
        door.direction = -1;
        if (_S !== null) _S.S_StartSound(sec.soundorg, 21 /*sfx_dorcls*/);
        break;
      case DT_BLAZERAISE: case DT_BLAZEOPEN:
        door.direction = 1;
        door.topheight = P_FindLowestCeilingSurrounding(sec) - 4 * FRACUNIT;
        door.speed = VDOORSPEED_BLZ;
        if (door.topheight !== sec.ceilingheight && _S !== null) _S.S_StartSound(sec.soundorg, 88 /*sfx_bdopn*/);
        break;
      case DT_NORMAL: case DT_OPEN:
        door.direction = 1;
        door.topheight = P_FindLowestCeilingSurrounding(sec) - 4 * FRACUNIT;
        if (door.topheight !== sec.ceilingheight && _S !== null) _S.S_StartSound(sec.soundorg, 20 /*sfx_doropn*/);
        break;
    }
    if (_P_AddThinker !== null) _P_AddThinker(thinker);
  }
  return rtn;
}

// p_doors.c:368 — EV_VerticalDoor (manual / locked open).
export function EV_VerticalDoor(line, thing) {
  const player = thing.player;
  // Lock check.
  switch (line.special) {
    case 26: case 32: // Blue
      if (player === null) return;
      if (player.cards[0 /*bluecard*/] !== true && player.cards[3 /*blueskull*/] !== true) {
        player.message = 'You need a blue key to open this door';
        if (_S !== null) _S.S_StartSound(null, 34 /*sfx_oof*/);
        return;
      }
      break;
    case 27: case 34: // Yellow
      if (player === null) return;
      if (player.cards[1 /*yellowcard*/] !== true && player.cards[4 /*yellowskull*/] !== true) {
        player.message = 'You need a yellow key to open this door';
        if (_S !== null) _S.S_StartSound(null, 34 /*sfx_oof*/);
        return;
      }
      break;
    case 28: case 33: // Red
      if (player === null) return;
      if (player.cards[2 /*redcard*/] !== true && player.cards[5 /*redskull*/] !== true) {
        player.message = 'You need a red key to open this door';
        if (_S !== null) _S.S_StartSound(null, 34 /*sfx_oof*/);
        return;
      }
      break;
  }
  // Look up the back-side sector (where the door physically lives).
  if (line.sidenum[1] === -1) return;
  const sec = sides[line.sidenum[1]].sector;
  if (sec === undefined || sec === null) return;
  // If an existing thinker is on this sector, reverse / re-trigger it.
  if (sec.specialdata !== null) {
    const door = sec.specialdata;
    switch (line.special) {
      case 1: case 26: case 27: case 28: case 117:
        if (door.direction === -1) door.direction = 1;
        else {
          if (thing.player === null) return;
          door.direction = -1;
        }
        return;
    }
  }
  // Otherwise spawn a new door. p_doors.c:468-494 — specials 31..34 / 118 are
  // one-shot opens (line.special cleared so they can't re-fire).
  const blazing = (line.special === 117 || line.special === 118);
  if (_S !== null) _S.S_StartSound(sec.soundorg, blazing ? 88 /*sfx_bdopn*/ : 20 /*sfx_doropn*/);
  let type;
  switch (line.special) {
    case 1: case 26: case 27: case 28: type = DT_NORMAL; break;
    case 31: case 32: case 33: case 34: type = DT_OPEN; line.special = 0; break;
    case 117: type = DT_BLAZERAISE; break;
    case 118: type = DT_BLAZEOPEN; line.special = 0; break;
    default:  type = DT_NORMAL; break;
  }
  const door = makeDoor(sec, type);
  door.direction = 1;
  door.speed = blazing ? VDOORSPEED_BLZ : VDOORSPEED;
  door.topheight = P_FindLowestCeilingSurrounding(sec) - 4 * FRACUNIT;
  sec.specialdata = door;
  if (_P_AddThinker !== null) _P_AddThinker({ prev: null, next: null, function: T_VerticalDoor, __door: door });
}

// p_doors.c:202 — EV_DoLockedDoor. Switch-activated locked door (specials 99/133/134/135/136/137).
export function EV_DoLockedDoor(line, typeArg, thing) {
  const player = thing.player;
  if (player === null) return 0;
  switch (line.special) {
    case 99: case 133:
      if (player.cards[0] !== true && player.cards[3] !== true) {
        player.message = 'You need a blue key to open this door';
        if (_S !== null) _S.S_StartSound(null, 34 /*sfx_oof*/);
        return 0;
      }
      break;
    case 134: case 135:
      if (player.cards[2] !== true && player.cards[5] !== true) {
        player.message = 'You need a red key to open this door';
        if (_S !== null) _S.S_StartSound(null, 34 /*sfx_oof*/);
        return 0;
      }
      break;
    case 136: case 137:
      if (player.cards[1] !== true && player.cards[4] !== true) {
        player.message = 'You need a yellow key to open this door';
        if (_S !== null) _S.S_StartSound(null, 34 /*sfx_oof*/);
        return 0;
      }
      break;
  }
  return EV_DoDoor(line, typeArg);
}

// p_doors.c:529 — P_SpawnDoorCloseIn30. Auto-close after 30s (sector special 10).
export function P_SpawnDoorCloseIn30(sec) {
  const door = makeDoor(sec, DT_NORMAL);
  door.direction = 0;
  door.topheight = sec.ceilingheight;
  door.topwait = 35 * 30;
  door.topcountdown = 35 * 30;
  sec.specialdata = door;
  sec.special = 0;
  if (_P_AddThinker !== null) _P_AddThinker({ prev: null, next: null, function: T_VerticalDoor, __door: door });
}

// p_doors.c:553 — P_SpawnDoorRaiseIn5Mins. Wait 5 minutes, then open (sector special 14).
export function P_SpawnDoorRaiseIn5Mins(sec) {
  const door = makeDoor(sec, DT_RAISEIN5MINS);
  door.direction = 2; // initial wait
  door.topheight = P_FindLowestCeilingSurrounding(sec) - 4 * FRACUNIT;
  door.topcountdown = 5 * 60 * 35;
  sec.specialdata = door;
  sec.special = 0;
  if (_P_AddThinker !== null) _P_AddThinker({ prev: null, next: null, function: T_VerticalDoor, __door: door });
}
