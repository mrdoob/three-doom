import {
  R_CreateSpriteDepthPass,
  R_MarkWorldSprite,
  R_RenderRetainedLevel,
  R_SPRITE_EQUAL_DEPTH,
  R_WORLD_SPRITE_LAYER,
} from '../src/r_sprite_depth.js';

const LESS_EQUAL_DEPTH = 3;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test('world sprites retain the ordinary layer and add the repair layer', () => {
  const enabled = [];
  const object = { layers: { enable: (layer) => enabled.push(layer) } };
  R_MarkWorldSprite(object);
  assert(enabled.join(',') === `${R_WORLD_SPRITE_LAYER}`,
    `unexpected retained layers: ${enabled}`);
});

Deno.test('fallback material discovery deduplicates shared sprite materials', () => {
  const shared = { depthFunc: LESS_EQUAL_DEPTH };
  const things = {
    userData: {},
    traverse(callback) {
      callback({ isSprite: true, material: shared });
      callback({ isSprite: true, material: shared });
    },
  };
  const pass = R_CreateSpriteDepthPass(things, { value: 0 });
  assert(pass.spriteMaterials.length === 1,
    `shared sprite material was registered ${pass.spriteMaterials.length} times`);
});

Deno.test('retained sprite pass matches overhangs to support-plane depth and restores state', () => {
  const materialA = { depthFunc: LESS_EQUAL_DEPTH };
  const materialB = { depthFunc: 1234 };
  const things = {
    visible: true,
    userData: { doomSpriteMaterials: [materialA, materialB] },
  };
  const floorPass = { value: 0 };
  const pass = R_CreateSpriteDepthPass(things, floorPass);
  assert(pass.spriteMaterials.length === 2, 'sprite materials were not cached');

  const events = [];
  const renderer = {
    autoClear: true,
    render(_scene, camera) {
      events.push({
        type: 'render', mask: camera.layers.mask, autoClear: this.autoClear,
        things: things.visible, floorPass: floorPass.value,
        a: materialA.depthFunc, b: materialB.depthFunc,
      });
    },
  };
  const camera = {
    layers: {
      mask: 37,
      set(layer) { this.mask = 1 << layer; },
    },
  };

  const count = R_RenderRetainedLevel(renderer, {}, camera, pass);
  assert(count === 2, `unexpected render count ${count}`);
  assert(JSON.stringify(events) === JSON.stringify([
    { type: 'render', mask: 1, autoClear: true, things: true,
      floorPass: 1, a: LESS_EQUAL_DEPTH, b: 1234 },
    { type: 'render', mask: 2, autoClear: false, things: true,
      floorPass: 2, a: R_SPRITE_EQUAL_DEPTH, b: R_SPRITE_EQUAL_DEPTH },
  ]), `split render order mismatch: ${JSON.stringify(events)}`);
  assert(renderer.autoClear === true && camera.layers.mask === 37 && things.visible === true,
    'renderer visibility state leaked after the split pass');
  assert(materialA.depthFunc === LESS_EQUAL_DEPTH && materialB.depthFunc === 1234,
    'sprite depth-function state leaked after the split pass');
  assert(floorPass.value === 0, 'sprite floor-pass mode leaked after the split pass');
});

Deno.test('retained sprite pass restores state when a render throws', () => {
  const material = { depthFunc: LESS_EQUAL_DEPTH };
  const things = {
    visible: true,
    userData: { doomSpriteMaterials: [material] },
  };
  const floorPass = { value: 0 };
  const pass = R_CreateSpriteDepthPass(things, floorPass);
  let renders = 0;
  const renderer = {
    autoClear: true,
    render() {
      renders++;
      if (renders === 2) throw new Error('expected render failure');
    },
  };
  const camera = {
    layers: { mask: 11, set(layer) { this.mask = 1 << layer; } },
  };
  let threw = false;
  try {
    R_RenderRetainedLevel(renderer, {}, camera, pass);
  } catch (error) {
    threw = error.message === 'expected render failure';
  }
  assert(threw, 'split pass swallowed the render failure');
  assert(renderer.autoClear === true && camera.layers.mask === 11 && things.visible === true,
    'renderer state leaked from the failed split pass');
  assert(material.depthFunc === LESS_EQUAL_DEPTH, 'sprite depth function leaked from the failed pass');
  assert(floorPass.value === 0, 'sprite floor-pass mode leaked from the failed split pass');
});
