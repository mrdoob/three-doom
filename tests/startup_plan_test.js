import { GameMode_t } from '../src/doomdef.js';
import { D_DemoArgumentPlan, D_StartupArgumentPlan } from '../src/d_startup_logic.js';

function assertEquals(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

Deno.test('startup defaults and skill boundaries use the native zero-based level', () => {
  assertEquals(
    D_StartupArgumentPlan([''], GameMode_t.shareware),
    { skill: 2, episode: 1, map: 1, autostart: false },
    'default plan',
  );
  assertEquals(
    D_StartupArgumentPlan(['', '-skill', '1'], GameMode_t.registered),
    { skill: 0, episode: 1, map: 1, autostart: true },
    'baby skill',
  );
  assertEquals(
    D_StartupArgumentPlan(['', '-SKILL', '5'], GameMode_t.registered),
    { skill: 4, episode: 1, map: 1, autostart: true },
    'nightmare skill',
  );
  assertEquals(
    D_StartupArgumentPlan(['', '-skill'], GameMode_t.registered),
    { skill: 2, episode: 1, map: 1, autostart: false },
    'missing skill value',
  );
});

Deno.test('-episode starts map one and clamps to the active IWAD family', () => {
  assertEquals(
    D_StartupArgumentPlan(['', '-episode', '3'], GameMode_t.registered),
    { skill: 2, episode: 3, map: 1, autostart: true },
    'registered episode',
  );
  assertEquals(
    D_StartupArgumentPlan(['', '-episode', '4'], GameMode_t.shareware),
    { skill: 2, episode: 1, map: 1, autostart: true },
    'shareware clamp',
  );
  assertEquals(
    D_StartupArgumentPlan(['', '-episode', '99'], GameMode_t.retail),
    { skill: 2, episode: 4, map: 1, autostart: true },
    'retail clamp',
  );
});

Deno.test('noncommercial -warp consumes native episode and map arguments', () => {
  assertEquals(
    D_StartupArgumentPlan(
      ['', '-skill', '4', '-episode', '3', '-warp', '2', '7'],
      GameMode_t.registered,
    ),
    { skill: 3, episode: 2, map: 7, autostart: true },
    'native Doom warp overrides episode',
  );
  assertEquals(
    D_StartupArgumentPlan(['', '-warp', '2'], GameMode_t.registered),
    { skill: 2, episode: 1, map: 1, autostart: false },
    'missing noncommercial map',
  );
  assertEquals(
    D_StartupArgumentPlan(['', '-warp', '9', '99'], GameMode_t.registered),
    { skill: 2, episode: 3, map: 9, autostart: true },
    'noncommercial target clamp',
  );
});

Deno.test('commercial -warp consumes one map and keeps the preceding episode plan', () => {
  assertEquals(
    D_StartupArgumentPlan(['', '-episode', '2', '-warp', '12'], GameMode_t.commercial),
    { skill: 2, episode: 2, map: 12, autostart: true },
    'native Doom II warp',
  );
  assertEquals(
    D_StartupArgumentPlan(['', '-warp', '0'], GameMode_t.commercial),
    { skill: 2, episode: 1, map: 1, autostart: true },
    'commercial lower map boundary',
  );
});

Deno.test('named browser maps remain compatible and valid -warp takes precedence', () => {
  assertEquals(
    D_StartupArgumentPlan(['', '-map', 'e2m3'], GameMode_t.registered),
    { skill: 2, episode: 2, map: 3, autostart: true },
    'E-style browser map',
  );
  assertEquals(
    D_StartupArgumentPlan(['', '-map', 'MAP09'], GameMode_t.commercial),
    { skill: 2, episode: 1, map: 9, autostart: true },
    'MAP-style browser map',
  );
  assertEquals(
    D_StartupArgumentPlan(
      ['', '-warp', '2', '4', '-map', 'E1M8'],
      GameMode_t.registered,
    ),
    { skill: 2, episode: 2, map: 4, autostart: true },
    'warp precedence',
  );
  assertEquals(
    D_StartupArgumentPlan(
      ['', '-warp', 'bad', '-map', 'E1M8'],
      GameMode_t.registered,
    ),
    { skill: 2, episode: 1, map: 8, autostart: true },
    'malformed warp fallback',
  );
});

Deno.test('demo planning appends .lmp and gives playdemo precedence', () => {
  assertEquals(
    D_DemoArgumentPlan(['', '-timedemo', 'bench', '-playdemo', 'demos/run?rev=2']),
    {
      kind: 'playdemo',
      argument: 'demos/run?rev=2',
      path: 'demos/run.lmp?rev=2',
      lump: 'RUN',
    },
    'playdemo precedence',
  );
  assertEquals(
    D_DemoArgumentPlan(['', '-timedemo', String.raw`C:\DEMOS\DEMO1.LMP`]),
    {
      kind: 'timedemo',
      argument: String.raw`C:\DEMOS\DEMO1.LMP`,
      path: String.raw`C:\DEMOS\DEMO1.LMP`,
      lump: 'DEMO1',
    },
    'explicit extension',
  );
  assertEquals(D_DemoArgumentPlan(['', '-playdemo']), null, 'missing demo name');
});
