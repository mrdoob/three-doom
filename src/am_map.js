// Ported from: linuxdoom-1.10/am_map.c — automap (2D overhead line map).
// Full C is ~1500 lines (line colors based on sector/key/secret state, panning,
// zooming, marker placement, follow mode). This implementation draws all
// linedefs + the player triangle on the Canvas2D overlay, with pan/zoom via
// +/-, follow toggle via 'f', and Tab to open/close.

import { lines, numlines } from './p_setup.js';
import { players, consoleplayer } from './doomstat.js';
import { ML_TWOSIDED, ML_DONTDRAW, ML_SECRET, ML_MAPPED } from './doomdata.js';

export let automapactive = false;
export function set_automapactive(v) { automapactive = v; }

let _viewX = 0, _viewY = 0;
let _scale = 0.25;
let _followMode = true;

const COLOR_BACKGROUND = '#000000';
const COLOR_WALL       = '#a07050';
const COLOR_TWOSIDED   = '#605040';
const COLOR_SECRET     = '#604030';
const COLOR_PLAYER     = '#ffffff';
const COLOR_GRID       = '#202020';

export function AM_Start() {
  automapactive = true;
  const p = players[consoleplayer];
  if (p !== undefined && p !== null && p.mo !== null) {
    _viewX = p.mo.x / 65536;
    _viewY = p.mo.y / 65536;
  }
}

export function AM_Stop() { automapactive = false; }
export function AM_Toggle() { if (automapactive) AM_Stop(); else AM_Start(); }

export function AM_Ticker() {
  if (!automapactive) return;
  if (_followMode) {
    const p = players[consoleplayer];
    if (p !== undefined && p !== null && p.mo !== null) {
      _viewX = p.mo.x / 65536;
      _viewY = p.mo.y / 65536;
    }
  }
}

export function AM_Responder(ev) {
  if (ev === undefined || ev === null) return false;
  if (ev.type !== 0 /*ev_keydown*/) return false;
  switch (ev.data1) {
    case 9 /*KEY_TAB*/: AM_Toggle(); return true;
    case 0x2b /*'+'*/:  _scale *= 1.2; return true;
    case 0x2d /*'-'*/:  _scale /= 1.2; return true;
    case 0x66 /*'f'*/:  _followMode = !_followMode; return true;
  }
  return false;
}

export function AM_Drawer(overlayCtx, dstX, dstY, dstW, dstH) {
  if (!automapactive) return;
  overlayCtx.fillStyle = COLOR_BACKGROUND;
  overlayCtx.fillRect(dstX, dstY, dstW, dstH);

  const cx = dstX + dstW * 0.5;
  const cy = dstY + dstH * 0.5;
  const scale = _scale * (dstW / 320);

  function project(x, y) {
    return [cx + (x - _viewX) * scale, cy - (y - _viewY) * scale];
  }

  // Grid.
  overlayCtx.strokeStyle = COLOR_GRID;
  overlayCtx.lineWidth = 1;
  overlayCtx.beginPath();
  const grid = 128;
  const left   = _viewX - dstW / (2 * scale);
  const right  = _viewX + dstW / (2 * scale);
  const bottom = _viewY - dstH / (2 * scale);
  const top    = _viewY + dstH / (2 * scale);
  for (let gx = Math.ceil(left / grid) * grid; gx < right; gx += grid) {
    const [px] = project(gx, 0);
    overlayCtx.moveTo(px, dstY);
    overlayCtx.lineTo(px, dstY + dstH);
  }
  for (let gy = Math.ceil(bottom / grid) * grid; gy < top; gy += grid) {
    const [, py] = project(0, gy);
    overlayCtx.moveTo(dstX, py);
    overlayCtx.lineTo(dstX + dstW, py);
  }
  overlayCtx.stroke();

  // Lines, bucketed by color.
  overlayCtx.lineWidth = 1.5;
  const buckets = new Map();
  for (let i = 0; i < numlines; i++) {
    const li = lines[i];
    if ((li.flags & ML_DONTDRAW) !== 0) continue;
    // Fog of war: only show linedefs the player has been near (ML_MAPPED set
    // by r_main.R_SetupFrame for the player's current subsector).
    if ((li.flags & ML_MAPPED) === 0) continue;
    let color = COLOR_WALL;
    if ((li.flags & ML_SECRET) !== 0) color = COLOR_SECRET;
    else if ((li.flags & ML_TWOSIDED) !== 0) {
      if (li.frontsector !== null && li.backsector !== null) {
        if (li.frontsector.floorheight === li.backsector.floorheight &&
            li.frontsector.ceilingheight === li.backsector.ceilingheight) continue;
        color = COLOR_TWOSIDED;
      }
    }
    let b = buckets.get(color);
    if (b === undefined) { b = []; buckets.set(color, b); }
    b.push(li);
  }
  for (const [color, list] of buckets) {
    overlayCtx.strokeStyle = color;
    overlayCtx.beginPath();
    for (const li of list) {
      const [x1, y1] = project(li.v1.x / 65536, li.v1.y / 65536);
      const [x2, y2] = project(li.v2.x / 65536, li.v2.y / 65536);
      overlayCtx.moveTo(x1, y1);
      overlayCtx.lineTo(x2, y2);
    }
    overlayCtx.stroke();
  }

  // Player triangle.
  const p = players[consoleplayer];
  if (p !== undefined && p !== null && p.mo !== null) {
    const [px, py] = project(p.mo.x / 65536, p.mo.y / 65536);
    const angle = (p.mo.angle >>> 0) / 0x100000000 * Math.PI * 2;
    const r = 12;
    overlayCtx.strokeStyle = COLOR_PLAYER;
    overlayCtx.lineWidth = 2;
    overlayCtx.beginPath();
    overlayCtx.moveTo(px + Math.cos(angle) * r, py - Math.sin(angle) * r);
    overlayCtx.lineTo(px + Math.cos(angle + 2.5) * r * 0.7, py - Math.sin(angle + 2.5) * r * 0.7);
    overlayCtx.lineTo(px + Math.cos(angle - 2.5) * r * 0.7, py - Math.sin(angle - 2.5) * r * 0.7);
    overlayCtx.closePath();
    overlayCtx.stroke();
  }
}
