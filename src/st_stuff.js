// Ported from: linuxdoom-1.10/st_stuff.c, st_stuff.h
// Status bar: STBAR + STARMS + STTNUM* + STYSNUM*/STGNUM* + STKEYS* + STF***
// face widgets, all rendered via Canvas2D from the WAD's actual patches.

import { players, consoleplayer } from './doomstat.js';
import { weapontype_t, ammotype_t } from './doomdef.js';
import { V_DecodePatchToCanvas, V_DrawPatchAtCanvas } from './v_video.js';
import { M_Random } from './m_random.js';
import { R_PointToAngle2 } from './r_bsp.js';
import { ANG45, ANG180 } from './tables.js';

// Patches are decoded + cached centrally in v_video.js (V_DecodePatchToCanvas).
const getPatch    = V_DecodePatchToCanvas;
const drawPatchAt = V_DrawPatchAtCanvas;

// Right-align a positive integer at (rightX, y) using digit patches `family + d`.
function drawNumber(ctx, num, rightX, y, sx, sy, family) {
  const str = String(Math.max(0, Math.floor(num)));
  const digits = [];
  let totalW = 0;
  for (const ch of str) {
    const p = getPatch(family + ch);
    if (p === null) continue;
    digits.push(p);
    totalW += p.w;
  }
  let cx = rightX - totalW * sx;
  for (const d of digits) {
    ctx.drawImage(d.canvas, cx, y, d.w * sx, d.h * sy);
    cx += d.w * sx;
  }
}

// ---------- Face state machine (ports st_stuff.c ST_updateFaceWidget) ----------
const ST_NUMPAINFACES     = 5;
const ST_NUMSTRAIGHTFACES = 3;
const ST_NUMTURNFACES     = 2;
const ST_NUMSPECIALFACES  = 3;
const ST_FACESTRIDE       = ST_NUMSTRAIGHTFACES + ST_NUMTURNFACES + ST_NUMSPECIALFACES;
const ST_TURNOFFSET       = ST_NUMSTRAIGHTFACES;
const ST_OUCHOFFSET       = ST_TURNOFFSET + ST_NUMTURNFACES;
const ST_EVILGRINOFFSET   = ST_OUCHOFFSET + 1;
const ST_RAMPAGEOFFSET    = ST_EVILGRINOFFSET + 1;
const ST_GODFACE          = ST_NUMPAINFACES * ST_FACESTRIDE;
const ST_DEADFACE         = ST_GODFACE + 1;
const ST_EVILGRINCOUNT    = 2 * 35;
const ST_TURNCOUNT        = 1 * 35;
const ST_STRAIGHTFACECOUNT = (35 / 2) | 0;
const ST_MUCHPAIN         = 20;
const CF_GODMODE          = 2;

let _faceIndex = 0;
let _faceCount = 0;
let _priority  = 0;
let _lastHealth = 100;
let _oldWeaponsOwned = [false, false, false, false, false, false, false, false, false];
let _lastAttackDown = -1;
// st_stuff.c:393 — st_randomnumber: M_Random() called ONCE per tic in
// ST_Ticker and reused for face-pose selection so we burn one RNG entry per
// tic regardless of which branch runs. Critical for demo determinism.
let _stRandomNumber = 0;

function faceHealthIndex(h) {
  if (h >= 80) return 0;
  if (h >= 60) return 1;
  if (h >= 40) return 2;
  if (h >= 20) return 3;
  return 4;
}

