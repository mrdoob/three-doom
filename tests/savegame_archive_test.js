import * as doomstat from '../src/doomstat.js';
import * as pSetup from '../src/p_setup.js';
import { GameMode_t } from '../src/doomdef.js';
import {
  P_ArchiveSpecials,
  P_ArchiveThinkers,
  P_SaveGame,
  P_SaveGameSetExternals,
} from '../src/p_saveg.js';
import { P_AddThinker, P_InitThinkers, P_RemoveThinker } from '../src/p_tick.js';
import { thinker_t } from '../src/d_think.js';
import { W_InitMultipleFiles } from '../src/w_wad.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function callback() {}

function P_MobjThinker() {}

class TestMobj {
  constructor() {
    this.thinker = new thinker_t();
    this.x = 0; this.y = 0; this.z = 0;
    this.angle = 0; this.sprite = 0; this.frame = 0;
    this.floorz = 0; this.ceilingz = 0; this.radius = 0; this.height = 0;
    this.momx = 0; this.momy = 0; this.momz = 0; this.validcount = 0;
    this.type = 0; this.tics = 0; this.state = 0; this.flags = 0; this.health = 0;
    this.movedir = 0; this.movecount = 0; this.reactiontime = 0;
    this.threshold = 0; this.lastlook = 0; this.spawnpoint = null;
    this.player = null; this.target = null; this.tracer = null;
  }
}

function makeCompletePlayer() {
  return {
    mo: null,
    playerstate: 0,
    cmd: { forwardmove: -7, sidemove: 8, angleturn: -900, consistancy: 12, chatchar: 65, buttons: 3 },
    viewz: 41 << 16,
    viewheight: 40 << 16,
    deltaviewheight: -123,
    bob: 456,
    health: 87,
    armorpoints: 33,
    armortype: 1,
    powers: new Int32Array([1, 2, 3, 4, 5, 6]),
    cards: [true, false, true, false, true, false],
    backpack: true,
    frags: new Int32Array([9, -2, 3, 4]),
    readyweapon: 2,
    pendingweapon: 10,
    weaponowned: [true, true, true, false, false, false, false, false, false],
    ammo: [45, 6, 7, 8],
    maxammo: [400, 100, 600, 100],
    attackdown: 1,
    usedown: 2,
    cheats: 4,
    refire: 5,
    killcount: 6,
    itemcount: 7,
    secretcount: 8,
    message: 'not persisted',
    damagecount: 9,
    bonuscount: 10,
    attacker: null,
    extralight: 11,
    fixedcolormap: 12,
    colormap: 3,
    psprites: [
      { state: 5, tics: 6, sx: 7, sy: 8 },
      { state: -1, tics: 10, sx: 11, sy: 12 },
    ],
    didsecret: true,
  };
}

P_SaveGameSetExternals({
  makePlayer: () => ({}),
  mobj_t: TestMobj,
  P_MobjThinker,
  P_RemoveMobj: () => {},
  P_SetThingPosition: () => {},
  mobjinfo: new Array(137).fill({}),
  NUMMOBJTYPES: 137,
  NUMSPRITES: 138,
  NUMSTATES: 967,
  T_VerticalDoor: callback,
  T_MoveCeiling: callback,
  T_MoveFloor: callback,
  T_PlatRaise: callback,
  T_LightFlash: callback,
  T_StrobeFlash: callback,
  T_Glow: callback,
  T_FireFlicker: callback,
});

Deno.test('thinker archive excludes mobjs queued for lazy removal', () => {
  P_InitThinkers();
  const live = new TestMobj();
  live.thinker.function = P_MobjThinker;
  live.thinker.__mobj = live;
  P_AddThinker(live.thinker);
  const removed = new TestMobj();
  removed.x = 999;
  removed.thinker.function = P_MobjThinker;
  removed.thinker.__mobj = removed;
  P_AddThinker(removed.thinker);
  P_RemoveThinker(removed.thinker);

  const archived = P_ArchiveThinkers();
  assert(archived.length === 1, `expected one live mobj, got ${archived.length}`);
  assert(archived[0].id === 0 && archived[0].x === 0, 'wrong mobj was archived');
  P_InitThinkers();
});

Deno.test('ordinary floor archive supplies zero defaults for raw C fields', () => {
  const oldSectors = pSetup.sectors;
  pSetup.set_sectors([{ index: 0 }]);
  P_InitThinkers();
  const floor = {
    sector: pSetup.sectors[0],
    type: 3,
    crush: false,
    direction: 1,
    floordestheight: 64 << 16,
    speed: 1 << 16,
  };
  const thinker = {
    prev: null,
    next: null,
    function: callback,
    __floor: floor,
  };
  P_AddThinker(thinker);
  try {
    const archived = P_ArchiveSpecials();
    assert(archived.length === 1, 'floor thinker was omitted');
    assert(archived[0].newspecial === 0, 'undefined newspecial was not normalized');
    assert(archived[0].texture === 0, 'undefined texture was not normalized');
  } finally {
    P_InitThinkers();
    pSetup.set_sectors(oldSectors);
  }
});

