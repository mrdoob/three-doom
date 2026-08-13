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
import { firstspritelump, lastspritelump } from './r_data.js';
import { W_CacheLumpNum } from './w_wad.js';
import { lumpinfo } from './w_wad.js';
import { I_Error } from './i_system.js';
import { FRACUNIT } from './m_fixed.js';
import { patch_t } from './v_video.js';
import { R_PointToAngle2 } from './r_bsp.js';
import { R_MakeIndexedTexture, R_MakeDoomSpriteMaterial } from './r_shader.js';
import {
  R_MobjHasWorldSprite,
  R_PlayerTranslationFromFlags,
  SPRITE_FF_FULLBRIGHT,
  SPRITE_MF_SHADOW,
  SPRITE_SHADOW_FLICKER,
  SPRITE_SHADOW_OPACITY,
  SPRITE_SHADOW_PALETTE_INDEX,
} from './r_sprite_logic.js';
import { R_SpriteBillboardCenterY } from './r_sprite_projection.js';
import { R_MarkWorldSprite } from './r_sprite_depth.js';

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
const _prewarmedSpriteDefinitions = new Set();
let _spriteBaseBuilds = 0;
let _spriteFlipBuilds = 0;
let _uploadSpriteTexture = null;

// R_NewMap installs WebGLRenderer.initTexture here. Keeping the uploader
// injected avoids an r_things -> i_video cycle, and lets dynamically spawned
// actors warm their textures before the next display pass.
export function R_SetSpriteTextureUploader(uploadTexture) {
  _uploadSpriteTexture = typeof uploadTexture === 'function' ? uploadTexture : null;
  // A state hook may have decoded a sprite before the renderer was available.
  // Installing the uploader later must still move every retained texture to
  // the GPU before display.
  if (_uploadSpriteTexture !== null) {
    for (const entry of _spriteTextureCache.values()) {
      _uploadSpriteTexture(entry.tex);
      if (entry.texFlipped !== null) _uploadSpriteTexture(entry.texFlipped);
    }
  }
}

function uploadSpriteTexture(texture) {
  if (_uploadSpriteTexture !== null) _uploadSpriteTexture(texture);
}

// Wrap palette indices + binary alpha in the same RG8 representation as Doom
// world textures. Sprite rows are stored top-first, so flip on upload.
function makeSpriteDataTexture(indices, alphas, w, h) {
  const tex = R_MakeIndexedTexture(indices, alphas, w, h);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  // Doom patches store row 0 at the top; THREE.Sprite samples V=0 at bottom.
  // Flip so sprites display upright (without flipY, they appear inverted).
  tex.flipY = true;
  tex.needsUpdate = true;
  return tex;
}

function buildSpriteTexture(spriteLumpIndex) {
  const cached = _spriteTextureCache.get(spriteLumpIndex);
  if (cached !== undefined) return cached;
  const lumpnum = firstspritelump + spriteLumpIndex;
  const bytes = W_CacheLumpNum(lumpnum, 0);
  const p = patch_t(bytes);
  const w = p.width, h = p.height;
  const indices = new Uint8Array(w * h);
  const alphas = new Uint8Array(w * h);
  // Decode column-post format into palette indices plus binary alpha.
  for (let col = 0; col < w; col++) {
    let colptr = p.columnofs(col);
    while (bytes[colptr] !== 0xff) {
      const topdelta = bytes[colptr];
      const length   = bytes[colptr + 1];
      const srcStart = colptr + 3;
      for (let i = 0; i < length; i++) {
        const y = topdelta + i;
        const idx = y * w + col;
        indices[idx] = bytes[srcStart + i];
        alphas[idx] = 255;
      }
      colptr += length + 4;
    }
  }
  const tex = makeSpriteDataTexture(indices, alphas, w, h);
  const info = { tex, texFlipped: null, w, h, offsetX: p.leftoffset, offsetY: p.topoffset };
  _spriteTextureCache.set(spriteLumpIndex, info);
  _spriteBaseBuilds++;
  uploadSpriteTexture(tex);
  return info;
}

