// Ported from: linuxdoom-1.10/r_things.c
// Sprite definitions + 3D billboards for in-world things.
//
// In linuxdoom this rendered sprite columns to a 1D framebuffer. In the 3D
// port we keep R_InitSpriteDefs (it walks the WAD's sprite lumps to build
// per-rotation tables) and add R_BuildSpriteBillboards that turns map things
// into THREE.Sprite billboards.

import * as THREE from 'three';
import { spritedef_t, spriteframe_t } from './r_defs.js';
import { sprnames, states } from './info.js';
import { firstspritelump, lastspritelump, playpal_rgba } from './r_data.js';
import { W_CacheLumpNum } from './w_wad.js';
import { lumpinfo } from './w_wad.js';
import { I_Error } from './i_system.js';
import { FRACBITS } from './m_fixed.js';
import { patch_t } from './v_video.js';

// ---------- Sprite definition tables ----------
export let numsprites = 0;
export let sprites    = null;

const sprtemp = new Array(29);
for (let i = 0; i < 29; i++) sprtemp[i] = new spriteframe_t();
let maxframe = -1;
let spritename = '';

function R_InstallSpriteLump(lump, frame, rotation, flipped) {
  // C declares `rotation` unsigned; in JS a malformed lump name (e.g. '/' at
  // pos 5) produces a negative value that would slip past `> 8` and then write
  // sprtemp[].lump[-1] silently. Guard the negative case explicitly.
  if (frame >= 29 || rotation < 0 || rotation > 8) {
    I_Error(`R_InstallSpriteLump: Bad frame characters in lump ${lump}`);
  }
  if (frame > maxframe) maxframe = frame;
  if (rotation === 0) {
    for (let r = 0; r < 8; r++) {
      sprtemp[frame].lump[r] = lump - firstspritelump;
      sprtemp[frame].flip[r] = flipped ? 1 : 0;
    }
    sprtemp[frame].rotate = false;
    return;
  }
  sprtemp[frame].rotate = true;
  rotation--;
  sprtemp[frame].lump[rotation] = lump - firstspritelump;
  sprtemp[frame].flip[rotation] = flipped ? 1 : 0;
}

// R_InitSpriteDefs — walks lump directory for sprite-named entries.
export function R_InitSpriteDefs(namelist) {
  numsprites = namelist.length;
  if (numsprites === 0) return;
  sprites = new Array(numsprites);
  const start = firstspritelump - 1;
  const end   = lastspritelump  + 1;
  for (let i = 0; i < numsprites; i++) {
    spritename = namelist[i];
    for (let k = 0; k < 29; k++) {
      sprtemp[k].rotate = -1; // sentinel
      for (let r = 0; r < 8; r++) { sprtemp[k].lump[r] = -1; sprtemp[k].flip[r] = 0; }
    }
    maxframe = -1;
    for (let l = start + 1; l < end; l++) {
      const lname = lumpinfo[l].name;
      if (lname.slice(0, 4) === namelist[i]) {
        const frame    = lname.charCodeAt(4) - 65; // 'A'
        const rotation = lname.charCodeAt(5) - 48; // '0'
        R_InstallSpriteLump(l, frame, rotation, false);
        if (lname.length > 6 && lname.charCodeAt(6) !== 0) {
          const frame2    = lname.charCodeAt(6) - 65;
          const rotation2 = lname.charCodeAt(7) - 48;
          R_InstallSpriteLump(l, frame2, rotation2, true);
        }
      }
    }
    if (maxframe === -1) {
      sprites[i] = new spritedef_t();
      sprites[i].numframes = 0;
      continue;
    }
    maxframe++;
    const sd = new spritedef_t();
    sd.numframes = maxframe;
    sd.spriteframes = new Array(maxframe);
    for (let f = 0; f < maxframe; f++) {
      const src = sprtemp[f];
      const dst = new spriteframe_t();
      dst.rotate = src.rotate === true;
      for (let r = 0; r < 8; r++) { dst.lump[r] = src.lump[r]; dst.flip[r] = src.flip[r]; }
      sd.spriteframes[f] = dst;
    }
    sprites[i] = sd;
  }
}

export function R_InitSprites() {
  R_InitSpriteDefs(sprnames);
}

// ---------- Sprite billboards (3D port) ----------

const _spriteTextureCache = new Map(); // lump index -> { tex, w, h, offsetX, offsetY }

