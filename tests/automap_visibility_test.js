import { ML_MAPPED, NF_SUBSECTOR } from '../src/doomdata.js';
import { ANG90, ANG180 } from '../src/tables.js';
import {
  R_BuildViewAngleMapping,
  R_CollectVisibleLinedefs,
  R_ViewAngleToX,
} from '../src/r_visibility_logic.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function vertex(x, y) { return { x: x << 16, y: y << 16 }; }
function sector(floor = 0, ceiling = 128) {
  return { floorheight: floor << 16, ceilingheight: ceiling << 16,
    floorpic: 1, ceilingpic: 2, lightlevel: 160 };
}
function line(id) { return { id, flags: 0 }; }
function seg(v1, v2, linedef, front, back = null, midtexture = 1) {
  return { v1, v2, linedef, frontsector: front, backsector: back,
    sidedef: { midtexture } };
}

function angleFrom(x1, y1, x2, y2) {
  let angle = Math.atan2(y2 - y1, x2 - x1);
  if (angle < 0) angle += Math.PI * 2;
  return Math.floor(angle / (Math.PI * 2) * 0x100000000) >>> 0;
}

function collect(segs, subsectors, nodes = []) {
  return R_CollectVisibleLinedefs({
    viewx: 0,
    viewy: 0,
    viewangle: 0,
    viewwidth: 320,
    nodes,
    numnodes: nodes.length,
    subsectors,
    segs,
    pointOnSide: () => 0,
    pointToAngle2: angleFrom,
  });
}

Deno.test('automap visibility marks front-facing lines inside the view only', () => {
  const front = sector();
  const ahead = line('ahead');
  const behind = line('behind');
  const edgeOn = line('edge-on');
  const segs = [
    seg(vertex(64, 32), vertex(64, -32), ahead, front),
    seg(vertex(-64, -32), vertex(-64, 32), behind, front),
    seg(vertex(64, -32), vertex(128, -64), edgeOn, front),
  ];
  const visible = collect(segs, [{ firstline: 0, numlines: segs.length }]);
  assert(visible.has(ahead), 'front-facing wall was not discovered');
  assert(!visible.has(behind), 'wall behind the view was discovered');
  assert(!visible.has(edgeOn), 'zero-column edge was discovered');
});

Deno.test('near solid spans hide farther linedefs but open portals do not', () => {
  const front = sector();
  const back = sector();
  const near = line('near');
  const far = line('far');
  const makeScene = (nearBack) => {
    const segs = [
      seg(vertex(32, 24), vertex(32, -24), near, front, nearBack),
      seg(vertex(96, 48), vertex(96, -48), far, front),
    ];
    // The first subsector is the front child; the second is visited afterward.
    const nodes = [{ children: new Uint16Array([NF_SUBSECTOR, NF_SUBSECTOR | 1]) }];
    const subsectors = [
      { firstline: 0, numlines: 1 },
      { firstline: 1, numlines: 1 },
    ];
    return collect(segs, subsectors, nodes);
  };

  const closed = makeScene(null);
  assert(closed.has(near), 'near solid wall was not discovered');
  assert(!closed.has(far), 'far wall was discovered through a solid span');

  const open = makeScene(back);
  assert(open.has(near), 'open portal boundary was not discovered');
  assert(open.has(far), 'far wall through an open portal was not discovered');
});

Deno.test('identical trigger-only portals remain absent from discovery', () => {
  const front = sector();
  const back = { ...front };
  const trigger = line('trigger');
  const visible = collect([
    seg(vertex(64, 32), vertex(64, -32), trigger, front, back, 0),
  ], [{ firstline: 0, numlines: 1 }]);
  assert(!visible.has(trigger), 'empty trigger line was discovered');
  assert((trigger.flags & ML_MAPPED) === 0, 'visibility helper mutated the line');
});

Deno.test('view rotation uses the same 90 degree horizontal cone', () => {
  const front = sector();
  const north = line('north');
  const segs = [seg(vertex(-32, 64), vertex(32, 64), north, front)];
  const visible = R_CollectVisibleLinedefs({
    viewx: 0,
    viewy: 0,
    viewangle: ANG90,
    viewwidth: 320,
    nodes: [],
    numnodes: 0,
    subsectors: [{ firstline: 0, numlines: 1 }],
    segs,
    pointOnSide: () => 0,
    pointToAngle2: angleFrom,
  });
  assert(visible.has(north), 'rotated forward wall was not discovered');

  const southFacing = R_CollectVisibleLinedefs({
    viewx: 0,
    viewy: 0,
    viewangle: (ANG90 + ANG180) >>> 0,
    viewwidth: 320,
    nodes: [],
    numnodes: 0,
    subsectors: [{ firstline: 0, numlines: 1 }],
    segs,
    pointOnSide: () => 0,
    pointToAngle2: angleFrom,
  });
  assert(!southFacing.has(north), 'wall behind the rotated view was discovered');
});

Deno.test('automap visibility uses native fine-angle and fencepost mapping', () => {
  const mapping = R_BuildViewAngleMapping(320);
  assert(mapping.clipangle === 0x20080000,
    `unexpected native clip angle: 0x${mapping.clipangle.toString(16)}`);
  assert(R_ViewAngleToX(0xe01f0000, mapping) === 320,
    'left-adjacent right-edge angle lost its fencepost');
  assert(R_ViewAngleToX(0xe0200000, mapping) === 319,
    'right-edge angle did not use fine-angle truncation');
  assert(R_ViewAngleToX(0xe0210000, mapping) === 319,
    'same-column edge angle diverged from viewangletox');

  for (const width of [96, 128, 160, 192, 224, 256, 288, 320]) {
    const sized = R_BuildViewAngleMapping(width);
    assert(sized.clipangle === 0x20080000,
      `view width ${width} changed the native horizontal cone`);
    let previous = width;
    for (const x of sized.viewangletox) {
      assert(x <= previous, `view width ${width} mapping is not monotone`);
      previous = x;
    }
  }
});
