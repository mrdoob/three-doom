// Ported from: linuxdoom-1.10/hu_stuff.c — heads-up display.
// Pickup / item / secret messages, level title, and the STCFN font.

import { players, consoleplayer, gameepisode, gamemap, gamemode } from './doomstat.js';
import { GameMode_t } from './doomdef.js';
import { V_DecodePatchToCanvas } from './v_video.js';

export const HU_FONTSTART = '!'.charCodeAt(0);  // 33
export const HU_FONTEND   = '_'.charCodeAt(0);  // 95
export const HU_FONTSIZE  = HU_FONTEND - HU_FONTSTART + 1;
export const HU_MSGX      = 0;
export const HU_MSGY      = 0;
export const HU_TITLEX    = 0;
export const HU_TITLEY    = 167 - 12; // bottom of view, above STBAR
export const HU_MSGTIMEOUT = 4 * 35;

const hu_font = new Array(HU_FONTSIZE);
let _fontLoaded = false;
function ensureFont() {
  if (_fontLoaded) return;
  for (let i = 0; i < HU_FONTSIZE; i++) {
    const idx = HU_FONTSTART + i;
    hu_font[i] = V_DecodePatchToCanvas(`STCFN${String(idx).padStart(3, '0')}`);
  }
  _fontLoaded = true;
}

// Episode 1 level titles (shareware/registered). Doom 2 titles go in MAPNN slots.
const HU_TITLES_E1 = [
  '', // map 0 unused
  "E1M1: HANGAR",
  "E1M2: NUCLEAR PLANT",
  "E1M3: TOXIN REFINERY",
  "E1M4: COMMAND CONTROL",
  "E1M5: PHOBOS LAB",
  "E1M6: CENTRAL PROCESSING",
  "E1M7: COMPUTER STATION",
  "E1M8: PHOBOS ANOMALY",
  "E1M9: MILITARY BASE",
];
const HU_TITLES_E2 = [
  '',
  "E2M1: DEIMOS ANOMALY",
  "E2M2: CONTAINMENT AREA",
  "E2M3: REFINERY",
  "E2M4: DEIMOS LAB",
  "E2M5: COMMAND CENTER",
  "E2M6: HALLS OF THE DAMNED",
  "E2M7: SPAWNING VATS",
  "E2M8: TOWER OF BABEL",
  "E2M9: FORTRESS OF MYSTERY",
];
const HU_TITLES_E3 = [
  '',
  "E3M1: HELL KEEP",
  "E3M2: SLOUGH OF DESPAIR",
  "E3M3: PANDEMONIUM",
  "E3M4: HOUSE OF PAIN",
  "E3M5: UNHOLY CATHEDRAL",
  "E3M6: MT. EREBUS",
  "E3M7: LIMBO",
  "E3M8: DIS",
  "E3M9: WARRENS",
];

function levelTitle() {
  if (gamemode === GameMode_t.commercial) return `MAP${String(gamemap).padStart(2, '0')}`;
  const tables = [null, HU_TITLES_E1, HU_TITLES_E2, HU_TITLES_E3];
  const t = tables[gameepisode];
  if (t === undefined || t === null) return '';
  return t[gamemap] || '';
}

// State.
let _msgText      = '';
let _msgCounter   = 0;
let _titleCounter = 0;
let _lastMo       = null;

export function HU_Init() { /* fonts loaded lazily on first draw */ }

export function HU_Start() {
  _msgText = ''; _msgCounter = 0;
  _titleCounter = 5 * 35; // show title for 5 seconds
}

// Push a message into the HUD. Called by P_TouchSpecialThing via player.message.
export function HU_QueueMessage(text) {
  if (text === null || text === undefined || text === '') return;
  _msgText = String(text);
  _msgCounter = HU_MSGTIMEOUT;
}

export function HU_Ticker() {
  const p = players[consoleplayer];
  if (p === null || p === undefined) return;
  // Auto-detect new level (player mo changed).
  if (p.mo !== _lastMo) {
    _lastMo = p.mo;
    HU_Start();
  }
  // Drain player.message into the widget.
  if (p.message && p.message !== '') {
    HU_QueueMessage(p.message);
    p.message = '';
  }
  if (_msgCounter > 0)   _msgCounter--;
  if (_titleCounter > 0) _titleCounter--;
}

export function HU_Responder(_ev) { return false; }

// Render one string at virtual (vx, vy) using the loaded STCFN font.
function drawText(ctx, text, vx, vy, dstX, dstY, sx, sy) {
  if (text === '' || text === null) return;
  let cx = vx;
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code === 32) { cx += 4; continue; } // space
    if (code >= 97 && code <= 122) code -= 32; // uppercase
    const idx = code - HU_FONTSTART;
    if (idx < 0 || idx >= HU_FONTSIZE) { cx += 4; continue; }
    const g = hu_font[idx];
    if (g === null || g === undefined) { cx += 4; continue; }
    ctx.drawImage(
      g.canvas,
      dstX + (cx - g.leftoffset) * sx,
      dstY + (vy - g.topoffset)  * sy,
      g.w * sx,
      g.h * sy
    );
    cx += g.w;
  }
}

// HU_Drawer renders messages on top of the 3D view; the STBAR is drawn separately
// by st_stuff.js. dstX/dstY/dstW/dstH = full 320x200 virtual screen.
export function HU_Drawer(overlayCtx, dstX, dstY, dstW, dstH) {
  const p = players[consoleplayer];
  if (p === null || p === undefined || p.mo === null) return;
  ensureFont();
  const sx = dstW / 320;
  const sy = dstH / 200;
  // Pickup / item / secret message at top-left.
  if (_msgCounter > 0 && _msgText !== '') {
    drawText(overlayCtx, _msgText, HU_MSGX, HU_MSGY, dstX, dstY, sx, sy);
  }
  // Level title fades in for 5 seconds after level start.
  if (_titleCounter > 0) {
    const title = levelTitle();
    if (title !== '') drawText(overlayCtx, title, HU_TITLEX, HU_TITLEY, dstX, dstY, sx, sy);
  }
}
