// Ported from: linuxdoom-1.10/f_finale.c — end-of-episode finale text +
// bunny scroller. Episodes 1, 2, 3 each have a unique flow:
//   E1 → text (E1TEXT) → CREDIT/HELP2 still
//   E2 → text (E2TEXT) → VICTORY2 still
//   E3 → text (E3TEXT) → bunny scroller (PFUB1 + PFUB2) → END0..END6 punchline

import { gameepisode } from './doomstat.js';
import { V_DecodePatchToCanvas } from './v_video.js';

// Episode-end text (vanilla d_englsh.h).
const TEXTS = {
  1:
    "Once you beat the big badasses and\nclean out the moon base you're supposed\n" +
    "to win, aren't you? Aren't you? Where's\nyour fat reward and ticket home? What\n" +
    "the hell is this? It's not supposed to\nend this way!\n\n" +
    "It stinks like rotten meat, but looks\nlike the lost Deimos base.  Looks like\n" +
    "you're stuck on The Shores of Hell.\nThe only way out is through.\n\n" +
    "To continue the DOOM experience, play\nThe Shores of Hell and its amazing\n" +
    "sequel, Inferno!",
  2:
    "You've done it! The hideous cyber-\ndemon lord that ruled the lost Deimos\n" +
    "moon base has been slain and you\nare triumphant! But ... where are\n" +
    "you? You clamber to the edge of the\nmoon and look down to see the awful\n" +
    "truth.\n\n" +
    "Deimos floats above Hell itself!\nYou've never heard of anyone escaping\n" +
    "from Hell, but you'll make the bastards\nsorry they ever heard of you! Quickly,\n" +
    "you rappel down to  the surface of\nHell.\n\n" +
    "Now, it's on to the final chapter of\nDOOM! -- Inferno.",
  3:
    "The loathsome spiderdemon that\nmasterminded the invasion of the moon\n" +
    "bases and caused so much death has had\nits ass kicked for all time.\n\n" +
    "A hidden doorway opens and you enter.\nYou've proven too tough for Hell to\n" +
    "contain, and now Hell at last plays\nfair -- for you emerge from the door\n" +
    "to see the green fields of Earth!\nHome at last.\n\n" +
    "You wonder what's been happening on\nEarth while you were battling evil\nunleashed. " +
    "It's good that no Hell-spawn\ncould have come through that door\nwith you ...",
  4:
    "the spider mastermind must have sent forth\nits legions of hellspawn before your\n" +
    "final confrontation with that terrible\nbeast from hell.  but you stepped forward\n" +
    "and brought them down ...\n\n" +
    "Game over, man!  No more chances!",
};

// State machine: 0 = typing text, 1 = post-text still / bunny scroll.
let _stage = 0;
let _finalecount = 0;
let _active = false;
let _done   = null;
const getPatch = V_DecodePatchToCanvas;
const F_TEXTWAIT = 250;
// f_finale.c:TEXTSPEED — one character per 3 tics (≈12 chars/s at 35Hz). The
// previous port used 2/0.5 timing which produced a faster reveal than vanilla.
const F_TEXTSPEED = 3;
const F_TEXTSTART = 10; // tics before the first character appears

export function F_StartFinale(onDone) {
  _active = true;
  _done = onDone || (() => {});
  _finalecount = 0;
  _stage = 0;
}

export function F_Responder(ev) {
  if (!_active) return false;
  if (ev && ev.type === 0) {
    // For episodes 1/2/4 the still picture closes immediately. For E3 the
    // bunny ending plays through to its END6 punchline, then closes.
    if (_stage === 1 && (_finalecount < 2000 || gameepisode !== 3)) {
      _active = false;
      _done();
    }
    return true;
  }
  return false;
}

export function F_Ticker() {
  if (_active === false) return;
  _finalecount++;
  const text = TEXTS[gameepisode] || TEXTS[1];
  if (_stage === 0 && _finalecount > F_TEXTWAIT + text.length * F_TEXTSPEED) {
    _stage = 1;
    _finalecount = 0;
  }
}

