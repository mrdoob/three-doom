// Ported from: linuxdoom-1.10/hu_lib.c
// Heads-up text widget primitives. In linuxdoom these draw via V_DrawPatch
// using the loaded hu_font[] patch glyphs. In the 3D port hu_stuff.js draws
// via Canvas2D, so these are bookkeeping objects kept for API parity.

const HU_MAXLINES   = 4;
const HU_MAXLINELEN = 80;

export class hu_textline_t {
  constructor() {
    this.x = 0; this.y = 0;
    this.f = null; this.sc = 0;
    this.l = ''; this.len = 0; this.needsupdate = 0;
  }
}

export class hu_stext_t {
  constructor() {
    this.l = [];
    this.h = HU_MAXLINES;
    this.cl = 0;
    this.on = null;
    this.laston = true;
  }
}

export class hu_itext_t {
  constructor() {
    this.l = new hu_textline_t();
    this.lm = 0;
    this.on = null;
    this.laston = true;
  }
}

export function HUlib_init() {}
export function HUlib_initTextLine(t, x, y, f, sc) {
  t.x = x; t.y = y; t.f = f; t.sc = sc; t.l = ''; t.needsupdate = 1;
}
export function HUlib_addCharToTextLine(t, ch) {
  if (t.l.length < HU_MAXLINELEN) { t.l += ch; t.needsupdate++; return true; }
  return false;
}
export function HUlib_delCharFromTextLine(t) {
  if (t.l.length === 0) return false;
  t.l = t.l.slice(0, -1); t.needsupdate++; return true;
}
export function HUlib_clearTextLine(t) { t.l = ''; t.needsupdate = 1; }
export function HUlib_eraseTextLine(_t) {}
export function HUlib_drawTextLine(_t, _drawCursor) {}

export function HUlib_initSText(s, x, y, h, font, startchar, on) {
  s.h = h; s.on = on; s.laston = true; s.cl = 0;
  s.l = new Array(h);
  for (let i = 0; i < h; i++) {
    s.l[i] = new hu_textline_t();
    HUlib_initTextLine(s.l[i], x, y - (h - 1 - i) * 10, font, startchar);
  }
}
export function HUlib_addLineToSText(s) {
  s.cl = (s.cl + 1) % s.h;
  HUlib_clearTextLine(s.l[s.cl]);
  for (let i = 0; i < s.h; i++) s.l[i].needsupdate = 4;
}
export function HUlib_addMessageToSText(s, _prefix, msg) {
  HUlib_addLineToSText(s);
  for (const ch of msg) HUlib_addCharToTextLine(s.l[s.cl], ch);
}
export function HUlib_drawSText(_s) {}
export function HUlib_eraseSText(_s) {}
