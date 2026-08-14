const mainSource = await Deno.readTextFile(
  new URL('../src/d_main.js', import.meta.url),
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test('URL warp starts a new game before synchronously loading its level', () => {
  const startup = mainSource.slice(
    mainSource.indexOf('export async function D_DoomMain()'),
  );
  const plan = startup.indexOf('const startupPlan = D_StartupArgumentPlan(myargv, detectedMode)');
  const publications = [
    'set_startskill(startupPlan.skill)',
    'set_startepisode(startupPlan.episode)',
    'set_startmap(startupPlan.map)',
    'set_autostart(startupPlan.autostart)',
  ].map((token) => startup.indexOf(token));
  const expose = startup.indexOf('// Expose to G_DoLoadLevel callers');
  const externals = startup.indexOf('_GGame.G_SetExternals({', expose);
  const init = startup.indexOf(
    '_GGame.G_InitNew(startupPlan.skill, startupPlan.episode, startupPlan.map)',
  );
  const load = startup.indexOf('_GGame.G_DoLoadLevel()');

  assert(plan >= 0 && publications.every((index) => index > plan) &&
      expose > Math.max(...publications) && externals > expose && init > externals && load > init,
    'startup must plan/publish args, wire loadLevel, then run G_InitNew -> G_DoLoadLevel');
  assert(!startup.includes('loadLevel(warp.episode, warp.map, 2)'),
    'startup still bypasses G_InitNew with a raw level setup');
  assert(!startup.includes('_GGame.G_DoNewGame()'),
    'startup must not clear -fast/-respawn/-nomonsters via G_DoNewGame');
});
