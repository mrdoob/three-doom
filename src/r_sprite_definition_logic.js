const MAX_SPRITE_FRAMES = 29;
const SPRITE_ROTATIONS = 8;

function frameCharacter(frame) {
  return String.fromCharCode(65 + frame);
}

export function R_CreateSpriteDefinitionScratch() {
  const frames = new Array(MAX_SPRITE_FRAMES);
  for (let frame = 0; frame < frames.length; frame++) {
    frames[frame] = {
      rotate: -1,
      lump: new Int32Array(SPRITE_ROTATIONS),
      flip: new Uint8Array(SPRITE_ROTATIONS),
    };
  }
  const scratch = { frames, maxFrame: -1 };
  R_ResetSpriteDefinitionScratch(scratch);
  return scratch;
}

export function R_ResetSpriteDefinitionScratch(scratch) {
  scratch.maxFrame = -1;
  for (const frame of scratch.frames) {
    frame.rotate = -1;
    frame.lump.fill(-1);
    frame.flip.fill(0);
  }
}

export function R_InstallSpriteLump(
  scratch,
  firstSpriteLump,
  lump,
  frame,
  rotation,
  flipped,
  spriteName,
  fail,
) {
  // C receives unsigned frame/rotation values. JavaScript's charCodeAt can
  // instead produce NaN or a negative index for short/malformed lump names.
  if (!Number.isInteger(frame) || frame < 0 || frame >= MAX_SPRITE_FRAMES ||
      !Number.isInteger(rotation) || rotation < 0 || rotation > SPRITE_ROTATIONS) {
    fail(`R_InstallSpriteLump: Bad frame characters in lump ${lump}`);
  }

  scratch.maxFrame = Math.max(scratch.maxFrame, frame);
  const target = scratch.frames[frame];
  const frameName = frameCharacter(frame);
  if (rotation === 0) {
    if (target.rotate === false) {
      fail(`R_InitSprites: Sprite ${spriteName} frame ${frameName} has multip rot=0 lump`);
    }
    if (target.rotate === true) {
      fail(`R_InitSprites: Sprite ${spriteName} frame ${frameName} has rotations and a rot=0 lump`);
    }
    target.rotate = false;
    for (let i = 0; i < SPRITE_ROTATIONS; i++) {
      target.lump[i] = lump - firstSpriteLump;
      target.flip[i] = flipped ? 1 : 0;
    }
    return;
  }

  if (target.rotate === false) {
    fail(`R_InitSprites: Sprite ${spriteName} frame ${frameName} has rotations and a rot=0 lump`);
  }
  target.rotate = true;
  const rotationIndex = rotation - 1;
  if (target.lump[rotationIndex] !== -1) {
    fail(`R_InitSprites: Sprite ${spriteName} frame ${frameName} rotation ${rotation} has two lumps mapped to it`);
  }
  target.lump[rotationIndex] = lump - firstSpriteLump;
  target.flip[rotationIndex] = flipped ? 1 : 0;
}

export function R_ValidateSpriteDefinition(scratch, spriteName, fail) {
  if (scratch.maxFrame === -1) return 0;
  const frameCount = scratch.maxFrame + 1;
  for (let frame = 0; frame < frameCount; frame++) {
    const source = scratch.frames[frame];
    const frameName = frameCharacter(frame);
    if (source.rotate === -1) {
      fail(`R_InitSprites: No patches found for ${spriteName} frame ${frameName}`);
    }
    if (source.rotate === true) {
      for (let rotation = 0; rotation < SPRITE_ROTATIONS; rotation++) {
        if (source.lump[rotation] === -1) {
          fail(`R_InitSprites: Sprite ${spriteName} frame ${frameName} is missing rotations`);
        }
      }
    }
  }
  return frameCount;
}