function updateFaceWidget(p) {
  // st_stuff.c:752 — ST_updateFaceWidget. The priority cascade is "if not
  // already claimed by a higher priority, consider this branch". Each branch
  // may overwrite the face state computed by a lower one.

  if (_priority < 10) {
    if (p.health <= 0) {
      _priority = 9; _faceIndex = ST_DEADFACE; _faceCount = 1;
    }
  }

  // Evil grin — just picked up a new weapon (gated on bonuscount in vanilla).
  if (_priority < 9) {
    if (p.bonuscount > 0) {
      let doevilgrin = false;
      for (let i = 0; i < _oldWeaponsOwned.length; i++) {
        if (_oldWeaponsOwned[i] !== p.weaponowned[i]) {
          doevilgrin = true;
          _oldWeaponsOwned[i] = p.weaponowned[i];
        }
      }
      if (doevilgrin === true) {
        _priority = 8; _faceCount = ST_EVILGRINCOUNT;
        _faceIndex = ST_EVILGRINOFFSET + ST_FACESTRIDE * faceHealthIndex(p.health);
      }
    }
  }

  // Being attacked by another mobj.
  if (_priority < 8) {
    if (p.damagecount > 0 && p.attacker !== null && p.attacker !== p.mo) {
      _priority = 7;
      // C compares `plyr->health - st_oldhealth > 20`. That's "health JUMPED
      // UP by >20 since last tic" — almost never true in practice (it's a
      // known vanilla quirk). Preserve it literally for demo parity.
      if (p.health - _lastHealth > ST_MUCHPAIN) {
        _faceCount = ST_TURNCOUNT;
        _faceIndex = ST_OUCHOFFSET + ST_FACESTRIDE * faceHealthIndex(p.health);
      } else {
        // Choose head-on / turn-left / turn-right from attacker geometry,
        // matching st_stuff.c:814. `i` from C is a boolean derived from the
        // unsigned BAM comparison; preserve the same logic.
        const badguy = R_PointToAngle2(p.mo.x, p.mo.y, p.attacker.x, p.attacker.y) >>> 0;
        const my = p.mo.angle >>> 0;
        let diffang, i;
        if (badguy > my) {
          diffang = (badguy - my) >>> 0;
          i = diffang > ANG180 ? 1 : 0;
        } else {
          diffang = (my - badguy) >>> 0;
          i = diffang <= ANG180 ? 1 : 0;
        }
        _faceCount = ST_TURNCOUNT;
        _faceIndex = ST_FACESTRIDE * faceHealthIndex(p.health);
        if (diffang < ANG45) {
          _faceIndex += ST_RAMPAGEOFFSET;       // head-on
        } else if (i === 1) {
          _faceIndex += ST_TURNOFFSET;          // turn right
        } else {
          _faceIndex += ST_TURNOFFSET + 1;      // turn left
        }
      }
    }
  }

  // Self-inflicted / environmental damage (no attacker or attacker is self).
  if (_priority < 7) {
    if (p.damagecount > 0) {
      if (p.health - _lastHealth > ST_MUCHPAIN) {
        _priority = 7; _faceCount = ST_TURNCOUNT;
        _faceIndex = ST_OUCHOFFSET + ST_FACESTRIDE * faceHealthIndex(p.health);
      } else {
        _priority = 6; _faceCount = ST_TURNCOUNT;
        _faceIndex = ST_RAMPAGEOFFSET + ST_FACESTRIDE * faceHealthIndex(p.health);
      }
    }
  }

  // Rampage — held attack button for 2+ seconds.
  if (_priority < 6) {
    if (p.attackdown !== 0) {
      if (_lastAttackDown === -1) _lastAttackDown = 2 * 35;
      else if (--_lastAttackDown === 0) {
        _priority = 5;
        _faceIndex = ST_RAMPAGEOFFSET + ST_FACESTRIDE * faceHealthIndex(p.health);
        _faceCount = 1;
        _lastAttackDown = 1;
      }
    } else {
      _lastAttackDown = -1;
    }
  }

  // God mode and invulnerability sphere.
  if (_priority < 5) {
    if ((p.cheats & CF_GODMODE) !== 0
        || (p.powers != null && p.powers[0 /*pw_invulnerability*/] !== 0)) {
      _priority = 4;
      _faceIndex = ST_GODFACE;
      _faceCount = 1;
    }
  }

  // Idle pose if the face counter has timed out. C uses `!st_facecount`
  // (post-decrement on the previous tic landed us at 0). Reuse the per-tic
  // st_randomnumber to pick the pose — must NOT call M_Random() here, or
  // demos desync.
  if (_faceCount === 0) {
    _faceIndex = (_stRandomNumber % 3) + ST_FACESTRIDE * faceHealthIndex(p.health);
    _faceCount = ST_STRAIGHTFACECOUNT;
    _priority = 0;
  }
  _faceCount--;
  _lastHealth = p.health;
}

function faceLumpName() {
  if (_faceIndex === ST_GODFACE)  return 'STFGOD0';
  if (_faceIndex === ST_DEADFACE) return 'STFDEAD0';
  const pain = (_faceIndex / ST_FACESTRIDE) | 0;
  const off  = _faceIndex - pain * ST_FACESTRIDE;
  if (off < ST_NUMSTRAIGHTFACES) return `STFST${pain}${off}`;
  if (off === ST_OUCHOFFSET)     return `STFOUCH${pain}`;
  if (off === ST_EVILGRINOFFSET) return `STFEVL${pain}`;
  if (off === ST_RAMPAGEOFFSET)  return `STFKILL${pain}`;
  if (off === ST_TURNOFFSET)     return `STFTR${pain}0`;
  if (off === ST_TURNOFFSET + 1) return `STFTL${pain}0`;
  return `STFST${pain}0`;
}

