import { P_FindMapThingType } from '../src/p_mapthing_logic.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('map thing lookup resolves a known DoomEd number', () => {
  const infos = [{ doomednum: 3004 }, { doomednum: 2011 }, { doomednum: 5 }];
  const type = P_FindMapThingType(
    { type: 2011, x: 12, y: -34 },
    infos,
    (message) => { throw new Error(message); },
  );
  assertEquals(type, 1, 'resolved mobjinfo index');
});

Deno.test('map thing lookup fails with the native unknown-type diagnostic', () => {
  let error = null;
  try {
    P_FindMapThingType(
      { type: 9999, x: 12, y: -34 },
      [{ doomednum: 3004 }],
      (message) => { throw new Error(message); },
    );
  } catch (caught) {
    error = caught;
  }

  assertEquals(error instanceof Error, true, 'unknown type throws');
  assertEquals(
    error.message,
    'P_SpawnMapThing: Unknown type 9999 at (12, -34)',
    'native diagnostic',
  );
});

Deno.test('map thing start and mode filters precede unknown-type validation', async () => {
  const source = await Deno.readTextFile(new URL('../src/d_main.js', import.meta.url));
  const start = source.indexOf('const P_SpawnMapThing = (mt) =>');
  const end = source.indexOf('P_SetupSetExternals({', start);
  const body = source.slice(start, end);

  const playerStart = body.indexOf('if (mt.type >= 1 && mt.type <= 4)');
  const deathmatchStart = body.indexOf('if (mt.type === 11)');
  const skillFilter = body.indexOf('if ((mt.options & bit) === 0) return null;');
  const multiplayerFilter = body.indexOf(
    'if (ds.netgame === false && (mt.options & MTF_MULTI) !== 0) return null;',
  );
  const lookup = body.indexOf('P_FindMapThingType(mt, mobjinfo, I_Error)');

  assert(start >= 0 && end > start, 'P_SpawnMapThing body is present');
  assert(playerStart >= 0 && playerStart < lookup, 'player starts bypass lookup');
  assert(deathmatchStart >= 0 && deathmatchStart < lookup, 'deathmatch starts bypass lookup');
  assert(skillFilter >= 0 && skillFilter < lookup, 'difficulty filter bypasses lookup');
  assert(multiplayerFilter >= 0 && multiplayerFilter < lookup, 'multiplayer filter bypasses lookup');
});
