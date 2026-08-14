// Ported from: linuxdoom-1.10/p_saveg.c
//
// Linux Doom writes native structs to a versioned binary stream.  The browser
// port uses a versioned JSON DTO instead, but keeps the same dearchive order:
// players, world, mobjs, then specials.  Parsing and validation are deliberately
// separate from restoration so a corrupt localStorage entry cannot partially
// mutate the running game.

import * as doomstat from './doomstat.js';
import * as pSetup from './p_setup.js';
import {
  GameMode_t, MAXPLAYERS, NUMAMMO, NUMCARDS, NUMPOWERS, NUMWEAPONS, VERSION,
} from './doomdef.js';
import { mapthing_t } from './doomdata.js';
import { W_GetNumForName } from './w_wad.js';
import {
  MAP_FINGERPRINT_ALGORITHM, MAP_FINGERPRINT_VERSION,
  P_GetMapFingerprintForLump, P_MapFingerprintsEqual,
} from './p_saveg_fingerprint.js';
import {
  P_AddThinker, P_InitThinkers, thinkercap,
} from './p_tick.js';
import { thinker_t } from './d_think.js';

export const SAVEGAME_FORMAT = 'linuxdoom-js-save';
export const SAVEGAME_VERSION = VERSION;
export const SAVEGAME_SLOTS = 6;

// Kept for source/API parity with p_saveg.c.  JSON archiving does not use a
// byte cursor, but a few callers historically imported the binding.
export let save_p = 0;

let _makePlayer = null;
let _MobjClass = null;
let _mobjinfo = null;
// Generated info.js table sizes.  Defaults let menus inspect validated save
// metadata before the simulation modules are wired; d_main also injects the
// live constants so a generated-table change cannot go unnoticed at runtime.
let _numMobjTypes = 137;
let _numSprites = 138;
let _numStates = 967;
let _P_MobjThinker = null;
let _P_RemoveMobj = null;
let _P_SetThingPosition = null;
let _T_VerticalDoor = null;
let _T_MoveCeiling = null;
let _T_MoveFloor = null;
let _T_PlatRaise = null;
let _T_LightFlash = null;
let _T_StrobeFlash = null;
let _T_Glow = null;
let _T_FireFlicker = null;
let _P_AddActiveCeiling = () => {};
let _P_AddActivePlat = () => {};

// p_plats.js deliberately uses directional values instead of the C enum's
// ordinal values.  Keep those persisted values stable without importing the
// renderer-dependent special modules into headless save-codec tests.
const PLAT_UP = 1;
const PLAT_DOWN = -1;
const PLAT_WAITING = 0;
const PLAT_IN_STASIS = 2;

// Optional dependency seam for embedders and focused tests.  Restoration is
// otherwise completely synchronous and uses the live engine module bindings.
export function P_SaveGameSetExternals(refs = {}) {
  if (typeof refs.makePlayer === 'function') _makePlayer = refs.makePlayer;
  if (typeof refs.mobj_t === 'function') _MobjClass = refs.mobj_t;
  if (Array.isArray(refs.mobjinfo)) _mobjinfo = refs.mobjinfo;
  if (Number.isInteger(refs.NUMMOBJTYPES)) _numMobjTypes = refs.NUMMOBJTYPES;
  if (Number.isInteger(refs.NUMSPRITES)) _numSprites = refs.NUMSPRITES;
  if (Number.isInteger(refs.NUMSTATES)) _numStates = refs.NUMSTATES;
  if (typeof refs.P_MobjThinker === 'function') _P_MobjThinker = refs.P_MobjThinker;
  if (typeof refs.P_RemoveMobj === 'function') _P_RemoveMobj = refs.P_RemoveMobj;
  if (typeof refs.P_SetThingPosition === 'function') _P_SetThingPosition = refs.P_SetThingPosition;
  if (typeof refs.T_VerticalDoor === 'function') _T_VerticalDoor = refs.T_VerticalDoor;
  if (typeof refs.T_MoveCeiling === 'function') _T_MoveCeiling = refs.T_MoveCeiling;
  if (typeof refs.T_MoveFloor === 'function') _T_MoveFloor = refs.T_MoveFloor;
  if (typeof refs.T_PlatRaise === 'function') _T_PlatRaise = refs.T_PlatRaise;
  if (typeof refs.T_LightFlash === 'function') _T_LightFlash = refs.T_LightFlash;
  if (typeof refs.T_StrobeFlash === 'function') _T_StrobeFlash = refs.T_StrobeFlash;
  if (typeof refs.T_Glow === 'function') _T_Glow = refs.T_Glow;
  if (typeof refs.T_FireFlicker === 'function') _T_FireFlicker = refs.T_FireFlicker;
  if (typeof refs.P_AddActiveCeiling === 'function') _P_AddActiveCeiling = refs.P_AddActiveCeiling;
  if (typeof refs.P_AddActivePlat === 'function') _P_AddActivePlat = refs.P_AddActivePlat;
}

function requireFunction(value, name) {
  if (typeof value !== 'function') throw new Error(`savegame external ${name} is not wired`);
  return value;
}

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`savegame external ${name} is not wired`);
  }
  return value;
}

const INT32_MIN = -0x80000000;
const INT32_MAX = 0x7fffffff;
const UINT32_MAX = 0xffffffff;

function invalid(path, detail = 'is invalid') {
  throw new TypeError(`savegame ${path} ${detail}`);
}

function objectValue(value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid(path, 'must be an object');
  }
  return value;
}

function stringValue(value, path, maxLength = 256) {
  if (typeof value !== 'string' || value.length > maxLength) {
    invalid(path, `must be a string of at most ${maxLength} characters`);
  }
  return value;
}

function booleanValue(value, path) {
  if (typeof value !== 'boolean') invalid(path, 'must be boolean');
  return value;
}

function integerValue(value, path, min = INT32_MIN, max = INT32_MAX) {
  if (!Number.isInteger(value) || value < min || value > max) {
    invalid(path, `must be an integer in [${min}, ${max}]`);
  }
  return value;
}

function oneOf(value, path, allowed) {
  integerValue(value, path);
  if (!allowed.includes(value)) invalid(path, `must be one of ${allowed.join(', ')}`);
  return value;
}

function arrayValue(value, path, length) {
  if (!Array.isArray(value) || (length !== undefined && value.length !== length)) {
    invalid(path, length === undefined ? 'must be an array' : `must have length ${length}`);
  }
  return value;
}

