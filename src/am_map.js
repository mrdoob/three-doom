// Ported from: linuxdoom-1.10/am_map.c — automap (2D overhead line map).
// Draws all linedefs + the player triangle on the Canvas2D overlay, with
// per-linedef colors (am_map.c:AM_drawWalls), pan/zoom via +/-, follow toggle
// via 'f', Tab to open/close, mark placement via 'm', and mark clear via 'c'.

import {
  bmaporgx, bmaporgy, lines, numlines, vertexes, sectors, numsectors,
} from './p_setup.js';
import {
  players, playeringame, consoleplayer, automapactive, set_automapactive,
  gameepisode, gamemap, deathmatch, netgame, singledemo,
} from './doomstat.js';
import { ML_DONTDRAW, ML_SECRET, ML_MAPPED } from './doomdata.js';
import { KEY_TAB, MAXPLAYERS, powertype_t } from './doomdef.js';
import { evtype_t } from './d_event.js';
import { FixedMul, FRACUNIT } from './m_fixed.js';
import { finecosine, finesine } from './tables.js';
import { V_PaletteCSS } from './v_palette.js';
import { V_DecodePatchToCanvas, V_DrawPatchAtCanvas } from './v_video.js';
import {
  AMSTR_FOLLOWON, AMSTR_FOLLOWOFF, AMSTR_GRIDON, AMSTR_GRIDOFF,
  AMSTR_MARKEDSPOT, AMSTR_MARKSCLEARED,
} from './d_englsh.js';
import {
  AM_ApplyControlEvent, AM_CreateViewState, AM_FRAME_HEIGHT, AM_FRAME_WIDTH,
  AM_OpenView, AM_ProjectFixedPoint, AM_ResetHeldControls, AM_TickViewState,
} from './am_map_logic.js';

// automapactive is a single engine-wide global in vanilla. Re-export the
// doomstat live binding so finale/level transitions and AM_* always mutate
// and observe the same state.
export { automapactive, set_automapactive } from './doomstat.js';

let _viewState = AM_CreateViewState(null, null);
let _lastLevel = -1;
let _lastEpisode = -1;
let _stopped = true;

// am_map.c:216,701-705 — IDDT is deliberately an automap-local cheat rather
// than one of ST_Responder's gameplay cheats. It is available in single-player
// and cooperative netgames, but not deathmatch, and persists across map opens.
const _cheatAmap = 'iddt';
let _cheatAmapPos = 0;
let _cheating = 0;

export function AM_GetCheatLevel() { return _cheating; }

// m_cheat.c:cht_CheckCheat without parameter slots. The real table scrambles
// stored bytes, but equality and mismatch/reset behavior reduce to this for a
// fixed ASCII sequence such as IDDT.
function checkAutomapCheat(key) {
  if ((key & 0xff) === _cheatAmap.charCodeAt(_cheatAmapPos)) _cheatAmapPos++;
  else _cheatAmapPos = 0;
  if (_cheatAmapPos !== _cheatAmap.length) return false;
  _cheatAmapPos = 0;
  return true;
}

// am_map.c color classes (AM_drawWalls): one-sided walls are red, teleporter
// lines mid-red, floor-height changes brown, ceiling-height changes yellow.
const COLOR_BACKGROUND = 0;              // BLACK
const COLOR_WALL       = 256 - 5 * 16;   // WALLCOLORS (REDS)
const COLOR_TELEPORT   = COLOR_WALL + 8; // WALLCOLORS + WALLRANGE/2
const COLOR_FLOORDIFF  = 4 * 16;         // FDWALLCOLORS (BROWNS)
const COLOR_CEILDIFF   = 256 - 32 + 7;   // CDWALLCOLORS (YELLOWS)
const COLOR_TWOSIDED   = 6 * 16;         // TSWALLCOLORS (GRAYS)
const COLOR_ALLMAP     = 6 * 16 + 3;     // GRAYS + 3
export const AM_THING_COLOR = 7 * 16;    // THINGCOLORS (GREENS)
const COLOR_PLAYER     = 256 - 47;        // YOURCOLORS (WHITE)
const COLOR_GRID       = 6 * 16 + 8;     // GRIDCOLORS (GRAYS + 8)
export const AM_CROSSHAIR_COLOR = 6 * 16; // XHAIRCOLORS (GRAYS)
const PLAYER_COLORS    = [7 * 16, 6 * 16, 4 * 16, 256 - 5 * 16];
const COLOR_INVISIBLE_PLAYER = 246;

