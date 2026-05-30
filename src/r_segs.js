// Ported from: linuxdoom-1.10/r_segs.c
// In linuxdoom this rendered wall columns to a 1D framebuffer. In the 3D port
// we instead build a THREE.BufferGeometry per wall surface (upper / middle /
// lower) and let WebGL rasterize them.
//
// One BufferGeometry is built per wall-texture: all linedefs sharing the
// same texture become triangles in the same mesh, which keeps draw call
// counts low.

import * as THREE from 'three';
import { lines, sides, numlines } from './p_setup.js';
import { ML_TWOSIDED, ML_DONTPEGTOP, ML_DONTPEGBOTTOM } from './doomdata.js';
import { skyflatnum } from './doomstat.js';
import { R_GetWallTexture, textures, R_RegisterWallMesh } from './r_data.js';
import { R_MakeDoomMaterial } from './r_shader.js';
import { top, middle, bottom, P_IsSwitchTexture } from './p_switch.js';

// Per-sector wall-quad contributions, so R_UpdateSectorWalls can re-write the
// Y coordinates when a door/lift/floor moves. Each entry knows how to
// recompute its quad's zBottom/zTop from the (front, back, kind) tuple.
// Map<sector, Array<{bucket, baseIdx, front, back, kind}>>
const _wallContribs = new Map();
function attachContrib(sectorRef, c) {
  if (sectorRef === null) return;
  let arr = _wallContribs.get(sectorRef);
  if (arr === undefined) { arr = []; _wallContribs.set(sectorRef, arr); }
  arr.push(c);
}

// Switch walls each get a PRIVATE single-quad bucket at build time, instead of
// being batched with other walls sharing the texture. That lets
// P_ChangeSwitchTexture re-texture one switch in place (a uniform swap) without
// disturbing its neighbours. Map<line, { [slot]: bucket }>, keyed by p_switch's
// top/middle/bottom slot.
const _switchWalls = new Map();

// Re-texture a switch wall in place after its sidedef texture number flips.
// No-op if (line, slot) isn't a registered switch wall.
export function R_SetSwitchTexture(line, slot, texnum) {
  const rec = _switchWalls.get(line);
  if (rec === undefined) return;
  const b = rec[slot];
  if (b === undefined || b.mesh === undefined) return;
  const tex = R_GetWallTexture(texnum);
  if (tex === null) return;
  b.mesh.material.uniforms.map.value = tex;
  b.texnum = texnum;
}

// Compute (vTop, vBottom) for a quad given its texture anchor in world Y.
// Vanilla `rw_*texturemid` is the world Y of texture row 0. Going down from
// there, V increases by 1/texH per world unit. rowoffset (in world units)
// shifts the anchor upward → texture visible inside the quad shifts down.
//
// Anchor by wall kind (per r_segs.c:447-540):
//   one-sided default          → frontCeiling
//   one-sided + DONTPEGBOTTOM  → frontFloor + texH
//   upper default              → backCeiling + texH
//   upper + DONTPEGTOP         → frontCeiling
//   lower default              → backFloor
//   lower + DONTPEGBOTTOM      → frontCeiling
//   middle (two-sided)         → min(frontCeiling, backCeiling)
//   middle (two-sided) + DPB   → max(frontFloor, backFloor) + texH
function uvFromAnchor(anchorY, rowoffset, zTop, zBottom, texH) {
  const a = anchorY + rowoffset;
  return { vTop: (a - zTop) / texH, vBottom: (a - zBottom) / texH };
}

// Recompute the four-vertex quad in place when its driving sector heights change.
function updateContrib(c) {
  if (c.bucket === undefined || c.bucket.mesh === undefined) return;
  const ff = c.front.floorheight   / 65536;
  const fc = c.front.ceilingheight / 65536;
  const bf = c.back !== null ? c.back.floorheight   / 65536 : 0;
  const bc = c.back !== null ? c.back.ceilingheight / 65536 : 0;
  let zBottom, zTop, anchorY;
  switch (c.kind) {
    case 'one-sided':
      zBottom = ff; zTop = fc;
      anchorY = c.dontPegBottom ? (ff + c.texH) : fc;
      break;
    case 'upper-front':
      zBottom = bc; zTop = fc;
      anchorY = c.dontPegTop ? fc : (bc + c.texH);
      break;
    case 'lower-front':
      zBottom = ff; zTop = bf;
      anchorY = c.dontPegBottom ? fc : bf;
      break;
    case 'middle-front':
      zBottom = Math.max(ff, bf); zTop = Math.min(fc, bc);
      anchorY = c.dontPegBottom ? (Math.max(ff, bf) + c.texH) : Math.min(fc, bc);
      break;
    case 'upper-back':
      zBottom = fc; zTop = bc;
      anchorY = c.dontPegTop ? bc : (fc + c.texH);
      break;
    case 'lower-back':
      zBottom = bf; zTop = ff;
      anchorY = c.dontPegBottom ? bc : ff;
      break;
    default: return;
  }
  const pos = c.bucket.mesh.geometry.attributes.position;
  pos.setY(c.baseIdx + 0, zBottom);
  pos.setY(c.baseIdx + 1, zBottom);
  pos.setY(c.baseIdx + 2, zTop);
  pos.setY(c.baseIdx + 3, zTop);
  pos.needsUpdate = true;
  if (c.texH > 0) {
    const { vBottom, vTop } = uvFromAnchor(anchorY, c.rowoffset, zTop, zBottom, c.texH);
    const uv = c.bucket.mesh.geometry.attributes.uv;
    uv.setY(c.baseIdx + 0, vBottom);
    uv.setY(c.baseIdx + 1, vBottom);
    uv.setY(c.baseIdx + 2, vTop);
    uv.setY(c.baseIdx + 3, vTop);
    uv.needsUpdate = true;
  }
}