function integerArray(value, path, length, min = INT32_MIN, max = INT32_MAX) {
  const input = arrayValue(value, path, length);
  return input.map((entry, i) => integerValue(entry, `${path}[${i}]`, min, max));
}

function booleanArray(value, path, length) {
  const input = arrayValue(value, path, length);
  return input.map((entry, i) => booleanValue(entry, `${path}[${i}]`));
}

function nullableInteger(value, path, min, max) {
  return value === null ? null : integerValue(value, path, min, max);
}

function snapshotCmd(cmd) {
  return {
    forwardmove: cmd.forwardmove,
    sidemove: cmd.sidemove,
    angleturn: cmd.angleturn,
    consistancy: cmd.consistancy,
    chatchar: cmd.chatchar,
    buttons: cmd.buttons,
  };
}

function snapshotPlayer(player) {
  return {
    playerstate: player.playerstate,
    cmd: snapshotCmd(player.cmd),
    viewz: player.viewz,
    viewheight: player.viewheight,
    deltaviewheight: player.deltaviewheight,
    bob: player.bob,
    health: player.health,
    armorpoints: player.armorpoints,
    armortype: player.armortype,
    powers: Array.from(player.powers),
    cards: Array.from(player.cards),
    backpack: player.backpack,
    frags: Array.from(player.frags),
    readyweapon: player.readyweapon,
    pendingweapon: player.pendingweapon,
    weaponowned: Array.from(player.weaponowned),
    ammo: Array.from(player.ammo),
    maxammo: Array.from(player.maxammo),
    attackdown: player.attackdown,
    usedown: player.usedown,
    cheats: player.cheats,
    refire: player.refire,
    killcount: player.killcount,
    itemcount: player.itemcount,
    secretcount: player.secretcount,
    damagecount: player.damagecount,
    bonuscount: player.bonuscount,
    extralight: player.extralight,
    fixedcolormap: player.fixedcolormap,
    colormap: player.colormap,
    psprites: player.psprites.map((psp) => ({
      // Older JS player initialization used -1 for an inactive flash sprite.
      // The C representation is a NULL state pointer, whose state index is 0.
      state: psp.state === -1 ? 0 : psp.state,
      tics: psp.tics,
      sx: psp.sx,
      sy: psp.sy,
    })),
    didsecret: player.didsecret,
  };
}

function validateCmd(value, path) {
  const cmd = objectValue(value, path);
  return {
    forwardmove: integerValue(cmd.forwardmove, `${path}.forwardmove`, -128, 127),
    sidemove: integerValue(cmd.sidemove, `${path}.sidemove`, -128, 127),
    angleturn: integerValue(cmd.angleturn, `${path}.angleturn`, -32768, 32767),
    consistancy: integerValue(cmd.consistancy, `${path}.consistancy`, -32768, 32767),
    chatchar: integerValue(cmd.chatchar, `${path}.chatchar`, 0, 255),
    buttons: integerValue(cmd.buttons, `${path}.buttons`, 0, 255),
  };
}

function validatePsprite(value, path) {
  const psp = objectValue(value, path);
  const numStates = requirePositiveInteger(_numStates, 'NUMSTATES');
  return {
    state: integerValue(psp.state, `${path}.state`, 0, numStates - 1),
    tics: integerValue(psp.tics, `${path}.tics`),
    sx: integerValue(psp.sx, `${path}.sx`),
    sy: integerValue(psp.sy, `${path}.sy`),
  };
}

function validatePlayer(value, path) {
  const player = objectValue(value, path);
  const pendingweapon = integerValue(player.pendingweapon, `${path}.pendingweapon`, 0, 10);
  if (pendingweapon === NUMWEAPONS) {
    invalid(`${path}.pendingweapon`, 'uses the reserved NUMWEAPONS value');
  }
  return {
    playerstate: integerValue(player.playerstate, `${path}.playerstate`, 0, 2),
    cmd: validateCmd(player.cmd, `${path}.cmd`),
    viewz: integerValue(player.viewz, `${path}.viewz`),
    viewheight: integerValue(player.viewheight, `${path}.viewheight`),
    deltaviewheight: integerValue(player.deltaviewheight, `${path}.deltaviewheight`),
    bob: integerValue(player.bob, `${path}.bob`),
    health: integerValue(player.health, `${path}.health`),
    armorpoints: integerValue(player.armorpoints, `${path}.armorpoints`),
    armortype: integerValue(player.armortype, `${path}.armortype`, 0, 2),
    powers: integerArray(player.powers, `${path}.powers`, NUMPOWERS),
    cards: booleanArray(player.cards, `${path}.cards`, NUMCARDS),
    backpack: booleanValue(player.backpack, `${path}.backpack`),
    frags: integerArray(player.frags, `${path}.frags`, MAXPLAYERS),
    readyweapon: integerValue(player.readyweapon, `${path}.readyweapon`, 0, NUMWEAPONS - 1),
    pendingweapon,
    weaponowned: booleanArray(player.weaponowned, `${path}.weaponowned`, NUMWEAPONS),
    ammo: integerArray(player.ammo, `${path}.ammo`, NUMAMMO),
    maxammo: integerArray(player.maxammo, `${path}.maxammo`, NUMAMMO),
    attackdown: integerValue(player.attackdown, `${path}.attackdown`),
    usedown: integerValue(player.usedown, `${path}.usedown`),
    cheats: integerValue(player.cheats, `${path}.cheats`, 0, UINT32_MAX),
    refire: integerValue(player.refire, `${path}.refire`),
    killcount: integerValue(player.killcount, `${path}.killcount`),
    itemcount: integerValue(player.itemcount, `${path}.itemcount`),
    secretcount: integerValue(player.secretcount, `${path}.secretcount`),
    damagecount: integerValue(player.damagecount, `${path}.damagecount`),
    bonuscount: integerValue(player.bonuscount, `${path}.bonuscount`),
    extralight: integerValue(player.extralight, `${path}.extralight`),
    fixedcolormap: integerValue(player.fixedcolormap, `${path}.fixedcolormap`),
    colormap: integerValue(player.colormap, `${path}.colormap`),
    psprites: arrayValue(player.psprites, `${path}.psprites`, 2)
      .map((psp, i) => validatePsprite(psp, `${path}.psprites[${i}]`)),
    didsecret: booleanValue(player.didsecret, `${path}.didsecret`),
  };
}

