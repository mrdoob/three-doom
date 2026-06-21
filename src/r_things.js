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
import { R_PointToAngle2 } from './r_bsp.js';
import { MF_SHADOW } from './p_mobj.js';

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

// Wrap an RGBA buffer as a sprite DataTexture with Doom's display settings.
function makeSpriteDataTexture(data, w, h) {
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat);
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
  return tex;
}

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
  const tex = makeSpriteDataTexture(rgba, w, h);
  const info = { tex, texFlipped: null, w, h, offsetX: p.leftoffset, offsetY: p.topoffset };
  _spriteTextureCache.set(spriteLumpIndex, info);
  return info;
}

// Doom's `flip` rotations (6/7/8 reuse 4/3/2's lumps mirrored). THREE.Sprite
// ignores a negative scale.x, so we build a genuinely horizontally-mirrored
// texture and cache it lazily on the lump's entry.
function getFlippedTexture(info) {
  if (info.texFlipped !== null) return info.texFlipped;
  const w = info.w, h = info.h;
  const src = info.tex.image.data;
  const dst = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + (w - 1 - x)) * 4;
      const d = (y * w + x) * 4;
      dst[d] = src[s]; dst[d + 1] = src[s + 1];
      dst[d + 2] = src[s + 2]; dst[d + 3] = src[s + 3];
    }
  }
  const tex = makeSpriteDataTexture(dst, w, h);
  info.texFlipped = tex;
  return tex;
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
  const mat = new THREE.SpriteMaterial({ transparent: true });
  setSpriteOpaqueMode(mat);
  const sprite = new THREE.Sprite(mat);
  // Hide until R_UpdateSprites positions it — avoids a single-frame flash
  // at (0,0,0) for newly-spawned mobjs.
  sprite.visible = false;
  _thingsGroup.add(sprite);
  _liveSprites.push({ sprite, mobj, _isShadow: false });
}

// info.c state.frame layout — high bit FF_FULLBRIGHT marks fullbright frames
// (projectiles, fireballs, plasma). The low 15 bits FF_FRAMEMASK index into
// sprite_t.spriteframes.
const FF_FULLBRIGHT = 0x8000;
const FF_FRAMEMASK  = 0x7fff;

// MF_SHADOW (p_mobj.js) — the Spectre and the partial-invisibility powerup.
// Vanilla draws these with fuzzcolfunc, a shimmering screen-space distortion
// through a dark colormap. We can't run that screen-space pass yet, so we
// approximate it with subtractive blending: rather than drawing a flat dark
// billboard, the silhouette *subtracts* its colour from the framebuffer, so the
// Spectre reads as a shimmering black-and-white distortion of whatever is behind
// it. With SubtractEquation and One/One factors the blend resolves to
//   result = srcColour - dstColour
// and a near-white srcColour yields ~(1 - background), i.e. a photo-negative
// silhouette. The colour (subtraction strength) flickers and the billboard
// jitters each frame (see R_UpdateSprites).
const SHADOW_FUZZ    = 0.9;  // base subtraction strength (0..1 grey srcColour)
const SHADOW_FLICKER = 0.1;  // +/- per-frame shimmer on the fuzz strength
const SHADOW_JITTER  = 1.5;  // vertical position shimmer, in map units
// Opacity stays at 1 for MF_SHADOW (the darkening comes from the blend, not from
// translucency), so silhouette texels keep full alpha. Use a low cutout so the
// soft antialiased fuzz edges survive while the transparent surround (alpha 0)
// is still discarded.
const SHADOW_ALPHATEST = 0.1;
// Default cutout for fully opaque sprites: keep solid texels, drop the
// transparent surround.
const SPRITE_ALPHATEST = 0.5;

