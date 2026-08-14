import {
  DEMO_MARKER,
  G_DecodeDemoTiccmd,
  G_DemoCanWriteTiccmd,
  G_EncodeDemoTiccmd,
  G_ValidateDemoStream,
} from '../src/g_demo.js';

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('demo ticcmd codec applies vanilla byte and signed-short narrowing', () => {
  const cases = [
    { angle: -32768, byte: 0x80, decoded: -32768 },
    { angle: -320,   byte: 0xff, decoded: -256 },
    { angle: -129,   byte: 0xff, decoded: -256 },
    { angle: -128,   byte: 0x00, decoded: 0 },
    { angle: 127,    byte: 0x00, decoded: 0 },
    { angle: 128,    byte: 0x01, decoded: 256 },
    { angle: 32760,  byte: 0x80, decoded: -32768 },
  ];

  for (const test of cases) {
    const source = {
      forwardmove: 130,
      sidemove: -129,
      angleturn: test.angle,
      buttons: 0x1ff,
    };
    const bytes = G_EncodeDemoTiccmd(source);
    assertEquals(bytes[0], 130, `forward byte at angle ${test.angle}`);
    assertEquals(bytes[1], 127, `side byte at angle ${test.angle}`);
    assertEquals(bytes[2], test.byte, `angle byte at angle ${test.angle}`);
    assertEquals(bytes[3], 255, `button byte at angle ${test.angle}`);

    const decoded = { consistancy: 1234, chatchar: 65 };
    const next = G_DecodeDemoTiccmd(bytes, 0, decoded);
    assertEquals(next, 4, `next offset at angle ${test.angle}`);
    assertEquals(decoded.forwardmove, -126, `forward decode at angle ${test.angle}`);
    assertEquals(decoded.sidemove, 127, `side decode at angle ${test.angle}`);
    assertEquals(decoded.angleturn, test.decoded, `angle decode at angle ${test.angle}`);
    assertEquals(decoded.buttons, 255, `button decode at angle ${test.angle}`);
    assertEquals(decoded.consistancy, 1234, `consistancy preservation at angle ${test.angle}`);
    assertEquals(decoded.chatchar, 65, `chat preservation at angle ${test.angle}`);
  }
});

Deno.test('demo ticcmd decoder honors a stream offset', () => {
  const cmd = {};
  const next = G_DecodeDemoTiccmd([99, 98, 0xff, 0x80, 0xff, 0xa5], 2, cmd);
  assertEquals(next, 6, 'next offset');
  assertEquals(cmd.forwardmove, -1, 'signed forward');
  assertEquals(cmd.sidemove, -128, 'signed side');
  assertEquals(cmd.angleturn, -256, 'signed angle');
  assertEquals(cmd.buttons, 0xa5, 'buttons');
});

Deno.test('demo capacity preserves the reference sixteen-byte tail reserve', () => {
  assertEquals(G_DemoCanWriteTiccmd(13, 29), true, 'exact reserve boundary');
  assertEquals(G_DemoCanWriteTiccmd(14, 29), false, 'first byte beyond boundary');
  assertEquals(G_DemoCanWriteTiccmd(0x1fff0, 0x20000), true, 'default final start');
  assertEquals(G_DemoCanWriteTiccmd(0x1fff1, 0x20000), false, 'default overflow');
});

Deno.test('demo validation rejects malformed streams before level setup', () => {
  const header = [109, 2, 1, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0];
  const valid = G_ValidateDemoStream([...header, 1, 2, 3, 4, DEMO_MARKER]);
  assertEquals(valid.valid, true, 'valid stream');
  assertEquals(valid.commandOffset, 13, 'command offset');
  assertEquals(valid.markerOffset, 17, 'marker offset');
  assertEquals(valid.header.skill, 2, 'skill');
  assertEquals(valid.header.playeringame[0], true, 'console topology');

  const cases = [
    { bytes: header.slice(0, 12), error: 'header is shorter than 13 bytes' },
    {
      bytes: [108, ...header.slice(1), DEMO_MARKER],
      error: 'version 108 does not match engine 109',
    },
    {
      bytes: [...header.slice(0, 9), 0, 0, 0, 0, DEMO_MARKER],
      error: 'header has no active players',
    },
    {
      bytes: [...header.slice(0, 8), 2, 1, 0, 0, 0, DEMO_MARKER],
      error: 'console player 2 is not active',
    },
    { bytes: header, error: 'stream has no end marker' },
    { bytes: [...header, 1, 2, 3], error: 'ticcmd at byte 13 is truncated' },
  ];
  for (const test of cases) {
    const result = G_ValidateDemoStream(test.bytes);
    assertEquals(result.valid, false, test.error);
    assertEquals(result.error, test.error, test.error);
  }
});
