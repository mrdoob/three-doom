// Ported from: linuxdoom-1.10/r_bsp.c (R_Subsector) + r_plane.c.
// Floors/ceilings built per subsector: clip a map-bound quad by each leaf's BSP
// partition half-planes (root → leaf), then by the leaf's directed segs. BSP
// partitions extend through void; the seg pass trims the convex cell back to
// the actual sector boundary that Doom exposes through portals.

import * as THREE from 'three';
import {
  subsectors, numsubsectors, nodes, numnodes, vertexes, segs, lines, numlines,
} from './p_setup.js';
import { ML_TWOSIDED, NF_SUBSECTOR } from './doomdata.js';
import {
  R_GetFlatTexture, R_RebindFlatMesh, R_RegisterFlatMesh, R_UnregisterFlatMesh,
} from './r_data.js';
import { R_MakeDoomMaterial } from './r_shader.js';
import { skyflatnum } from './doomstat.js';
import { R_FlatTextureUV } from './r_plane_mapping.js';
import { R_NeedsSkyCeilingSeam } from './r_sky_logic.js';
import { R_MarkSpriteOccluder } from './r_sprite_depth.js';

// sector → [{bucket, kind, startVertex, vertexCount}] for the by-sector updaters.
const _sectorContribs = new Map();
let _skyMaterials = null;
const SKY_COLOR_RENDER_ORDER = -2;
const SKY_DEPTH_RENDER_ORDER = -1;

function attachSkyDepthOccluder(mesh, kind) {
  if (mesh.__doomSkyDepthOccluder !== undefined) return;
  const material = kind === 'floor'
    ? _skyMaterials?.floorOccluder
    : _skyMaterials?.ceilingOccluder;
  if (material === null || material === undefined) return;
  // Render the screen-space sky color first. This paired mesh then writes the
  // portal's real world depth without touching color, preventing geometry
  // behind a terminal sky cap/seam from overwriting it. Geometry physically
  // in front still passes the depth test and draws normally.
  const occluder = new THREE.Mesh(mesh.geometry, material);
  R_MarkSpriteOccluder(occluder);
  occluder.frustumCulled = false;
  occluder.renderOrder = SKY_DEPTH_RENDER_ORDER;
  occluder.userData.doomSkyDepthOccluder = true;
  mesh.add(occluder);
  mesh.__doomSkyDepthOccluder = occluder;
}

function detachSkyDepthOccluder(mesh) {
  const occluder = mesh.__doomSkyDepthOccluder;
  if (occluder === undefined) return;
  mesh.remove(occluder);
  delete mesh.__doomSkyDepthOccluder;
}

function attachSectorContribution(sector, contribution) {
  if (sector === null || sector === undefined) return;
  let arr = _sectorContribs.get(sector);
  if (arr === undefined) {
    arr = [];
    _sectorContribs.set(sector, arr);
  }
  arr.push(contribution);
}

export function R_ShutdownPlanes() {
  _sectorContribs.clear();
  _skyMaterials = null;
}

// Sutherland–Hodgman clip by a node's partition half-plane (f<0 = side 0, right).
function clipPolyByHalfplane(poly, nx, ny, dx, dy, keepNeg) {
  const out = [];
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const cur = poly[i], nxt = poly[(i + 1) % n];
    const fc = dx * (cur.y - ny) - dy * (cur.x - nx);
    const fn = dx * (nxt.y - ny) - dy * (nxt.x - nx);
    const curIn = keepNeg ? fc <= 0 : fc >= 0;
    const nxtIn = keepNeg ? fn <= 0 : fn >= 0;
    if (curIn) out.push(cur);
    if (curIn !== nxtIn) {
      const t = fc / (fc - fn);
      out.push({ x: cur.x + t * (nxt.x - cur.x), y: cur.y + t * (nxt.y - cur.y) });
    }
  }
  return out;
}

// Drop near-duplicate vertices (avoids zero-area triangles).
function cleanPoly(poly) {
  const eps = 1 / 256;
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = out.length > 0 ? out[out.length - 1] : null;
    if (q !== null && Math.abs(p.x - q.x) < eps && Math.abs(p.y - q.y) < eps) continue;
    out.push(p);
  }
  if (out.length >= 2) {
    const a = out[0], b = out[out.length - 1];
    if (Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps) out.pop();
  }
  return out;
}

// Shoelace signed area; positive == CCW (fans to a +Y floor normal).
function polySignedArea(poly) {
  let s = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    s += poly[j].x * poly[i].y - poly[i].x * poly[j].y;
  }
  return s * 0.5;
}