function copyArray(target, source) {
  for (let i = 0; i < source.length; i++) target[i] = source[i];
}

function restorePlayer(player, saved) {
  player.playerstate = saved.playerstate;
  Object.assign(player.cmd, saved.cmd);
  player.viewz = saved.viewz;
  player.viewheight = saved.viewheight;
  player.deltaviewheight = saved.deltaviewheight;
  player.bob = saved.bob;
  player.health = saved.health;
  player.armorpoints = saved.armorpoints;
  player.armortype = saved.armortype;
  copyArray(player.powers, saved.powers);
  copyArray(player.cards, saved.cards);
  player.backpack = saved.backpack;
  copyArray(player.frags, saved.frags);
  player.readyweapon = saved.readyweapon;
  player.pendingweapon = saved.pendingweapon;
  copyArray(player.weaponowned, saved.weaponowned);
  copyArray(player.ammo, saved.ammo);
  copyArray(player.maxammo, saved.maxammo);
  player.attackdown = saved.attackdown;
  player.usedown = saved.usedown;
  player.cheats = saved.cheats;
  player.refire = saved.refire;
  player.killcount = saved.killcount;
  player.itemcount = saved.itemcount;
  player.secretcount = saved.secretcount;
  player.damagecount = saved.damagecount;
  player.bonuscount = saved.bonuscount;
  player.extralight = saved.extralight;
  player.fixedcolormap = saved.fixedcolormap;
  player.colormap = saved.colormap;
  for (let i = 0; i < saved.psprites.length; i++) {
    Object.assign(player.psprites[i], saved.psprites[i]);
  }
  player.didsecret = saved.didsecret;

  // p_saveg.c:94-97 -- pointer fields are rebuilt (mo) or deliberately reset.
  player.mo = null;
  player.message = null;
  player.attacker = null;
}

export function P_ArchivePlayers() {
  const archived = new Array(MAXPLAYERS);
  for (let i = 0; i < MAXPLAYERS; i++) {
    const player = doomstat.players[i];
    archived[i] = doomstat.playeringame[i] === true && player != null
      ? snapshotPlayer(player)
      : null;
  }
  return archived;
}

export function P_UnArchivePlayers(archived) {
  for (let i = 0; i < MAXPLAYERS; i++) {
    const existing = doomstat.players[i];
    if (existing != null) {
      existing.mo = null;
      existing.message = null;
      existing.attacker = null;
    }
    if (doomstat.playeringame[i] !== true) continue;
    let player = existing;
    if (player == null) {
      player = requireFunction(_makePlayer, 'makePlayer')();
      doomstat.players[i] = player;
    }
    restorePlayer(player, archived[i]);
  }
}

function liveSectors() { return pSetup.sectors ?? []; }
function liveLines() { return pSetup.lines ?? []; }
function liveSides() { return pSetup.sides ?? []; }

export function P_GetMapFingerprint() {
  const mapName = doomstat.gamemode === GameMode_t.commercial
    ? `${doomstat.gamemap < 10 ? 'MAP0' : 'MAP'}${doomstat.gamemap}`
    : `E${doomstat.gameepisode}M${doomstat.gamemap}`;
  return P_GetMapFingerprintForLump(W_GetNumForName(mapName));
}

export function P_ArchiveWorld() {
  return {
    sectors: liveSectors().map((sector) => ({
      floorheight: sector.floorheight,
      ceilingheight: sector.ceilingheight,
      floorpic: sector.floorpic,
      ceilingpic: sector.ceilingpic,
      lightlevel: sector.lightlevel,
      special: sector.special,
      tag: sector.tag,
    })),
    lines: liveLines().map((line) => ({
      flags: line.flags,
      special: line.special,
      tag: line.tag,
    })),
    sides: liveSides().map((side) => ({
      textureoffset: side.textureoffset,
      rowoffset: side.rowoffset,
      toptexture: side.toptexture,
      bottomtexture: side.bottomtexture,
      midtexture: side.midtexture,
    })),
  };
}

function validateSector(value, path) {
  const sector = objectValue(value, path);
  return {
    floorheight: integerValue(sector.floorheight, `${path}.floorheight`),
    ceilingheight: integerValue(sector.ceilingheight, `${path}.ceilingheight`),
    floorpic: integerValue(sector.floorpic, `${path}.floorpic`),
    ceilingpic: integerValue(sector.ceilingpic, `${path}.ceilingpic`),
    lightlevel: integerValue(sector.lightlevel, `${path}.lightlevel`),
    special: integerValue(sector.special, `${path}.special`),
    tag: integerValue(sector.tag, `${path}.tag`),
  };
}

function validateLine(value, path) {
  const line = objectValue(value, path);
  return {
    flags: integerValue(line.flags, `${path}.flags`),
    special: integerValue(line.special, `${path}.special`),
    tag: integerValue(line.tag, `${path}.tag`),
  };
}

function validateSide(value, path) {
  const side = objectValue(value, path);
  return {
    textureoffset: integerValue(side.textureoffset, `${path}.textureoffset`),
    rowoffset: integerValue(side.rowoffset, `${path}.rowoffset`),
    toptexture: integerValue(side.toptexture, `${path}.toptexture`),
    bottomtexture: integerValue(side.bottomtexture, `${path}.bottomtexture`),
    midtexture: integerValue(side.midtexture, `${path}.midtexture`),
  };
}

function validateWorld(value, fingerprint, path) {
  const world = objectValue(value, path);
  const sectorValues = arrayValue(world.sectors, `${path}.sectors`, fingerprint.sectors);
  const lineValues = arrayValue(world.lines, `${path}.lines`, fingerprint.lines);
  const sideValues = arrayValue(world.sides, `${path}.sides`, fingerprint.sides);
  return {
    sectors: sectorValues.map((sector, i) => validateSector(sector, `${path}.sectors[${i}]`)),
    lines: lineValues.map((line, i) => validateLine(line, `${path}.lines[${i}]`)),
    sides: sideValues.map((side, i) => validateSide(side, `${path}.sides[${i}]`)),
  };
}

