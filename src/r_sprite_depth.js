// Doom draws floor/ceiling visplanes before masked objects, then clips world
// sprites only against the wall silhouettes collected by R_StoreWallRange.
// The retained Three.js renderer needs the same separation: its normal depth
// buffer contains physical floor planes, which otherwise cut off authored
// sprite rows below thing->z (five pixels on the stock imp frames).

export const R_WORLD_LAYER = 0;
export const R_WORLD_SPRITE_LAYER = 1;
export const R_SPRITE_OCCLUDER_LAYER = 2;

export function R_MarkWorldSprite(object) {
  object.layers.enable(R_WORLD_SPRITE_LAYER);
}

export function R_MarkSpriteOccluder(object) {
  object.layers.enable(R_SPRITE_OCCLUDER_LAYER);
}

// Render a retained Doom level in the reference draw order:
//   1. walls and planes paint the world;
//   2. walls rebuild a colorless sprite-occlusion depth buffer;
//   3. sprites draw over visplanes while remaining behind nearer walls.
// Objects stay on layer 0 as well, so direct renderer.render() calls retain
// their ordinary single-pass behaviour for diagnostics and resource warmup.
export function R_CreateSpriteDepthPass(things, walls) {
  const wallMaterials = [];
  walls.traverse((object) => {
    if (object.material === undefined || object.material === null) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (let i = 0; i < materials.length; i++) {
      if (wallMaterials.includes(materials[i]) === false) wallMaterials.push(materials[i]);
    }
  });
  return {
    things,
    wallMaterials,
    savedWallColorWrites: new Array(wallMaterials.length).fill(true),
  };
}

export function R_RenderRetainedLevel(renderer, targetScene, targetCamera, pass) {
  if (pass === null || pass === undefined || pass.things === null) {
    renderer.render(targetScene, targetCamera);
    return 1;
  }

  const oldAutoClear = renderer.autoClear;
  const oldCameraMask = targetCamera.layers.mask;
  const oldThingsVisible = pass.things.visible;
  let wallsMuted = false;

  try {
    // Preserve the normal scissored PLAYPAL index-0 clear on the first pass.
    // Subsequent passes retain that color result and replace only depth.
    pass.things.visible = false;
    targetCamera.layers.set(R_WORLD_LAYER);
    renderer.render(targetScene, targetCamera);

    renderer.autoClear = false;
    renderer.clearDepth();
    for (let i = 0; i < pass.wallMaterials.length; i++) {
      const material = pass.wallMaterials[i];
      pass.savedWallColorWrites[i] = material.colorWrite;
      material.colorWrite = false;
    }
    wallsMuted = true;
    targetCamera.layers.set(R_SPRITE_OCCLUDER_LAYER);
    renderer.render(targetScene, targetCamera);

    pass.things.visible = oldThingsVisible;
    targetCamera.layers.set(R_WORLD_SPRITE_LAYER);
    renderer.render(targetScene, targetCamera);
    return 3;
  } finally {
    if (wallsMuted) {
      for (let i = 0; i < pass.wallMaterials.length; i++) {
        pass.wallMaterials[i].colorWrite = pass.savedWallColorWrites[i];
      }
    }
    pass.things.visible = oldThingsVisible;
    targetCamera.layers.mask = oldCameraMask;
    renderer.autoClear = oldAutoClear;
  }
}