// The two sprite render modes. Both the initial material (R_RegisterMobjSprite)
// and the runtime MF_SHADOW toggle (R_UpdateSprites) route through these so the
// opaque defaults and the fuzz blend state can't drift apart.
function setSpriteOpaqueMode(mat) {
  mat.blending = THREE.NormalBlending; // default sprite blend
  mat.depthWrite = true;
  mat.opacity = 1;
  mat.alphaTest = SPRITE_ALPHATEST; // keep solid texels, drop the surround
}
function setSpriteShadowMode(mat) {
  // Subtractive blend (see SHADOW_FUZZ comment): the silhouette subtracts its
  // colour from the framebuffer instead of overwriting it.
  mat.blending = THREE.CustomBlending;
  mat.blendEquation = THREE.SubtractEquation; // result = src - dst
  mat.blendSrc = THREE.OneFactor;
  mat.blendDst = THREE.OneFactor;
  mat.depthWrite = false; // translucent: don't occlude what's behind it
  mat.opacity = 1; // darkening comes from the blend, not from translucency
  mat.alphaTest = SHADOW_ALPHATEST;
}

export function R_UpdateSprites() {
  for (const entry of _liveSprites) {
    const mo = entry.mobj;
    if (mo === null) continue;
    const isShadow = (mo.flags & MF_SHADOW) !== 0;
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
    if (entry.sprite.material.map !== tex) {
      entry.sprite.material.map = tex;
      entry.sprite.material.needsUpdate = true;
    }
    if (entry.sprite.scale.x !== t.w || entry.sprite.scale.y !== t.h) {
      entry.sprite.scale.set(t.w, t.h, 1);
    }
    // Vanilla R_ProjectSprite anchors the sprite top at (mobj.z + topoffset)
    // and draws downwards; bottom edge sits at (mobj.z + topoffset - height).
    // Three.Sprite centres on .position, so we shift down by h/2.
    const halfH = t.h / 2;
    let centerY = mo.z / 65536 + t.offsetY - halfH;
    // Vanilla draws sprites *over* the floor flat, so the few pixels that dip
    // below the mobj's z (topoffset < height, e.g. BON1's flask base) stay
    // visible. Our true-3D floor plane is opaque and would occlude them. Clamp
    // the sprite so its bottom never sinks below the floor it stands on — the
    // full sprite then rests on the floor instead of being clipped into it.
    // Floating items (soulsphere, keys) already sit above the floor, so the
    // clamp leaves them untouched.
    const floorY = mo.floorz / 65536;
    if (centerY - halfH < floorY) centerY = floorY + halfH;
    // Fuzz shimmer: nudge the Spectre's billboard vertically each frame.
    if (isShadow) centerY += (Math.random() - 0.5) * SHADOW_JITTER;
    entry.sprite.position.set(
      mo.x / 65536,
      centerY,
      -mo.y / 65536,
    );
    // MF_SHADOW (Spectre / partial-invisibility powerup): swap the lit opaque
    // billboard for a subtractive, shimmering one. The flag can toggle at
    // runtime (the powerup wears off), so switch material modes on change.
    const mat = entry.sprite.material;
    if (isShadow !== entry._isShadow) {
      if (isShadow) {
        setSpriteShadowMode(mat);
      } else {
        setSpriteOpaqueMode(mat);
        entry._lastLight = -1; // force the light tint below to re-apply
      }
      mat.needsUpdate = true;
      entry._isShadow = isShadow;
    }

    if (isShadow) {
      // Flicker the subtraction strength (src grey level) to mimic fuzzcolfunc's
      // shimmering static. A near-white src subtracts most of the background.
      const f = SHADOW_FUZZ + (Math.random() - 0.5) * 2 * SHADOW_FLICKER;
      mat.color.setRGB(f, f, f);
    } else {
      // Sector lighting: vanilla r_things.c:R_ProjectSprite picks a colormap row
      // from the sector's lightlevel (and distance, via spritelights[]); we
      // approximate by tinting the sprite material with the lightlevel scaled
      // 0..1. FF_FULLBRIGHT (projectiles, fireballs, plasma) overrides.
      const fullbright = (st.frame & FF_FULLBRIGHT) !== 0;
      let light = 1;
      if (fullbright !== true && mo.subsector !== null && mo.subsector.sector !== null) {
        light = (mo.subsector.sector.lightlevel | 0) / 255;
        if (light < 0) light = 0; else if (light > 1) light = 1;
      }
      // Skip the material uniform write when the sector light is unchanged —
      // typical for thinkers standing still in a static-light room.
      if (entry._lastLight !== light) {
        mat.color.setRGB(light, light, light);
        entry._lastLight = light;
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
      if (mo !== undefined && mo !== null) R_RegisterMobjSprite(mo);
    }
  }
  return _thingsGroup;
}
