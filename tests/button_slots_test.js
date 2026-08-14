import {
  P_ResetButtonsInList,
  P_StartButtonInList,
  P_UpdateButtonsInList,
} from '../src/p_switch_logic.js';

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('button allocation reuses an existing line before taking a free slot', () => {
  const buttons = Array.from(
    { length: 2 },
    () => ({ line: null, where: 0, btexture: 0, btimer: 0 }),
  );
  const line = {};
  const fail = (message) => { throw new Error(message); };

  P_StartButtonInList(buttons, line, 1, 12, 35, fail);
  P_StartButtonInList(buttons, line, 2, 99, 70, fail);

  assertEquals(buttons[0].where, 1, 'active slot location remains unchanged');
  assertEquals(buttons[0].btexture, 12, 'active slot texture remains unchanged');
  assertEquals(buttons[0].btimer, 35, 'active slot timer remains unchanged');
  assertEquals(buttons[1].btimer, 0, 'duplicate line does not consume a slot');
});

Deno.test('button allocation fails when all sixteen native slots are active', () => {
  const buttons = Array.from(
    { length: 16 },
    () => ({ line: null, where: 0, btexture: 0, btimer: 0 }),
  );
  const lines = Array.from({ length: 17 }, (_, i) => ({ id: i }));
  const fail = (message) => { throw new Error(message); };

  for (let i = 0; i < 16; i++) {
    P_StartButtonInList(buttons, lines[i], 0, i, 35, fail);
  }

  let error = null;
  try {
    P_StartButtonInList(buttons, lines[16], 0, 16, 35, fail);
  } catch (caught) {
    error = caught;
  }

  assertEquals(error instanceof Error, true, 'slot exhaustion throws');
  assertEquals(error.message, 'P_StartButton: no button slots left!', 'native diagnostic');
});

Deno.test('map reset retires stale button callbacks and restores all slots', () => {
  const buttons = Array.from(
    { length: 16 },
    () => ({ line: null, where: 0, btexture: 0, btimer: 0 }),
  );
  const oldLines = Array.from({ length: 16 }, (_, i) => ({ map: 'old', id: i }));
  const fail = (message) => { throw new Error(message); };

  for (let i = 0; i < buttons.length; i++) {
    P_StartButtonInList(buttons, oldLines[i], 2, 100 + i, 1, fail);
  }

  P_ResetButtonsInList(buttons);
  let staleCallbacks = 0;
  P_UpdateButtonsInList(buttons, () => { staleCallbacks++; });

  assertEquals(staleCallbacks, 0, 'old-map button callback count');
  for (let i = 0; i < buttons.length; i++) {
    const line = { map: 'new', id: i };
    P_StartButtonInList(buttons, line, 0, i, 35, fail);
    assertEquals(buttons[i].line, line, `reused slot ${i} line`);
    assertEquals(buttons[i].btimer, 35, `reused slot ${i} timer`);
  }
});

Deno.test('P_SpawnSpecials performs the native per-map button reset', async () => {
  const source = await Deno.readTextFile(new URL('../src/p_spec.js', import.meta.url));
  const spawn = source.indexOf('export function P_SpawnSpecials()');
  const scrollScan = source.indexOf('_scrollLines.length = 0;', spawn);
  const reset = source.indexOf('_PSwitch.P_ResetButtons();', scrollScan);
  const update = source.indexOf('export function P_UpdateSpecials()', spawn);

  assertEquals(spawn >= 0, true, 'special-spawn entry point exists');
  assertEquals(scrollScan > spawn, true, 'current-map line effects are scanned');
  assertEquals(reset > scrollScan, true, 'button slots reset after the map scan');
  assertEquals(reset < update, true, 'button slots reset during map setup');
});