// No-node map: the lone leaf's segs already close the polygon.
function polyFromSegs(sub) {
  const pts = [];
  for (let i = 0; i < sub.numlines; i++) {
    const sg = segs[sub.firstline + i];
    pts.push({ x: sg.v1.x / 65536, y: sg.v1.y / 65536 });
  }
  return cleanPoly(pts);
}

// Fan-triangulate a convex poly into its per-sector bucket. A sector must own
// its material so runtime floorpic changes do not retarget unrelated sectors
// that happened to start on the same flat.
function pushConvexPoly(buckets, flatnum, sector, poly, height, reverse, kind) {
  if (flatnum < 0) return;
  let b = buckets.get(sector);
  if (b === undefined) {
    b = { flatnum, sector, kind, positions: [], uvs: [], colors: [], indices: [] };
    buckets.set(sector, b);
  }
  const startVertex = b.positions.length / 3;
  const l = sector.lightlevel >> 4;
  for (let i = 0; i < poly.length; i++) {
    const x = poly[i].x, y = poly[i].y;
    const uv = R_FlatTextureUV(x, y);
    b.positions.push(x, height, -y);
    b.uvs.push(uv.u, uv.v);
    b.colors.push(l, l, l);
  }
  for (let i = 1; i < poly.length - 1; i++) {
    if (reverse) b.indices.push(startVertex, startVertex + i + 1, startVertex + i);
    else         b.indices.push(startVertex, startVertex + i, startVertex + i + 1);
  }
  attachSectorContribution(sector, {
    bucket: b, kind, startVertex, vertexCount: poly.length,
  });
}