// Doom's `flip` rotations (6/7/8 reuse 4/3/2's lumps mirrored). THREE.Sprite
// ignores a negative scale.x, so we build a genuinely horizontally-mirrored
// texture and cache it lazily on the lump's entry.
function getFlippedTexture(info) {
  if (info.texFlipped !== null) return info.texFlipped;
  const w = info.w, h = info.h;
  const src = info.tex.image.data;
  const indices = new Uint8Array(w * h);
  const alphas = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + (w - 1 - x)) * 2;
      const d = y * w + x;
      indices[d] = src[s];
      alphas[d] = src[s + 1];
    }
  }
  const tex = makeSpriteDataTexture(indices, alphas, w, h);
  info.texFlipped = tex;
  _spriteFlipBuilds++;
  uploadSpriteTexture(tex);
  return tex;
}

function precacheSpriteDefinition(spriteIndex) {
  if (_prewarmedSpriteDefinitions.has(spriteIndex)) return;
  const definition = sprites?.[spriteIndex];
  if (definition === undefined || definition === null || definition.numframes === 0 ||
      !Array.isArray(definition.spriteframes)) {
    _prewarmedSpriteDefinitions.add(spriteIndex);
    return;
  }
  for (const frame of definition.spriteframes) {
    if (frame === undefined || frame === null) continue;
    const rotations = frame.rotate === true ? 8 : 1;
    for (let rotation = 0; rotation < rotations; rotation++) {
      const lump = frame.lump[rotation];
      if (!Number.isInteger(lump) || lump < 0) continue;
      const info = buildSpriteTexture(lump);
      if (frame.flip[rotation] === 1) getFlippedTexture(info);
    }
  }
  _prewarmedSpriteDefinitions.add(spriteIndex);
}

// Warm the complete sprite definition selected by one state. This is also
// injected into P_SetMobjState, covering exceptional runtime assignments such
// as a crusher replacing an arbitrary corpse with S_GIBS.
export function R_PrecacheMobjState(stateIndex) {
  if (!Number.isInteger(stateIndex) || stateIndex <= 0) return;
  const state = states[stateIndex];
  if (state === undefined || state === null || state.tics === 0) return;
  precacheSpriteDefinition(state.sprite);
}

const MOBJ_STATE_ROOTS = [
  'spawnstate', 'seestate', 'painstate', 'meleestate', 'missilestate',
  'deathstate', 'xdeathstate', 'raisestate',
];

export function R_PrecacheMobjSprite(mobj) {
  if (mobj === null || mobj === undefined) return;
  // Preserve native's current mobj->sprite marking even for a restored object
  // whose raw sprite/state fields disagree, then cover every normal state
  // family reachable for this actor type.
  if (Number.isInteger(mobj.sprite)) precacheSpriteDefinition(mobj.sprite);
  const roots = [mobj.state];
  if (mobj.info !== null && mobj.info !== undefined) {
    for (const key of MOBJ_STATE_ROOTS) roots.push(mobj.info[key]);
  }
  const visited = new Set();
  for (const root of roots) {
    let stateIndex = root;
    while (Number.isInteger(stateIndex) && stateIndex > 0 && !visited.has(stateIndex)) {
      visited.add(stateIndex);
      const state = states[stateIndex];
      if (state === undefined || state === null) break;
      if (state.tics !== 0) precacheSpriteDefinition(state.sprite);
      stateIndex = state.nextstate;
    }
  }
}

// Authoritative level warmup. R_NewMap calls this only after optional save
// restoration has installed the final thinker population.
export function R_PrecacheLevelSprites() {
  const cap = typeof globalThis === 'undefined' ? null : globalThis.__doom_thinkercap;
  if (cap === null || cap === undefined || cap.next === null) return R_GetSpriteCacheStats();
  for (let current = cap.next; current !== cap; current = current.next) {
    const mobj = current.__mobj;
    if (mobj !== undefined && mobj !== null && R_MobjHasWorldSprite(mobj.flags)) {
      R_PrecacheMobjSprite(mobj);
    }
  }
  return R_GetSpriteCacheStats();
}

