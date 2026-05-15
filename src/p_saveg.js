// Ported from: linuxdoom-1.10/p_saveg.c
// Save/load game state. The C version writes a packed binary blob; the JS
// port uses JSON in localStorage which is simpler and avoids endian/struct
// alignment problems. Save slots are keyed by "doom:save:N".

import { players, consoleplayer, gameepisode, gamemap, gameskill, leveltime,
         gamemode, set_gameepisode, set_gamemap, set_gameskill, set_leveltime } from './doomstat.js';

// ---------- helpers ----------
function snapshotPlayer(p) {
  return {
    playerstate: p.playerstate,
    health: p.health,
    armorpoints: p.armorpoints,
    armortype:   p.armortype,
    powers:      Array.from(p.powers),
    cards:       Array.from(p.cards),
    backpack:    p.backpack,
    readyweapon: p.readyweapon,
    pendingweapon: p.pendingweapon,
    weaponowned: Array.from(p.weaponowned),
    ammo:        Array.from(p.ammo),
    maxammo:     Array.from(p.maxammo),
    cheats:      p.cheats,
    killcount:   p.killcount,
    itemcount:   p.itemcount,
    secretcount: p.secretcount,
    extralight:  p.extralight,
    fixedcolormap: p.fixedcolormap,
    colormap:    p.colormap,
    mo: p.mo === null ? null : {
      x: p.mo.x, y: p.mo.y, z: p.mo.z,
      angle: p.mo.angle, momx: p.mo.momx, momy: p.mo.momy, momz: p.mo.momz,
      health: p.mo.health, type: p.mo.type, state: p.mo.state, flags: p.mo.flags,
    },
  };
}

function restorePlayer(p, snap) {
  if (snap === undefined || snap === null) return;
  p.playerstate = snap.playerstate;
  p.health = snap.health;
  p.armorpoints = snap.armorpoints;
  p.armortype = snap.armortype;
  for (let i = 0; i < 6; i++) p.powers[i] = snap.powers[i];
  for (let i = 0; i < 6; i++) p.cards[i]  = snap.cards[i];
  p.backpack    = snap.backpack;
  p.readyweapon = snap.readyweapon;
  p.pendingweapon = snap.pendingweapon;
  for (let i = 0; i < 9; i++) p.weaponowned[i] = snap.weaponowned[i];
  for (let i = 0; i < 4; i++) { p.ammo[i] = snap.ammo[i]; p.maxammo[i] = snap.maxammo[i]; }
  p.cheats = snap.cheats;
  p.killcount   = snap.killcount;
  p.itemcount   = snap.itemcount;
  p.secretcount = snap.secretcount;
  p.extralight  = snap.extralight;
  if (snap.fixedcolormap !== undefined) p.fixedcolormap = snap.fixedcolormap;
  if (snap.colormap !== undefined)      p.colormap      = snap.colormap;
  if (p.mo !== null && snap.mo !== null) {
    p.mo.x = snap.mo.x; p.mo.y = snap.mo.y; p.mo.z = snap.mo.z;
    p.mo.angle = snap.mo.angle;
    p.mo.momx  = snap.mo.momx; p.mo.momy = snap.mo.momy; p.mo.momz = snap.mo.momz;
    p.mo.health = snap.mo.health;
    p.mo.flags  = snap.mo.flags;
  }
}

// ---------- public API (mirrors P_ArchivePlayers / etc.) ----------

export let save_p = 0;

export function P_ArchivePlayers() {
  const out = [];
  for (let i = 0; i < players.length; i++) {
    out.push(players[i] === undefined ? null : snapshotPlayer(players[i]));
  }
  return out;
}
export function P_UnArchivePlayers(arr) {
  if (arr === undefined || arr === null) return;
  for (let i = 0; i < arr.length && i < players.length; i++) {
    if (players[i] !== undefined && arr[i] !== null) restorePlayer(players[i], arr[i]);
  }
}