function mapLine(ax, ay, bx, by) {
  return { a: { x: ax, y: ay }, b: { x: bx, y: by } };
}

// am_map.c's initializers are converted to signed 16.16 fixed_t values before
// AM_drawLineCharacter applies its optional scale and BAM-angle rotation.
const THIN_TRIANGLE = [
  mapLine(-32768, -45875, 65536, 0),
  mapLine(65536, 0, -32768, 45875),
  mapLine(-32768, 45875, -32768, -45875),
];

const PLAYER_RADIUS = 16 * FRACUNIT;
const ARROW_R = Math.trunc((8 * PLAYER_RADIUS) / 7);
const div = (value, divisor) => Math.trunc(value / divisor);

// am_map.c:155-171 — the normal seven-stroke player arrow. Its dimensions are
// map units, not a fixed number of Canvas pixels, so it zooms with the map.
const PLAYER_ARROW = [
  mapLine(-ARROW_R + div(ARROW_R, 8), 0, ARROW_R, 0),
  mapLine(ARROW_R, 0, ARROW_R - div(ARROW_R, 2), div(ARROW_R, 4)),
  mapLine(ARROW_R, 0, ARROW_R - div(ARROW_R, 2), -div(ARROW_R, 4)),
  mapLine(-ARROW_R + div(ARROW_R, 8), 0, -ARROW_R - div(ARROW_R, 8), div(ARROW_R, 4)),
  mapLine(-ARROW_R + div(ARROW_R, 8), 0, -ARROW_R - div(ARROW_R, 8), -div(ARROW_R, 4)),
  mapLine(-ARROW_R + div(3 * ARROW_R, 8), 0, -ARROW_R + div(ARROW_R, 8), div(ARROW_R, 4)),
  mapLine(-ARROW_R + div(3 * ARROW_R, 8), 0, -ARROW_R + div(ARROW_R, 8), -div(ARROW_R, 4)),
];

// am_map.c:157-195 — the 16 strokes spell "ddt" inside the longer player
// arrow whenever the single-player automap cheat is active.
const CHEAT_PLAYER_ARROW = [
  mapLine(-ARROW_R + div(ARROW_R, 8), 0, ARROW_R, 0),
  mapLine(ARROW_R, 0, ARROW_R - div(ARROW_R, 2), div(ARROW_R, 6)),
  mapLine(ARROW_R, 0, ARROW_R - div(ARROW_R, 2), -div(ARROW_R, 6)),
  mapLine(-ARROW_R + div(ARROW_R, 8), 0, -ARROW_R - div(ARROW_R, 8), div(ARROW_R, 6)),
  mapLine(-ARROW_R + div(ARROW_R, 8), 0, -ARROW_R - div(ARROW_R, 8), -div(ARROW_R, 6)),
  mapLine(-ARROW_R + div(3 * ARROW_R, 8), 0, -ARROW_R + div(ARROW_R, 8), div(ARROW_R, 6)),
  mapLine(-ARROW_R + div(3 * ARROW_R, 8), 0, -ARROW_R + div(ARROW_R, 8), -div(ARROW_R, 6)),
  mapLine(-div(ARROW_R, 2), 0, -div(ARROW_R, 2), -div(ARROW_R, 6)),
  mapLine(-div(ARROW_R, 2), -div(ARROW_R, 6), -div(ARROW_R, 2) + div(ARROW_R, 6), -div(ARROW_R, 6)),
  mapLine(-div(ARROW_R, 2) + div(ARROW_R, 6), -div(ARROW_R, 6), -div(ARROW_R, 2) + div(ARROW_R, 6), div(ARROW_R, 4)),
  mapLine(-div(ARROW_R, 6), 0, -div(ARROW_R, 6), -div(ARROW_R, 6)),
  mapLine(-div(ARROW_R, 6), -div(ARROW_R, 6), 0, -div(ARROW_R, 6)),
  mapLine(0, -div(ARROW_R, 6), 0, div(ARROW_R, 4)),
  mapLine(div(ARROW_R, 6), div(ARROW_R, 4), div(ARROW_R, 6), -div(ARROW_R, 7)),
  mapLine(div(ARROW_R, 6), -div(ARROW_R, 7), div(ARROW_R, 6) + div(ARROW_R, 32), -div(ARROW_R, 7) - div(ARROW_R, 32)),
  mapLine(div(ARROW_R, 6) + div(ARROW_R, 32), -div(ARROW_R, 7) - div(ARROW_R, 32), div(ARROW_R, 6) + div(ARROW_R, 10), -div(ARROW_R, 7)),
];

