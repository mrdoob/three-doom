// Ported from: linuxdoom-1.10/m_menu.c, m_menu.h
// Main menu hierarchy: Main → New Game / Episode / Skill / Options
//                                 ↘ Load Game / Save Game
//                                 ↘ Read This (help screens)
//                                 ↘ Options → Sound / Detail / Screen size /
//                                              Mouse sensitivity / Messages /
//                                              End Game
//                                 ↘ Quit (with random message)
//
// The 3D port draws menus via Canvas2D using the WAD's M_* patches when
// available, falling back to a monospace font for items.

import { menuactive, set_menuactive, gamestate, gamemode } from './doomstat.js';
import { GameMode_t } from './doomdef.js';
import { G_DeferedInitNew, G_LoadGame, G_SaveGame } from './g_game.js';
import { D_AcquirePointerLock } from './d_keyboard.js';
import { V_DecodePatchToCanvas, V_DrawPatchAtCanvas } from './v_video.js';
const getPatch = V_DecodePatchToCanvas;

// ---------- Menu structure ----------
let _currentMenu = null;
let _selected    = 0;
let _menuStack   = [];

// Skull cursor — 2 frames, alternates each 8 tics.
const SKULL_NAMES = ['M_SKULL1', 'M_SKULL2'];
let _skullFrame   = 0;
let _skullTicker  = 0;

// Sound volumes (0..15).
export let sfxVolume = 8;
export let musicVolume = 8;
let _detailLevel  = 0;  // 0=high, 1=low
let _screenSize   = 9;  // 3..11
let _messages     = 1;
let _mouseSens    = 5;

// Save-slot names.
const SAVE_SLOTS = 6;
const _saveStrings = new Array(SAVE_SLOTS).fill('EMPTY SLOT');

// ---------- Menus ----------
const MAIN_MENU = { name: 'Main', patch: 'M_DOOM', x: 97, y: 64, items: [
  { patch: 'M_NGAME',  label: 'New Game',  action: () => pushMenu(EPISODE_MENU) },
  { patch: 'M_OPTION', label: 'Options',   action: () => pushMenu(OPTIONS_MENU) },
  { patch: 'M_LOADG',  label: 'Load Game', action: () => pushMenu(LOAD_MENU) },
  { patch: 'M_SAVEG',  label: 'Save Game', action: () => pushMenu(SAVE_MENU) },
  { patch: 'M_RDTHIS', label: 'Read This!', action: () => pushMenu(READ_MENU_1) },
  { patch: 'M_QUITG',  label: 'Quit',      action: () => M_QuitDOOM() },
]};

const EPISODE_MENU = { name: 'Episode', x: 48, y: 63, items: [
  { patch: 'M_EPI1', label: 'Knee-Deep in the Dead', action: () => _chooseEpisode(1) },
  { patch: 'M_EPI2', label: 'The Shores of Hell',     action: () => _chooseEpisode(2) },
  { patch: 'M_EPI3', label: 'Inferno',                action: () => _chooseEpisode(3) },
  { patch: 'M_EPI4', label: 'Thy Flesh Consumed',     action: () => _chooseEpisode(4) },
]};

const SKILL_MENU = { name: 'Skill', x: 48, y: 63, items: [
  { patch: 'M_JKILL', label: "I'm too young to die.", action: () => _chooseSkill(0) },
  { patch: 'M_ROUGH', label: 'Hey, not too rough.',    action: () => _chooseSkill(1) },
  { patch: 'M_HURT',  label: 'Hurt me plenty.',        action: () => _chooseSkill(2) },
  { patch: 'M_ULTRA', label: 'Ultra-Violence.',        action: () => _chooseSkill(3) },
  { patch: 'M_NMARE', label: 'Nightmare!',             action: () => _chooseSkill(4) },
]};

const OPTIONS_MENU = { name: 'Options', x: 60, y: 37, items: [
  { patch: 'M_ENDGAM', label: 'End Game',          action: () => M_EndGame() },
  { patch: 'M_MESSG',  label: 'Messages',          action: () => { _messages ^= 1; } },
  { patch: 'M_DETAIL', label: 'Graphic Detail',    action: () => { _detailLevel ^= 1; } },
  { patch: 'M_SCRNSZ', label: 'Screen Size',       slider: true, get: () => _screenSize, set: (v) => { _screenSize = Math.max(3, Math.min(11, v)); } },
  { patch: 'M_MSENS',  label: 'Mouse Sensitivity', slider: true, get: () => _mouseSens,  set: (v) => { _mouseSens  = Math.max(0, Math.min(9, v)); } },
  { patch: 'M_SVOL',   label: 'Sound Volume',      action: () => pushMenu(SOUND_MENU) },
]};

const SOUND_MENU = { name: 'Sound', x: 80, y: 64, items: [
  { patch: 'M_SFXVOL', label: 'Sfx Volume',   slider: true, get: () => sfxVolume,   set: (v) => { sfxVolume   = Math.max(0, Math.min(15, v)); _notifyVolume(); } },
  { patch: 'M_MUSVOL', label: 'Music Volume', slider: true, get: () => musicVolume, set: (v) => { musicVolume = Math.max(0, Math.min(15, v)); _notifyVolume(); } },
]};

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

