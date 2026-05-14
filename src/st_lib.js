// Ported from: linuxdoom-1.10/st_lib.c
// Status bar widget primitives. In linuxdoom these draw via V_DrawPatch into
// the paletted screen buffer; in the 3D port we render via Canvas2D directly
// (driven from st_stuff.js), so these classes are mostly bookkeeping objects
// kept for API parity with the C source.

export class st_number_t {
  constructor() {
    this.x = 0; this.y = 0; this.width = 0;
    this.num = 0;
    this.on = null;       // pointer to a boolean (display flag)
    this.p = null;        // patch array for the digit font
    this.data = 0;
    this.oldnum = 0;
  }
}

export class st_percent_t {
  constructor() {
    this.n = new st_number_t();
    this.p = null;        // percent-sign patch
  }
}

export class st_multicon_t {
  constructor() {
    this.x = 0; this.y = 0;
    this.oldinum = -1;
    this.inum = 0;        // pointer to current icon index
    this.on = null;
    this.p = null;        // patch array
  }
}

export class st_binicon_t {
  constructor() {
    this.x = 0; this.y = 0;
    this.oldval = 0;
    this.val = 0;         // pointer to current bool state
    this.on = null;
    this.p = null;        // patch
  }
}

export function STlib_init() { /* paletted screen — not used in 3D port */ }
export function STlib_initNum(n, x, y, pl, num, on, width) {
  n.x = x; n.y = y; n.oldnum = 0;
  n.width = width; n.num = num; n.on = on; n.p = pl;
}
export function STlib_updateNum(_n, _refresh) { /* st_stuff renders directly */ }
export function STlib_initPercent(p, x, y, pl, num, on, percent) {
  STlib_initNum(p.n, x, y, pl, num, on, 3);
  p.p = percent;
}
export function STlib_updatePercent(_p, _refresh) { /* st_stuff renders directly */ }
export function STlib_initMultIcon(i, x, y, il, inum, on) {
  i.x = x; i.y = y; i.oldinum = -1; i.inum = inum; i.on = on; i.p = il;
}
export function STlib_updateMultIcon(_i, _refresh) { /* st_stuff renders directly */ }
export function STlib_initBinIcon(b, x, y, il, val, on) {
  b.x = x; b.y = y; b.oldval = 0; b.val = val; b.on = on; b.p = il;
}
export function STlib_updateBinIcon(_b, _refresh) { /* st_stuff renders directly */ }