function F_TextWrite(ctx, dx, dy, dw, dh) {
  const text = TEXTS[gameepisode] || TEXTS[1];
  ctx.fillStyle = '#000';
  ctx.fillRect(dx, dy, dw, dh);
  const lineH = Math.round(dh * 0.04);
  ctx.font = `bold ${lineH}px monospace`;
  ctx.fillStyle = '#ffcf00';
  ctx.textAlign = 'left';
  // f_finale.c:F_TextWrite — `count = (finalecount - 10) / TEXTSPEED`
  // characters revealed so far. Clamped to text length.
  const maxChars = Math.min(text.length,
    Math.max(0, ((_finalecount - F_TEXTSTART) / F_TEXTSPEED) | 0));
  const visible = text.slice(0, maxChars);
  const lines = visible.split('\n');
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], dx + dw * 0.08, dy + dh * 0.15 + i * lineH * 1.4);
  }
}

// F_BunnyScroll — E3 ending. Two 320-wide images (PFUB1 + PFUB2) scroll
// horizontally over ~3 seconds, then DOOM-style "THE END" END0..END6 patches
// pop in stage-by-stage with a pistol shot per frame.
function F_BunnyScroll(ctx, dx, dy, dw, dh) {
  const sx = dw / 320, sy = dh / 200;
  const p1 = getPatch('PFUB2'); // left image (drawn first)
  const p2 = getPatch('PFUB1'); // right image
  let scrolled = 320 - ((_finalecount - 230) / 2) | 0;
  if (scrolled > 320) scrolled = 320;
  if (scrolled < 0)   scrolled = 0;
  // Composite: 320-pixel-wide viewport sourced from p1 (cols 0..320-scrolled-1)
  // followed by p2 (cols 0..scrolled-1). Pillarbox black if absent.
  ctx.fillStyle = '#000';
  ctx.fillRect(dx, dy, dw, dh);
  if (p1 !== null) {
    const visW = 320 - scrolled;
    if (visW > 0) ctx.drawImage(p1.canvas, scrolled, 0, visW, p1.h, dx, dy, visW * sx, dh);
  }
  if (p2 !== null && scrolled > 0) {
    ctx.drawImage(p2.canvas, 0, 0, scrolled, p2.h, dx + (320 - scrolled) * sx, dy, scrolled * sx, dh);
  }
  if (_finalecount < 1130) return;
  let stage;
  if (_finalecount < 1180) stage = 0;
  else {
    stage = ((_finalecount - 1180) / 5) | 0;
    if (stage > 6) stage = 6;
  }
  const end = getPatch(`END${stage}`);
  if (end !== null) {
    const ex = dx + ((320 - end.w) / 2) * sx;
    const ey = dy + ((200 - end.h) / 2) * sy;
    ctx.drawImage(end.canvas, ex, ey, end.w * sx, end.h * sy);
  }
}

export function F_Drawer(ctx, dx, dy, dw, dh) {
  if (!_active) return;
  if (_stage === 0) { F_TextWrite(ctx, dx, dy, dw, dh); return; }
  // Stage 1: still picture (or bunny scroll for E3).
  if (gameepisode === 3) { F_BunnyScroll(ctx, dx, dy, dw, dh); return; }
  const sx = dw / 320, sy = dh / 200;
  ctx.fillStyle = '#000';
  ctx.fillRect(dx, dy, dw, dh);
  let pic = null;
  if (gameepisode === 1) pic = getPatch('HELP2') || getPatch('CREDIT');
  else if (gameepisode === 2) pic = getPatch('VICTORY2');
  else if (gameepisode === 4) pic = getPatch('ENDPIC');
  if (pic !== null) ctx.drawImage(pic.canvas, dx, dy, pic.w * sx, pic.h * sy);
}

export function F_isActive() { return _active; }

// ---------- F_CastDrawer / F_Cast* (Doom 2 cast call) ----------
// The cast call is a roster of every Doom monster, one at a time, looped
// through their attack animation. Shareware doom1.wad has no MAP30 to trigger
// it, but the functions are here for source-map parity with f_finale.c.

