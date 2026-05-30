// Ported from: linuxdoom-1.10/p_switch.c
// Switch texture toggle (off/on pair). When a switch line is used, the
// linedef's texture is flipped to its paired "on" form and (if button-style)
// flipped back after `time` tics.

import { sides } from './p_setup.js';
import { R_TextureNumForName, R_CheckTextureNumForName } from './r_data.js';

// Doom's alphSwitchList pairs (name1 = off, name2 = on, episode).
// Mirrors p_switch.c: episode 1 = Doom shareware, episode 2 = Doom registered+,
// episode 3 = Doom II. At init, episode is bumped to the running gamemode and
// any entry with `ep > episode` is filtered out.
const alphSwitchList = [
  // Doom shareware episode 1 switches
  ['SW1BRCOM', 'SW2BRCOM', 1], ['SW1BRN1',  'SW2BRN1',  1],
  ['SW1BRN2',  'SW2BRN2',  1], ['SW1BRNGN', 'SW2BRNGN', 1],
  ['SW1BROWN', 'SW2BROWN', 1], ['SW1COMM',  'SW2COMM',  1],
  ['SW1COMP',  'SW2COMP',  1], ['SW1DIRT',  'SW2DIRT',  1],
  ['SW1EXIT',  'SW2EXIT',  1], ['SW1GRAY',  'SW2GRAY',  1],
  ['SW1GRAY1', 'SW2GRAY1', 1], ['SW1METAL', 'SW2METAL', 1],
  ['SW1PIPE',  'SW2PIPE',  1], ['SW1SLAD',  'SW2SLAD',  1],
  ['SW1STARG', 'SW2STARG', 1], ['SW1STON1', 'SW2STON1', 1],
  ['SW1STON2', 'SW2STON2', 1], ['SW1STONE', 'SW2STONE', 1],
  ['SW1STRTN', 'SW2STRTN', 1],
  // Doom registered episodes 2&3 switches
  ['SW1BLUE',  'SW2BLUE',  2], ['SW1CMT',   'SW2CMT',   2],
  ['SW1GARG',  'SW2GARG',  2], ['SW1GSTON', 'SW2GSTON', 2],
  ['SW1HOT',   'SW2HOT',   2], ['SW1LION',  'SW2LION',  2],
  ['SW1SATYR', 'SW2SATYR', 2], ['SW1SKIN',  'SW2SKIN',  2],
  ['SW1VINE',  'SW2VINE',  2], ['SW1WOOD',  'SW2WOOD',  2],
  // Doom II switches
  ['SW1PANEL', 'SW2PANEL', 3], ['SW1ROCK',  'SW2ROCK',  3],
  ['SW1MET2',  'SW2MET2',  3], ['SW1WDMET', 'SW2WDMET', 3],
  ['SW1BRIK',  'SW2BRIK',  3], ['SW1MOD1',  'SW2MOD1',  3],
  ['SW1ZIM',   'SW2ZIM',   3], ['SW1STON6', 'SW2STON6', 3],
  ['SW1TEK',   'SW2TEK',   3], ['SW1MARB',  'SW2MARB',  3],
  ['SW1SKULL', 'SW2SKULL', 3],
];

export const top = 0, middle = 1, bottom = 2;

// switchlist[2*i] = off-texture, switchlist[2*i+1] = on-texture.
let switchlist = [];
let numswitches = 0;
// Texnums (off and on) of every active switch, for O(1) membership tests — the
// 3D renderer asks "is this wall a switch?" when building wall geometry.
const _switchTexSet = new Set();
export function P_IsSwitchTexture(texnum) { return _switchTexSet.has(texnum); }

// Active buttons (countdown timers to flip back).
const MAXBUTTONS = 16;
const buttonlist = new Array(MAXBUTTONS);
for (let i = 0; i < MAXBUTTONS; i++) buttonlist[i] = { line: null, where: 0, btexture: 0, btimer: 0 };

let _S = null;
// Injected so the 3D renderer can re-texture the switch wall in place when it
// flips (the wall lives in a per-texture mesh built once; r_segs owns it).
let _R_SetSwitchTexture = null;
export function P_SwitchSetExternals(refs) {
  if (refs.S != null) _S = refs.S;
  if (refs.R_SetSwitchTexture != null) _R_SetSwitchTexture = refs.R_SetSwitchTexture;
}