export function P_UnArchiveWorld(world) {
  const sectors = liveSectors();
  const lines = liveLines();
  const sides = liveSides();
  for (let i = 0; i < sectors.length; i++) {
    const target = sectors[i];
    const saved = world.sectors[i];
    target.floorheight = saved.floorheight;
    target.ceilingheight = saved.ceilingheight;
    target.floorpic = saved.floorpic;
    target.ceilingpic = saved.ceilingpic;
    target.lightlevel = saved.lightlevel;
    target.special = saved.special;
    target.tag = saved.tag;
    target.specialdata = null;
    target.soundtarget = null;
  }
  for (let i = 0; i < lines.length; i++) {
    lines[i].flags = world.lines[i].flags;
    lines[i].special = world.lines[i].special;
    lines[i].tag = world.lines[i].tag;
  }
  for (let i = 0; i < sides.length; i++) {
    sides[i].textureoffset = world.sides[i].textureoffset;
    sides[i].rowoffset = world.sides[i].rowoffset;
    sides[i].toptexture = world.sides[i].toptexture;
    sides[i].bottomtexture = world.sides[i].bottomtexture;
    sides[i].midtexture = world.sides[i].midtexture;
  }
}

function snapshotSpawnpoint(spawnpoint) {
  if (spawnpoint == null) return null;
  return {
    x: spawnpoint.x,
    y: spawnpoint.y,
    angle: spawnpoint.angle,
    type: spawnpoint.type,
    options: spawnpoint.options,
  };
}

function playerIndexFor(player) {
  if (player == null) return null;
  const index = doomstat.players.indexOf(player);
  return index < 0 ? null : index;
}

function collectLiveMobjs() {
  const mobjs = [];
  if (_P_MobjThinker === null) return mobjs;
  if (thinkercap.next == null || thinkercap.prev == null) return mobjs;
  for (let current = thinkercap.next; current !== thinkercap; current = current.next) {
    // p_saveg.c:240 -- only P_MobjThinker entries are live mobj records.  An
    // object bearing __mobj but queued for lazy removal must not be archived.
    if (current.function === _P_MobjThinker && current.__mobj != null) {
      mobjs.push(current.__mobj);
    }
  }
  return mobjs;
}

export function P_ArchiveThinkers() {
  const mobjs = collectLiveMobjs();
  const ids = new Map(mobjs.map((mobj, id) => [mobj, id]));
  return mobjs.map((mobj, id) => ({
    id,
    x: mobj.x,
    y: mobj.y,
    z: mobj.z,
    angle: mobj.angle >>> 0,
    sprite: mobj.sprite,
    frame: mobj.frame >>> 0,
    floorz: mobj.floorz,
    ceilingz: mobj.ceilingz,
    radius: mobj.radius,
    height: mobj.height,
    momx: mobj.momx,
    momy: mobj.momy,
    momz: mobj.momz,
    validcount: mobj.validcount,
    type: mobj.type,
    tics: mobj.tics,
    state: mobj.state,
    flags: mobj.flags >>> 0,
    health: mobj.health,
    movedir: mobj.movedir,
    movecount: mobj.movecount,
    reactiontime: mobj.reactiontime,
    threshold: mobj.threshold,
    lastlook: mobj.lastlook,
    spawnpoint: snapshotSpawnpoint(mobj.spawnpoint),
    playerIndex: playerIndexFor(mobj.player),
    targetId: ids.has(mobj.target) ? ids.get(mobj.target) : null,
    tracerId: ids.has(mobj.tracer) ? ids.get(mobj.tracer) : null,
  }));
}

function validateSpawnpoint(value, path) {
  if (value === null) return null;
  const spawnpoint = objectValue(value, path);
  return {
    x: integerValue(spawnpoint.x, `${path}.x`, -32768, 32767),
    y: integerValue(spawnpoint.y, `${path}.y`, -32768, 32767),
    angle: integerValue(spawnpoint.angle, `${path}.angle`, -32768, 32767),
    type: integerValue(spawnpoint.type, `${path}.type`, -32768, 32767),
    options: integerValue(spawnpoint.options, `${path}.options`, -32768, 32767),
  };
}

function validateMobj(value, path, expectedId) {
  const mobj = objectValue(value, path);
  const numSprites = requirePositiveInteger(_numSprites, 'NUMSPRITES');
  const numMobjTypes = requirePositiveInteger(_numMobjTypes, 'NUMMOBJTYPES');
  const numStates = requirePositiveInteger(_numStates, 'NUMSTATES');
  return {
    id: integerValue(mobj.id, `${path}.id`, expectedId, expectedId),
    x: integerValue(mobj.x, `${path}.x`),
    y: integerValue(mobj.y, `${path}.y`),
    z: integerValue(mobj.z, `${path}.z`),
    angle: integerValue(mobj.angle, `${path}.angle`, 0, UINT32_MAX),
    sprite: integerValue(mobj.sprite, `${path}.sprite`, 0, numSprites - 1),
    frame: integerValue(mobj.frame, `${path}.frame`, 0, UINT32_MAX),
    floorz: integerValue(mobj.floorz, `${path}.floorz`),
    ceilingz: integerValue(mobj.ceilingz, `${path}.ceilingz`),
    radius: integerValue(mobj.radius, `${path}.radius`, 0, INT32_MAX),
    height: integerValue(mobj.height, `${path}.height`, 0, INT32_MAX),
    momx: integerValue(mobj.momx, `${path}.momx`),
    momy: integerValue(mobj.momy, `${path}.momy`),
    momz: integerValue(mobj.momz, `${path}.momz`),
    validcount: integerValue(mobj.validcount, `${path}.validcount`),
    type: integerValue(mobj.type, `${path}.type`, 0, numMobjTypes - 1),
    tics: integerValue(mobj.tics, `${path}.tics`),
    state: integerValue(mobj.state, `${path}.state`, 0, numStates - 1),
    flags: integerValue(mobj.flags, `${path}.flags`, 0, UINT32_MAX),
    health: integerValue(mobj.health, `${path}.health`),
    movedir: integerValue(mobj.movedir, `${path}.movedir`, 0, 8),
    movecount: integerValue(mobj.movecount, `${path}.movecount`),
    reactiontime: integerValue(mobj.reactiontime, `${path}.reactiontime`),
    threshold: integerValue(mobj.threshold, `${path}.threshold`),
    lastlook: integerValue(mobj.lastlook, `${path}.lastlook`),
    spawnpoint: validateSpawnpoint(mobj.spawnpoint, `${path}.spawnpoint`),
    playerIndex: nullableInteger(mobj.playerIndex, `${path}.playerIndex`, 0, MAXPLAYERS - 1),
    targetId: nullableInteger(mobj.targetId, `${path}.targetId`, 0, INT32_MAX),
    tracerId: nullableInteger(mobj.tracerId, `${path}.tracerId`, 0, INT32_MAX),
  };
}

