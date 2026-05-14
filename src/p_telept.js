// Ported from: linuxdoom-1.10/p_telept.c
// Teleporter: find a TELEPORTMAN mobj in the sector with the matching tag,
// move thing there, spawn fog, set reaction time, play sfx_telept.

import { MF_MISSILE } from './p_mobj.js';
import { sectors, numsectors } from './p_setup.js';
import { MT_TELEPORTMAN, MT_TFOG } from './info.js';
import { ANGLETOFINESHIFT, FINEMASK, finecosine, finesine } from './tables.js';

let _S = null;
let _PMobj = null;
let _PMap = null;
let _thinkercap = null;
export function P_TeleptSetExternals(refs) {
  if (refs.S != null)          _S = refs.S;
  if (refs.PMobj != null)      _PMobj = refs.PMobj;
  if (refs.PMap != null)       _PMap = refs.PMap;
  if (refs.thinkercap != null) _thinkercap = refs.thinkercap;
}

export function EV_Teleport(line, side, thing) {
  if (thing.flags & MF_MISSILE) return 0;
  if (side === 1) return 0;
  if (_thinkercap === null || _PMobj === null) return 0;

  const tag = line.tag;
  for (let i = 0; i < numsectors; i++) {
    if (sectors[i].tag !== tag) continue;
    let cur = _thinkercap.next;
    while (cur !== _thinkercap) {
      const m = cur.__mobj;
      cur = cur.next;
      if (m === undefined) continue;
      if (m.type !== MT_TELEPORTMAN) continue;
      if (m.subsector === null || m.subsector.sector !== sectors[i]) continue;
      const oldx = thing.x, oldy = thing.y, oldz = thing.z;
      if (_PMap !== null && !_PMap.P_TeleportMove(thing, m.x, m.y)) return 0;
      thing.z = thing.floorz;
      if (thing.player !== null) {
        thing.player.viewz = thing.z + thing.player.viewheight;
      }
      // Source fog
      const sourceFog = _PMobj.P_SpawnMobj(oldx, oldy, oldz, MT_TFOG);
      if (_S !== null) _S.S_StartSound(sourceFog, 35 /*sfx_telept*/);
      const an = (m.angle >>> ANGLETOFINESHIFT) & FINEMASK;
      const destFog = _PMobj.P_SpawnMobj(
        (m.x + 20 * finecosine[an]) | 0,
        (m.y + 20 * finesine[an]) | 0,
        thing.z, MT_TFOG);
      if (_S !== null) _S.S_StartSound(destFog, 35);
      if (thing.player !== null) thing.reactiontime = 18;
      thing.angle = m.angle;
      thing.momx = 0; thing.momy = 0; thing.momz = 0;
      return 1;
    }
  }
  return 0;
}