function transformPoint(point, scale, angle, originX, originY) {
  let x = point.x | 0;
  let y = point.y | 0;
  if (scale !== 0) {
    x = FixedMul(scale, x);
    y = FixedMul(scale, y);
  }
  if ((angle >>> 0) !== 0) {
    const fineangle = angle >>> 19;
    const oldX = x;
    x = (FixedMul(x, finecosine[fineangle]) -
      FixedMul(y, finesine[fineangle])) | 0;
    y = (FixedMul(oldX, finesine[fineangle]) +
      FixedMul(y, finecosine[fineangle])) | 0;
  }
  return { x: (x + originX) | 0, y: (y + originY) | 0 };
}

function lineCharacterSegments(character, scale, angle, originX, originY) {
  return character.map((line) => ({
    a: transformPoint(line.a, scale, angle, originX, originY),
    b: transformPoint(line.b, scale, angle, originX, originY),
  }));
}

export function AM_ThingSegments(thing) {
  return lineCharacterSegments(
    THIN_TRIANGLE,
    16 * FRACUNIT,
    thing.angle,
    thing.x,
    thing.y,
  );
}

export function AM_CheatPlayerSegments(mo) {
  return lineCharacterSegments(CHEAT_PLAYER_ARROW, 0, mo.angle, mo.x, mo.y);
}

export function AM_PlayerSegments(mo) {
  return lineCharacterSegments(PLAYER_ARROW, 0, mo.angle, mo.x, mo.y);
}

// am_map.c:AM_drawPlayers, kept pure enough for multiplayer/demo matrices.
// Slot colors advance even across inactive players, hence the direct index.
export function AM_PlayerDrawPlan({
  roster = players,
  active = playeringame,
  localIndex = consoleplayer,
  isNetgame = netgame,
  deathmatchMode = deathmatch,
  isSingleDemo = singledemo,
  cheatLevel = _cheating,
} = {}) {
  let resolvedLocal = localIndex | 0;
  if (active[resolvedLocal] !== true) {
    resolvedLocal = active.findIndex((value) => value === true);
  }
  const localPlayer = resolvedLocal >= 0 ? roster[resolvedLocal] : null;

  if (isNetgame !== true) {
    if (localPlayer?.mo == null) return [];
    return [{
      playerIndex: resolvedLocal,
      mo: localPlayer.mo,
      color: COLOR_PLAYER,
      cheat: (cheatLevel | 0) !== 0,
    }];
  }

  const result = [];
  for (let i = 0; i < MAXPLAYERS; i++) {
    const player = roster[i];
    if (deathmatchMode !== 0 && isSingleDemo !== true && player !== localPlayer) continue;
    if (active[i] !== true || player?.mo == null) continue;
    const invisible = (player.powers?.[powertype_t.pw_invisibility] ?? 0) !== 0;
    result.push({
      playerIndex: i,
      mo: player.mo,
      color: invisible ? COLOR_INVISIBLE_PLAYER : PLAYER_COLORS[i],
      cheat: false,
    });
  }
  return result;
}