Deno.test('P_SaveGame catches archive construction failures', async () => {
  // Supply a valid current-map identity so this reaches the deliberately bad
  // live player topology instead of failing earlier during fingerprinting.
  const wad = await Deno.readFile(new URL('../doom1.wad', import.meta.url));
  W_InitMultipleFiles([{ name: 'doom1.wad', buffer: wad.buffer }]);
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldPlayers = doomstat.players.slice();
  const oldActive = doomstat.playeringame.slice();
  const calls = [];
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { setItem: (...args) => calls.push(args) },
  });
  doomstat.playeringame.fill(false);
  doomstat.playeringame[0] = true;
  doomstat.players[0] = null;
  try {
    assert(P_SaveGame(0, 'bad live topology') === false, 'archive exception escaped as success');
    assert(calls.length === 0, 'invalid live state reached localStorage');
  } finally {
    for (let i = 0; i < oldPlayers.length; i++) {
      doomstat.players[i] = oldPlayers[i];
      doomstat.playeringame[i] = oldActive[i];
    }
    if (oldStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', oldStorage);
  }
});

Deno.test('P_SaveGame writes full player, world, thinker, and special arrays', async () => {
  const wad = await Deno.readFile(new URL('../doom1.wad', import.meta.url));
  W_InitMultipleFiles([{ name: 'doom1.wad', buffer: wad.buffer }]);
  doomstat.set_gamemode(GameMode_t.shareware);
  pSetup.P_SetExternals({
    R_TextureNumForName: () => 0,
    R_FlatNumForName: () => 0,
    P_SpawnMapThing: () => {},
    P_SpawnSpecials: () => {},
    P_ResetRespawnQueue: () => {},
    R_PrecacheLevel: () => {},
    S_Start: () => {},
  });
  pSetup.P_SetupLevel(1, 1, 0, 2);

  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldPlayers = doomstat.players.slice();
  const oldActive = doomstat.playeringame.slice();
  let written = null;
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { setItem: (key, value) => { written = { key, value }; } },
  });
  doomstat.playeringame.fill(false);
  doomstat.playeringame[0] = true;
  const player = makeCompletePlayer();
  doomstat.players[0] = player;
  const mobj = new TestMobj();
  mobj.type = 0;
  mobj.state = 1;
  mobj.sprite = 0;
  mobj.radius = 20 << 16;
  mobj.height = 56 << 16;
  mobj.flags = 6;
  mobj.health = 87;
  mobj.player = player;
  player.mo = mobj;
  mobj.thinker.function = P_MobjThinker;
  mobj.thinker.__mobj = mobj;
  P_AddThinker(mobj.thinker);
  try {
    assert(P_SaveGame(2, 'complete') === true, 'complete live save failed');
    assert(written?.key === 'doom:save:2', 'numeric slot produced the wrong storage key');
    const blob = JSON.parse(written.value);
    assert(blob.version === 110, 'version marker missing');
    assert(blob.mapFingerprint.algorithm === 'sha256' &&
      /^[0-9a-f]{64}$/.test(blob.mapFingerprint.digest),
    'map content digest missing');
    assert(blob.players[0].cmd.forwardmove === -7, 'ticcmd field missing');
    assert(blob.players[0].frags[1] === -2, 'frag field missing');
    assert(blob.players[0].damagecount === 9, 'damage flash field missing');
    assert(blob.players[0].psprites[1].state === 0, 'NULL psprite was not normalized');
    assert(blob.players[0].didsecret === true, 'didsecret field missing');
    assert(blob.world.lines.length === pSetup.lines.length && blob.world.lines.length > 0,
      'live line array was not archived');
    assert(blob.world.sides.length === pSetup.sides.length && blob.world.sides.length > 0,
      'live side array was not archived');
    assert(blob.thinkers.length === 1 && blob.thinkers[0].playerIndex === 0,
      'player mobj was not archived');
    assert(Array.isArray(blob.specials), 'special array missing');
  } finally {
    P_InitThinkers();
    for (let i = 0; i < oldPlayers.length; i++) {
      doomstat.players[i] = oldPlayers[i];
      doomstat.playeringame[i] = oldActive[i];
    }
    if (oldStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', oldStorage);
  }
});
