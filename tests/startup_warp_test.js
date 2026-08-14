const mainSource = await Deno.readTextFile(
  new URL('../src/d_main.js', import.meta.url),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test('URL warp starts a new game before synchronously loading its level', () => {
  const startup = mainSource.slice(
    mainSource.indexOf('// Expose to G_DoLoadLevel callers'),
    mainSource.indexOf('function parseMapParam()'),
  );
  const externals = startup.indexOf('_GGame.G_SetExternals({');
  const parse = startup.indexOf('const warp = parseMapParam()');
  const init = startup.indexOf('_GGame.G_InitNew(2, warp.episode, warp.map)');
  const load = startup.indexOf('_GGame.G_DoLoadLevel()');

  assert(externals >= 0 && parse > externals && init > parse && load > init,
    'startup must wire loadLevel before G_InitNew -> G_DoLoadLevel');
  assert(!startup.includes('loadLevel(warp.episode, warp.map, 2)'),
    'startup still bypasses G_InitNew with a raw level setup');
  assert(!startup.includes('_GGame.G_DoNewGame()'),
    'startup must not clear -fast/-respawn/-nomonsters via G_DoNewGame');
});
