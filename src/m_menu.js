// Ported from: linuxdoom-1.10/m_menu.c, m_menu.h
// Main menu hierarchy: Main → New Game / Episode / Skill / Options
//                                 ↘ Load Game / Save Game
//                                 ↘ Read This (help screens)
//                                 ↘ Options → Sound / Detail / Screen size /
//                                              Mouse sensitivity / Messages
//                                 ↘ Quit (with random message)
//
// The 3D port draws menus via Canvas2D using the WAD's M_* patches when
// available, falling back to a monospace font for items.

import { menuactive, set_menuactive, gamestate, gamemode, demoplayback } from './doomstat.js';
import { GameMode_t, KEY_UPARROW, KEY_DOWNARROW, KEY_LEFTARROW, KEY_RIGHTARROW,
  KEY_BACKSPACE, KEY_ESCAPE, KEY_ENTER } from './doomdef.js';
import { G_DeferedInitNew, G_LoadGame, G_SaveGame } from './g_game.js';
// m_menu.c sprinkles S_StartSound through M_Responder for UI feedback: pstop on
// cursor move, pistol on select, stnmov on slider, swtchn/swtchx on open/back/
// close, oof on an invalid action.
import { S_StartSound } from './s_sound.js';
import { sfx_pstop, sfx_pistol, sfx_stnmov, sfx_swtchn, sfx_swtchx } from './sounds.js';
import { HU_ToggleMessages, showMessages } from './hu_stuff.js';
import { D_AcquirePointerLock } from './d_keyboard.js';
import { V_DecodePatchToCanvas, V_DrawPatchAtCanvas, V_RegisterPNGPatch } from './v_video.js';
const getPatch = V_DecodePatchToCanvas;

// M_CONT isn't a WAD lump; it's a user-supplied PNG in the project root for
// the in-game "Continue" entry. Load it asynchronously — until it's ready
// the menu's text fallback ("Continue") renders in its place.
V_RegisterPNGPatch('M_CONT', './M_CONT.png');

// ---------- Menu structure ----------
let _currentMenu = null;
let _selected    = 0;
let _menuStack   = [];

// m_menu.c:129 — LINEHEIGHT.
const LINE_HEIGHT = 16;

// Skull cursor — 2 frames, alternates each 8 tics.
const SKULL_NAMES = ['M_SKULL1', 'M_SKULL2'];
let _skullFrame   = 0;
let _skullTicker  = 0;

// Sound volumes (0..15).
export let sfxVolume = 8;
export let musicVolume = 8;
let _detailLevel  = 0;  // 0=high, 1=low
// _screenSize is the menu's view-size index (0..8 — slider position).
// _screenblocks is the corresponding renderer "screen blocks" value (3..11)
// the C code passes to R_SetViewSize. They move together: m_menu.c:1152 has
// `screenblocks-- ; screenSize--` and the inverse for grow.
// m_misc.c:279 — vanilla default is screenblocks=9 (status bar visible,
// view inset by one step inside a border). The matching slider position
// is screenSize = screenblocks - 3 = 6 (m_menu.c:1854).
let _screenSize   = 6;
let _screenblocks = 9;
let _mouseSens    = 5;

export function getScreenblocks() { return _screenblocks; }
export function isStatusBarVisible() { return _screenblocks < 11; }

// Save-slot names.
const SAVE_SLOTS = 6;
const _saveStrings = new Array(SAVE_SLOTS).fill('EMPTY SLOT');

// ---------- Menus ----------
const CONTINUE_ITEM = { patch: 'M_CONT', label: 'Continue', action: () => M_ClearMenus() };
const MAIN_MENU_BASE_ITEMS = [
  { patch: 'M_NGAME',  label: 'New Game',  action: () => _openEpisodeMenu() },
  { patch: 'M_OPTION', label: 'Options',   action: () => pushMenu(OPTIONS_MENU) },
  // { patch: 'M_LOADG',  label: 'Load Game', action: () => pushMenu(LOAD_MENU) },
  // { patch: 'M_SAVEG',  label: 'Save Game', action: () => pushMenu(SAVE_MENU) },
  { patch: 'M_RDTHIS', label: 'Read This!', action: () => pushMenu(READ_MENU_1) },
  { patch: 'M_QUITG',  label: 'Quit',      action: () => M_QuitDOOM() },
];
const MAIN_MENU = { name: 'Main', patch: 'M_DOOM', x: 97, y: 64, items: MAIN_MENU_BASE_ITEMS };