// f_finale.c:118 — castorder[]. HERO is the FINAL entry (the loop runs
// monsters first, hero last). The previous port had HERO at index 0 which
// meant the cast call started with you, not the zombieman.
const CAST_ORDER = [
  { name: 'ZOMBIEMAN',             spr: 'POSS', type: 39 },
  { name: 'SHOTGUN GUY',           spr: 'SPOS', type: 40 },
  { name: 'HEAVY WEAPON DUDE',     spr: 'CPOS', type: 41 },
  { name: 'IMP',                   spr: 'TROO', type: 2  },
  { name: 'DEMON',                 spr: 'SARG', type: 42 },
  { name: 'LOST SOUL',             spr: 'SKUL', type: 18 },
  { name: 'CACODEMON',             spr: 'HEAD', type: 17 },
  { name: 'HELL KNIGHT',           spr: 'BOS2', type: 16 },
  { name: 'BARON OF HELL',         spr: 'BOSS', type: 15 },
  { name: 'ARACHNOTRON',           spr: 'BSPI', type: 20 },
  { name: 'PAIN ELEMENTAL',        spr: 'PAIN', type: 22 },
  { name: 'REVENANT',              spr: 'SKEL', type: 7  },
  { name: 'MANCUBUS',              spr: 'FATT', type: 8  },
  { name: 'ARCH-VILE',             spr: 'VILE', type: 3  },
  { name: 'THE SPIDER MASTERMIND', spr: 'SPID', type: 19 },
  { name: 'THE CYBERDEMON',        spr: 'CYBR', type: 21 },
  { name: 'OUR HERO',              spr: 'PLAY', type: 38 /*MT_PLAYER*/ },
];
let _castNum = 0, _castFrame = 0, _castTics = 0, _castActive = false, _castAttacking = false;

export function F_StartCast() { _castActive = true; _castNum = 0; _castFrame = 0; _castTics = 35; _castAttacking = false; }
export function F_CastTicker() {
  if (!_castActive) return;
  if (--_castTics > 0) return;
  _castFrame = (_castFrame + 1) & 3;
  _castTics = 12;
  // After ~3 seconds, swing to the next monster.
  if (_castFrame === 0) {
    _castNum = (_castNum + 1) % CAST_ORDER.length;
    _castAttacking = false;
  }
}
export function F_CastResponder(ev) {
  if (!_castActive) return false;
  if (ev && ev.type === 0) {
    _castNum = (_castNum + 1) % CAST_ORDER.length;
    _castFrame = 0; _castTics = 12;
    return true;
  }
  return false;
}
export function F_CastDrawer(ctx, dx, dy, dw, dh) {
  if (!_castActive) return;
  const sx = dw / 320, sy = dh / 200;
  ctx.fillStyle = '#000';
  ctx.fillRect(dx, dy, dw, dh);
  // Background — use BOSSBACK if present (Doom 2 only), else solid.
  const bg = getPatch('BOSSBACK');
  if (bg !== null) ctx.drawImage(bg.canvas, dx, dy, bg.w * sx, bg.h * sy);
  // Monster name as a centred label.
  const cast = CAST_ORDER[_castNum];
  ctx.fillStyle = '#ffcf00';
  ctx.font = `bold ${Math.round(dh * 0.06)}px monospace`;
  ctx.textAlign = 'center';
  ctx.fillText(cast.name, dx + dw * 0.5, dy + dh * 0.92);
  // Sprite — first idle frame, rotation 0 (front).
  const sprName = cast.spr + String.fromCharCode(65 + (_castFrame & 3)) + '0'; // e.g. POSSA0
  const sp = getPatch(sprName);
  if (sp !== null) {
    const x = dx + (160 - sp.leftoffset) * sx;
    const y = dy + (170 - sp.topoffset)  * sy;
    ctx.drawImage(sp.canvas, x, y, sp.w * sx, sp.h * sy);
  }
  ctx.textAlign = 'left';
}
export function F_CastActive() { return _castActive; }