export function R_BuildPlanes(scene, skyMaterials = null) {
  _sectorContribs.clear();
  _skyMaterials = skyMaterials;
  const floorBuckets   = new Map();
  const ceilingBuckets = new Map();

  // BSP is child-down only; record each node/leaf's parent + slot to walk up.
  const parent       = new Int32Array(numnodes).fill(-1);
  const parentSide   = new Int8Array(numnodes);
  const ssParent     = new Int32Array(numsubsectors).fill(-1);
  const ssParentSide = new Int8Array(numsubsectors);
  for (let ni = 0; ni < numnodes; ni++) {
    const node = nodes[ni];
    for (let s = 0; s < 2; s++) {
      const c = node.children[s];
      if ((c & NF_SUBSECTOR) !== 0) {
        ssParent[c & ~NF_SUBSECTOR] = ni;
        ssParentSide[c & ~NF_SUBSECTOR] = s;
      } else {
        parent[c] = ni;
        parentSide[c] = s;
      }
    }
  }

  // Map-bound quad seed (CCW). Ancestor partitions recover the convex BSP
  // cell; the directed-seg pass below trims perimeter cells away from void.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < vertexes.length; i++) {
    const vx = vertexes[i].x / 65536, vy = vertexes[i].y / 65536;
    if (vx < minX) minX = vx;
    if (vx > maxX) maxX = vx;
    if (vy < minY) minY = vy;
    if (vy > maxY) maxY = vy;
  }
  const pad = 8;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  for (let ssi = 0; ssi < numsubsectors; ssi++) {
    const sub = subsectors[ssi];
    const sector = sub.sector;
    if (sector === null || sector === undefined) continue;

    let poly;
    if (numnodes === 0) {
      poly = polyFromSegs(sub);
    } else {
      poly = [
        { x: minX, y: minY }, { x: maxX, y: minY },
        { x: maxX, y: maxY }, { x: minX, y: maxY },
      ];
      let n = ssParent[ssi], side = ssParentSide[ssi];
      while (n !== -1) {
        const node = nodes[n];
        poly = clipPolyByHalfplane(poly, node.x / 65536, node.y / 65536,
          node.dx / 65536, node.dy / 65536, side === 0);
        if (poly.length < 3) break;
        side = parentSide[n];
        n = parent[n];
      }
      poly = cleanPoly(poly);
    }
    // A BSP leaf is a convex partition cell, not necessarily a closed sector
    // polygon. In particular, leaves along the map perimeter remain open all
    // the way to the padded seed bounds. Every seg is directed so its owning
    // front sector lies on side 0 (the right / negative-cross-product side).
    // Intersecting those half-planes removes phantom floors and ceilings from
    // void space while retaining ordinary two-sided portal openings.
    for (let i = 0; i < sub.numlines && poly.length >= 3; i++) {
      const sg = segs[sub.firstline + i];
      poly = clipPolyByHalfplane(
        poly,
        sg.v1.x / 65536,
        sg.v1.y / 65536,
        (sg.v2.x - sg.v1.x) / 65536,
        (sg.v2.y - sg.v1.y) / 65536,
        true,
      );
    }
    poly = cleanPoly(poly);
    if (poly === null || poly.length < 3) continue;
    // Keep CCW so the floor fan faces +Y.
    if (polySignedArea(poly) < 0) poly.reverse();

    pushConvexPoly(floorBuckets, sector.floorpic, sector, poly,
      sector.floorheight / 65536, false, 'floor');
    pushConvexPoly(ceilingBuckets, sector.ceilingpic, sector, poly,
      sector.ceilingheight / 65536, true, 'ceiling');
  }

  function makeMesh(buckets, name) {
    const group = new THREE.Group();
    group.name = name;
    for (const b of buckets.values()) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
      g.setAttribute('uv',       new THREE.Float32BufferAttribute(b.uvs, 2));
      g.setAttribute('color',    new THREE.Float32BufferAttribute(b.colors, 3));
      g.setIndex(b.indices);
      g.computeVertexNormals();
      const skyMaterial = b.kind === 'floor' ? skyMaterials?.floor : skyMaterials?.ceiling;
      const isSky = b.flatnum === skyflatnum && skyMaterial !== null &&
        skyMaterial !== undefined;
      const map = isSky ? null : R_GetFlatTexture(b.flatnum);
      const mat = isSky ? skyMaterial :
        R_MakeDoomMaterial(map, { plane: true, side: THREE.FrontSide });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      // Wire each bucket back to its mesh so updates can hit the right geometry.
      b.mesh = mesh;
      mesh.userData.doomSector = b.sector;
      mesh.userData.doomPlaneKind = b.kind;
      mesh.userData.doomSkyPortal = isSky;
      if (isSky) {
        mesh.renderOrder = SKY_COLOR_RENDER_ORDER;
        attachSkyDepthOccluder(mesh, b.kind);
      } else R_RegisterFlatMesh(b.flatnum, mesh);
      group.add(mesh);
    }
    scene.add(group);
    return group;
  }

  // r_segs.c:530-534 makes adjacent sky ceilings share one effective top
  // edge. A vertical portal quad fills the interval between their real world
  // heights; without it, the retained geometry would leave a black slit where
  // vanilla continues drawing the sky visplane. Equal-height candidates are
  // kept as collapsed quads so later ceiling movement can open the seam.
  function makeSkyCeilingSeams() {
    const skyMaterial = skyMaterials?.ceiling;
    if (skyMaterial === null || skyMaterial === undefined) return null;
    const positions = [];
    const indices = [];
    const seamBucket = { mesh: null };
    let activeCount = 0;
    let candidateCount = 0;
    for (let i = 0; i < numlines; i++) {
      const line = lines[i];
      if ((line.flags & ML_TWOSIDED) === 0 || line.frontsector === null ||
          line.backsector === null ||
          line.frontsector.ceilingpic !== skyflatnum ||
          line.backsector.ceilingpic !== skyflatnum) {
        continue;
      }
      const front = line.frontsector;
      const back = line.backsector;
      const active = R_NeedsSkyCeilingSeam(front, back, skyflatnum);
      const frontHeight = front.ceilingheight / 65536;
      const backHeight = back.ceilingheight / 65536;
      const bottom = active ? Math.min(frontHeight, backHeight) : frontHeight;
      const top = active ? Math.max(frontHeight, backHeight) : frontHeight;
      const x1 = line.v1.x / 65536;
      const y1 = line.v1.y / 65536;
      const x2 = line.v2.x / 65536;
      const y2 = line.v2.y / 65536;
      const baseIdx = positions.length / 3;
      positions.push(
        x1, bottom, -y1,
        x2, bottom, -y2,
        x2, top,    -y2,
        x1, top,    -y1,
      );
      indices.push(baseIdx, baseIdx + 1, baseIdx + 2,
        baseIdx, baseIdx + 2, baseIdx + 3);
      const contribution = {
        bucket: seamBucket, baseIdx, front, back, kind: 'sky-ceiling-seam', active,
      };
      attachSectorContribution(front, contribution);
      if (back !== front) attachSectorContribution(back, contribution);
      candidateCount++;
      if (active) activeCount++;
    }
    if (candidateCount === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    const mesh = new THREE.Mesh(geometry, skyMaterial);
    mesh.frustumCulled = false;
    mesh.userData.doomSkyPortal = true;
    mesh.userData.doomSkyPortalKind = 'ceiling-seams';
    mesh.userData.doomSkySeamCount = activeCount;
    mesh.userData.doomSkySeamCandidates = candidateCount;
    mesh.renderOrder = SKY_COLOR_RENDER_ORDER;
    attachSkyDepthOccluder(mesh, 'sky-ceiling-seam');
    seamBucket.mesh = mesh;
    const group = new THREE.Group();
    group.name = 'sky-ceiling-seams';
    group.add(mesh);
    scene.add(group);
    return group;
  }

  return {
    floors: makeMesh(floorBuckets, 'floors'),
    ceilings: makeMesh(ceilingBuckets, 'ceilings'),
    skySeams: makeSkyCeilingSeams(),
  };
}