export function R_GetSpriteCacheStats() {
  let flippedEntries = 0;
  for (const entry of _spriteTextureCache.values()) {
    if (entry.texFlipped !== null) flippedEntries++;
  }
  return {
    baseEntries: _spriteTextureCache.size,
    flippedEntries,
    baseBuilds: _spriteBaseBuilds,
    flipBuilds: _spriteFlipBuilds,
  };
}

// Dispose every cached sprite texture and drop the cache. Called from
// R_NewMap before the level group is torn down, since wall/sprite materials
// (in the old level) still reference these textures and would leak otherwise.
export function R_ClearSpriteCache() {
  for (const entry of _spriteTextureCache.values()) {
    entry.tex.dispose();
    if (entry.texFlipped !== null) entry.texFlipped.dispose();
  }
  _spriteTextureCache.clear();
  _prewarmedSpriteDefinitions.clear();
  _spriteBaseBuilds = 0;
  _spriteFlipBuilds = 0;
}

export function R_ShutdownThings() {
  _liveSprites.length = 0;
  _thingsGroup = null;
  viewx = 0;
  viewy = 0;
  R_ClearSpriteCache();
  _uploadSpriteTexture = null;
}

// Track live billboards so we can update them per-frame from mobj state.
const _liveSprites = []; // [{ sprite: THREE.Sprite, mobj: mobj_t }, ...]
// The level's 'things' THREE.Group. P_SpawnMobj-driven registrations add new
// sprites here directly; R_NewMap resets this each level.
let _thingsGroup = null;

function removeLiveSpriteAt(index) {
  const sp = _liveSprites[index].sprite;
  if (sp.parent !== null) sp.parent.remove(sp);
  if (sp.material !== null) sp.material.dispose();
  _liveSprites.splice(index, 1);
}

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
    removeLiveSpriteAt(i);
    return;
  }
}

// Mirror of vanilla's "any mobj is potentially visible" model: every mobj
// P_SpawnMobj creates gets a sprite billboard added to the level's things
// group. P_RemoveMobj's R_RemoveMobjSprite tears it back down. R_UpdateSprites
// then refreshes texture/position from the mobj's current state each frame.
export function R_RegisterMobjSprite(mobj) {
  // Vanilla discovers sprites only through sector.thinglist. MF_NOSECTOR
  // mobjs are thinkers but are intentionally absent from that list.
  if (mobj === null || !R_MobjHasWorldSprite(mobj.flags)) return;
  if (_thingsGroup === null) return; // level not yet rendered (boot transient)
  // Mid-game actors (projectiles, puffs, drops, fog) were absent from the
  // level-start thinker walk. Decode and upload their complete state family at
  // spawn time so R_UpdateSprites remains a cache-only display operation.
  R_PrecacheMobjSprite(mobj);
  // Bare sprite — texture/scale/position set on first R_UpdateSprites pass.
  // We use a placeholder material so the sprite is valid even before the
  // first update; R_UpdateSprites supplies its indexed map immediately.
  const mat = R_MakeDoomSpriteMaterial(null, {
    alphaCutoff: SPRITE_ALPHATEST,
    shadowPaletteIndex: SPRITE_SHADOW_PALETTE_INDEX,
  });
  const sprite = new THREE.Sprite(mat);
  R_MarkWorldSprite(sprite);
  // WebGLRenderer only copies Sprite.center automatically for SpriteMaterial.
  // Link the custom uniform to the same mutable Vector2 instead.
  mat.uniforms.center.value = sprite.center;
  // Hide until R_UpdateSprites positions it — avoids a single-frame flash
  // at (0,0,0) for newly-spawned mobjs.
  sprite.visible = false;
  _thingsGroup.add(sprite);
  _liveSprites.push({ sprite, mobj, _isShadow: false });
}