// am_map.c:AM_NUMMARKPOINTS — player-placed map markers. x === -1 means empty.
const AM_NUMMARKPOINTS = 10;
const _markpoints = [];
for (let i = 0; i < AM_NUMMARKPOINTS; i++) _markpoints.push({ x: -1, y: -1 });
const _marknums = new Array(AM_NUMMARKPOINTS).fill(null);
let _markpointnum = 0;

// am_map.c:524 — AM_clearMarks.
export function AM_clearMarks() {
  for (let i = 0; i < AM_NUMMARKPOINTS; i++) _markpoints[i].x = -1;
  _markpointnum = 0;
}

// am_map.c:377 — AM_addMark drops a marker at the automap view center.
export function AM_addMark() {
  _markpoints[_markpointnum].x = _viewState.mX + Math.trunc(_viewState.mW / 2);
  _markpoints[_markpointnum].y = _viewState.mY + Math.trunc(_viewState.mH / 2);
  _markpointnum = (_markpointnum + 1) % AM_NUMMARKPOINTS;
}

function mapPlayer() {
  let pnum = consoleplayer;
  if (playeringame[pnum] !== true) {
    pnum = playeringame.findIndex((active) => active === true);
  }
  return pnum >= 0 ? players[pnum] : null;
}

export function AM_Start() {
  if (_stopped !== true) AM_Stop();
  _stopped = false;
  const player = mapPlayer();
  const mo = player?.mo ?? null;
  if (_lastLevel !== gamemap || _lastEpisode !== gameepisode ||
      (_viewState.hasBounds !== true && Array.isArray(vertexes))) {
    _viewState = AM_CreateViewState(vertexes, mo, _viewState);
    AM_clearMarks();
    _lastLevel = gamemap;
    _lastEpisode = gameepisode;
  } else {
    _viewState = AM_OpenView(_viewState, mo);
  }
  // am_map.c:AM_loadPics — marker digits are real WAD patches, not browser
  // text. V_DecodePatchToCanvas retains the cache-equivalent backing data.
  for (let i = 0; i < AM_NUMMARKPOINTS; i++) {
    _marknums[i] = V_DecodePatchToCanvas(`AMMNUM${i}`);
  }
  set_automapactive(true);
}

export function AM_Stop() {
  set_automapactive(false);
  _stopped = true;
}
export function AM_Toggle() { if (automapactive) AM_Stop(); else AM_Start(); }

export function AM_Ticker() {
  if (!automapactive) return;
  _viewState = AM_TickViewState(_viewState, mapPlayer()?.mo ?? null);
}

// Release browser-owned held controls without closing or repositioning the
// automap. Used when focus/visibility changes can swallow DOM keyup events.
export function AM_ResetControls() {
  _viewState = AM_ResetHeldControls(_viewState);
}

export function AM_Responder(ev) {
  if (ev === undefined || ev === null) return false;
  if (!automapactive) {
    if (ev.type === evtype_t.ev_keydown && ev.data1 === KEY_TAB) {
      AM_Start();
      return true;
    }
    return false;
  }
  const player = mapPlayer();
  const result = AM_ApplyControlEvent(_viewState, ev, player?.mo ?? null);
  _viewState = result.state;
  if (result.action === 'stop') AM_Stop();
  else if (result.action === 'mark') {
    if (player !== null) player.message = `${AMSTR_MARKEDSPOT} ${_markpointnum}`;
    AM_addMark();
  } else if (result.action === 'clear') {
    AM_clearMarks();
  }
  if (player !== null && result.message !== null) {
    const messages = {
      followOn: AMSTR_FOLLOWON,
      followOff: AMSTR_FOLLOWOFF,
      gridOn: AMSTR_GRIDON,
      gridOff: AMSTR_GRIDOFF,
      marksCleared: AMSTR_MARKSCLEARED,
    };
    player.message = messages[result.message];
  }

  // The reference checks this after its control-key switch. A completed IDDT
  // is intentionally returned as unhandled so the final 't' can continue
  // through the responder chain just like every other cheat character.
  if (ev.type === evtype_t.ev_keydown && deathmatch === 0 && checkAutomapCheat(ev.data1)) {
    _cheating = (_cheating + 1) % 3;
    return false;
  }
  return result.handled;
}