// m_menu.c:1882 — shareware and registered show 3 episodes, retail shows 4.
// (Shareware fall-throughs to registered: `EpiDef.numitems--`.) In shareware,
// Ep2/3 are visible but _chooseEpisode routes them to the "order to play"
// ad-screen. Only Ep4 is hidden outside retail — and only retail ships M_EPI4
// as a WAD patch anyway, so this also keeps the text-fallback font from
// leaking into the menu.
const EPISODE_ITEMS = [
  { patch: 'M_EPI1', label: 'Knee-Deep in the Dead', action: () => _chooseEpisode(1) },
  { patch: 'M_EPI2', label: 'The Shores of Hell',     action: () => _chooseEpisode(2) },
  { patch: 'M_EPI3', label: 'Inferno',                action: () => _chooseEpisode(3) },
  { patch: 'M_EPI4', label: 'Thy Flesh Consumed',     action: () => _chooseEpisode(4) },
];
const EPISODE_MENU = { name: 'Episode', x: 48, y: 63, items: EPISODE_ITEMS };
function _openEpisodeMenu() {
  EPISODE_MENU.items = EPISODE_ITEMS.slice(0, gamemode === GameMode_t.retail ? 4 : 3);
  pushMenu(EPISODE_MENU);
}

const SKILL_MENU = { name: 'Skill', x: 48, y: 63, items: [
  { patch: 'M_JKILL', label: "I'm too young to die.", action: () => _chooseSkill(0) },
  { patch: 'M_ROUGH', label: 'Hey, not too rough.',    action: () => _chooseSkill(1) },
  { patch: 'M_HURT',  label: 'Hurt me plenty.',        action: () => _chooseSkill(2) },
  { patch: 'M_ULTRA', label: 'Ultra-Violence.',        action: () => _chooseSkill(3) },
  { patch: 'M_NMARE', label: 'Nightmare!',             action: () => _chooseSkill(4) },
]};

// m_menu.c:339-372 — OptionsMenu (the "End Game" entry is intentionally
// omitted in this port). The two `status:-1` spacer rows (option_empty1/2)
// reserve the lines on which M_DrawOptions draws the screen-size and
// mouse-sensitivity thermos (one line BELOW each slider's label). The faithful
// indicators/title/thermos are painted by `draw` below.
const OPTIONS_MENU = { name: 'Options', x: 60, y: 37, items: [
  { patch: 'M_MESSG',  label: 'Messages',          action: () => HU_ToggleMessages() },
  { patch: 'M_DETAIL', label: 'Graphic Detail',    action: () => { _detailLevel ^= 1; } },
  { patch: 'M_SCRNSZ', label: 'Screen Size',       slider: true, get: () => _screenSize, set: (v) => M_SizeDisplay(v > _screenSize ? 1 : 0) },
  { spacer: true },
  { patch: 'M_MSENS',  label: 'Mouse Sensitivity', slider: true, get: () => _mouseSens,  set: (v) => { _mouseSens  = Math.max(0, Math.min(9, v)); } },
  { spacer: true },
  { patch: 'M_SVOL',   label: 'Sound Volume',      action: () => pushMenu(SOUND_MENU) },
]};
// m_menu.c:951-966 M_DrawOptions — title, on/off + hi/lo indicators, thermos.
// Row indices run one below m_menu.c's because the "End Game" row (idx 0) is
// omitted here.
OPTIONS_MENU.draw = (ctx, lx, ly, sx, sy) => {
  const x = OPTIONS_MENU.x, y = OPTIONS_MENU.y, LH = LINE_HEIGHT;
  _drawPatchDoom(ctx, 'M_OPTTTL', 108, 15, lx, ly, sx, sy);
  // detailNames[detailLevel] (0=high,1=low) on the detail row (idx 1).
  _drawPatchDoom(ctx, _detailLevel === 0 ? 'M_GDHIGH' : 'M_GDLOW', x + 175, y + LH * 1, lx, ly, sx, sy);
  // msgNames[showMessages] (0=off,1=on) on the messages row (idx 0).
  _drawPatchDoom(ctx, showMessages === true ? 'M_MSGON' : 'M_MSGOFF', x + 120, y + LH * 0, lx, ly, sx, sy);
  // Thermos on the spacer rows: mousesens+1 (idx 5), scrnsize+1 (idx 3).
  M_DrawThermo(ctx, x, y + LH * 5, 10, _mouseSens,  lx, ly, sx, sy);
  M_DrawThermo(ctx, x, y + LH * 3,  9, _screenSize, lx, ly, sx, sy);
};

