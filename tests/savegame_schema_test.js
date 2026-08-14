import * as doomstat from '../src/doomstat.js';
import {
  P_ReadSaveGame,
  P_RestoreGame,
  P_SaveGameSetExternals,
  P_ValidateSaveGame,
  SAVEGAME_FORMAT,
  SAVEGAME_VERSION,
} from '../src/p_saveg.js';
import {
  MAP_FINGERPRINT_ALGORITHM,
  MAP_FINGERPRINT_VERSION,
} from '../src/p_saveg_fingerprint.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function playerDto() {
  return {
    playerstate: 0,
    cmd: { forwardmove: 0, sidemove: 0, angleturn: 0, consistancy: 0, chatchar: 0, buttons: 0 },
    viewz: 0,
    viewheight: 41 << 16,
    deltaviewheight: 0,
    bob: 0,
    health: 100,
    armorpoints: 0,
    armortype: 0,
    powers: [0, 0, 0, 0, 0, 0],
    cards: [false, false, false, false, false, false],
    backpack: false,
    frags: [0, 0, 0, 0],
    readyweapon: 1,
    pendingweapon: 10,
    weaponowned: [true, true, false, false, false, false, false, false, false],
    ammo: [50, 0, 0, 0],
    maxammo: [200, 50, 300, 50],
    attackdown: 0,
    usedown: 0,
    cheats: 0,
    refire: 0,
    killcount: 0,
    itemcount: 0,
    secretcount: 0,
    damagecount: 0,
    bonuscount: 0,
    extralight: 0,
    fixedcolormap: 0,
    colormap: 0,
    psprites: [{ state: 0, tics: -1, sx: 0, sy: 32 << 16 }, { state: 0, tics: 0, sx: 0, sy: 32 << 16 }],
    didsecret: false,
  };
}

function mobjDto(id, playerIndex = null) {
  return {
    id,
    x: 1,
    y: 2,
    z: 3,
    angle: 0xffffffff,
    sprite: 0,
    frame: 0x8000,
    floorz: 0,
    ceilingz: 128 << 16,
    radius: 20 << 16,
    height: 56 << 16,
    momx: 4,
    momy: 5,
    momz: 6,
    validcount: 7,
    type: 0,
    tics: 8,
    state: 1,
    flags: 6,
    health: 100,
    movedir: 8,
    movecount: 9,
    reactiontime: 10,
    threshold: 11,
    lastlook: 3,
    spawnpoint: { x: 12, y: 13, angle: 90, type: 1, options: 7 },
    playerIndex,
    targetId: null,
    tracerId: null,
  };
}

function validSave() {
  return {
    format: SAVEGAME_FORMAT,
    version: SAVEGAME_VERSION,
    description: 'schema fixture',
    when: 123,
    episode: 1,
    map: 1,
    skill: 2,
    leveltime: 456,
    playeringame: [true, false, false, false],
    mapFingerprint: {
      version: MAP_FINGERPRINT_VERSION,
      algorithm: MAP_FINGERPRINT_ALGORITHM,
      digest: '00'.repeat(32),
      sectors: 1,
      lines: 1,
      sides: 1,
    },
    players: [playerDto(), null, null, null],
    world: {
      sectors: [{
        floorheight: 0,
        ceilingheight: 128 << 16,
        floorpic: 1,
        ceilingpic: 2,
        lightlevel: 160,
        special: 0,
        tag: 3,
      }],
      lines: [{ flags: 4, special: 5, tag: 6 }],
      sides: [{
        textureoffset: 7,
        rowoffset: 8,
        toptexture: 9,
        bottomtexture: 10,
        midtexture: 11,
      }],
    },
    thinkers: [mobjDto(0, 0)],
    specials: [],
  };
}

P_SaveGameSetExternals({ NUMMOBJTYPES: 137, NUMSPRITES: 138, NUMSTATES: 967 });

Deno.test('save schema normalizes a complete version-110 DTO', () => {
  const source = validSave();
  const normalized = P_ValidateSaveGame(source);
  assert(normalized !== false, 'complete save rejected');
  assert(normalized !== source, 'validator returned mutable input object');
  assert(normalized.players[0].cmd !== source.players[0].cmd, 'nested player command not detached');
  assert(normalized.world.lines[0].special === 5, 'line state was not preserved');
  assert(normalized.world.sides[0].midtexture === 11, 'side state was not preserved');
  assert(normalized.thinkers[0].spawnpoint.options === 7, 'spawnpoint was not preserved');
  assert(normalized.mapFingerprint.digest === '00'.repeat(32), 'map digest was not preserved');
});