export function R_UpdateSectorWalls(sector) {
  const arr = _wallContribs.get(sector);
  if (arr === undefined) return;
  for (const c of arr) updateContrib(c);
}

// Recompute a quad's vertex colors when its light-driving sector's
// lightlevel changes. Mirrors the build-time fake-contrast bake.
function updateContribLight(c) {
  if (c.bucket === undefined || c.bucket.mesh === undefined) return;
  const light = Math.max(0, Math.min(255, c.lightSector.lightlevel + c.contrast)) / 255;
  const col = c.bucket.mesh.geometry.attributes.color;
  for (let i = 0; i < 4; i++) col.setXYZ(c.baseIdx + i, light, light, light);
  col.needsUpdate = true;
}

// R_UpdateSectorWallLight — call after sector.lightlevel changes. Updates
// the vertex colors of every wall quad whose light is driven by this sector.
export function R_UpdateSectorWallLight(sector) {
  const arr = _wallContribs.get(sector);
  if (arr === undefined) return;
  for (const c of arr) {
    if (c.lightSector === sector) updateContribLight(c);
  }
}

// One mesh per (texture index, masked?) pair, plus the parent group placed
// in the scene. Midtextures on two-sided linedefs land in the masked bucket
// — vanilla draws those via R_RenderMaskedSegRange / R_DrawMaskedColumn so
// transparent gaps in the column posts stay see-through. Other wall surfaces
// (one-sided, upper, lower) go in the opaque bucket.
export function R_BuildWalls(scene) {
  _wallContribs.clear();
  _switchWalls.clear();
  let switchSeq = 0; // unique-bucket counter for private switch-wall meshes
  const opaqueBuckets = new Map(); // bucket key -> bucket
  const maskedBuckets = new Map(); // bucket key -> bucket

  // frontFacing = true → triangle winding makes the normal point toward the
  // Doom-front side of the linedef (FrontSide material then renders the wall
  // only to viewers in the front sector). frontFacing = false → normal points
  // toward Doom-back, visible only from the back sector. Both layouts keep
  // the same vertex/UV order (u0 at v1, u1 at v2), so each sidedef's
  // textureoffset anchors correctly.
  // Returns { bucket, baseIdx } for the pushed quad, or null if skipped.
  // switchSlot/switchLine (optional) mark a front-side switch surface: it gets
  // its own private bucket and is recorded in _switchWalls for runtime swapping.
  function pushQuad(buckets, texnum, x1, y1, x2, y2, zBottom, zTop,
                    uOffset, anchorY, rowoffset, lightlevel, frontFacing,
                    switchSlot, switchLine) {
    if (texnum <= 0) return null;
    const tex = textures[texnum];
    if (tex === undefined) return null;
    const isSwitch = switchSlot !== undefined && P_IsSwitchTexture(texnum);
    const key = isSwitch ? ('sw:' + (switchSeq++)) : texnum;
    let b = buckets.get(key);
    if (b === undefined) {
      b = { positions: [], uvs: [], colors: [], indices: [], texnum };
      buckets.set(key, b);
      if (isSwitch) {
        let rec = _switchWalls.get(switchLine);
        if (rec === undefined) { rec = {}; _switchWalls.set(switchLine, rec); }
        rec[switchSlot] = b;
      }
    }
    const dx = x2 - x1, dy = y2 - y1;
    const length = Math.sqrt(dx * dx + dy * dy);
    const baseIdx = b.positions.length / 3;
    b.positions.push(
      x1, zBottom, -y1,
      x2, zBottom, -y2,
      x2, zTop,    -y2,
      x1, zTop,    -y1,
    );
    const u0 = uOffset / tex.width;
    const u1 = (uOffset + length) / tex.width;
    const { vBottom, vTop } = uvFromAnchor(anchorY, rowoffset, zTop, zBottom, tex.height);
    b.uvs.push(u0, vBottom, u1, vBottom, u1, vTop, u0, vTop);
    const light = lightlevel / 255;
    for (let i = 0; i < 4; i++) b.colors.push(light, light, light);
    if (frontFacing === true) {
      b.indices.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx, baseIdx + 2, baseIdx + 3);
    } else {
      b.indices.push(baseIdx, baseIdx + 2, baseIdx + 1, baseIdx, baseIdx + 3, baseIdx + 2);
    }
    return { bucket: b, baseIdx };
  }

  // For each linedef, build wall geometry.
  for (let i = 0; i < numlines; i++) {
    const li = lines[i];
    const front = li.frontsector;
    if (front === null) continue;

    const x1 = li.v1.x / 65536;
    const y1 = li.v1.y / 65536;
    const x2 = li.v2.x / 65536;
    const y2 = li.v2.y / 65536;

    const frontFloor   = front.floorheight   / 65536;
    const frontCeiling = front.ceilingheight / 65536;
    const lightlevel = front.lightlevel;

    const sd0 = sides[li.sidenum[0]];
    if (sd0 === undefined) continue;

    const _texH = (texnum) => {
      const t = textures[texnum];
      return t === undefined ? 0 : t.height;
    };
    const dontPegTop    = (li.flags & ML_DONTPEGTOP)    !== 0;
    const dontPegBottom = (li.flags & ML_DONTPEGBOTTOM) !== 0;

    // Fake contrast — r_segs.c R_RenderSegLoop: horizontal lines get
    // lightlevel-16, vertical lines get lightlevel+16. Computed once per
    // linedef in vanilla; baked into per-quad vertex colors here.
    let contrast = 0;
    if (li.v1.y === li.v2.y)      contrast = -16;
    else if (li.v1.x === li.v2.x) contrast = 16;
    const baseLight = Math.max(0, Math.min(255, lightlevel + contrast));

    if ((li.flags & ML_TWOSIDED) === 0 || li.backsector === null) {
      const texH = _texH(sd0.midtexture);
      const anchor = dontPegBottom ? (frontFloor + texH) : frontCeiling;
      const r = pushQuad(opaqueBuckets, sd0.midtexture, x1, y1, x2, y2, frontFloor, frontCeiling,
        sd0.textureoffset / 65536, anchor, sd0.rowoffset / 65536, baseLight, true, middle, li);
      if (r !== null) attachContrib(front, {
        bucket: r.bucket, baseIdx: r.baseIdx, front, back: null,
        kind: 'one-sided', rowoffset: sd0.rowoffset/65536, texH,
        dontPegTop, dontPegBottom, lightSector: front, contrast,
      });
    } else {
      const back = li.backsector;
      const backFloor   = back.floorheight   / 65536;
      const backCeiling = back.ceilingheight / 65536;
      const backLight = Math.max(0, Math.min(255, back.lightlevel + contrast));

      // r_segs.c:530-534 — "hack to allow height changes in outdoor areas":
      // when both sectors' ceilings are the sky flat, vanilla skips the upper
      // texture entirely, so the sky bleeds across the height difference
      // instead of revealing a wall standing against the sky.
      const skyToSky = front.ceilingpic === skyflatnum && back.ceilingpic === skyflatnum;

      // Front upper.
      if (frontCeiling > backCeiling && skyToSky !== true) {
        const texH = _texH(sd0.toptexture);
        const anchor = dontPegTop ? frontCeiling : (backCeiling + texH);
        const r = pushQuad(opaqueBuckets, sd0.toptexture, x1, y1, x2, y2, backCeiling, frontCeiling,
          sd0.textureoffset / 65536, anchor, sd0.rowoffset / 65536, baseLight, true, top, li);
        if (r !== null) {
          const c = { bucket: r.bucket, baseIdx: r.baseIdx, front, back,
            kind: 'upper-front', rowoffset: sd0.rowoffset/65536, texH,
            dontPegTop, dontPegBottom, lightSector: front, contrast };
          attachContrib(front, c); attachContrib(back, c);
        }
      }
      // Front lower.
      if (backFloor > frontFloor) {
        const texH = _texH(sd0.bottomtexture);
        // DONTPEGBOTTOM anchors at the front ceiling so the texture continues
        // through the lower section (vanilla r_segs.c rw_bottomtexturemid = worldtop).
        const anchor = dontPegBottom ? frontCeiling : backFloor;
        const r = pushQuad(opaqueBuckets, sd0.bottomtexture, x1, y1, x2, y2, frontFloor, backFloor,
          sd0.textureoffset / 65536, anchor, sd0.rowoffset / 65536, baseLight, true, bottom, li);
        if (r !== null) {
          const c = { bucket: r.bucket, baseIdx: r.baseIdx, front, back,
            kind: 'lower-front', rowoffset: sd0.rowoffset/65536, texH,
            dontPegTop, dontPegBottom, lightSector: front, contrast };
          attachContrib(front, c); attachContrib(back, c);
        }
      }
      // Front middle (grates / fences / hanging scenery). Vanilla routes this
      // through R_RenderMaskedSegRange — masked bucket, alphaTest material.
      if (sd0.midtexture > 0) {
        const yBottom = Math.max(frontFloor, backFloor);
        const yTop    = Math.min(frontCeiling, backCeiling);
        if (yTop > yBottom) {
          const texH = _texH(sd0.midtexture);
          const anchor = dontPegBottom ? (yBottom + texH) : yTop;
          const r = pushQuad(maskedBuckets, sd0.midtexture, x1, y1, x2, y2, yBottom, yTop,
            sd0.textureoffset / 65536, anchor, sd0.rowoffset / 65536, baseLight, true, middle, li);
          if (r !== null) {
            const c = { bucket: r.bucket, baseIdx: r.baseIdx, front, back,
              kind: 'middle-front', rowoffset: sd0.rowoffset/65536, texH,
              dontPegTop, dontPegBottom, lightSector: front, contrast };
            attachContrib(front, c); attachContrib(back, c);
          }
        }
      }

      // Back side (mirror).
      const sd1 = sides[li.sidenum[1]];
      if (sd1 !== undefined) {
        if (backCeiling > frontCeiling && skyToSky !== true) {
          const texH = _texH(sd1.toptexture);
          const anchor = dontPegTop ? backCeiling : (frontCeiling + texH);
          const r = pushQuad(opaqueBuckets, sd1.toptexture, x1, y1, x2, y2, frontCeiling, backCeiling,
            sd1.textureoffset / 65536, anchor, sd1.rowoffset / 65536, backLight, false);
          if (r !== null) {
            const c = { bucket: r.bucket, baseIdx: r.baseIdx, front, back,
              kind: 'upper-back', rowoffset: sd1.rowoffset/65536, texH,
              dontPegTop, dontPegBottom, lightSector: back, contrast };
            attachContrib(front, c); attachContrib(back, c);
          }
        }
        if (frontFloor > backFloor) {
          const texH = _texH(sd1.bottomtexture);
          const anchor = dontPegBottom ? backCeiling : frontFloor;
          const r = pushQuad(opaqueBuckets, sd1.bottomtexture, x1, y1, x2, y2, backFloor, frontFloor,
            sd1.textureoffset / 65536, anchor, sd1.rowoffset / 65536, backLight, false);
          if (r !== null) {
            const c = { bucket: r.bucket, baseIdx: r.baseIdx, front, back,
              kind: 'lower-back', rowoffset: sd1.rowoffset/65536, texH,
              dontPegTop, dontPegBottom, lightSector: back, contrast };
            attachContrib(front, c); attachContrib(back, c);
          }
        }
      }
    }
  }

  // Build meshes.
  const group = new THREE.Group();
  group.name = 'walls';

  function buildBucketMeshes(buckets, masked) {
    for (const b of buckets.values()) {
      const texnum = b.texnum; // bucket key may be a private 'sw:N' for switches
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
      g.setAttribute('uv',       new THREE.Float32BufferAttribute(b.uvs, 2));
      g.setAttribute('color',    new THREE.Float32BufferAttribute(b.colors, 3));
      g.setIndex(b.indices);
      g.computeVertexNormals();
      const map = R_GetWallTexture(texnum);
      // Custom Doom shader: paletted texture + COLORMAP remap + distance-
      // fade lighting (r_shader.js). Masked midtextures (grates / fences)
      // run the same shader with masked=true (discards alpha=0 pixels) and
      // DoubleSide so vanilla's two-sided masked rendering matches.
      const mat = R_MakeDoomMaterial(map, {
        masked, side: masked ? THREE.DoubleSide : THREE.FrontSide,
      });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      b.mesh = mesh; // make findable from per-contrib pointer
      R_RegisterWallMesh(texnum, mesh);
      group.add(mesh);
    }
  }
  buildBucketMeshes(opaqueBuckets, false);
  buildBucketMeshes(maskedBuckets, true);

  scene.add(group);
  return group;
}
