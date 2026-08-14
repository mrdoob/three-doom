import {
  R_ClearPspriteFuzzCapture,
  R_FUZZ_COLORMAP_ROW,
  R_FUZZ_OFFSETS,
  R_FUZZ_TABLE_LENGTH,
  R_FuzzOffsetAt,
  R_GetPspriteFuzzCapture,
  R_RasterizeFuzzPatch,
  R_SetFuzzPhase,
  R_StorePspriteFuzzCapture,
} from '../src/r_fuzz.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('fuzz offsets exactly match linuxdoom and wrap deterministically', () => {
  const reference = [
    1, -1, 1, -1, 1, 1, -1,
    1, 1, -1, 1, 1, 1, -1,
    1, 1, 1, -1, -1, -1, -1,
    1, -1, -1, 1, 1, 1, 1, -1,
    1, -1, 1, 1, -1, -1, 1,
    1, -1, -1, -1, -1, 1, 1,
    1, 1, -1, 1, 1, -1, 1,
  ];
  assertEquals(R_FUZZ_TABLE_LENGTH, 50, 'FUZZTABLE length');
  assertEquals(R_FUZZ_OFFSETS.join(','), reference.join(','), 'fuzzoffset signs');
  for (let phase = -100; phase <= 100; phase++) {
    for (let position = -100; position <= 100; position++) {
      const index = ((phase + position) % 50 + 50) % 50;
      assertEquals(R_FuzzOffsetAt(position, phase), reference[index],
        `position=${position} phase=${phase}`);
    }
  }
  R_SetFuzzPhase(0);
});

Deno.test('psprite index readback flips WebGL rows and clears outside a reduced view', () => {
  // 3x2 RGBA target in WebGL bottom-origin order. Only red is authoritative.
  const rgba = new Uint8Array([
    10, 99, 88, 255, 11, 99, 88, 255, 12, 99, 88, 255,
    20, 77, 66, 255, 21, 77, 66, 255, 22, 77, 66, 255,
  ]);
  const indices = R_StorePspriteFuzzCapture(rgba, 3, 2, 1, 1, 6, 5);
  assertEquals(indices.length, 30, 'logical screen allocation');
  assertEquals(indices[1 * 6 + 1], 20, 'top logical row comes from last GL row');
  assertEquals(indices[1 * 6 + 3], 22, 'top logical row preserves X');
  assertEquals(indices[2 * 6 + 1], 10, 'bottom logical row comes from first GL row');
  assertEquals(indices[2 * 6 + 3], 12, 'bottom logical row preserves X');
  assertEquals(indices[0], 0, 'outside-view index clears to palette index 0');
  assert(R_GetPspriteFuzzCapture() === indices, 'capture is published without RGB conversion');
  R_ClearPspriteFuzzCapture();
  assertEquals(R_GetPspriteFuzzCapture(), null, 'cleared capture is not reused');
});

function grayscaleFixture(width, height) {
  const maps = new Uint8Array(34 * 256);
  for (let index = 0; index < 256; index++) {
    maps[R_FUZZ_COLORMAP_ROW * 256 + index] = (index + 10) & 255;
  }
  const background = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      background[y * width + x] = y;
    }
  }
  return { maps, background };
}

Deno.test('Canvas fuzz samples vertical neighbours in column order and applies row 6', () => {
  const width = 4;
  const height = 5;
  const { maps, background } = grayscaleFixture(width, height);
  const output = new Uint8Array(background.length);
  const outputAlpha = new Uint8Array(background.length);
  const result = R_RasterizeFuzzPatch({
    background,
    output,
    outputAlpha,
    screenWidth: width,
    screenHeight: height,
    mask: new Uint8Array(2 * 5).fill(255),
    sourceWidth: 2,
    sourceHeight: 5,
    bounds: { left: 1, top: 0, right: 3, bottom: 5, width: 2, height: 5 },
    phase: 0,
    colormaps: maps,
  });

  assertEquals(result.pixels, 6, 'protected top/bottom rows are skipped');
  assertEquals(result.phase, 6, 'fuzzpos advances once per drawn mask pixel');
  // First column offsets are +1,-1,+1. The -1 read observes the row already
  // replaced immediately above, just as the in-place C framebuffer does.
  assertEquals(output[1 * width + 1], 12, 'x1 y1 copies row 2 then remaps');
  assertEquals(output[2 * width + 1], 22, 'x1 y2 copies the replaced row 1');
  assertEquals(output[3 * width + 1], 14, 'x1 y3 copies row 4');
  // The next column continues at table entry 3: -1,+1,+1.
  assertEquals(output[1 * width + 2], 10, 'x2 y1 copies row 0');
  assertEquals(output[2 * width + 2], 13, 'x2 y2 copies row 3');
  assertEquals(output[3 * width + 2], 14, 'x2 y3 copies row 4');
  assertEquals(outputAlpha[0 * width + 1], 0, 'top view row remains untouched');
  assertEquals(outputAlpha[4 * width + 1], 0, 'bottom view row remains untouched');
});

Deno.test('Canvas fuzz is deterministic and preserves colliding palette indices', () => {
  const run = (mask) => {
    const fixture = grayscaleFixture(4, 5);
    // Index 200 may have the same displayed RGB as another PLAYPAL entry; the
    // raster never sees RGB and therefore cannot collapse it to that entry.
    fixture.background[2 * 4 + 1] = 200;
    const output = new Uint8Array(fixture.background.length);
    const outputAlpha = new Uint8Array(fixture.background.length);
    const result = R_RasterizeFuzzPatch({
      background: fixture.background,
      output,
      outputAlpha,
      screenWidth: 4,
      screenHeight: 5,
      mask,
      sourceWidth: 2,
      sourceHeight: 5,
      bounds: { left: 1, top: 0, right: 3, bottom: 5, width: 2, height: 5 },
      phase: 0,
      colormaps: fixture.maps,
    });
    return { output, result };
  };
  const mask = new Uint8Array(10).fill(255);
  const first = run(mask);
  const second = run(Uint8Array.from(mask));
  assertEquals(first.output.join(','), second.output.join(','), 'same inputs reproduce pixels');
  assertEquals(first.result.phase, second.result.phase, 'same inputs reproduce fuzzpos');
  assertEquals(first.output[1 * 4 + 1], 210,
    'row-6 remap uses exact index 200 without palette RGB ambiguity');
});