Deno.test('save schema rejects unauthenticated legacy count-only fingerprints', () => {
  const legacy = validSave();
  delete legacy.mapFingerprint.version;
  delete legacy.mapFingerprint.algorithm;
  delete legacy.mapFingerprint.digest;
  assert(P_ValidateSaveGame(legacy) === false, 'legacy count-only fingerprint was accepted');
});

Deno.test('reading a legacy count-only browser save leaves its slot untouched', () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const legacy = validSave();
  delete legacy.mapFingerprint.version;
  delete legacy.mapFingerprint.algorithm;
  delete legacy.mapFingerprint.digest;
  const raw = JSON.stringify(legacy);
  const entries = new Map([['doom:save:0', raw]]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key) => entries.get(key) ?? null },
  });
  try {
    assert(P_ReadSaveGame(0) === false, 'legacy browser save was accepted');
    assert(entries.get('doom:save:0') === raw, 'legacy browser save was removed or rewritten');
  } finally {
    if (oldStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', oldStorage);
  }
});

Deno.test('save schema requires one player-owned mobj for every active player', () => {
  const noActivePlayers = validSave();
  noActivePlayers.playeringame.fill(false);
  noActivePlayers.players.fill(null);
  noActivePlayers.thinkers[0].playerIndex = null;
  assert(P_ValidateSaveGame(noActivePlayers) === false, 'save with no active player was accepted');

  const missing = validSave();
  missing.thinkers[0].playerIndex = null;
  assert(P_ValidateSaveGame(missing) === false, 'missing active player mobj was accepted');

  const duplicate = validSave();
  duplicate.thinkers.push(mobjDto(1, 0));
  assert(P_ValidateSaveGame(duplicate) === false, 'duplicate active player mobj was accepted');

  const inactiveOwner = validSave();
  inactiveOwner.thinkers.push(mobjDto(1, 1));
  assert(P_ValidateSaveGame(inactiveOwner) === false, 'inactive player owner was accepted');
});

Deno.test('P_ReadSaveGame rejects corrupt slots without mutating live globals', () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldEpisode = doomstat.gameepisode;
  const oldMap = doomstat.gamemap;
  const oldSkill = doomstat.gameskill;
  const oldLeveltime = doomstat.leveltime;
  const entries = new Map([
    ['doom:save:0', JSON.stringify({ ...validSave(), version: 109 })],
    ['doom:save:1', '{broken'],
  ]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (key) => entries.get(key) ?? null },
  });
  try {
    assert(P_ReadSaveGame(0) === false, 'wrong-version slot was accepted');
    assert(P_ReadSaveGame(1) === false, 'malformed JSON slot was accepted');
    assert(P_ReadSaveGame('doom:save:0') === false, 'prefixed string slot was accepted');
    assert(P_ReadSaveGame(6) === false, 'out-of-range numeric slot was accepted');
    assert(doomstat.gameepisode === oldEpisode, 'read mutated episode');
    assert(doomstat.gamemap === oldMap, 'read mutated map');
    assert(doomstat.gameskill === oldSkill, 'read mutated skill');
    assert(doomstat.leveltime === oldLeveltime, 'read mutated leveltime');
  } finally {
    if (oldStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', oldStorage);
  }
});

Deno.test('P_RestoreGame validates the complete graph before mutating globals', () => {
  const corrupt = validSave();
  corrupt.thinkers[0].targetId = 99;
  const before = {
    episode: doomstat.gameepisode,
    map: doomstat.gamemap,
    skill: doomstat.gameskill,
    leveltime: doomstat.leveltime,
    playeringame: doomstat.playeringame.slice(),
  };
  assert(P_RestoreGame(corrupt) === false, 'corrupt reference reached restore commit');
  assert(doomstat.gameepisode === before.episode, 'failed restore mutated episode');
  assert(doomstat.gamemap === before.map, 'failed restore mutated map');
  assert(doomstat.gameskill === before.skill, 'failed restore mutated skill');
  assert(doomstat.leveltime === before.leveltime, 'failed restore mutated leveltime');
  assert(JSON.stringify(doomstat.playeringame) === JSON.stringify(before.playeringame),
    'failed restore mutated player topology');
});