function hydrateSpawnpoint(saved) {
  if (saved === null) return null;
  const spawnpoint = new mapthing_t();
  Object.assign(spawnpoint, saved);
  return spawnpoint;
}

// Remove the freshly loaded base-map thinkers before installing the archived
// list.  This follows p_saveg.c:273-286, including P_RemoveMobj's normal
// unlink/sound/item-respawn side effects, then abandons the old list at once.
export function P_ClearThinkersForLoad() {
  if (thinkercap.next != null && thinkercap.prev != null) {
    let current = thinkercap.next;
    while (current !== thinkercap) {
      const next = current.next;
      if (current.function === _P_MobjThinker && current.__mobj != null) {
        requireFunction(_P_RemoveMobj, 'P_RemoveMobj')(current.__mobj);
      }
      current = next;
    }
  }
  P_InitThinkers();
  // Defensive postcondition for the JS object graph.  Vanilla obtains the same
  // result from P_UnsetThingPosition on every live mobj.
  for (const sector of liveSectors()) sector.thinglist = null;
  if (pSetup.blocklinks != null) pSetup.blocklinks.fill(null);
}

export function P_UnArchiveThinkers(archived) {
  const MobjClass = requireFunction(_MobjClass, 'mobj_t');
  const mobjThinker = requireFunction(_P_MobjThinker, 'P_MobjThinker');
  const setThingPosition = requireFunction(_P_SetThingPosition, 'P_SetThingPosition');
  if (!Array.isArray(_mobjinfo)) throw new Error('savegame external mobjinfo is not wired');
  P_ClearThinkersForLoad();
  const restored = new Array(archived.length);

  // First pass: raw scalar hydration, spatial links, thinker links, and player
  // ownership.  Do not call P_SpawnMobj or P_SetMobjState: both have gameplay
  // side effects and the former consumes P_Random for lastlook.
  for (let i = 0; i < archived.length; i++) {
    const saved = archived[i];
    const mobj = new MobjClass();
    mobj.x = saved.x;
    mobj.y = saved.y;
    mobj.z = saved.z;
    mobj.angle = saved.angle >>> 0;
    mobj.sprite = saved.sprite;
    mobj.frame = saved.frame >>> 0;
    mobj.floorz = saved.floorz;
    mobj.ceilingz = saved.ceilingz;
    mobj.radius = saved.radius;
    mobj.height = saved.height;
    mobj.momx = saved.momx;
    mobj.momy = saved.momy;
    mobj.momz = saved.momz;
    mobj.validcount = saved.validcount;
    mobj.type = saved.type;
    mobj.info = _mobjinfo[saved.type];
    mobj.tics = saved.tics;
    mobj.state = saved.state;
    mobj.flags = saved.flags | 0;
    mobj.health = saved.health;
    mobj.movedir = saved.movedir;
    mobj.movecount = saved.movecount;
    mobj.reactiontime = saved.reactiontime;
    mobj.threshold = saved.threshold;
    mobj.lastlook = saved.lastlook;
    mobj.spawnpoint = hydrateSpawnpoint(saved.spawnpoint);
    mobj.target = null;
    mobj.tracer = null;
    mobj.player = saved.playerIndex === null ? null : doomstat.players[saved.playerIndex];
    mobj.thinker.function = mobjThinker;
    mobj.thinker.__mobj = mobj;

    setThingPosition(mobj);
    mobj.floorz = mobj.subsector.sector.floorheight;
    mobj.ceilingz = mobj.subsector.sector.ceilingheight;
    P_AddThinker(mobj.thinker);
    if (mobj.player !== null) mobj.player.mo = mobj;
    restored[i] = mobj;
  }

  // Second pass: references are IDs rather than stale object pointers.
  for (let i = 0; i < archived.length; i++) {
    const saved = archived[i];
    restored[i].target = saved.targetId === null ? null : restored[saved.targetId];
    restored[i].tracer = saved.tracerId === null ? null : restored[saved.tracerId];
  }
  return restored;
}

function sectorIndex(sector) {
  if (sector != null && Number.isInteger(sector.index) && liveSectors()[sector.index] === sector) {
    return sector.index;
  }
  return liveSectors().indexOf(sector);
}

export function P_ArchiveSpecials() {
  const archived = [];
  if (thinkercap.next == null || thinkercap.prev == null) return archived;
  for (let current = thinkercap.next; current !== thinkercap; current = current.next) {
    const fn = current.function;
    if (current.__door != null && fn === _T_VerticalDoor) {
      const door = current.__door;
      archived.push({
        kind: 'door', sector: sectorIndex(door.sector), type: door.type,
        topheight: door.topheight, speed: door.speed, direction: door.direction,
        topwait: door.topwait, topcountdown: door.topcountdown,
      });
    } else if (current.__ceiling != null &&
      (fn === _T_MoveCeiling || (fn === null && current.__ceiling.direction === 0))) {
      const ceiling = current.__ceiling;
      archived.push({
        kind: 'ceiling', sector: sectorIndex(ceiling.sector), type: ceiling.type,
        bottomheight: ceiling.bottomheight, topheight: ceiling.topheight,
        speed: ceiling.speed, crush: ceiling.crush, direction: ceiling.direction,
        tag: ceiling.tag, olddirection: ceiling.olddirection,
      });
    } else if (current.__floor != null && fn === _T_MoveFloor) {
      const floor = current.__floor;
      archived.push({
        kind: 'floor', sector: sectorIndex(floor.sector), type: floor.type,
        crush: floor.crush, direction: floor.direction, newspecial: floor.newspecial ?? 0,
        texture: floor.texture ?? 0, floordestheight: floor.floordestheight, speed: floor.speed,
      });
    } else if (current.__plat != null &&
      (fn === _T_PlatRaise || (fn === null && current.__plat.status === PLAT_IN_STASIS))) {
      const plat = current.__plat;
      archived.push({
        kind: 'plat', sector: sectorIndex(plat.sector), speed: plat.speed,
        low: plat.low, high: plat.high, wait: plat.wait, count: plat.count,
        status: plat.status, oldstatus: plat.oldstatus, crush: plat.crush,
        tag: plat.tag, type: plat.type,
      });
    } else if (current.__flash != null && fn === _T_LightFlash) {
      const flash = current.__flash;
      archived.push({
        kind: 'flash', sector: sectorIndex(flash.sector), count: flash.count,
        maxlight: flash.maxlight, minlight: flash.minlight,
        maxtime: flash.maxtime, mintime: flash.mintime,
      });
    } else if (current.__strobe != null && fn === _T_StrobeFlash) {
      const strobe = current.__strobe;
      archived.push({
        kind: 'strobe', sector: sectorIndex(strobe.sector), count: strobe.count,
        minlight: strobe.minlight, maxlight: strobe.maxlight,
        darktime: strobe.darktime, brighttime: strobe.brighttime,
      });
    } else if (current.__glow != null && fn === _T_Glow) {
      const glow = current.__glow;
      archived.push({
        kind: 'glow', sector: sectorIndex(glow.sector), minlight: glow.minlight,
        maxlight: glow.maxlight, direction: glow.direction,
      });
    } else if (current.__flick != null && fn === _T_FireFlicker) {
      // Linux Doom 1.10 accidentally omitted fire flicker from p_saveg.c.  The
      // JSON schema preserves it so loading does not silently remove the effect.
      const flicker = current.__flick;
      archived.push({
        kind: 'flicker', sector: sectorIndex(flicker.sector), count: flicker.count,
        maxlight: flicker.maxlight, minlight: flicker.minlight,
      });
    }
  }
  return archived;
}

