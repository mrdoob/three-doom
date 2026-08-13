// Doom draws floor/ceiling visplanes before masked objects, then clips world
// sprites only against the wall silhouettes collected by R_StoreWallRange.
// The retained Three.js renderer needs a narrow repair pass: its normal depth
// buffer contains physical floor planes, which otherwise cut off authored
// sprite rows below thing->z (five pixels on stock imp frames). The repair
// redraws only those rows at the support plane's exact projected depth, so an
// unrelated nearer floor or wall remains an occluder.

// Three.js r184 Material depth-function constants. Keeping this compositor
// module dependency-free lets its render-order/state contract run in Deno.
const THREE_LESS_EQUAL_DEPTH = 3;
export const R_SPRITE_EQUAL_DEPTH = 4;

export const R_SPRITE_PASS_FULL = 0;
export const R_SPRITE_PASS_BODY = 1;
export const R_SPRITE_PASS_FLOOR_OVERHANG = 2;
export const spriteFloorPassUniform = { value: R_SPRITE_PASS_FULL };

export const R_WORLD_LAYER = 0;
export const R_WORLD_SPRITE_LAYER = 1;

export function R_MarkWorldSprite(object) {
  object.layers.enable(R_WORLD_SPRITE_LAYER);
}

// Render a retained Doom level in the reference draw order:
//   1. world geometry and the source rows on/above each actor's floor render;
//   2. rows below that floor redraw only where EqualDepth proves the retained
//      depth belongs to the same horizontal support plane.
// Objects stay on layer 0 as well, so direct renderer.render() calls retain
// their ordinary single-pass behaviour for diagnostics and resource warmup.
export function R_CreateSpriteDepthPass(things, floorPassUniform) {
  let spriteMaterials = things?.userData?.doomSpriteMaterials;
  if (!Array.isArray(spriteMaterials)) {
    spriteMaterials = [];
    things?.traverse?.((object) => {
      if (object.isSprite === true && object.material !== null &&
          object.material !== undefined &&
          !spriteMaterials.includes(object.material)) {
        spriteMaterials.push(object.material);
      }
    });
  }
  return {
    things,
    floorPassUniform,
    spriteMaterials,
    savedSpriteDepthFuncs: new Array(spriteMaterials.length).fill(THREE_LESS_EQUAL_DEPTH),
  };
}

export function R_RenderRetainedLevel(renderer, targetScene, targetCamera, pass) {
  if (pass === null || pass === undefined || pass.things === null ||
      pass.floorPassUniform === null || pass.floorPassUniform === undefined) {
    renderer.render(targetScene, targetCamera);
    return 1;
  }

  const oldAutoClear = renderer.autoClear;
  const oldCameraMask = targetCamera.layers.mask;
  const oldThingsVisible = pass.things.visible;
  const oldFloorPass = pass.floorPassUniform.value;
  let spriteDepthChanged = false;

  try {
    // Preserve the normal scissored PLAYPAL index-0 clear and the complete
    // world depth. Bodies retain ordinary floor/wall occlusion here.
    pass.things.visible = oldThingsVisible;
    pass.floorPassUniform.value = R_SPRITE_PASS_BODY;
    targetCamera.layers.set(R_WORLD_LAYER);
    renderer.render(targetScene, targetCamera);

    renderer.autoClear = false;
    for (let i = 0; i < pass.spriteMaterials.length; i++) {
      const material = pass.spriteMaterials[i];
      pass.savedSpriteDepthFuncs[i] = material.depthFunc;
      material.depthFunc = R_SPRITE_EQUAL_DEPTH;
    }
    spriteDepthChanged = true;
    pass.floorPassUniform.value = R_SPRITE_PASS_FLOOR_OVERHANG;
    targetCamera.layers.set(R_WORLD_SPRITE_LAYER);
    renderer.render(targetScene, targetCamera);
    return 2;
  } finally {
    if (spriteDepthChanged) {
      for (let i = 0; i < pass.spriteMaterials.length; i++) {
        pass.spriteMaterials[i].depthFunc = pass.savedSpriteDepthFuncs[i];
      }
    }
    pass.things.visible = oldThingsVisible;
    pass.floorPassUniform.value = oldFloorPass;
    targetCamera.layers.mask = oldCameraMask;
    renderer.autoClear = oldAutoClear;
  }
}
