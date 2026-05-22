// Ported from: linuxdoom-1.10/r_plane.c
// Per-sector floor + ceiling triangulation using sector-loop earcut. Records
// (mesh, vertexIndex range) per sector so opening doors / lifts can mutate
// just the affected vertices.

import * as THREE from 'three';
import { sectors, numsectors } from './p_setup.js';
import { R_GetFlatTexture, R_RegisterFlatMesh } from './r_data.js';
import { R_MakeDoomMaterial } from './r_shader.js';
import { skyflatnum } from './doomstat.js';
import { earcut } from './earcut.js';

// Sector → array of {mesh, kind:'floor'|'ceiling', startVertex, vertexCount}
const _sectorContribs = new Map();

function extractSectorLoops(sector) {
  const edges = [];
  for (const li of sector.lines) {
    if (li.frontsector === sector) edges.push([li.v2, li.v1]);
    if (li.backsector  === sector) edges.push([li.v1, li.v2]);
  }
  const byStart = new Map();
  for (const e of edges) {
    if (!byStart.has(e[0])) byStart.set(e[0], []);
    byStart.get(e[0]).push(e);
  }
  const loops = [];
  const used = new Set();
  for (const seed of edges) {
    if (used.has(seed)) continue;
    const loop = [seed[0]];
    let cur = seed;
    let safety = 0;
    while (safety++ < 10000) {
      used.add(cur);
      loop.push(cur[1]);
      if (cur[1] === loop[0]) break;
      const list = byStart.get(cur[1]);
      if (!list) break;
      let nxt = null;
      for (const e of list) if (!used.has(e)) { nxt = e; break; }
      if (!nxt) break;
      cur = nxt;
    }
    if (loop.length >= 4 && loop[loop.length - 1] === loop[0]) loops.push(loop.slice(0, -1));
  }
  return loops;
}

function signedArea2D(pts) {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    s += (pts[j].x - pts[i].x) * (pts[i].y + pts[j].y);
  }
  return s;
}

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x / 65536, yi = pts[i].y / 65536;
    const xj = pts[j].x / 65536, yj = pts[j].y / 65536;
    const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function R_BuildPlanes(scene) {
  _sectorContribs.clear();
  const floorBuckets   = new Map();
  const ceilingBuckets = new Map();

  function pushOuterWithHoles(buckets, flatnum, sector, outer, holes, height, reverse, kind) {
    if (flatnum < 0) return;
    const data = [];
    for (const v of outer) data.push(v.x / 65536, v.y / 65536);
    const holeIdx = [];
    for (const h of holes) {
      holeIdx.push(data.length / 2);
      for (const v of h) data.push(v.x / 65536, v.y / 65536);
    }
    const tris = earcut(data, holeIdx.length ? holeIdx : undefined);
    if (tris.length === 0) return;
    let b = buckets.get(flatnum);
    if (b === undefined) {
      b = { positions: [], uvs: [], colors: [], indices: [] };
      buckets.set(flatnum, b);
    }
    const startVertex = b.positions.length / 3;
    for (let i = 0; i < data.length; i += 2) {
      const x = data[i], y = data[i + 1];
      b.positions.push(x, height, -y);
      b.uvs.push(x / 64, y / 64);
      const l = sector.lightlevel / 255;
      b.colors.push(l, l, l);
    }
    for (let i = 0; i < tris.length; i += 3) {
      if (reverse) b.indices.push(startVertex + tris[i], startVertex + tris[i + 2], startVertex + tris[i + 1]);
      else         b.indices.push(startVertex + tris[i], startVertex + tris[i + 1], startVertex + tris[i + 2]);
    }
    const vertexCount = data.length / 2;
    let arr = _sectorContribs.get(sector);
    if (arr === undefined) { arr = []; _sectorContribs.set(sector, arr); }
    arr.push({ bucket: b, kind, startVertex, vertexCount });
  }

  for (let i = 0; i < numsectors; i++) {
    const sector = sectors[i];
    const loops = extractSectorLoops(sector);
    if (loops.length === 0) continue;
    const classified = loops.map(loop => ({ loop, area: signedArea2D(loop) }));
    classified.sort((a, b) => Math.abs(b.area) - Math.abs(a.area));
    const outers = [];
    for (const c of classified) if (c.area > 0) outers.push({ loop: c.loop, holes: [] });
    for (const c of classified) {
      if (c.area < 0) {
        const px = c.loop[0].x, py = c.loop[0].y;
        for (const o of outers) {
          if (pointInPolygon(px, py, o.loop)) { o.holes.push(c.loop); break; }
        }
      }
    }
    for (const o of outers) {
      if (sector.floorpic !== skyflatnum) {
        pushOuterWithHoles(floorBuckets, sector.floorpic, sector, o.loop, o.holes,
          sector.floorheight / 65536, false, 'floor');
      }
      if (sector.ceilingpic !== skyflatnum) {
        pushOuterWithHoles(ceilingBuckets, sector.ceilingpic, sector, o.loop, o.holes,
          sector.ceilingheight / 65536, true, 'ceiling');
      }
    }
  }

  function makeMesh(buckets, name) {
    const group = new THREE.Group();
    group.name = name;
    for (const [flatnum, b] of buckets) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
      g.setAttribute('uv',       new THREE.Float32BufferAttribute(b.uvs, 2));
      g.setAttribute('color',    new THREE.Float32BufferAttribute(b.colors, 3));
      g.setIndex(b.indices);
      g.computeVertexNormals();
      const map = R_GetFlatTexture(flatnum);
      const mat = R_MakeDoomMaterial(map, { side: THREE.FrontSide });
      const mesh = new THREE.Mesh(g, mat);
      mesh.frustumCulled = false;
      // Wire each bucket back to its mesh so updates can hit the right geometry.
      b.mesh = mesh;
      R_RegisterFlatMesh(flatnum, mesh);
      group.add(mesh);
    }
    scene.add(group);
    return group;
  }
  return { floors: makeMesh(floorBuckets, 'floors'), ceilings: makeMesh(ceilingBuckets, 'ceilings') };
}

// R_UpdateSectorPlanes — call after sector.floorheight or .ceilingheight changes.
// Updates the Y (height) component of every vertex contributed by this sector,
// and the walls that touch this sector (door/lift/floor animation).
import { R_UpdateSectorWalls, R_UpdateSectorWallLight } from './r_segs.js';
export function R_UpdateSectorPlanes(sector) {
  const arr = _sectorContribs.get(sector);
  if (arr !== undefined) {
    for (const c of arr) {
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
    const l = sector.lightlevel / 255;
    for (const c of arr) {
      const col = c.bucket.mesh.geometry.attributes.color;
      for (let i = 0; i < c.vertexCount; i++) {
        col.setXYZ(c.startVertex + i, l, l, l);
      }
      col.needsUpdate = true;
    }
  }
  R_UpdateSectorWallLight(sector);
}