function specialBase(value, path, sectorCount) {
  const special = objectValue(value, path);
  return {
    special,
    kind: stringValue(special.kind, `${path}.kind`, 16),
    sector: integerValue(special.sector, `${path}.sector`, 0, sectorCount - 1),
  };
}

function validateSpecial(value, path, sectorCount) {
  const { special, kind, sector } = specialBase(value, path, sectorCount);
  switch (kind) {
    case 'door':
      return {
        kind, sector,
        type: integerValue(special.type, `${path}.type`, 0, 7),
        topheight: integerValue(special.topheight, `${path}.topheight`),
        speed: integerValue(special.speed, `${path}.speed`, 0, INT32_MAX),
        direction: oneOf(special.direction, `${path}.direction`, [-1, 0, 1, 2]),
        topwait: integerValue(special.topwait, `${path}.topwait`),
        topcountdown: integerValue(special.topcountdown, `${path}.topcountdown`),
      };
    case 'ceiling':
      return {
        kind, sector,
        type: integerValue(special.type, `${path}.type`, 0, 5),
        bottomheight: integerValue(special.bottomheight, `${path}.bottomheight`),
        topheight: integerValue(special.topheight, `${path}.topheight`),
        speed: integerValue(special.speed, `${path}.speed`, 0, INT32_MAX),
        crush: booleanValue(special.crush, `${path}.crush`),
        direction: oneOf(special.direction, `${path}.direction`, [-1, 0, 1]),
        tag: integerValue(special.tag, `${path}.tag`),
        olddirection: oneOf(special.olddirection, `${path}.olddirection`, [-1, 0, 1]),
      };
    case 'floor':
      return {
        kind, sector,
        type: integerValue(special.type, `${path}.type`, 0, 12),
        crush: booleanValue(special.crush, `${path}.crush`),
        direction: oneOf(special.direction, `${path}.direction`, [-1, 1]),
        newspecial: integerValue(special.newspecial, `${path}.newspecial`),
        texture: integerValue(special.texture, `${path}.texture`),
        floordestheight: integerValue(special.floordestheight, `${path}.floordestheight`),
        speed: integerValue(special.speed, `${path}.speed`, 0, INT32_MAX),
      };
    case 'plat':
      return {
        kind, sector,
        speed: integerValue(special.speed, `${path}.speed`, 0, INT32_MAX),
        low: integerValue(special.low, `${path}.low`),
        high: integerValue(special.high, `${path}.high`),
        wait: integerValue(special.wait, `${path}.wait`),
        count: integerValue(special.count, `${path}.count`),
        status: oneOf(special.status, `${path}.status`, [PLAT_DOWN, PLAT_WAITING, PLAT_UP, PLAT_IN_STASIS]),
        oldstatus: oneOf(special.oldstatus, `${path}.oldstatus`, [PLAT_DOWN, PLAT_WAITING, PLAT_UP, PLAT_IN_STASIS]),
        crush: booleanValue(special.crush, `${path}.crush`),
        tag: integerValue(special.tag, `${path}.tag`),
        type: integerValue(special.type, `${path}.type`, 0, 4),
      };
    case 'flash':
      return {
        kind, sector,
        count: integerValue(special.count, `${path}.count`),
        maxlight: integerValue(special.maxlight, `${path}.maxlight`),
        minlight: integerValue(special.minlight, `${path}.minlight`),
        maxtime: integerValue(special.maxtime, `${path}.maxtime`),
        mintime: integerValue(special.mintime, `${path}.mintime`),
      };
    case 'strobe':
      return {
        kind, sector,
        count: integerValue(special.count, `${path}.count`),
        minlight: integerValue(special.minlight, `${path}.minlight`),
        maxlight: integerValue(special.maxlight, `${path}.maxlight`),
        darktime: integerValue(special.darktime, `${path}.darktime`),
        brighttime: integerValue(special.brighttime, `${path}.brighttime`),
      };
    case 'glow':
      return {
        kind, sector,
        minlight: integerValue(special.minlight, `${path}.minlight`),
        maxlight: integerValue(special.maxlight, `${path}.maxlight`),
        direction: oneOf(special.direction, `${path}.direction`, [-1, 1]),
      };
    case 'flicker':
      return {
        kind, sector,
        count: integerValue(special.count, `${path}.count`),
        maxlight: integerValue(special.maxlight, `${path}.maxlight`),
        minlight: integerValue(special.minlight, `${path}.minlight`),
      };
    default:
      invalid(`${path}.kind`, `has unknown value ${JSON.stringify(kind)}`);
  }
}

function makeSpecialThinker(fn, key, data) {
  const thinker = new thinker_t();
  thinker.function = fn;
  thinker[key] = data;
  P_AddThinker(thinker);
  return thinker;
}

