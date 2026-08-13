import {
  R_CreateSpriteDepthPass,
  R_MarkSpriteOccluder,
  R_MarkWorldSprite,
  R_RenderRetainedLevel,
  R_SPRITE_OCCLUDER_LAYER,
  R_WORLD_SPRITE_LAYER,
} from '../src/r_sprite_depth.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

Deno.test('world sprites and wall silhouettes retain the ordinary layer', () => {
  const enabled = [];
  const object = { layers: { enable: (layer) => enabled.push(layer) } };
  R_MarkWorldSprite(object);
  R_MarkSpriteOccluder(object);
  assert(enabled.join(',') === `${R_WORLD_SPRITE_LAYER},${R_SPRITE_OCCLUDER_LAYER}`,
    `unexpected retained layers: ${enabled}`);
});

Deno.test('retained sprite pass excludes plane depth and restores renderer state', () => {
  const materialA = { colorWrite: true };
  const materialB = { colorWrite: false };
  const walls = {
    traverse(callback) {
      callback({ material: materialA });
      callback({ material: [materialA, materialB] });
    },
  };
  const things = { visible: true };
  const pass = R_CreateSpriteDepthPass(things, walls);
  assert(pass.wallMaterials.length === 2, 'wall materials were not cached uniquely');

  const events = [];
  const renderer = {
    autoClear: true,
    render(_scene, camera) {
      events.push({
        type: 'render', mask: camera.layers.mask, autoClear: this.autoClear,
        things: things.visible, a: materialA.colorWrite, b: materialB.colorWrite,
      });
    },
    clearDepth() { events.push({ type: 'clearDepth' }); },
  };
  const camera = {
    layers: {
      mask: 37,
      set(layer) { this.mask = 1 << layer; },
    },
  };

  const count = R_RenderRetainedLevel(renderer, {}, camera, pass);
  assert(count === 3, `unexpected render count ${count}`);
  assert(JSON.stringify(events) === JSON.stringify([
    { type: 'render', mask: 1, autoClear: true, things: false, a: true, b: false },
    { type: 'clearDepth' },
    { type: 'render', mask: 4, autoClear: false, things: false, a: false, b: false },
    { type: 'render', mask: 2, autoClear: false, things: true, a: false, b: false },
  ]), `split render order mismatch: ${JSON.stringify(events)}`);
  assert(renderer.autoClear === true && camera.layers.mask === 37 && things.visible === true,
    'renderer visibility state leaked after the split pass');
  assert(materialA.colorWrite === true && materialB.colorWrite === false,
    'wall color-write state leaked after the split pass');
});

Deno.test('retained sprite pass restores state when a render throws', () => {
  const material = { colorWrite: true };
  const things = { visible: true };
  const pass = R_CreateSpriteDepthPass(things, {
    traverse(callback) { callback({ material }); },
  });
  let renders = 0;
  const renderer = {
    autoClear: true,
    render() {
      renders++;
      if (renders === 2) throw new Error('expected render failure');
    },
    clearDepth() {},
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
  assert(material.colorWrite === true, 'wall material leaked from the failed split pass');
});
