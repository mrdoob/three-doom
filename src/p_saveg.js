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

// World snapshot: sectors' moving heights + tag/special.
export function P_ArchiveWorld() {
  const ps = imp_sectors();
  const out = [];
  for (const s of ps) out.push({ fh: s.floorheight, ch: s.ceilingheight, ll: s.lightlevel, sp: s.special, tg: s.tag });
  return out;
}
export function P_UnArchiveWorld(arr) {
  if (arr === undefined || arr === null) return;
  const ps = imp_sectors();
  for (let i = 0; i < arr.length && i < ps.length; i++) {
    ps[i].floorheight = arr[i].fh;
    ps[i].ceilingheight = arr[i].ch;
    ps[i].lightlevel = arr[i].ll;
    ps[i].special = arr[i].sp;
    ps[i].tag = arr[i].tg;
  }
}

function imp_sectors() {
  // Access dynamically (avoid import cycle on module load).
  return globalThis.__doom_sectors || [];
}

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

// Active specials (doors, lifts, etc.) re-derive themselves from the world
// snapshot — no per-thinker serialization needed because sector heights /
// states are captured in P_ArchiveWorld.
export function P_ArchiveSpecials() { return []; }
export function P_UnArchiveSpecials(_arr) { }

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