export function P_UnArchiveSpecials(archived) {
  const sectors = liveSectors();
  for (const saved of archived) {
    const sector = sectors[saved.sector];
    let data;
    switch (saved.kind) {
      case 'door':
        data = { ...saved, sector };
        delete data.kind;
        makeSpecialThinker(requireFunction(_T_VerticalDoor, 'T_VerticalDoor'), '__door', data);
        sector.specialdata = data;
        break;
      case 'ceiling':
        data = { ...saved, sector };
        delete data.kind;
        makeSpecialThinker(requireFunction(_T_MoveCeiling, 'T_MoveCeiling'), '__ceiling', data);
        sector.specialdata = data;
        _P_AddActiveCeiling(data);
        break;
      case 'floor':
        data = { ...saved, sector };
        delete data.kind;
        makeSpecialThinker(requireFunction(_T_MoveFloor, 'T_MoveFloor'), '__floor', data);
        sector.specialdata = data;
        break;
      case 'plat':
        data = { ...saved, sector };
        delete data.kind;
        makeSpecialThinker(requireFunction(_T_PlatRaise, 'T_PlatRaise'), '__plat', data);
        sector.specialdata = data;
        _P_AddActivePlat(data);
        break;
      case 'flash':
        data = { ...saved, sector };
        delete data.kind;
        makeSpecialThinker(requireFunction(_T_LightFlash, 'T_LightFlash'), '__flash', data);
        break;
      case 'strobe':
        data = { ...saved, sector };
        delete data.kind;
        makeSpecialThinker(requireFunction(_T_StrobeFlash, 'T_StrobeFlash'), '__strobe', data);
        break;
      case 'glow':
        data = { ...saved, sector };
        delete data.kind;
        makeSpecialThinker(requireFunction(_T_Glow, 'T_Glow'), '__glow', data);
        break;
      case 'flicker':
        data = { ...saved, sector };
        delete data.kind;
        makeSpecialThinker(requireFunction(_T_FireFlicker, 'T_FireFlicker'), '__flick', data);
        break;
    }
  }
  return archived.length;
}

function validateFingerprint(value, path) {
  const fingerprint = objectValue(value, path);
  // Count-only saves written before fingerprint v1 cannot be migrated safely:
  // assigning the currently loaded map's digest would recreate the same-count
  // cross-WAD bug. P_ReadSaveGame rejects them without deleting their slot.
  const version = integerValue(
    fingerprint.version,
    `${path}.version`,
    MAP_FINGERPRINT_VERSION,
    MAP_FINGERPRINT_VERSION,
  );
  const algorithm = stringValue(fingerprint.algorithm, `${path}.algorithm`, 16);
  if (algorithm !== MAP_FINGERPRINT_ALGORITHM) {
    invalid(`${path}.algorithm`, `must be ${MAP_FINGERPRINT_ALGORITHM}`);
  }
  const digest = stringValue(fingerprint.digest, `${path}.digest`, 64);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    invalid(`${path}.digest`, 'must be a lowercase SHA-256 digest');
  }
  return {
    version,
    algorithm,
    digest,
    sectors: integerValue(fingerprint.sectors, `${path}.sectors`, 0, INT32_MAX),
    lines: integerValue(fingerprint.lines, `${path}.lines`, 0, INT32_MAX),
    sides: integerValue(fingerprint.sides, `${path}.sides`, 0, INT32_MAX),
  };
}

function validateSaveGameOrThrow(value) {
  const save = objectValue(value, 'root');
  if (save.format !== SAVEGAME_FORMAT) invalid('root.format', `must be ${SAVEGAME_FORMAT}`);
  integerValue(save.version, 'root.version', SAVEGAME_VERSION, SAVEGAME_VERSION);
  const fingerprint = validateFingerprint(save.mapFingerprint, 'root.mapFingerprint');
  const playeringame = booleanArray(save.playeringame, 'root.playeringame', MAXPLAYERS);
  if (!playeringame.some((active) => active === true)) {
    invalid('root.playeringame', 'must contain at least one active player');
  }
  const playerValues = arrayValue(save.players, 'root.players', MAXPLAYERS);
  const players = playerValues.map((player, i) => {
    if (playeringame[i] !== true) {
      if (player !== null) invalid(`root.players[${i}]`, 'must be null for an inactive slot');
      return null;
    }
    return validatePlayer(player, `root.players[${i}]`);
  });
  const world = validateWorld(save.world, fingerprint, 'root.world');
  const thinkerValues = arrayValue(save.thinkers, 'root.thinkers');
  const thinkers = thinkerValues.map((mobj, i) => validateMobj(mobj, `root.thinkers[${i}]`, i));

  const playerOwners = new Set();
  for (let i = 0; i < thinkers.length; i++) {
    const mobj = thinkers[i];
    for (const field of ['targetId', 'tracerId']) {
      if (mobj[field] !== null && mobj[field] >= thinkers.length) {
        invalid(`root.thinkers[${i}].${field}`, 'does not name an archived mobj');
      }
    }
    if (mobj.playerIndex !== null) {
      if (playeringame[mobj.playerIndex] !== true) {
        invalid(`root.thinkers[${i}].playerIndex`, 'names an inactive player');
      }
      if (playerOwners.has(mobj.playerIndex)) {
        invalid(`root.thinkers[${i}].playerIndex`, 'duplicates a player mobj owner');
      }
      playerOwners.add(mobj.playerIndex);
    }
  }
  for (let i = 0; i < MAXPLAYERS; i++) {
    if (playeringame[i] === true && !playerOwners.has(i)) {
      invalid(`root.thinkers`, `must contain exactly one mobj owned by active player ${i}`);
    }
  }

  const specialValues = arrayValue(save.specials, 'root.specials');
  const specials = specialValues.map((special, i) =>
    validateSpecial(special, `root.specials[${i}]`, fingerprint.sectors));
  const movingSectors = new Set();
  for (let i = 0; i < specials.length; i++) {
    if (!['door', 'ceiling', 'floor', 'plat'].includes(specials[i].kind)) continue;
    if (movingSectors.has(specials[i].sector)) {
      invalid(`root.specials[${i}].sector`, 'has more than one geometry thinker');
    }
    movingSectors.add(specials[i].sector);
  }

  return {
    format: SAVEGAME_FORMAT,
    version: SAVEGAME_VERSION,
    description: stringValue(save.description, 'root.description'),
    when: integerValue(save.when, 'root.when', 0, Number.MAX_SAFE_INTEGER),
    episode: integerValue(save.episode, 'root.episode', 1, 4),
    // Commercial PWADs commonly extend beyond MAP32; target-WAD fingerprint
    // preflight is the authoritative existence check.
    map: integerValue(save.map, 'root.map', 1, 99),
    skill: integerValue(save.skill, 'root.skill', 0, 4),
    leveltime: integerValue(save.leveltime, 'root.leveltime', 0, INT32_MAX),
    playeringame,
    mapFingerprint: fingerprint,
    players,
    world,
    thinkers,
    specials,
  };
}

