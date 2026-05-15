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
import { R_GetWallTexture, textures, R_RegisterWallMesh } from './r_data.js';

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

// One mesh per (texture index, masked?) pair, plus the parent group placed
// in the scene. Midtextures on two-sided linedefs land in the masked bucket
// — vanilla draws those via R_RenderMaskedSegRange / R_DrawMaskedColumn so
// transparent gaps in the column posts stay see-through. Other wall surfaces
// (one-sided, upper, lower) go in the opaque bucket.
export function R_BuildWalls(scene) {
  _wallContribs.clear();
  const opaqueBuckets = new Map(); // texnum -> bucket
  const maskedBuckets = new Map(); // texnum -> bucket

  // frontFacing = true → triangle winding makes the normal point toward the
  // Doom-front side of the linedef (FrontSide material then renders the wall
  // only to viewers in the front sector). frontFacing = false → normal points
  // toward Doom-back, visible only from the back sector. Both layouts keep
  // the same vertex/UV order (u0 at v1, u1 at v2), so each sidedef's
  // textureoffset anchors correctly.
  function pushQuad(buckets, texnum, x1, y1, x2, y2, zBottom, zTop,
                    uOffset, anchorY, rowoffset, lightlevel, frontFacing) {
    if (texnum <= 0) return -1;
    const tex = textures[texnum];
    if (tex === undefined) return -1;
    let b = buckets.get(texnum);
    if (b === undefined) {
      b = { positions: [], uvs: [], colors: [], indices: [] };
      buckets.set(texnum, b);
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
      b.indices.push(baseIdx, baseIdx + 2, baseIdx + 1, baseIdx, baseIdx + 3, baseIdx + 2);
    } else {
      b.indices.push(baseIdx, baseIdx + 1, baseIdx + 2, baseIdx, baseIdx + 2, baseIdx + 3);
    }
    return baseIdx;
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
    let baseLight = lightlevel;
    if (li.v1.y === li.v2.y)      baseLight = Math.max(0,   baseLight - 16);
    else if (li.v1.x === li.v2.x) baseLight = Math.min(255, baseLight + 16);

    if ((li.flags & ML_TWOSIDED) === 0 || li.backsector === null) {
      const texH = _texH(sd0.midtexture);
      const anchor = dontPegBottom ? (frontFloor + texH) : frontCeiling;
      const bi = pushQuad(opaqueBuckets, sd0.midtexture, x1, y1, x2, y2, frontFloor, frontCeiling,
        sd0.textureoffset / 65536, anchor, sd0.rowoffset / 65536, baseLight, true);
      if (bi >= 0) attachContrib(front, {
        bucket: opaqueBuckets.get(sd0.midtexture), baseIdx: bi, front, back: null,
        kind: 'one-sided', rowoffset: sd0.rowoffset/65536, texH,
        dontPegTop, dontPegBottom,
      });
    } else {
      const back = li.backsector;
      const backFloor   = back.floorheight   / 65536;
      const backCeiling = back.ceilingheight / 65536;
      let backLight = back.lightlevel;
      if (li.v1.y === li.v2.y)      backLight = Math.max(0,   backLight - 16);
      else if (li.v1.x === li.v2.x) backLight = Math.min(255, backLight + 16);

      // Front upper.
      if (frontCeiling > backCeiling) {
        const texH = _texH(sd0.toptexture);
        const anchor = dontPegTop ? frontCeiling : (backCeiling + texH);
        const bi = pushQuad(opaqueBuckets, sd0.toptexture, x1, y1, x2, y2, backCeiling, frontCeiling,
          sd0.textureoffset / 65536, anchor, sd0.rowoffset / 65536, baseLight, true);
        if (bi >= 0) {
          const c = { bucket: opaqueBuckets.get(sd0.toptexture), baseIdx: bi, front, back,
            kind: 'upper-front', rowoffset: sd0.rowoffset/65536, texH,
            dontPegTop, dontPegBottom };
          attachContrib(front, c); attachContrib(back, c);
        }
      }
      // Front lower.
      if (backFloor > frontFloor) {
        const texH = _texH(sd0.bottomtexture);
        // DONTPEGBOTTOM anchors at the front ceiling so the texture continues
        // through the lower section (vanilla r_segs.c rw_bottomtexturemid = worldtop).
        const anchor = dontPegBottom ? frontCeiling : backFloor;
        const bi = pushQuad(opaqueBuckets, sd0.bottomtexture, x1, y1, x2, y2, frontFloor, backFloor,
          sd0.textureoffset / 65536, anchor, sd0.rowoffset / 65536, baseLight, true);
        if (bi >= 0) {
          const c = { bucket: opaqueBuckets.get(sd0.bottomtexture), baseIdx: bi, front, back,
            kind: 'lower-front', rowoffset: sd0.rowoffset/65536, texH,
            dontPegTop, dontPegBottom };
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
          const bi = pushQuad(maskedBuckets, sd0.midtexture, x1, y1, x2, y2, yBottom, yTop,
            sd0.textureoffset / 65536, anchor, sd0.rowoffset / 65536, baseLight, true);
          if (bi >= 0) {
            const c = { bucket: maskedBuckets.get(sd0.midtexture), baseIdx: bi, front, back,
              kind: 'middle-front', rowoffset: sd0.rowoffset/65536, texH,
              dontPegTop, dontPegBottom };
            attachContrib(front, c); attachContrib(back, c);
          }
        }
      }

      // Back side (mirror).
      const sd1 = sides[li.sidenum[1]];
      if (sd1 !== undefined) {
        if (backCeiling > frontCeiling) {
          const texH = _texH(sd1.toptexture);
          const anchor = dontPegTop ? backCeiling : (frontCeiling + texH);
          const bi = pushQuad(opaqueBuckets, sd1.toptexture, x1, y1, x2, y2, frontCeiling, backCeiling,
            sd1.textureoffset / 65536, anchor, sd1.rowoffset / 65536, backLight, false);
          if (bi >= 0) {
            const c = { bucket: opaqueBuckets.get(sd1.toptexture), baseIdx: bi, front, back,
              kind: 'upper-back', rowoffset: sd1.rowoffset/65536, texH,
              dontPegTop, dontPegBottom };
            attachContrib(front, c); attachContrib(back, c);
          }
        }
        if (frontFloor > backFloor) {
          const texH = _texH(sd1.bottomtexture);
          const anchor = dontPegBottom ? backCeiling : frontFloor;
          const bi = pushQuad(opaqueBuckets, sd1.bottomtexture, x1, y1, x2, y2, backFloor, frontFloor,
            sd1.textureoffset / 65536, anchor, sd1.rowoffset / 65536, backLight, false);
          if (bi >= 0) {
            const c = { bucket: opaqueBuckets.get(sd1.bottomtexture), baseIdx: bi, front, back,
              kind: 'lower-back', rowoffset: sd1.rowoffset/65536, texH,
              dontPegTop, dontPegBottom };
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
    for (const [texnum, b] of buckets) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
      g.setAttribute('uv',       new THREE.Float32BufferAttribute(b.uvs, 2));
      g.setAttribute('color',    new THREE.Float32BufferAttribute(b.colors, 3));
      g.setIndex(b.indices);
      g.computeVertexNormals();
      const map = R_GetWallTexture(texnum);
      // Masked midtextures use alphaTest so transparent post-gaps clip out.
      // depthWrite stays on (binary alpha) so we avoid back-to-front sorting.
      // Opaque walls render single-sided. The triangle winding (front-vs-back
      // facing in pushQuad) places the normal on the appropriate Doom side so
      // FrontSide rendering culls the back face — viewers on the wrong side
      // see through to the next sector instead of seeing the mirrored texture.
      // Masked midtextures (grates / fences) stay DoubleSide since vanilla
      // renders them visible from both sides.
      const mat = masked
        ? new THREE.MeshBasicMaterial({ map, vertexColors: true, side: THREE.DoubleSide,
            alphaTest: 0.5, transparent: false, depthWrite: true })
        : new THREE.MeshBasicMaterial({ map, vertexColors: true, side: THREE.FrontSide });
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