// am_map.c:AM_drawWalls. Kept pure so fog-of-war and IDDT visibility cases can
// be checked independently of Canvas2D rendering.
export function AM_LineColorForMode(li, cheatLevel, hasAllMap = false) {
  const cheating = (cheatLevel | 0) !== 0;
  if (cheating || (li.flags & ML_MAPPED) !== 0) {
    if ((li.flags & ML_DONTDRAW) !== 0 && !cheating) return null;
    if (li.backsector === null) return COLOR_WALL;
    if (li.special === 39) return COLOR_TELEPORT;
    if ((li.flags & ML_SECRET) !== 0) return COLOR_WALL;
    if (li.backsector.floorheight !== li.frontsector.floorheight) return COLOR_FLOORDIFF;
    if (li.backsector.ceilingheight !== li.frontsector.ceilingheight) return COLOR_CEILDIFF;
    if (cheating) return COLOR_TWOSIDED;
    return null;
  }
  if (hasAllMap && (li.flags & ML_DONTDRAW) === 0) return COLOR_ALLMAP;
  return null;
}

export function AM_Drawer(overlayCtx, dstX, dstY, dstW, dstH) {
  if (!automapactive) return;
  // AM_clipMline constrains every framebuffer write to f_w/f_h. Canvas paths
  // need the equivalent explicit clip or off-window strokes can cover the
  // status-bar/lower letterbox region.
  overlayCtx.save();
  overlayCtx.beginPath();
  overlayCtx.rect(dstX, dstY, dstW, dstH);
  overlayCtx.clip();
  overlayCtx.fillStyle = V_PaletteCSS(COLOR_BACKGROUND);
  overlayCtx.fillRect(dstX, dstY, dstW, dstH);

  const sx = dstW / AM_FRAME_WIDTH;
  const sy = dstH / AM_FRAME_HEIGHT;

  function project(x, y) {
    const p = AM_ProjectFixedPoint(_viewState, x, y);
    return [dstX + p.x * sx, dstY + p.y * sy];
  }

  // am_map.c:AM_drawGrid — disabled by default and aligned to the BLOCKMAP
  // origin, not world coordinate zero.
  if (_viewState.grid === true) {
    overlayCtx.strokeStyle = V_PaletteCSS(COLOR_GRID);
    overlayCtx.lineWidth = 1;
    overlayCtx.beginPath();
    const step = 128 * FRACUNIT; // MAPBLOCKUNITS
    let start = _viewState.mX;
    let remainder = (start - bmaporgx) % step;
    if (remainder !== 0) start += step - remainder;
    const endX = _viewState.mX + _viewState.mW;
    for (let gx = start; gx < endX; gx += step) {
      const [px] = project(gx, 0);
      overlayCtx.moveTo(px, dstY);
      overlayCtx.lineTo(px, dstY + dstH);
    }
    start = _viewState.mY;
    remainder = (start - bmaporgy) % step;
    if (remainder !== 0) start += step - remainder;
    const endY = _viewState.mY + _viewState.mH;
    for (let gy = start; gy < endY; gy += step) {
      const [, py] = project(0, gy);
      overlayCtx.moveTo(dstX, py);
      overlayCtx.lineTo(dstX + dstW, py);
    }
    overlayCtx.stroke();
  }

  // Lines, bucketed by color (am_map.c:AM_drawWalls).
  overlayCtx.lineWidth = 1.5;
  const buckets = new Map();
  const p = mapPlayer();
  const hasAllMap = (p?.powers?.[4] ?? 0) !== 0;
  for (let i = 0; i < numlines; i++) {
    const li = lines[i];
    const color = AM_LineColorForMode(li, _cheating, hasAllMap);
    if (color === null) continue;
    let b = buckets.get(color);
    if (b === undefined) { b = []; buckets.set(color, b); }
    b.push(li);
  }
  for (const [color, list] of buckets) {
    overlayCtx.strokeStyle = V_PaletteCSS(color);
    overlayCtx.beginPath();
    for (const li of list) {
      const [x1, y1] = project(li.v1.x, li.v1.y);
      const [x2, y2] = project(li.v2.x, li.v2.y);
      overlayCtx.moveTo(x1, y1);
      overlayCtx.lineTo(x2, y2);
    }
    overlayCtx.stroke();
  }

  // am_map.c:AM_drawPlayers — exact fixed-point arrow geometry, plus every
  // active network player with the reference slot/invisibility colors.
  overlayCtx.lineWidth = 1;
  for (const entry of AM_PlayerDrawPlan()) {
    overlayCtx.strokeStyle = V_PaletteCSS(entry.color);
    overlayCtx.beginPath();
    const segments = entry.cheat
      ? AM_CheatPlayerSegments(entry.mo)
      : AM_PlayerSegments(entry.mo);
    for (const segment of segments) {
      const [x1, y1] = project(segment.a.x, segment.a.y);
      const [x2, y2] = project(segment.b.x, segment.b.y);
      overlayCtx.moveTo(x1, y1);
      overlayCtx.lineTo(x2, y2);
    }
    overlayCtx.stroke();
  }

  // am_map.c:1285-1302,1341-1342 — the second IDDT mode draws every mobj as
  // the original 16-map-unit thin triangle, walking each sector's thing list.
  if (_cheating === 2 && sectors !== null) {
    overlayCtx.strokeStyle = V_PaletteCSS(AM_THING_COLOR);
    overlayCtx.lineWidth = 1;
    overlayCtx.beginPath();
    for (let i = 0; i < numsectors; i++) {
      for (let thing = sectors[i].thinglist; thing !== null; thing = thing.snext) {
        for (const segment of AM_ThingSegments(thing)) {
          const [x1, y1] = project(segment.a.x, segment.a.y);
          const [x2, y2] = project(segment.b.x, segment.b.y);
          overlayCtx.moveTo(x1, y1);
          overlayCtx.lineTo(x2, y2);
        }
      }
    }
    overlayCtx.stroke();
  }

  // am_map.c:AM_drawCrosshair writes the single center framebuffer pixel
  // after walls/players/things and before player-placed marks.
  overlayCtx.fillStyle = V_PaletteCSS(AM_CROSSHAIR_COLOR);
  overlayCtx.fillRect(
    dstX + Math.trunc(AM_FRAME_WIDTH / 2) * sx,
    dstY + Math.trunc(AM_FRAME_HEIGHT / 2) * sy,
    sx,
    sy,
  );

  // am_map.c:AM_drawMarks — WAD digits are anchored at the projected point;
  // the source deliberately uses literal 5x6 visibility bounds.
  for (let i = 0; i < AM_NUMMARKPOINTS; i++) {
    const m = _markpoints[i];
    if (m.x === -1) continue;
    const point = AM_ProjectFixedPoint(_viewState, m.x, m.y);
    if (point.x < 0 || point.x > AM_FRAME_WIDTH - 5 ||
        point.y < 0 || point.y > AM_FRAME_HEIGHT - 6) continue;
    V_DrawPatchAtCanvas(
      overlayCtx,
      _marknums[i],
      dstX + point.x * sx,
      dstY + point.y * sy,
      sx,
      sy,
    );
  }
  overlayCtx.restore();
}