// info.c state.frame layout — high bit FF_FULLBRIGHT marks fullbright frames
// (projectiles, fireballs, plasma). The low 15 bits FF_FRAMEMASK index into
// sprite_t.spriteframes.
const FF_FRAMEMASK  = 0x7fff;

// MF_SHADOW (p_mobj.js) — the Spectre and the partial-invisibility powerup.
// Vanilla draws these with fuzzcolfunc, a shimmering screen-space distortion
// through a dark colormap. We can't run that screen-space pass yet, so we
// approximate it with a dark, semi-transparent billboard that flickers and
// jitters each frame (see R_UpdateSprites).
const SHADOW_JITTER  = 1.5;  // vertical position shimmer, in map units
// Below the opacity floor (SPRITE_SHADOW_OPACITY - SPRITE_SHADOW_FLICKER =
// 0.24) so silhouette
// texels pass, above 0 so the transparent surround is still discarded.
const SHADOW_ALPHATEST = 0.1;
// Default cutout for fully opaque sprites: keep solid texels, drop the
// transparent surround. Shared by the material constructor and the shadow
// restore path so they can't drift apart.
const SPRITE_ALPHATEST = 0.5;

// Apply the source-authored patch bounds to a Three.js billboard. Keeping this
// operation explicit makes it possible to verify the actual Sprite geometry,
// including its non-central horizontal origin, without running the game loop.
export function R_ApplySpritePatchGeometry(sprite, mobj, patch) {
  if (sprite.scale.x !== patch.w || sprite.scale.y !== patch.h) {
    sprite.scale.set(patch.w, patch.h, 1);
  }
  const centerX = patch.offsetX / patch.w;
  if (sprite.center.x !== centerX) sprite.center.x = centerX;
  sprite.position.set(
    mobj.x / FRACUNIT,
    R_SpriteBillboardCenterY(mobj.z, patch.offsetY, patch.h),
    -mobj.y / FRACUNIT,
  );
}