// m_menu.c:422-447 — SoundMenu also has spacer rows (sfx_empty1/2) holding the
// volume thermos (one line below each label).
const SOUND_MENU = { name: 'Sound', x: 80, y: 64, items: [
  { patch: 'M_SFXVOL', label: 'Sfx Volume',   slider: true, get: () => sfxVolume,   set: (v) => { sfxVolume   = Math.max(0, Math.min(15, v)); _notifyVolume(); } },
  { spacer: true },
  { patch: 'M_MUSVOL', label: 'Music Volume', slider: true, get: () => musicVolume, set: (v) => { musicVolume = Math.max(0, Math.min(15, v)); _notifyVolume(); } },
  { spacer: true },
]};
// m_menu.c:800-809 M_DrawSound — title + sfx/music thermos (width 16).
SOUND_MENU.draw = (ctx, lx, ly, sx, sy) => {
  const x = SOUND_MENU.x, y = SOUND_MENU.y, LH = LINE_HEIGHT;
  _drawPatchDoom(ctx, 'M_SVOL', 60, 38, lx, ly, sx, sy);
  M_DrawThermo(ctx, x, y + LH * 1, 16, sfxVolume,   lx, ly, sx, sy);  // sfx_vol+1
  M_DrawThermo(ctx, x, y + LH * 3, 16, musicVolume, lx, ly, sx, sy);  // music_vol+1
};

// Slot items use a getter for `label` so the displayed text tracks
// _saveStrings as it changes (e.g. after a save) instead of capturing the
// initial 'EMPTY SLOT' string forever.
const LOAD_MENU = { name: 'Load Game', x: 80, y: 54, save: true, items:
  Array.from({ length: SAVE_SLOTS }, (_, i) => ({ patch: '', get label() { return _saveStrings[i]; }, action: () => _loadSlot(i) })),
};
const SAVE_MENU = { name: 'Save Game', x: 80, y: 54, save: true, items:
  Array.from({ length: SAVE_SLOTS }, (_, i) => ({ patch: '', get label() { return _saveStrings[i]; }, action: () => _saveSlot(i) })),
};

const READ_MENU_1 = { name: 'Read This', x: 280, y: 185, fullscreen: 'HELP1', items: [
  { patch: '', label: '', action: () => pushMenu(READ_MENU_2) },
]};
const READ_MENU_2 = { name: 'Read This 2', x: 330, y: 175, fullscreen: 'HELP2', items: [
  { patch: '', label: '', action: () => popMenu() },
]};

// ---------- Volume change side-effect wiring ----------
let _onVolumeChanged = null;
export function M_SetExternals(refs) {
  if (refs.onVolumeChanged != null) _onVolumeChanged = refs.onVolumeChanged;
}
function _notifyVolume() { if (_onVolumeChanged) _onVolumeChanged(sfxVolume, musicVolume); }

// ---------- Modal message prompt ----------
let _message = null;    // { text, yes:fn, no:fn }
let _input = false;     // input echo for save slot edit
let _saveEditingSlot = -1;

export function M_StartMessage(text, routine, input) {
  _message = { text, routine, input: input === true };
}
export function M_StopMessage() { _message = null; }

// ---------- Navigation ----------
function pushMenu(m) { _menuStack.push(_currentMenu); _currentMenu = m; _selected = 0; }
function popMenu()   { _currentMenu = _menuStack.pop() || MAIN_MENU; _selected = 0; }
// m_menu.c:1624-1642 — move the cursor by `delta`, skipping spacer rows (status:-1).
function _moveCursor(m, delta) {
  const n = m.items.length;
  do { _selected = (_selected + delta + n) % n; } while (m.items[_selected].spacer === true);
  // m_menu.c:1630/1640 — cursor move plays sfx_pstop.
  S_StartSound(null, sfx_pstop);
}

function _chooseEpisode(ep) {
  if (gamemode === GameMode_t.shareware && ep > 1) {
    M_StartMessage('This is the shareware version of DOOM.\nYou need to order to play three more episodes.\n\n(Press y to order)\n(Press n to cancel)', () => {}, true);
    return;
  }
  _pendingEpisode = ep;
  pushMenu(SKILL_MENU);
}