// p_saveg.c:P_ArchiveWorld — sectors, lines, sides. Vanilla also serialises:
//   sector: floorheight, ceilingheight, floorpic, ceilingpic, lightlevel,
//           special, tag
//   line:   flags, special, tag
//   side:   textureoffset, rowoffset, toptexture, bottomtexture, midtexture
// We must capture all of these so switches don't reset, scrolling textures
// preserve their offsets, and triggered specials remember they're consumed.
export function P_ArchiveWorld() {
  const ps = imp_sectors();
  const ls = imp_lines();
  const sd = imp_sides();
  const sectors = [];
  for (const s of ps) sectors.push({
    fh: s.floorheight, ch: s.ceilingheight,
    fp: s.floorpic,    cp: s.ceilingpic,
    ll: s.lightlevel,  sp: s.special, tg: s.tag,
  });
  const lines = [];
  for (const l of ls) lines.push({ fl: l.flags, sp: l.special, tg: l.tag });
  const sides = [];
  for (const s of sd) sides.push({
    tx: s.textureoffset, ry: s.rowoffset,
    tt: s.toptexture,    bt: s.bottomtexture, mt: s.midtexture,
  });
  return { sectors, lines, sides };
}
export function P_UnArchiveWorld(blob) {
  if (blob === undefined || blob === null) return;
  // Back-compat: previous serialisation was a flat sectors array.
  const sectorArr = Array.isArray(blob) ? blob : blob.sectors;
  const lineArr   = Array.isArray(blob) ? null : blob.lines;
  const sideArr   = Array.isArray(blob) ? null : blob.sides;
  const ps = imp_sectors();
  if (sectorArr !== undefined && sectorArr !== null) {
    for (let i = 0; i < sectorArr.length && i < ps.length; i++) {
      const a = sectorArr[i];
      ps[i].floorheight   = a.fh;
      ps[i].ceilingheight = a.ch;
      if (a.fp !== undefined) ps[i].floorpic   = a.fp;
      if (a.cp !== undefined) ps[i].ceilingpic = a.cp;
      ps[i].lightlevel = a.ll;
      ps[i].special    = a.sp;
      ps[i].tag        = a.tg;
      // p_saveg.c:188 — clear transient runtime back-links.
      ps[i].specialdata = null;
      ps[i].soundtarget = null;
    }
  }
  if (lineArr !== null && lineArr !== undefined) {
    const ls = imp_lines();
    for (let i = 0; i < lineArr.length && i < ls.length; i++) {
      ls[i].flags   = lineArr[i].fl;
      ls[i].special = lineArr[i].sp;
      ls[i].tag     = lineArr[i].tg;
    }
  }
  if (sideArr !== null && sideArr !== undefined) {
    const sd = imp_sides();
    for (let i = 0; i < sideArr.length && i < sd.length; i++) {
      sd[i].textureoffset = sideArr[i].tx;
      sd[i].rowoffset     = sideArr[i].ry;
      sd[i].toptexture    = sideArr[i].tt;
      sd[i].bottomtexture = sideArr[i].bt;
      sd[i].midtexture    = sideArr[i].mt;
    }
  }
}

function imp_sectors() { return globalThis.__doom_sectors || []; }
function imp_lines()   { return globalThis.__doom_lines   || []; }
function imp_sides()   { return globalThis.__doom_sides   || []; }

// Thinkers — snapshot every live mobj (position, angle, momentum, state, type,
// flags, health, target). On restore, the caller is expected to first call
// P_SetupLevel(episode, map) which wipes the world, then P_UnArchiveThinkers
// re-spawns each mobj via P_SpawnMobj.
export function P_ArchiveThinkers() {
  const out = [];
  const cap = globalThis.__doom_thinkercap;
  if (cap === undefined) return out;
  let cur = cap.next;
  while (cur !== cap) {
    const mo = cur.__mobj;
    if (mo !== undefined) {
      out.push({
        x: mo.x, y: mo.y, z: mo.z,
        angle: mo.angle, momx: mo.momx, momy: mo.momy, momz: mo.momz,
        type: mo.type, state: mo.state, flags: mo.flags,
        health: mo.health, tics: mo.tics,
      });
    }
    cur = cur.next;
  }
  return out;
}
export function P_UnArchiveThinkers(arr) {
  if (arr === undefined || arr === null) return;
  const P_SpawnMobj = globalThis.__P_SpawnMobj;
  if (P_SpawnMobj === undefined) return;
  for (const s of arr) {
    const mo = P_SpawnMobj(s.x, s.y, s.z, s.type);
    mo.angle = s.angle;
    mo.momx = s.momx; mo.momy = s.momy; mo.momz = s.momz;
    mo.flags = s.flags;
    mo.health = s.health; mo.tics = s.tics; mo.state = s.state;
  }
}

