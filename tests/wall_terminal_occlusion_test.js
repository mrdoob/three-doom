import { R_NeedsTerminalDepthOccluder } from '../src/r_wall_occlusion.js';

function sector(floor, ceiling) {
  return { floorheight: floor * 65536, ceilingheight: ceiling * 65536 };
}

function side({ middle = 0, top = 0, bottom = 0 } = {}) {
  return { midtexture: middle, toptexture: top, bottomtexture: bottom };
}

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

Deno.test('one-sided lines need terminal depth only when their middle texture is missing', () => {
  const front = sector(0, 128);
  assertEquals(
    R_NeedsTerminalDepthOccluder(front, null, side({ middle: 0 })),
    true,
    'missing middle texture',
  );
  assertEquals(
    R_NeedsTerminalDepthOccluder(front, null, side({ middle: 12 })),
    false,
    'textured middle wall already writes depth',
  );
});

Deno.test('closed two-sided lines use the missing tier for the current side', () => {
  const high = sector(72, 80);
  const low = sector(-16, 48);

  assertEquals(
    R_NeedsTerminalDepthOccluder(high, low, side({ top: 0, bottom: 9 })),
    true,
    'high side needs its missing upper tier',
  );
  assertEquals(
    R_NeedsTerminalDepthOccluder(high, low, side({ top: 9, bottom: 0 })),
    false,
    'present upper tier covers the high side',
  );
  assertEquals(
    R_NeedsTerminalDepthOccluder(low, high, side({ top: 9, bottom: 0 })),
    true,
    'low side needs its missing lower tier',
  );
  assertEquals(
    R_NeedsTerminalDepthOccluder(low, high, side({ top: 0, bottom: 9 })),
    false,
    'present lower tier covers the low side',
  );
});

Deno.test('open and zero-height interior portals are not promoted to solid spans', () => {
  const front = sector(0, 128);
  assertEquals(
    R_NeedsTerminalDepthOccluder(front, sector(24, 96), side()),
    false,
    'ordinary open window',
  );
  // Stock E1M4 contains this construction. Although the back interval has no
  // height, neither exact r_bsp.c closed-door inequality is true.
  assertEquals(
    R_NeedsTerminalDepthOccluder(sector(136, 248), sector(144, 144), side()),
    false,
    'interior zero-height sector',
  );
});

Deno.test('closed-span equality follows the reference inclusive comparisons', () => {
  assertEquals(
    R_NeedsTerminalDepthOccluder(sector(64, 128), sector(0, 64), side({ top: 0 })),
    true,
    'back ceiling equal to front floor',
  );
  assertEquals(
    R_NeedsTerminalDepthOccluder(sector(0, 64), sector(64, 128), side({ bottom: 0 })),
    true,
    'back floor equal to front ceiling',
  );
});
