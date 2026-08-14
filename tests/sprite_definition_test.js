import {
  R_CreateSpriteDefinitionScratch,
  R_InstallSpriteLump,
  R_ResetSpriteDefinitionScratch,
  R_ValidateSpriteDefinition,
} from '../src/r_sprite_definition_logic.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function fail(message) {
  throw new Error(message);
}

function assertThrows(fn, expected) {
  try {
    fn();
  } catch (error) {
    if (error.message.includes(expected)) return;
    throw new Error(`expected ${JSON.stringify(expected)}, got ${JSON.stringify(error.message)}`);
  }
  throw new Error(`expected ${JSON.stringify(expected)} to throw`);
}

function install(scratch, lump, frame, rotation, flipped = false) {
  R_InstallSpriteLump(
    scratch, 100, lump, frame, rotation, flipped, 'TEST', fail,
  );
}

function freshScratch() {
  return R_CreateSpriteDefinitionScratch();
}

Deno.test('sprite definitions reject malformed frame and rotation characters', () => {
  for (const [frame, rotation] of [[NaN, 0], [-1, 0], [29, 0], [0, NaN], [0, -1], [0, 9]]) {
    assertThrows(
      () => install(freshScratch(), 100, frame, rotation),
      'Bad frame characters',
    );
  }
});

Deno.test('sprite definitions reject duplicate and mixed rotation modes', () => {
  let scratch = freshScratch();
  install(scratch, 100, 0, 0);
  assertThrows(() => install(scratch, 101, 0, 0), 'multip rot=0 lump');

  scratch = freshScratch();
  install(scratch, 100, 0, 0);
  assertThrows(
    () => install(scratch, 101, 0, 1),
    'has rotations and a rot=0 lump',
  );

  scratch = freshScratch();
  install(scratch, 100, 0, 1);
  assertThrows(
    () => install(scratch, 101, 0, 0),
    'has rotations and a rot=0 lump',
  );

  scratch = freshScratch();
  install(scratch, 100, 0, 1);
  assertThrows(() => install(scratch, 101, 0, 1), 'has two lumps mapped to it');
});

Deno.test('sprite definitions require consecutive complete frames', () => {
  let scratch = freshScratch();
  install(scratch, 100, 0, 0);
  install(scratch, 101, 2, 0);
  assertThrows(
    () => R_ValidateSpriteDefinition(scratch, 'TEST', fail),
    'No patches found for TEST frame B',
  );

  scratch = freshScratch();
  install(scratch, 100, 0, 1);
  assertThrows(
    () => R_ValidateSpriteDefinition(scratch, 'TEST', fail),
    'Sprite TEST frame A is missing rotations',
  );
});

Deno.test('combined lumps produce one complete flippable rotation frame', () => {
  const scratch = freshScratch();
  for (let rotation = 1; rotation <= 4; rotation++) {
    install(scratch, 99 + rotation, 0, rotation);
    install(scratch, 99 + rotation, 0, 9 - rotation, true);
  }
  assert(R_ValidateSpriteDefinition(scratch, 'TEST', fail) === 1, 'frame count');
  const frame = scratch.frames[0];
  assert(frame.rotate === true, 'frame must use rotations');
  assert([...frame.lump].every((lump) => lump >= 0), 'every rotation needs a lump');
  assert([...frame.flip].join(',') === '0,0,0,0,1,1,1,1', 'combined aliases flip 5..8');
});

Deno.test('sprite definition scratch resets every frame and rotation slot', () => {
  const scratch = freshScratch();
  install(scratch, 100, 3, 0, true);
  R_ResetSpriteDefinitionScratch(scratch);
  assert(scratch.maxFrame === -1, 'maximum frame reset');
  for (const frame of scratch.frames) {
    assert(frame.rotate === -1, 'rotation mode reset');
    assert([...frame.lump].every((lump) => lump === -1), 'lump slots reset');
    assert([...frame.flip].every((flip) => flip === 0), 'flip slots reset');
  }
});