// p_saveg.c:355 — P_ArchiveSpecials. Walk the thinker list and snapshot every
// active special (door, lift, ceiling, floor, light flash, strobe, glow,
// fire flicker) with enough state to resume mid-motion on load. The C source
// stores a tag byte + struct dump per entry; we use tagged JSON objects with
// sector index in place of the pointer "swizzle".
//
// Each special hangs off a thinker as one of: __door, __ceiling, __floor,
// __plat, __flash, __strobe, __glow, __flick. We dispatch on whichever is
// present.
function _sectorIndex(sec) {
  const ss = imp_sectors();
  for (let i = 0; i < ss.length; i++) if (ss[i] === sec) return i;
  return -1;
}

export function P_ArchiveSpecials() {
  const out = [];
  const cap = globalThis.__doom_thinkercap;
  if (cap === undefined) return out;
  let cur = cap.next;
  while (cur !== cap) {
    if (cur.__door !== undefined) {
      const d = cur.__door;
      out.push({ k: 'door', s: _sectorIndex(d.sector), type: d.type, topwait: d.topwait,
        speed: d.speed, topheight: d.topheight, topcountdown: d.topcountdown, direction: d.direction });
    } else if (cur.__ceiling !== undefined) {
      const c = cur.__ceiling;
      out.push({ k: 'ceil', s: _sectorIndex(c.sector), type: c.type, speed: c.speed,
        crush: c.crush, topheight: c.topheight, bottomheight: c.bottomheight,
        tag: c.tag, direction: c.direction, olddirection: c.olddirection });
    } else if (cur.__floor !== undefined) {
      const f = cur.__floor;
      out.push({ k: 'floor', s: _sectorIndex(f.sector), type: f.type,
        speed: f.speed, direction: f.direction, crush: f.crush,
        floordestheight: f.floordestheight, newspecial: f.newspecial, texture: f.texture });
    } else if (cur.__plat !== undefined) {
      const p = cur.__plat;
      out.push({ k: 'plat', s: _sectorIndex(p.sector), type: p.type,
        speed: p.speed, low: p.low, high: p.high, wait: p.wait, count: p.count,
        status: p.status, oldstatus: p.oldstatus, crush: p.crush, tag: p.tag });
    } else if (cur.__flash !== undefined) {
      const f = cur.__flash;
      out.push({ k: 'flash', s: _sectorIndex(f.sector), count: f.count,
        maxlight: f.maxlight, minlight: f.minlight, maxtime: f.maxtime, mintime: f.mintime });
    } else if (cur.__strobe !== undefined) {
      const s = cur.__strobe;
      out.push({ k: 'strobe', s: _sectorIndex(s.sector), count: s.count,
        minlight: s.minlight, maxlight: s.maxlight, darktime: s.darktime, brighttime: s.brighttime });
    } else if (cur.__glow !== undefined) {
      const g = cur.__glow;
      out.push({ k: 'glow', s: _sectorIndex(g.sector), minlight: g.minlight,
        maxlight: g.maxlight, direction: g.direction });
    } else if (cur.__flick !== undefined) {
      const f = cur.__flick;
      out.push({ k: 'flick', s: _sectorIndex(f.sector), count: f.count,
        maxlight: f.maxlight, minlight: f.minlight });
    }
    cur = cur.next;
  }
  return out;
}