function M_EndGame() {
  M_StartMessage('Are you sure you want to end the game?\n\n(Press y to quit)', (yes) => {
    if (yes) {
      M_ClearMenus();
      if (typeof window !== 'undefined') window.location.reload();
    }
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
  _currentMenu = MAIN_MENU;
  _menuStack = [];
  _selected = 0;
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
    if (key === 0x79 /*y*/ || key === 13) { _message.routine?.(true);  _message = null; return true; }
    if (key === 0x6e /*n*/ || key === 27) { _message.routine?.(false); _message = null; return true; }
    return true;
  }
  if (key === 27 /*KEY_ESCAPE*/) {
    if (menuactive) M_ClearMenus(); else M_StartControlPanel();
    return true;
  }
  if (!menuactive) return false;
  const m = _currentMenu;
  if (m === null) return false;
  if (key === 0xad /*UP*/)   { _selected = (_selected - 1 + m.items.length) % m.items.length; return true; }
  if (key === 0xaf /*DOWN*/) { _selected = (_selected + 1) % m.items.length; return true; }
  if (key === 0xac /*LEFT*/) {
    const it = m.items[_selected];
    if (it.slider) it.set(it.get() - 1);
    return true;
  }
  if (key === 0xae /*RIGHT*/) {
    const it = m.items[_selected];
    if (it.slider) it.set(it.get() + 1);
    return true;
  }
  if (key === 13 /*ENTER*/) {
    const it = m.items[_selected];
    if (it.action) it.action();
    return true;
  }
  if (key === 0x08 /*BACKSPACE*/) { popMenu(); return true; }
  return true;
}

// ---------- Drawer ----------
const drawPatchAt = V_DrawPatchAtCanvas;

export function M_Drawer(overlayCtx, dstX, dstY, dstW, dstH) {
  if (!menuactive) {
    // Even when menu is inactive, draw any pending modal message.
    if (_message !== null) drawMessage(overlayCtx, dstX, dstY, dstW, dstH);
    return;
  }
  if (_currentMenu === null) return;
  const m = _currentMenu;
  const sx = dstW / 320, sy = dstH / 200;
  // Background dim only when not over title screen.
  if (gamestate === 0 /*GS_LEVEL*/) {
    overlayCtx.fillStyle = 'rgba(0,0,0,0.6)';
    overlayCtx.fillRect(dstX, dstY, dstW, dstH);
  }
  if (m.fullscreen) {
    const help = getPatch(m.fullscreen);
    if (help !== null) drawPatchAt(overlayCtx, help, dstX, dstY, sx, sy);
  }
  // Main menu draws the DOOM logo at the top.
  if (m.patch) {
    const title = getPatch(m.patch);
    if (title !== null) drawPatchAt(overlayCtx, title, dstX + 94 * sx, dstY + 2 * sy, sx, sy);
  }
  // Items.
  const baseX = m.x, baseY = m.y;
  const LINE_HEIGHT = 16;
  for (let i = 0; i < m.items.length; i++) {
    const it = m.items[i];
    const ix = dstX + baseX * sx;
    const iy = dstY + (baseY + i * LINE_HEIGHT) * sy;
    if (it.patch) {
      const p = getPatch(it.patch);
      if (p !== null) drawPatchAt(overlayCtx, p, ix, iy, sx, sy);
    } else {
      overlayCtx.fillStyle = '#cccccc';
      overlayCtx.font = `bold ${Math.round(12 * sy)}px monospace`;
      overlayCtx.textAlign = 'left';
      overlayCtx.fillText(it.label, ix, iy + 12 * sy);
    }
    if (it.slider) {
      const sliderX = ix + 100 * sx;
      const v = it.get();
      const vMax = it.label === 'Mouse Sensitivity' ? 9 : (it.label === 'Screen Size' ? 11 : 15);
      // Slider: '<' '*'*16 '>'
      overlayCtx.fillStyle = '#888';
      overlayCtx.fillRect(sliderX, iy + 6 * sy, vMax * 8 * sx, 4 * sy);
      overlayCtx.fillStyle = '#ff8';
      overlayCtx.fillRect(sliderX, iy + 6 * sy, v * 8 * sx, 4 * sy);
    }
  }
  // Skull cursor next to the selected item.
  const cur = getPatch(SKULL_NAMES[_skullFrame]);
  if (cur !== null) {
    const cx = dstX + (baseX - 32) * sx;
    const cy = dstY + (baseY - 5 + _selected * LINE_HEIGHT) * sy;
    drawPatchAt(overlayCtx, cur, cx, cy, sx, sy);
  } else {
    // Fallback ">" marker.
    overlayCtx.fillStyle = '#ff8';
    overlayCtx.font = `bold ${Math.round(14 * sy)}px monospace`;
    overlayCtx.fillText('►', dstX + (baseX - 16) * sx, dstY + (baseY + 12 + _selected * LINE_HEIGHT) * sy);
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
export function M_SizeDisplay(_v) {}