export function P_InitSwitchList(episode) {
  switchlist = [];
  _switchTexSet.clear();
  for (const [n1, n2, ep] of alphSwitchList) {
    if (ep > episode) continue;
    const t1 = R_CheckTextureNumForName(n1);
    const t2 = R_CheckTextureNumForName(n2);
    if (t1 >= 0 && t2 >= 0) {
      switchlist.push(t1); switchlist.push(t2);
      _switchTexSet.add(t1); _switchTexSet.add(t2);
    }
  }
  numswitches = switchlist.length / 2;
}

export function P_StartButton(line, w, texture, time) {
  for (const b of buttonlist) {
    if (b.btimer !== 0 && b.line === line) return;
  }
  for (const b of buttonlist) {
    if (b.btimer === 0) {
      b.line = line; b.where = w; b.btexture = texture; b.btimer = time;
      return;
    }
  }
}

// Per-tic countdown — call from P_UpdateSpecials.
export function P_UpdateButtons() {
  for (const b of buttonlist) {
    if (b.btimer === 0) continue;
    b.btimer--;
    if (b.btimer === 0) {
      const sd = sides[b.line.sidenum[0]];
      if      (b.where === top)    sd.toptexture    = b.btexture;
      else if (b.where === middle) sd.midtexture    = b.btexture;
      else if (b.where === bottom) sd.bottomtexture = b.btexture;
      if (_R_SetSwitchTexture !== null) _R_SetSwitchTexture(b.line, b.where, b.btexture);
      // p_spec.c:1151 — button-return click is positional from the switch's
      // sector soundorg (C stores it on the button; we read it off the line).
      if (_S !== null) _S.S_StartSound(b.line.frontsector.soundorg, 23 /*sfx_swtchn*/);
      b.line = null;
    }
  }
}

// p_switch.c:194 P_ChangeSwitchTexture. The C source plays the switch sound
// only when a matching switch texture is actually found; lines that aren't in
// alphSwitchList just fall through and emit nothing.
export function P_ChangeSwitchTexture(line, useAgain) {
  if (useAgain === 0) line.special = 0;
  const sd = sides[line.sidenum[0]];
  const texTop = sd.toptexture, texMid = sd.midtexture, texBot = sd.bottomtexture;
  // EXIT SWITCH? (C: only special==11 uses sfx_swtchx)
  const isExit = (line.special === 11);
  const sound  = isExit ? 24 /*sfx_swtchx*/ : 23 /*sfx_swtchn*/;
  // Find the matching switch and flip — play sound only on match. p_switch.c
  // plays from buttonlist[0].soundorg (a stale-slot quirk); we use this switch's
  // own front-sector soundorg so the click is correctly positioned at the switch.
  for (let i = 0; i < numswitches * 2; i++) {
    if (switchlist[i] === texTop) {
      if (_S !== null) _S.S_StartSound(line.frontsector.soundorg, sound);
      sd.toptexture = switchlist[i ^ 1];
      if (_R_SetSwitchTexture !== null) _R_SetSwitchTexture(line, top, switchlist[i ^ 1]);
      if (useAgain !== 0) P_StartButton(line, top, texTop, 35);
      return;
    }
    if (switchlist[i] === texMid) {
      if (_S !== null) _S.S_StartSound(line.frontsector.soundorg, sound);
      sd.midtexture = switchlist[i ^ 1];
      if (_R_SetSwitchTexture !== null) _R_SetSwitchTexture(line, middle, switchlist[i ^ 1]);
      if (useAgain !== 0) P_StartButton(line, middle, texMid, 35);
      return;
    }
    if (switchlist[i] === texBot) {
      if (_S !== null) _S.S_StartSound(line.frontsector.soundorg, sound);
      sd.bottomtexture = switchlist[i ^ 1];
      if (_R_SetSwitchTexture !== null) _R_SetSwitchTexture(line, bottom, switchlist[i ^ 1]);
      if (useAgain !== 0) P_StartButton(line, bottom, texBot, 35);
      return;
    }
  }
}