let _pendingEpisode = 1;
function _chooseSkill(skill) {
  if (skill === 4) {
    M_StartMessage('Are you sure? This skill level\nisn\'t even remotely fair.\n\n(Press y to confirm)', (yes) => {
      if (yes) _doStart(skill);
    }, false);
    return;
  }
  _doStart(skill);
}
function _doStart(skill) {
  G_DeferedInitNew(skill, _pendingEpisode, 1);
  M_ClearMenus();
  D_AcquirePointerLock();
}

function _loadSlot(slot) {
  G_LoadGame(`doom:save:${slot}`);
  M_ClearMenus();
}
function _saveSlot(slot) {
  G_SaveGame(slot, _saveStrings[slot] === 'EMPTY SLOT' ? `Slot ${slot + 1}` : _saveStrings[slot]);
  M_ClearMenus();
}

// ---------- Quit ----------
const QUIT_MESSAGES = [
  'please don\'t leave, there\'s more\ndemons to toast!',
  'let\'s beat it -- this is turning\ninto a bloodbath!',
  'i wouldn\'t leave if i were you.\nDOS is much worse.',
  'you\'re trying to say you like DOS\nbetter than me, right?',
  'don\'t leave yet -- there\'s a\ndemon around that corner!',
  'ya know, next time you come in here\ni\'m gonna toast ya.',
  'go ahead and leave. see if i care.',
];
function M_QuitDOOM() {
  // m_menu.c:1105 — deterministic by gametic so it's reproducible per session.
  const gametic = (globalThis.__doom_gametic | 0);
  const idx = (gametic % (QUIT_MESSAGES.length - 1)) + 1;
  M_StartMessage(QUIT_MESSAGES[idx % QUIT_MESSAGES.length] + '\n\n(Press y to quit)', (yes) => {
    if (yes && typeof window !== 'undefined') window.location.reload();
  }, false);
}

// ---------- Lifecycle ----------
export function M_Init() {
  _menuStack = [];
  _currentMenu = MAIN_MENU;
  _selected = 0;
  _skullFrame = 0;
  _skullTicker = 0;
}
export function M_StartControlPanel() {
  if (menuactive) return;
  set_menuactive(true);
  // Continue is only meaningful when the user has started a game — i.e. a
  // level is active AND it isn't a title-screen demo playing in the
  // background.
  const inUserGame = gamestate === 0 /*GS_LEVEL*/ && demoplayback !== true;
  MAIN_MENU.items = inUserGame
    ? [CONTINUE_ITEM, ...MAIN_MENU_BASE_ITEMS]
    : MAIN_MENU_BASE_ITEMS;
  _currentMenu = MAIN_MENU;
  _menuStack = [];
  _selected = 0;
  // m_menu.c:1614 — opening the control panel plays sfx_swtchn. Placed here
  // (rather than at each call site, as vanilla does) so every open path — ESC,
  // a title-screen key, pointer-lock loss — gets it; callers must NOT also
  // play swtchn themselves.
  S_StartSound(null, sfx_swtchn);
}
export function M_ClearMenus() {
  set_menuactive(false);
  _menuStack = [];
  _currentMenu = MAIN_MENU;
  _selected = 0;
}
export function M_Toggle() {
  if (menuactive) M_ClearMenus(); else M_StartControlPanel();
}
export function M_Ticker() {
  if (++_skullTicker >= 8) { _skullTicker = 0; _skullFrame ^= 1; }
}

