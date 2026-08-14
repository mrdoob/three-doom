import {
  R_TextureColumnPeriod,
  R_WallTextureUV,
} from '../src/r_texture_logic.js';

function assertEquals(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test('wall column period is the next-lower power of two', () => {
  const cases = [
    [1, 1], [2, 2], [3, 2], [15, 8], [16, 16], [24, 16],
    [63, 32], [64, 64], [96, 64], [300, 256], [1024, 1024],
  ];
  for (const [width, expected] of cases) {
    assertEquals(R_TextureColumnPeriod(width), expected, `width ${width}`);
  }
});

Deno.test('wall build and scrolling UVs use the masked column period', () => {
  assertEquals(
    R_WallTextureUV(0, 24, R_TextureColumnPeriod(24)),
    { u0: 0, u1: 1.5 },
    'declared 24-column texture repeats after column 15',
  );
  assertEquals(
    R_WallTextureUV(5, 31, 16),
    { u0: 0.3125, u1: 2.25 },
    'positive scrolling offset',
  );
  assertEquals(
    R_WallTextureUV(-3, 20, 16),
    { u0: -0.1875, u1: 1.0625 },
    'negative scrolling offset',
  );
});