export function R_UpdateSprites() {
  for (let i = 0; i < _liveSprites.length; i++) {
    const entry = _liveSprites[i];
    const mo = entry.mobj;
    if (mo === null) continue;
    // Flags can change after registration. Match removal from the sector list
    // immediately rather than leaving a stale billboard alive indefinitely.
    if (!R_MobjHasWorldSprite(mo.flags)) {
      removeLiveSpriteAt(i);
      i--;
      continue;
    }
    const isShadow = (mo.flags & SPRITE_MF_SHADOW) !== 0;
    const st = states[mo.state];
    if (st === undefined) continue;
    const sd = sprites[st.sprite];
    if (sd === undefined || sd.numframes === 0) continue;
    const frame = st.frame & FF_FRAMEMASK;
    if (frame >= sd.numframes) continue;
    const sf = sd.spriteframes[frame];
    // Pick rotation: 8 segments around the thing. R_PointToAngle2 → angle
    // from view to thing, then (thing.angle - that - π/8) >> 29 (3 bits).
    let lumpIdx, flipped;
    if (sf.rotate === false) {
      lumpIdx = sf.lump[0];
      flipped = sf.flip[0];
    } else {
      // r_things.c:R_ProjectSprite:
      //   ang = R_PointToAngle(thing->x, thing->y);
      //   rot = (ang - thing->angle + (unsigned)(ANG45/2)*9) >> 29;
      // Match vanilla bit-for-bit using R_PointToAngle2 (which uses the
      // tantoangle LUT, not Math.atan2). The unsigned arithmetic wraps
      // around 2^32 implicitly via >>> 0.
      const ang   = R_PointToAngle2(viewx, viewy, mo.x, mo.y) >>> 0;
      const ta    = mo.angle >>> 0;
      const off   = 0x90000000;            // 9 * ANG45 / 2 = 9 * 0x10000000.
      const rot32 = ((ang - ta + off) | 0) >>> 0; // wrap to uint32.
      const idx   = (rot32 >>> 29) & 7;
      lumpIdx = sf.lump[idx];
      flipped = sf.flip[idx];
    }
    if (lumpIdx < 0) continue;
    const t = buildSpriteTexture(lumpIdx);
    const tex = flipped === 1 ? getFlippedTexture(t) : t.tex;
    if (entry.sprite.material.uniforms.map.value !== tex) {
      entry.sprite.material.uniforms.map.value = tex;
    }
    // R_ProjectSprite subtracts spriteoffset horizontally and anchors the top
    // at mobj.z + spritetopoffset. Flipping changes only column sampling; the
    // projected bounds stay fixed. Do not lift short-origin patches to the
    // floor: the split sprite-depth pass draws them over visplanes while its
    // wall-only depth buffer clips the exact bounds against nearer drawsegs.
    R_ApplySpritePatchGeometry(entry.sprite, mo, t);
    // Fuzz shimmer: nudge the Spectre's billboard vertically each frame.
    if (isShadow) entry.sprite.position.y += (Math.random() - 0.5) * SHADOW_JITTER;
    // MF_SHADOW (Spectre / partial-invisibility powerup): swap the lit opaque
    // billboard for a dark, translucent, shimmering one. The flag can toggle at
    // runtime (the powerup wears off), so switch material modes on change.
    const mat = entry.sprite.material;
    const uniforms = mat.uniforms;
    const playerTranslation = R_PlayerTranslationFromFlags(mo.flags);
    if (entry._lastPlayerTranslation !== playerTranslation) {
      uniforms.playerTranslation.value = playerTranslation;
      entry._lastPlayerTranslation = playerTranslation;
    }
    if (isShadow !== entry._isShadow) {
      if (isShadow) {
        mat.depthWrite = false; // translucent: don't occlude what's behind it
        uniforms.shadow.value = true;
        // The default alpha cutoff (0.5) compares against texAlpha * opacity.
        // SPRITE_SHADOW_OPACITY (~0.33) puts every silhouette texel below the
        // default 0.5 cutoff and would discard the Spectre entirely. Drop the
        // threshold below the flickering opacity floor so the silhouette survives,
        // while the fully transparent surround (alpha 0) is still culled.
        uniforms.alphaCutoff.value = SHADOW_ALPHATEST;
      } else {
        uniforms.shadow.value = false;
        uniforms.opacity.value = 1;
        mat.depthWrite = true;
        uniforms.alphaCutoff.value = SPRITE_ALPHATEST;
        entry._lastLightBucket = -1;
        entry._lastFullbright = null;
      }
      entry._isShadow = isShadow;
    }

    if (isShadow) {
      // Per-frame flicker mimics fuzzcolfunc's shimmering static.
      uniforms.opacity.value = SPRITE_SHADOW_OPACITY
        + (Math.random() - 0.5) * 2 * SPRITE_SHADOW_FLICKER;
    } else {
      // R_AddSprites selects a sector bucket before R_ProjectSprite applies
      // fixed/fullbright/distance precedence in the shader.
      const fullbright = (mo.frame & SPRITE_FF_FULLBRIGHT) !== 0;
      let lightBucket = 15;
      if (mo.subsector !== null && mo.subsector.sector !== null) {
        lightBucket = mo.subsector.sector.lightlevel >> 4;
      }
      if (entry._lastLightBucket !== lightBucket) {
        uniforms.sectorLight.value = lightBucket;
        entry._lastLightBucket = lightBucket;
      }
      if (entry._lastFullbright !== fullbright) {
        uniforms.fullbright.value = fullbright;
        entry._lastFullbright = fullbright;
      }
    }
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
      if (mo !== undefined && mo !== null && R_MobjHasWorldSprite(mo.flags)) {
        R_RegisterMobjSprite(mo);
      }
    }
  }
  return _thingsGroup;
}