// Return a detached, normalized DTO on success and false on any schema error.
export function P_ValidateSaveGame(value) {
  try {
    return validateSaveGameOrThrow(value);
  } catch (_) {
    return false;
  }
}

// Tests and embedders may validate storage/schema fields before the heavyweight
// actor tables have been installed.  Runtime validation still receives the
// exact info.js bounds through P_SaveGameSetExternals.

function makeSaveBlob(description) {
  // A save must never appear successful while an unwired archive classifier
  // silently drops actors or specials.
  requireFunction(_P_MobjThinker, 'P_MobjThinker');
  requireFunction(_T_VerticalDoor, 'T_VerticalDoor');
  requireFunction(_T_MoveCeiling, 'T_MoveCeiling');
  requireFunction(_T_MoveFloor, 'T_MoveFloor');
  requireFunction(_T_PlatRaise, 'T_PlatRaise');
  requireFunction(_T_LightFlash, 'T_LightFlash');
  requireFunction(_T_StrobeFlash, 'T_StrobeFlash');
  requireFunction(_T_Glow, 'T_Glow');
  requireFunction(_T_FireFlicker, 'T_FireFlicker');
  return {
    format: SAVEGAME_FORMAT,
    version: SAVEGAME_VERSION,
    description,
    when: Date.now(),
    episode: doomstat.gameepisode,
    map: doomstat.gamemap,
    skill: doomstat.gameskill,
    leveltime: doomstat.leveltime,
    playeringame: doomstat.playeringame.map((active) => active === true),
    mapFingerprint: P_GetMapFingerprint(),
    players: P_ArchivePlayers(),
    world: P_ArchiveWorld(),
    thinkers: P_ArchiveThinkers(),
    specials: P_ArchiveSpecials(),
  };
}

function validSlot(slot) {
  return Number.isInteger(slot) && slot >= 0 && slot < SAVEGAME_SLOTS;
}

function storageKey(slot) {
  return `doom:save:${slot}`;
}

export function P_SaveGame(slot, description) {
  if (!validSlot(slot)) return false;
  const label = description == null ? `Slot ${slot + 1}` : description;
  if (typeof label !== 'string') return false;
  try {
    const blob = P_ValidateSaveGame(makeSaveBlob(label));
    if (blob === false) return false;
    localStorage.setItem(storageKey(slot), JSON.stringify(blob));
    return true;
  } catch (error) {
    console.error('save failed', error);
    return false;
  }
}

// Read and validate only.  This function never mutates game state.
export function P_ReadSaveGame(slot) {
  if (!validSlot(slot)) return false;
  try {
    const raw = localStorage.getItem(storageKey(slot));
    if (raw === null) return false;
    return P_ValidateSaveGame(JSON.parse(raw));
  } catch (_) {
    return false;
  }
}

// Compatibility name retained for older callers.  Loading is now explicitly a
// read/preflight followed by the synchronous P_RestoreGame commit.
export function P_LoadGame(slot) {
  return P_ReadSaveGame(slot);
}

function preflightRestoreRuntime(save) {
  requireFunction(_P_MobjThinker, 'P_MobjThinker');
  requireFunction(_P_RemoveMobj, 'P_RemoveMobj');
  requireFunction(_MobjClass, 'mobj_t');
  requireFunction(_P_SetThingPosition, 'P_SetThingPosition');
  if (!Array.isArray(_mobjinfo) || _mobjinfo.length < _numMobjTypes) {
    throw new Error('savegame external mobjinfo is not wired');
  }
  for (let i = 0; i < MAXPLAYERS; i++) {
    if (save.playeringame[i] === true && doomstat.players[i] == null) {
      requireFunction(_makePlayer, 'makePlayer');
    }
  }
  const callbackByKind = {
    door: [_T_VerticalDoor, 'T_VerticalDoor'],
    ceiling: [_T_MoveCeiling, 'T_MoveCeiling'],
    floor: [_T_MoveFloor, 'T_MoveFloor'],
    plat: [_T_PlatRaise, 'T_PlatRaise'],
    flash: [_T_LightFlash, 'T_LightFlash'],
    strobe: [_T_StrobeFlash, 'T_StrobeFlash'],
    glow: [_T_Glow, 'T_Glow'],
    flicker: [_T_FireFlicker, 'T_FireFlicker'],
  };
  for (const special of save.specials) {
    const [callback, name] = callbackByKind[special.kind];
    requireFunction(callback, name);
  }
}

export function P_RestoreGame(value) {
  const save = P_ValidateSaveGame(value);
  if (save === false) return false;
  // This is the last precondition checked before the commit begins.  d_main's
  // target-WAD preflight performs the same check before replacing the old map;
  // this live check protects direct callers and wrong-map restores.
  try {
    if (!P_MapFingerprintsEqual(save.mapFingerprint, P_GetMapFingerprint())) return false;
  } catch (_) {
    return false;
  }
  try {
    preflightRestoreRuntime(save);
  } catch (_) {
    return false;
  }

  doomstat.set_gameepisode(save.episode);
  doomstat.set_gamemap(save.map);
  doomstat.set_gameskill(save.skill);
  doomstat.set_leveltime(save.leveltime);
  for (let i = 0; i < MAXPLAYERS; i++) doomstat.playeringame[i] = save.playeringame[i];

  P_UnArchivePlayers(save.players);
  P_UnArchiveWorld(save.world);
  P_UnArchiveThinkers(save.thinkers);
  P_UnArchiveSpecials(save.specials);
  return true;
}

export function P_ListSaves() {
  const saves = new Array(SAVEGAME_SLOTS);
  for (let slot = 0; slot < SAVEGAME_SLOTS; slot++) {
    const save = P_ReadSaveGame(slot);
    saves[slot] = save === false ? null : { slot, ...save };
  }
  return saves;
}
