import * as THREE from 'three';
import { R_ApplySpritePatchGeometry } from '../src/r_things.js';
import { R_MakeDoomSpriteMaterial, R_ShaderInit } from '../src/r_shader.js';
import { R_SpritePatchWorldBounds } from '../src/r_sprite_projection.js';

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

async function run() {
  const renderer = new THREE.WebGLRenderer({ antialias: false });
  renderer.setPixelRatio(1);
  renderer.setSize(32, 32, false);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const target = new THREE.WebGLRenderTarget(32, 32, {
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: true,
  });
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-16, 16, 16, -16, 0.1, 10);
  camera.position.z = 5;

  const material = new THREE.SpriteMaterial({ color: 0xff0000 });
  const sprite = new THREE.Sprite(material);
  R_ApplySpritePatchGeometry(
    sprite,
    { x: 0, y: 0, z: 0, floorz: 128 * 65536 },
    { w: 14, h: 18, offsetX: 7, offsetY: 14 },
  );
  const bounds = R_SpritePatchWorldBounds(0, 14, 18);
  scene.add(sprite);

  assertEquals(bounds.top, 14, 'stock BON1 top');
  assertEquals(bounds.bottom, -4, 'stock BON1 bottom');
  assertEquals(sprite.position.y, 5, 'billboard midpoint ignores floorz');
  assertEquals(sprite.scale.y, 18, 'billboard source height');
  assertEquals(sprite.center.x, 0.5, 'billboard patch origin');

  renderer.setRenderTarget(target);
  renderer.setClearColor(0x000000, 1);
  renderer.clear();
  renderer.render(scene, camera);
  const pixels = new Uint8Array(32 * 32 * 4);
  renderer.readRenderTargetPixels(target, 0, 0, 32, 32, pixels);
  let minX = 32, minY = 32, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const p = (y * 32 + x) * 4;
      if (pixels[p] < 200 || pixels[p + 1] !== 0 || pixels[p + 2] !== 0) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      count++;
    }
  }
  assertEquals(minX, 9, 'rendered left edge');
  assertEquals(maxX, 22, 'rendered right edge');
  assertEquals(minY, 12, 'rendered bottom edge at world -4');
  assertEquals(maxY, 29, 'rendered top edge at world 14');
  assertEquals(count, 14 * 18, 'rendered source-sized area');

  // Lock in the local material contract: source-authored bounds stay fixed
  // and depth testing remains enabled. Production's support-plane pass
  // repairs only the authored rows that belong over the actor's own floor.
  const palette = new Uint8Array(256 * 4);
  const maps = new Uint8Array(34 * 256);
  for (let i = 0; i < 256; i++) palette[i * 4 + 3] = 255;
  R_ShaderInit(palette, maps);
  const doomMaterial = R_MakeDoomSpriteMaterial(null);
  assertEquals(doomMaterial.depthTest, true, 'Doom sprite depth test');

  doomMaterial.dispose();
  material.dispose();
  target.dispose();
  renderer.dispose();
  return { ok: true, bounds, pixels: count, depthTest: true };
}

run().then((result) => {
  window.__headlessResult = result;
  document.getElementById('result').textContent = JSON.stringify(result);
}).catch((error) => {
  const result = { ok: false, error: error.stack ?? String(error) };
  window.__headlessResult = result;
  document.getElementById('result').textContent = JSON.stringify(result);
});
