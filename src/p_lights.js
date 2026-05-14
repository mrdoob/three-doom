// Ported from: linuxdoom-1.10/p_lights.c
// Sector light effects: flicker, broken-flash, strobe, glow.
//
// The vertex-color light values in r_segs/r_plane are baked at level load,
// so changing sector.lightlevel here doesn't currently propagate to the
// rendered geometry. A follow-up pass should add R_UpdateSectorLight that
// rewrites the color attribute. For now the thinkers update the data structure
// but visual flicker won't appear until that hook is added.

import { sectors, numsectors } from './p_setup.js';
import { P_Random } from './m_random.js';

let _P_AddThinker = null;
let _P_RemoveThinker = null;
let _R_UpdateSectorLight = null;
export function P_LightsSetExternals(refs) {
  if (refs.P_AddThinker)        _P_AddThinker        = refs.P_AddThinker;
  if (refs.P_RemoveThinker)     _P_RemoveThinker     = refs.P_RemoveThinker;
  if (refs.R_UpdateSectorLight) _R_UpdateSectorLight = refs.R_UpdateSectorLight;
}
// Helper called by each tic that mutates sector.lightlevel.
function applyLight(sec) {
  if (_R_UpdateSectorLight !== null) _R_UpdateSectorLight(sec);
}

function P_FindMinSurroundingLight(sec, defaultMin) {
  let min = defaultMin;
  for (const li of sec.lines) {
    let other = null;
    if (li.frontsector === sec && li.backsector !== null) other = li.backsector;
    else if (li.backsector === sec && li.frontsector !== null) other = li.frontsector;
    if (other !== null && other.lightlevel < min) min = other.lightlevel;
  }
  return min;
}

// FireFlicker (sector special 17).
export function T_FireFlicker(thinker) {
  const f = thinker.__flick;
  if (--f.count > 0) return;
  // p_lights.c T_FireFlicker: amount = (P_Random()&3)*16
  const amount = (P_Random() & 3) * 16;
  f.sector.lightlevel = (f.sector.lightlevel - amount < f.minlight) ? f.minlight : (f.maxlight - amount);
  applyLight(f.sector);
  f.count = 4;
}
export function P_SpawnFireFlicker(sector) {
  sector.special = 0;
  const f = { sector, maxlight: sector.lightlevel,
              minlight: P_FindMinSurroundingLight(sector, sector.lightlevel) + 16, count: 4 };
  if (_P_AddThinker !== null) {
    _P_AddThinker({ prev: null, next: null, function: T_FireFlicker, __flick: f });
  }
}

// LightFlash (sector special 1: random flicker).
export function T_LightFlash(thinker) {
  const f = thinker.__flash;
  if (--f.count > 0) return;
  // p_lights.c T_LightFlash: count = (P_Random() & {min,max}time) + 1
  if (f.sector.lightlevel === f.maxlight) {
    f.sector.lightlevel = f.minlight;
    f.count = (P_Random() & f.mintime) + 1;
  } else {
    f.sector.lightlevel = f.maxlight;
    f.count = (P_Random() & f.maxtime) + 1;
  }
  applyLight(f.sector);
}
export function P_SpawnLightFlash(sector) {
  sector.special = 0;
  const f = { sector, maxlight: sector.lightlevel,
              minlight: P_FindMinSurroundingLight(sector, sector.lightlevel),
              maxtime: 64, mintime: 7, count: 0 };
  f.count = (P_Random() & f.maxtime) + 1;
  if (_P_AddThinker !== null) {
    _P_AddThinker({ prev: null, next: null, function: T_LightFlash, __flash: f });
  }
}

// StrobeFlash (sector specials 2, 4, 12, 13).
export const SLOWDARK = 35, FASTDARK = 15, STROBEBRIGHT = 5;
export function T_StrobeFlash(thinker) {
  const f = thinker.__strobe;
  if (--f.count > 0) return;
  if (f.sector.lightlevel === f.minlight) {
    f.sector.lightlevel = f.maxlight; f.count = f.brighttime;
  } else {
    f.sector.lightlevel = f.minlight; f.count = f.darktime;
  }
  applyLight(f.sector);
}
export function P_SpawnStrobeFlash(sector, fastOrSlow, inSync) {
  const f = { sector, brighttime: STROBEBRIGHT, darktime: fastOrSlow,
              maxlight: sector.lightlevel,
              minlight: P_FindMinSurroundingLight(sector, sector.lightlevel),
              count: inSync ? 1 : (P_Random() & 7) + 1 };
  if (f.minlight === f.maxlight) f.minlight = 0;
  sector.special = 0;
  if (_P_AddThinker !== null) {
    _P_AddThinker({ prev: null, next: null, function: T_StrobeFlash, __strobe: f });
  }
}

// Glow (sector special 8).
const GLOWSPEED = 8;
export function T_Glow(thinker) {
  const g = thinker.__glow;
  if (g.direction === -1) {
    g.sector.lightlevel -= GLOWSPEED;
    if (g.sector.lightlevel <= g.minlight) { g.sector.lightlevel += GLOWSPEED; g.direction = 1; }
  } else {
    g.sector.lightlevel += GLOWSPEED;
    if (g.sector.lightlevel >= g.maxlight) { g.sector.lightlevel -= GLOWSPEED; g.direction = -1; }
  }
  applyLight(g.sector);
}
export function P_SpawnGlowingLight(sector) {
  const g = { sector, minlight: P_FindMinSurroundingLight(sector, sector.lightlevel),
              maxlight: sector.lightlevel, direction: -1 };
  sector.special = 0;
  if (_P_AddThinker !== null) {
    _P_AddThinker({ prev: null, next: null, function: T_Glow, __glow: g });
  }
}

// Switch-activated bulk light controls.
export function EV_StartLightStrobing(line) {
  for (let i = 0; i < sectors.length; i++) {
    if (sectors[i].tag !== line.tag) continue;
    if (sectors[i].specialdata !== null) continue;
    P_SpawnStrobeFlash(sectors[i], SLOWDARK, 0);
  }
}
export function EV_TurnTagLightsOff(line) {
  for (let i = 0; i < sectors.length; i++) {
    if (sectors[i].tag !== line.tag) continue;
    let min = sectors[i].lightlevel;
    for (const li of sectors[i].lines) {
      const other = (li.frontsector === sectors[i]) ? li.backsector : li.frontsector;
      if (other !== null && other.lightlevel < min) min = other.lightlevel;
    }
    sectors[i].lightlevel = min;
  }
}
export function EV_LightTurnOn(line, bright) {
  for (let i = 0; i < sectors.length; i++) {
    if (sectors[i].tag !== line.tag) continue;
    let target = bright;
    if (bright === 0) {
      target = 0;
      for (const li of sectors[i].lines) {
        const other = (li.frontsector === sectors[i]) ? li.backsector : li.frontsector;
        if (other !== null && other.lightlevel > target) target = other.lightlevel;
      }
    }
    sectors[i].lightlevel = target;
  }
}