// ---------- Palette flashes ----------
// STARMS slot positions (px, py, weapontype) — hoisted out of the per-frame
// drawer to avoid re-allocating the 6-entry literal every frame.
const ARMS_CELLS = [
  [111, 172, 1], [123, 172, 2], [135, 172, 3],
  [111, 182, 4], [123, 182, 5], [135, 182, 6],
];

const STARTREDPALS = 1, NUMREDPALS = 8;
const STARTBONUSPALS = 9, NUMBONUSPALS = 4;
const RADIATIONPAL = 13;
let _lastPaletteIndex = 0;
let _setPaletteIndex = null;

export function ST_SetExternals(refs) { if (refs.I_SetPaletteIndex != null) _setPaletteIndex = refs.I_SetPaletteIndex; }

export function ST_doPaletteStuff() {
  const p = players[consoleplayer];
  if (p === undefined || p === null) return;
  let palette = 0;
  let cnt = p.damagecount;
  // st_stuff.c:1010 — berserk fades out red palette slowly.
  if (p.powers != null && p.powers[1 /*pw_strength*/] !== 0) {
    const bzc = 12 - (p.powers[1] >> 6);
    if (bzc > cnt) cnt = bzc;
  }
  if (cnt > 0) {
    palette = ((cnt + 7) >> 3) | 0;
    if (palette >= NUMREDPALS) palette = NUMREDPALS - 1;
    palette += STARTREDPALS;
  } else if (p.bonuscount > 0) {
    palette = ((p.bonuscount + 7) >> 3) | 0;
    if (palette >= NUMBONUSPALS) palette = NUMBONUSPALS - 1;
    palette += STARTBONUSPALS;
  } else if (p.powers != null && (p.powers[3] > 4 * 32 || (p.powers[3] & 8) !== 0)) {
    // st_stuff.c:1039 — radsuit indicator: solid green when > 128 tics,
    // blinks via bit 3 as the power expires.
    palette = RADIATIONPAL;
  }
  if (palette !== _lastPaletteIndex && _setPaletteIndex !== null) {
    _setPaletteIndex(palette);
    _lastPaletteIndex = palette;
  }
  // NB: damagecount/bonuscount decrement happens in P_PlayerThink — mirroring
  // vanilla. We must not double-decrement here.
}

// ---------- Lifecycle ----------
export function ST_Init() {}
export function ST_Start() {
  _faceIndex = 0; _faceCount = ST_STRAIGHTFACECOUNT; _priority = 0;
  for (let i = 0; i < _oldWeaponsOwned.length; i++) _oldWeaponsOwned[i] = false;
  const p = players[consoleplayer];
  if (p !== null && p !== undefined) _lastHealth = p.health;
}
let _stStartedThisLevel = false;
let _lastSeenMo = null;
export function ST_Ticker() {
  const p = players[consoleplayer];
  if (p === null || p === undefined) return;
  // st_stuff.c:992 — st_randomnumber sampled once per tic.
  _stRandomNumber = M_Random();
  // Reset face state when a new player mobj appears (new level / respawn).
  if (p.mo !== _lastSeenMo) {
    _stStartedThisLevel = false;
    _lastSeenMo = p.mo;
  }
  if (_stStartedThisLevel === false) {
    for (let i = 0; i < _oldWeaponsOwned.length; i++) _oldWeaponsOwned[i] = p.weaponowned[i] === true;
    _lastHealth = p.health;
    _faceIndex = 0; _faceCount = ST_STRAIGHTFACECOUNT; _priority = 0;
    _stStartedThisLevel = true;
  }
  updateFaceWidget(p);
}
export function ST_Responder(_ev) { return false; }

function weaponAmmoIndex(w) {
  switch (w) {
    case weapontype_t.wp_fist:
    case weapontype_t.wp_chainsaw:        return -1;
    case weapontype_t.wp_pistol:
    case weapontype_t.wp_chaingun:        return ammotype_t.am_clip;
    case weapontype_t.wp_shotgun:
    case weapontype_t.wp_supershotgun:    return ammotype_t.am_shell;
    case weapontype_t.wp_plasma:
    case weapontype_t.wp_bfg:             return ammotype_t.am_cell;
    case weapontype_t.wp_missile:         return ammotype_t.am_misl;
    default:                              return -1;
  }
}