// p_saveg.c:475 — P_UnArchiveSpecials. Re-spawn each archived thinker
// against the freshly-loaded map, rebinding the sector pointer from index.
// We dynamic-import the special modules to avoid a hard dependency cycle
// with p_doors/p_floor/etc.
export async function P_UnArchiveSpecials(arr) {
  if (arr === undefined || arr === null || arr.length === 0) return;
  const sectors = imp_sectors();
  // Load the modules once.
  const [pDoors, pCeil, pFloor, pPlats, pLights, pTick] = await Promise.all([
    import('./p_doors.js'),  import('./p_ceilng.js'),
    import('./p_floor.js'),  import('./p_plats.js'),
    import('./p_lights.js'), import('./p_tick.js'),
  ]);
  for (const r of arr) {
    if (r.s < 0 || r.s >= sectors.length) continue;
    const sec = sectors[r.s];
    let data, fn, key;
    switch (r.k) {
      case 'door':
        data = { sector: sec, type: r.type, topwait: r.topwait, speed: r.speed,
          topheight: r.topheight, topcountdown: r.topcountdown, direction: r.direction };
        fn = pDoors.T_VerticalDoor; key = '__door'; break;
      case 'ceil':
        data = { sector: sec, type: r.type, speed: r.speed, crush: r.crush,
          topheight: r.topheight, bottomheight: r.bottomheight,
          tag: r.tag, direction: r.direction, olddirection: r.olddirection };
        fn = pCeil.T_MoveCeiling; key = '__ceiling'; break;
      case 'floor':
        data = { sector: sec, type: r.type, speed: r.speed, direction: r.direction,
          crush: r.crush, floordestheight: r.floordestheight,
          newspecial: r.newspecial, texture: r.texture };
        fn = pFloor.T_MoveFloor; key = '__floor'; break;
      case 'plat':
        data = { sector: sec, type: r.type, speed: r.speed, low: r.low, high: r.high,
          wait: r.wait, count: r.count, status: r.status, oldstatus: r.oldstatus,
          crush: r.crush, tag: r.tag };
        fn = pPlats.T_PlatRaise; key = '__plat'; break;
      case 'flash':
        data = { sector: sec, count: r.count, maxlight: r.maxlight, minlight: r.minlight,
          maxtime: r.maxtime, mintime: r.mintime };
        fn = pLights.T_LightFlash; key = '__flash'; break;
      case 'strobe':
        data = { sector: sec, count: r.count, minlight: r.minlight, maxlight: r.maxlight,
          darktime: r.darktime, brighttime: r.brighttime };
        fn = pLights.T_StrobeFlash; key = '__strobe'; break;
      case 'glow':
        data = { sector: sec, minlight: r.minlight, maxlight: r.maxlight, direction: r.direction };
        fn = pLights.T_Glow; key = '__glow'; break;
      case 'flick':
        data = { sector: sec, count: r.count, maxlight: r.maxlight, minlight: r.minlight };
        fn = pLights.T_FireFlicker; key = '__flick'; break;
      default: continue;
    }
    sec.specialdata = data;
    const thinker = { prev: null, next: null, function: fn, [key]: data };
    pTick.P_AddThinker(thinker);
  }
}

// ---------- localStorage save slots ----------

export function P_SaveGame(slot, description) {
  const blob = {
    description: description || `Slot ${slot}`,
    when:     Date.now(),
    episode:  gameepisode,
    map:      gamemap,
    skill:    gameskill,
    leveltime,
    players:  P_ArchivePlayers(),
    world:    P_ArchiveWorld(),
  };
  try { localStorage.setItem(`doom:save:${slot}`, JSON.stringify(blob)); return true; }
  catch (e) { console.error('save failed', e); return false; }
}

export function P_LoadGame(slot) {
  const raw = localStorage.getItem(`doom:save:${slot}`);
  if (raw === null) return false;
  try {
    const blob = JSON.parse(raw);
    set_gameepisode(blob.episode);
    set_gamemap(blob.map);
    set_gameskill(blob.skill);
    set_leveltime(blob.leveltime);
    // World + players come after P_SetupLevel reloads geometry — caller is
    // expected to invoke P_SetupLevel(blob.episode, blob.map, 0, blob.skill)
    // and then P_UnArchiveWorld(blob.world) + P_UnArchivePlayers(blob.players).
    return blob;
  } catch (e) { console.error('load parse fail', e); return false; }
}

// List available save slots for UI.
export function P_ListSaves() {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const raw = localStorage.getItem(`doom:save:${i}`);
    if (raw === null) { out.push(null); continue; }
    try { const b = JSON.parse(raw); out.push({ slot: i, ...b }); }
    catch (_) { out.push(null); }
  }
  return out;
}