// ---------- Input ----------
export function M_Responder(ev) {
  if (ev === undefined || ev === null) return false;
  if (ev.type !== 0 /*ev_keydown*/) return false;
  const key = ev.data1;
  // Modal message handling: y/n only.
  if (_message !== null) {
    // m_menu.c:1507 — any dismissal of a modal message plays sfx_swtchx.
    if (key === 0x79 /*y*/ || key === 13) { _message.routine?.(true);  _message = null; S_StartSound(null, sfx_swtchx); return true; }
    if (key === 0x6e /*n*/ || key === KEY_ESCAPE) { _message.routine?.(false); _message = null; S_StartSound(null, sfx_swtchx); return true; }
    return true;
  }
  if (key === KEY_ESCAPE) {
    // m_menu.c:1683 — ESC closes the menu with sfx_swtchx; the open path
    // (M_StartControlPanel) plays sfx_swtchn itself, m_menu.c:1614.
    if (menuactive === true) { M_ClearMenus(); S_StartSound(null, sfx_swtchx); }
    else M_StartControlPanel();
    return true;
  }
  if (menuactive !== true) return false;
  const m = _currentMenu;
  if (m === null) return false;
  if (key === KEY_UPARROW)    { _moveCursor(m, -1); return true; }
  if (key === KEY_DOWNARROW)  { _moveCursor(m,  1); return true; }
  if (key === KEY_LEFTARROW)  {
    const it = m.items[_selected];
    // m_menu.c:1648 — slider left arrow plays sfx_stnmov.
    if (it.slider === true) { S_StartSound(null, sfx_stnmov); it.set(it.get() - 1); }
    return true;
  }
  if (key === KEY_RIGHTARROW) {
    const it = m.items[_selected];
    // m_menu.c:1657 — slider right arrow plays sfx_stnmov.
    if (it.slider === true) { S_StartSound(null, sfx_stnmov); it.set(it.get() + 1); }
    return true;
  }
  if (key === KEY_ENTER) {
    const it = m.items[_selected];
    // m_menu.c:1667 — ENTER on a slider (status==2) acts as the right arrow
    // and plays sfx_stnmov; ENTER on a normal item plays sfx_pistol.
    if (it.slider === true) { it.set(it.get() + 1); S_StartSound(null, sfx_stnmov); }
    else if (it.action != null) { it.action(); S_StartSound(null, sfx_pistol); }
    return true;
  }
  // doomdef.h:KEY_BACKSPACE = 127 — d_keyboard sends 127 for Backspace per
  // the vanilla mapping.
  if (key === KEY_BACKSPACE) {
    // m_menu.c:1688 — sfx_swtchn only when there's a previous menu to pop to.
    const hadPrev = _menuStack.length > 0;
    popMenu();
    if (hadPrev === true) S_StartSound(null, sfx_swtchn);
    return true;
  }
  return true;
}

// ---------- Drawer ----------
const drawPatchAt = V_DrawPatchAtCanvas;

// Draw a WAD patch positioned in Doom (320x200) coords (dx,dy), mapped into the
// letterboxed menu box at origin (lx,ly) and scale (sx,sy). Mirrors
// V_DrawPatchDirect used throughout m_menu.c's draw routines.
function _drawPatchDoom(ctx, name, dx, dy, lx, ly, sx, sy) {
  const p = getPatch(name);
  if (p !== null) drawPatchAt(ctx, p, lx + dx * sx, ly + dy * sy, sx, sy);
}

// m_menu.c:1182 M_DrawThermo — left cap, `thermWidth` middle cells, right cap,
// then the slider knob (M_THERMO) at cell `thermDot`.
function M_DrawThermo(ctx, x, y, thermWidth, thermDot, lx, ly, sx, sy) {
  let xx = x;
  _drawPatchDoom(ctx, 'M_THERML', xx, y, lx, ly, sx, sy);
  xx += 8;
  // The middle cell is the same patch every iteration — resolve it once
  // (drawPatchAt no-ops on null, so no per-cell null check needed).
  const mid = getPatch('M_THERMM');
  for (let i = 0; i < thermWidth; i++) {
    drawPatchAt(ctx, mid, lx + xx * sx, ly + y * sy, sx, sy);
    xx += 8;
  }
  _drawPatchDoom(ctx, 'M_THERMR', xx, y, lx, ly, sx, sy);
  _drawPatchDoom(ctx, 'M_THERMO', (x + 8) + thermDot * 8, y, lx, ly, sx, sy);
}