// ---------- Status bar drawer ----------
// dstX/dstY/dstW/dstH = destination rectangle for the FULL 320x200 virtual screen
// (status bar occupies the bottom 32 of 200 rows).
export function ST_Drawer(overlayCtx, dstX, dstY, dstW, dstH) {
  const p = players[consoleplayer];
  if (p === null || p === undefined || p.mo === null) return;
  const sx = dstW / 320;
  const sy = dstH / 200;
  const barY = dstY + 168 * sy;
  // 1) STBAR background.
  const stbar = getPatch('STBAR');
  if (stbar !== null) {
    overlayCtx.drawImage(stbar.canvas, dstX, barY, 320 * sx, 32 * sy);
  } else {
    overlayCtx.fillStyle = '#404040';
    overlayCtx.fillRect(dstX, barY, dstW, 32 * sy);
  }
  // 2) AMMO — right-aligned at x=44 (3-digit width).
  const ammoIdx = weaponAmmoIndex(p.readyweapon);
  if (ammoIdx >= 0) drawNumber(overlayCtx, p.ammo[ammoIdx], dstX + 44 * sx, barY + 3 * sy, sx, sy, 'STTNUM');
  // 3) HEALTH — right-aligned at x=90.
  drawNumber(overlayCtx, p.health, dstX + 90 * sx, barY + 3 * sy, sx, sy, 'STTNUM');
  // 4) STARMS widget — slots 2..7 = pistol..bfg.
  const starms = getPatch('STARMS');
  if (starms !== null) {
    overlayCtx.drawImage(starms.canvas, dstX + 104 * sx, barY, starms.w * sx, starms.h * sy);
  }
  // STYSNUM (yellow) if owned, STGNUM (gray) if not.
  for (const [px, py, weap] of ARMS_CELLS) {
    const owned = p.weaponowned[weap] === true || p.weaponowned[weap] === 1;
    const family = owned ? 'STYSNUM' : 'STGNUM';
    const digit = getPatch(`${family}${weap + 1}`);
    if (digit !== null) overlayCtx.drawImage(digit.canvas, dstX + px * sx, dstY + py * sy, digit.w * sx, digit.h * sy);
  }
  // 5) Face widget — animated. V_DrawPatch subtracts patch->leftoffset/topoffset.
  const face = getPatch(faceLumpName()) || getPatch('STFST00');
  if (face !== null) {
    const fx = dstX + (143 - face.leftoffset) * sx;
    const fy = dstY + (168 - face.topoffset)  * sy;
    overlayCtx.drawImage(face.canvas, fx, fy, face.w * sx, face.h * sy);
  }
  // 6) ARMOR — right-aligned at x=221.
  drawNumber(overlayCtx, p.armorpoints, dstX + 221 * sx, barY + 3 * sy, sx, sy, 'STTNUM');
  // 7) Keys — three slots stacked, with skull variants overriding keycards.
  for (let i = 0; i < 3; i++) {
    const hasKey  = p.cards && p.cards[i] === true;
    const hasSkul = p.cards && p.cards[i + 3] === true;
    let lump = null;
    if (hasSkul && hasKey) lump = `STKEYS${i + 6}`; // composite (Doom 2 only)
    else if (hasSkul)      lump = `STKEYS${i + 3}`;
    else if (hasKey)       lump = `STKEYS${i}`;
    if (lump !== null) {
      const k = getPatch(lump);
      if (k !== null) overlayCtx.drawImage(k.canvas, dstX + 239 * sx, dstY + (171 + i * 10) * sy, k.w * sx, k.h * sy);
    }
  }
  // 8) Small ammo readout (BULL/SHEL/RCKT/CELL labels live on STBAR itself;
  // we draw current/max in yellow STYSNUM digits, right-aligned).
  const ammoY = [173, 179, 185, 191];
  for (let i = 0; i < 4; i++) {
    drawNumber(overlayCtx, p.ammo[i],    dstX + 287 * sx, dstY + ammoY[i] * sy, sx, sy, 'STYSNUM');
    drawNumber(overlayCtx, p.maxammo[i], dstX + 314 * sx, dstY + ammoY[i] * sy, sx, sy, 'STYSNUM');
  }
}
