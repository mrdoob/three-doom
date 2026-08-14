import { P_StartButtonInList } from '../src/p_switch_logic.js';

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