function buildSpriteTexture(spriteLumpIndex) {
  const cached = _spriteTextureCache.get(spriteLumpIndex);
  if (cached !== undefined) return cached;
  const lumpnum = firstspritelump + spriteLumpIndex;
  const bytes = W_CacheLumpNum(lumpnum, 0);
  const p = patch_t(bytes);
  const w = p.width, h = p.height;
  const rgba = new Uint8Array(w * h * 4);
  // Decode column-post format into RGBA with alpha 0 for transparent pixels.
  for (let col = 0; col < w; col++) {
    let colptr = p.columnofs(col);
    while (bytes[colptr] !== 0xff) {
      const topdelta = bytes[colptr];
      const length   = bytes[colptr + 1];
      const srcStart = colptr + 3;
      for (let i = 0; i < length; i++) {
        const y = topdelta + i;
        const pix = bytes[srcStart + i] * 4;
        const idx = (y * w + col) * 4;
        rgba[idx + 0] = playpal_rgba[pix + 0];
        rgba[idx + 1] = playpal_rgba[pix + 1];
        rgba[idx + 2] = playpal_rgba[pix + 2];
        rgba[idx + 3] = 255;
      }
      colptr += length + 4;
    }
  }
  const tex = new THREE.DataTexture(rgba, w, h, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  // Doom patches store row 0 at the top; THREE.Sprite samples V=0 at bottom.
  // Flip so sprites display upright (without flipY, they appear inverted).
  tex.flipY = true;
  // sRGB so the shader linearises Doom's already-gamma-encoded palette colors
  // before any lighting math; output sRGB then gamma-encodes the result.
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  const info = { tex, w, h, offsetX: p.leftoffset, offsetY: p.topoffset };
  _spriteTextureCache.set(spriteLumpIndex, info);
  return info;
}

// Dispose every cached sprite texture and drop the cache. Called from
// R_NewMap before the level group is torn down, since wall/sprite materials
// (in the old level) still reference these textures and would leak otherwise.
export function R_ClearSpriteCache() {
  for (const entry of _spriteTextureCache.values()) entry.tex.dispose();
  _spriteTextureCache.clear();
}

// Track live billboards so we can update them per-frame from mobj state.
const _liveSprites = []; // [{ sprite: THREE.Sprite, mobj: mobj_t }, ...]
// The level's 'things' THREE.Group. P_SpawnMobj-driven registrations add new
// sprites here directly; R_NewMap resets this each level.
let _thingsGroup = null;

// View origin (in Doom fixed-point) — updated by R_SetupFrame.
export let viewx = 0, viewy = 0;
export function set_view(x, y) { viewx = x; viewy = y; }

// Vanilla r_things.c walks sec->thinglist each frame, so a removed mobj just
// stops appearing. Our parallel _liveSprites list needs an explicit prune
// when P_RemoveMobj fires — otherwise R_UpdateSprites keeps reading states[
// mo.state]; once mo.state is S_NULL, states[0].sprite is SPR_TROO and the
// billboard renders as a frozen imp.
export function R_RemoveMobjSprite(mobj) {
  for (let i = 0; i < _liveSprites.length; i++) {
    if (_liveSprites[i].mobj !== mobj) continue;
    const sp = _liveSprites[i].sprite;
    if (sp.parent !== null) sp.parent.remove(sp);
    if (sp.material !== null) sp.material.dispose();
    _liveSprites.splice(i, 1);
    return;
  }
}

// Mirror of vanilla's "any mobj is potentially visible" model: every mobj
// P_SpawnMobj creates gets a sprite billboard added to the level's things
// group. P_RemoveMobj's R_RemoveMobjSprite tears it back down. R_UpdateSprites
// then refreshes texture/position from the mobj's current state each frame.
export function R_RegisterMobjSprite(mobj) {
  if (_thingsGroup === null) return; // level not yet rendered (boot transient)
  // Bare sprite — texture/scale/position set on first R_UpdateSprites pass.
  // We use a placeholder material so the sprite is valid even before the
  // first update; R_UpdateSprites overwrites .map immediately.
  const mat = new THREE.SpriteMaterial({ transparent: true, alphaTest: 0.5, depthWrite: true });
  const sprite = new THREE.Sprite(mat);
  // Hide until R_UpdateSprites positions it — avoids a single-frame flash
  // at (0,0,0) for newly-spawned mobjs.
  sprite.visible = false;
  _thingsGroup.add(sprite);
  _liveSprites.push({ sprite, mobj });
}

export function R_UpdateSprites() {
  for (const entry of _liveSprites) {
    const mo = entry.mobj;
    if (mo === null) continue;
    const st = states[mo.state];
    if (st === undefined) continue;
    const sd = sprites[st.sprite];
    if (sd === undefined || sd.numframes === 0) continue;
    const frame = st.frame & 0x7fff;
    if (frame >= sd.numframes) continue;
    const sf = sd.spriteframes[frame];
    // Pick rotation: 8 segments around the thing. R_PointToAngle2 → angle
    // from view to thing, then (thing.angle - that - π/8) >> 29 (3 bits).
    let lumpIdx, flipped;
    if (sf.rotate === false) {
      lumpIdx = sf.lump[0];
      flipped = sf.flip[0];
    } else {
      // Vanilla r_things.c: rot = (ang - thing->angle + 9*ANG45/2) >> 29
      // where ang = R_PointToAngle2(viewer, thing) — viewer-to-thing.
      // The sign was flipped in the original port so we saw the back when an
      // enemy faced us. Fixed: use (angleToThing - thingAngle) as in vanilla.
      const dx = mo.x - viewx;
      const dy = mo.y - viewy;
      const angleToThing = Math.atan2(dy, dx); // -π..π
      const thingAngleRad = (mo.angle >>> 0) / 0x100000000 * Math.PI * 2;
      // 9 * ANG45 / 2 in radians = 9π/8.
      let r = angleToThing - thingAngleRad + (9 * Math.PI / 8);
      while (r < 0) r += Math.PI * 2;
      while (r >= Math.PI * 2) r -= Math.PI * 2;
      const idx = (r / (Math.PI / 4)) | 0; // 0..7
      lumpIdx = sf.lump[idx & 7];
      flipped = sf.flip[idx & 7];
    }
    if (lumpIdx < 0) continue;
    const t = buildSpriteTexture(lumpIdx);
    if (entry.sprite.material.map !== t.tex) {
      entry.sprite.material.map = t.tex;
      entry.sprite.material.needsUpdate = true;
      entry.sprite.scale.set(flipped ? -t.w : t.w, t.h, 1);
    } else if (entry.sprite.scale.x !== (flipped ? -t.w : t.w)) {
      entry.sprite.scale.x = flipped ? -t.w : t.w;
    }
    // Vanilla R_ProjectSprite anchors the sprite top at (mobj.z + topoffset)
    // and draws downwards; bottom edge sits at (mobj.z + topoffset - height).
    // Three.Sprite centres on .position, so we shift down by h/2.
    entry.sprite.position.set(
      mo.x / 65536,
      mo.z / 65536 + t.offsetY - t.h / 2,
      -mo.y / 65536,
    );
    if (entry.sprite.visible === false) entry.sprite.visible = true;
  }
}

// Vanilla r_things.c iterates each visible sector's thinglist per frame and
// projects every mobj. Here we maintain a parallel 'things' group: at level
// build time we iterate the post-P_SetupLevel thinker list and register a
// billboard for every existing mobj (initial mapthings, the player itself,
// etc.). Mid-game spawns hook P_SpawnMobj → R_RegisterMobjSprite so dropped
// items, projectiles, blood, puffs and gibs all appear. P_RemoveMobj fires
// R_RemoveMobjSprite to drop the billboard when the mobj is gone.
//
// `scene` parameter kept for API compatibility with R_NewMap.
export function R_BuildSpriteBillboards(scene) {
  // Tear down any previous billboards (sprites and their materials live under
  // the previous _levelRoot; R_NewMap will have already disposed it).
  _liveSprites.length = 0;
  _thingsGroup = new THREE.Group();
  _thingsGroup.name = 'things';
  scene.add(_thingsGroup);
  // Walk the thinker list and register every mobj that's already in the
  // world (initial map things + player). p_tick.js's thinkercap is a doubly-
  // linked sentinel; thinker.__mobj backlinks to the mobj_t.
  if (typeof globalThis !== 'undefined' && globalThis.__doom_thinkercap !== undefined) {
    const cap = globalThis.__doom_thinkercap;
    for (let cur = cap.next; cur !== cap; cur = cur.next) {
      const mo = cur.__mobj;
      if (mo !== undefined && mo !== null) R_RegisterMobjSprite(mo);
    }
  }
  return _thingsGroup;
}
