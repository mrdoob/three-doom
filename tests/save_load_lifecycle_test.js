const gameSource = await Deno.readTextFile(
  new URL('../src/g_game.js', import.meta.url),
);
const mainSource = await Deno.readTextFile(
  new URL('../src/d_main.js', import.meta.url),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test('save load restores synchronously between base setup and one renderer build', () => {
  const loadGame = gameSource.slice(
    gameSource.indexOf('export function G_DoLoadGame()'),
    gameSource.indexOf('// Level completion / world transitions.'),
  );
  const read = loadGame.indexOf('const blob = _readSave(_loadName)');
  const validate = loadGame.indexOf('_validateSaveMap(blob)');
  const topology = loadGame.indexOf('playeringame[i] = blob.playeringame[i] === true');
  const init = loadGame.indexOf('G_InitNew(blob.skill, blob.episode, blob.map)');
  const restore = loadGame.indexOf('const result = _restoreSave(blob)');
  const load = loadGame.indexOf('G_DoLoadLevel()');
  assert(read >= 0 && validate > read && topology > validate && init > topology &&
    restore > init && load > restore,
  'load game ordering drifted away from validate -> topology -> base -> restore');
  assert(!loadGame.includes('__P_LoadGame'), 'legacy global load hook survived');

  const loadLevel = mainSource.slice(
    mainSource.indexOf('const loadLevel = ('),
    mainSource.indexOf('const validateSaveMap = ('),
  );
  const shutdown = loadLevel.indexOf('R_Shutdown()');
  const setup = loadLevel.indexOf('P_SetupLevel(episode, map, 0, skill)');
  const afterSetup = loadLevel.indexOf('const result = afterSetup()');
  const clearAfterRestore = loadLevel.indexOf('mobjsByMapThing.clear()', afterSetup);
  const fallback = loadLevel.indexOf('for (let i = 0; i < doomstat.playeringame.length; i++)');
  const build = loadLevel.indexOf('R_NewMap()');
  assert(shutdown >= 0 && setup > shutdown && afterSetup > setup &&
    clearAfterRestore > afterSetup && fallback > clearAfterRestore && build > fallback,
  'renderer lifecycle must be teardown -> setup -> restore -> fallback -> one build');
  assert(loadLevel.indexOf('R_NewMap()', build + 1) === -1,
    'loadLevel contains more than one renderer build');
});

Deno.test('save preflight fingerprints the target WAD before live-level mutation', () => {
  const validate = mainSource.slice(
    mainSource.indexOf('const validateSaveMap = ('),
    mainSource.indexOf('// Expose to G_DoLoadLevel callers'),
  );
  for (const token of [
    'W_CheckNumForName(mapName)',
    'P_GetMapFingerprintForLump(lumpnum)',
    'P_MapFingerprintsEqual(',
  ]) {
    assert(validate.includes(token), `target-map validation is missing ${token}`);
  }
  assert(!gameSource.includes('__P_SaveGame') && !gameSource.includes('__P_LoadGame'),
    'save/load orchestration still relies on global hooks');
});