export function M_Drawer(overlayCtx, dstX, dstY, dstW, dstH) {
  if (!menuactive) {
    // Even when menu is inactive, draw any pending modal message.
    if (_message !== null) drawMessage(overlayCtx, dstX, dstY, dstW, dstH);
    return;
  }
  if (_currentMenu === null) return;
  const m = _currentMenu;
  // Letterbox the menu layout to a 4:3 box centered in the passed area so
  // patches and items don't stretch with window aspect. Background dim and
  // modal overlay still cover the full passed box.
  const scale = Math.min(dstW / 320, dstH / 200);
  const sx = scale, sy = scale;
  const lx = dstX + (dstW - 320 * scale) * 0.5;
  const ly = dstY + (dstH - 200 * scale) * 0.5;
  // Background dim only when not over title screen.
  if (gamestate === 0 /*GS_LEVEL*/) {
    overlayCtx.fillStyle = 'rgba(0,0,0,0.6)';
    overlayCtx.fillRect(dstX, dstY, dstW, dstH);
  }
  if (m.fullscreen) {
    const help = getPatch(m.fullscreen);
    if (help !== null) drawPatchAt(overlayCtx, help, lx, ly, sx, sy);
  }
  // Main menu draws the DOOM logo at the top.
  if (m.patch) {
    const title = getPatch(m.patch);
    if (title !== null) drawPatchAt(overlayCtx, title, lx + 94 * sx, ly + 2 * sy, sx, sy);
  }
  // m_menu.c:1784 — per-menu draw routine (title, indicators, thermos) runs
  // before the item labels, exactly like currentMenu->routine() in M_Drawer.
  if (typeof m.draw === 'function') m.draw(overlayCtx, lx, ly, sx, sy);
  // Items.
  const baseX = m.x, baseY = m.y;
  for (let i = 0; i < m.items.length; i++) {
    const it = m.items[i];
    // Spacer rows (m_menu.c status:-1) reserve a line for a thermo; no label.
    if (it.spacer === true) continue;
    const ix = lx + baseX * sx;
    const iy = ly + (baseY + i * LINE_HEIGHT) * sy;
    // Patch if available; otherwise fall back to the text label. The fallback
    // also covers patches that aren't yet ready (e.g. M_CONT loading from a
    // PNG file) and lookups that miss the WAD.
    const p = it.patch ? getPatch(it.patch) : null;
    if (p !== null) {
      drawPatchAt(overlayCtx, p, ix, iy, sx, sy);
    } else if (it.label) {
      overlayCtx.fillStyle = '#cccccc';
      overlayCtx.font = `bold ${Math.round(12 * sy)}px monospace`;
      overlayCtx.textAlign = 'left';
      overlayCtx.fillText(it.label, ix, iy + 12 * sy);
    }
  }
  // Skull cursor next to the selected item.
  const cur = getPatch(SKULL_NAMES[_skullFrame]);
  if (cur !== null) {
    const cx = lx + (baseX - 32) * sx;
    const cy = ly + (baseY - 5 + _selected * LINE_HEIGHT) * sy;
    drawPatchAt(overlayCtx, cur, cx, cy, sx, sy);
  } else {
    // Fallback ">" marker.
    overlayCtx.fillStyle = '#ff8';
    overlayCtx.font = `bold ${Math.round(14 * sy)}px monospace`;
    overlayCtx.fillText('►', lx + (baseX - 16) * sx, ly + (baseY + 12 + _selected * LINE_HEIGHT) * sy);
  }
  // Modal message renders on top.
  if (_message !== null) drawMessage(overlayCtx, dstX, dstY, dstW, dstH);
}

function drawMessage(ctx, dstX, dstY, dstW, dstH) {
  ctx.fillStyle = 'rgba(0,0,0,0.85)';
  ctx.fillRect(dstX, dstY, dstW, dstH);
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(dstH * 0.035)}px monospace`;
  ctx.textAlign = 'center';
  const lines = _message.text.split('\n');
  const lh = dstH * 0.045;
  const startY = dstY + dstH * 0.4 - (lines.length * lh) / 2;
  for (let i = 0; i < lines.length; i++) ctx.fillText(lines[i], dstX + dstW * 0.5, startY + i * lh);
  ctx.textAlign = 'left';
}

// ---------- API expected by g_game.js ----------
// m_menu.c:1152 — M_SizeDisplay. Slider LEFT (choice=0) shrinks the view
// (decrement screenSize/screenblocks); RIGHT (choice=1) grows it. The
// vanilla bounds are screenSize in [0,8] mapping to screenblocks in [3,11].
// Once we reach the top, screenblocks=11 hides the status bar.
export function M_SizeDisplay(choice) {
  if (choice === 0) {
    if (_screenSize > 0) {
      _screenSize--;
      _screenblocks--;
    }
  } else if (choice === 1) {
    if (_screenSize < 8) {
      _screenSize++;
      _screenblocks++;
    }
  }
  // 3D port doesn't have R_SetViewSize — instead the renderer just stays
  // full-window. The only observable effect is hiding/showing the status bar
  // (handled by d_main checking isStatusBarVisible() before calling ST_Drawer).
}