// R_UpdateSectorPlanes — call after sector.floorheight or .ceilingheight changes.
// Updates the Y (height) component of every vertex contributed by this sector,
// and the walls that touch this sector (door/lift/floor animation).
import { R_UpdateSectorWalls, R_UpdateSectorWallLight } from './r_segs.js';

function updateSkySeam(c) {
  const mesh = c.bucket.mesh;
  if (mesh === null) return;
  const active = R_NeedsSkyCeilingSeam(c.front, c.back, skyflatnum);
  const frontHeight = c.front.ceilingheight / 65536;
  const backHeight = c.back.ceilingheight / 65536;
  const bottom = active ? Math.min(frontHeight, backHeight) : frontHeight;
  const top = active ? Math.max(frontHeight, backHeight) : frontHeight;
  const pos = mesh.geometry.attributes.position;
  pos.setY(c.baseIdx + 0, bottom);
  pos.setY(c.baseIdx + 1, bottom);
  pos.setY(c.baseIdx + 2, top);
  pos.setY(c.baseIdx + 3, top);
  pos.needsUpdate = true;
  if (c.active !== active) {
    mesh.userData.doomSkySeamCount += active ? 1 : -1;
    c.active = active;
  }
}

function rebindPlaneMaterial(c, flatnum) {
  const bucket = c.bucket;
  if (bucket.flatnum === flatnum) return true;
  const mesh = bucket.mesh;
  const wasSky = mesh.userData.doomSkyPortal === true;
  const skyMaterial = c.kind === 'floor' ? _skyMaterials?.floor : _skyMaterials?.ceiling;
  const isSky = flatnum === skyflatnum && skyMaterial !== null &&
    skyMaterial !== undefined;
  if (isSky) {
    if (!wasSky) {
      R_UnregisterFlatMesh(bucket.flatnum, mesh);
      const oldMaterial = mesh.material;
      mesh.material = skyMaterial;
      oldMaterial.dispose();
    }
    mesh.userData.doomSkyPortal = true;
    mesh.renderOrder = SKY_COLOR_RENDER_ORDER;
    attachSkyDepthOccluder(mesh, c.kind);
    bucket.flatnum = flatnum;
    return true;
  }
  if (wasSky) {
    const map = R_GetFlatTexture(flatnum);
    if (map === null) return false;
    detachSkyDepthOccluder(mesh);
    mesh.material = R_MakeDoomMaterial(map, {
      plane: true, side: THREE.FrontSide,
    });
    mesh.userData.doomSkyPortal = false;
    mesh.renderOrder = 0;
    R_RegisterFlatMesh(flatnum, mesh);
    bucket.flatnum = flatnum;
    return true;
  }
  if (R_RebindFlatMesh(mesh, bucket.flatnum, flatnum) !== true) return false;
  bucket.flatnum = flatnum;
  return true;
}

export function R_UpdateSectorPlanes(sector) {
  const arr = _sectorContribs.get(sector);
  if (arr !== undefined) {
    for (const c of arr) {
      if (c.kind === 'sky-ceiling-seam') {
        updateSkySeam(c);
        continue;
      }
      const flatnum = c.kind === 'floor' ? sector.floorpic : sector.ceilingpic;
      rebindPlaneMaterial(c, flatnum);
      const h = (c.kind === 'floor' ? sector.floorheight : sector.ceilingheight) / 65536;
      const pos = c.bucket.mesh.geometry.attributes.position;
      for (let i = 0; i < c.vertexCount; i++) {
        pos.setY(c.startVertex + i, h);
      }
      pos.needsUpdate = true;
    }
  }
  R_UpdateSectorWalls(sector);
}

// R_UpdateSectorLight — call after sector.lightlevel changes. Updates the
// per-vertex color on this sector's floor + ceiling contributions, plus the
// walls whose light is driven by this sector.
export function R_UpdateSectorLight(sector) {
  const arr = _sectorContribs.get(sector);
  if (arr !== undefined) {
    const l = sector.lightlevel >> 4;
    for (const c of arr) {
      if (c.kind === 'sky-ceiling-seam') continue;
      const col = c.bucket.mesh.geometry.attributes.color;
      for (let i = 0; i < c.vertexCount; i++) {
        col.setXYZ(c.startVertex + i, l, l, l);
      }
      col.needsUpdate = true;
    }
  }
  R_UpdateSectorWallLight(sector);
}
