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

import {
  menuactive, set_menuactive, gamestate, gamemode, demoplayback,
  usergame, netgame, automapactive, players, consoleplayer,
  gametic,
  mouseSensitivity, set_mouseSensitivity,
  snd_SfxVolume as sfxVolume, snd_MusicVolume as musicVolume,
} from './doomstat.js';
export {
  snd_SfxVolume as sfxVolume,
  snd_MusicVolume as musicVolume,
} from './doomstat.js';
import { GameMode_t, KEY_UPARROW, KEY_DOWNARROW, KEY_LEFTARROW, KEY_RIGHTARROW,
  KEY_BACKSPACE, KEY_ESCAPE, KEY_ENTER, KEY_EQUALS, KEY_MINUS, KEY_F1,
  KEY_F11 } from './doomdef.js';
import {
  G_DeferedInitNew,
  G_LoadGame as G_QueueLoadGame,
  G_SaveGame as G_QueueSaveGame,
} from './g_game.js';
// m_menu.c sprinkles S_StartSound through M_Responder for UI feedback: pstop on
// cursor move, pistol on select, stnmov on slider, swtchn/swtchx on open/back/
// close, oof on an invalid action.
import {
  S_SetMusicVolume as S_ApplyMusicVolume,
  S_SetSfxVolume as S_ApplySfxVolume,
  S_StartSound,
} from './s_sound.js';
import { sfx_oof, sfx_pstop, sfx_pistol, sfx_stnmov, sfx_swtchn, sfx_swtchx } from './sounds.js';
import { HU_ToggleMessages, showMessages } from './hu_stuff.js';
import { D_AcquirePointerLock } from './d_keyboard.js';
import { I_Quit } from './i_system.js';
import {
  gammatable, set_usegamma, usegamma,
  V_DecodePatchToCanvas, V_DrawPatchAtCanvas, V_RegisterPNGPatch,
} from './v_video.js';
import { V_PaletteCSS } from './v_palette.js';
import { I_SetPalette } from './i_video.js';
import { W_CacheLumpName } from './w_wad.js';
import {
  ENDGAME, GAMMALVL0, GAMMALVL1, GAMMALVL2, GAMMALVL3, GAMMALVL4,
  EMPTYSTRING, LOADNET, NETEND, NEWGAME, QLOADNET, QLPROMPT, QSPROMPT,
  QSAVESPOT, SAVEDEAD,
} from './d_englsh.js';
import { M_EndGameRoute } from './m_menu_endgame_logic.js';
import {
  M_ConfirmQuit, M_QuitMessageForTic, QUIT_CONFIRM_KEY,
} from './m_menu_quit_logic.js';
import { M_ALPHA_KEYS, M_FindAlphaItem } from './m_menu_alpha_logic.js';
import { M_RestoreMainCursor } from './m_menu_cursor_logic.js';
import { M_MessageAcceptsKey } from './m_menu_message_logic.js';
import { M_NewGameRoute } from './m_menu_newgame_logic.js';
import { M_ReadThisPlan } from './m_menu_read_logic.js';
import { M_ClosedShortcutRoute } from './m_menu_shortcut_logic.js';
import {
  M_ApplySaveEditKey, M_BeginSaveEdit, M_FormatSavePrompt,
  M_NormalizeSaveSlots, M_QuickLoadRoute, M_QuickSaveRoute,
  QUICK_SAVE_NONE, QUICK_SAVE_PICKING, SAVE_SLOTS,
} from './m_menu_save_logic.js';
import { HU_DrawLayout, HU_GetFont, HU_LayoutText, HU_TextWidth } from './hu_font.js';
import { M_LayoutMessage } from './m_menu_text.js';
import { R_GetScreenblocks, R_SetViewSize } from './r_view.js';
const getPatch = V_DecodePatchToCanvas;
const GAMMA_MESSAGES = [GAMMALVL0, GAMMALVL1, GAMMALVL2, GAMMALVL3, GAMMALVL4];

// M_CONT isn't a WAD lump; it's a user-supplied PNG in the project root for
// the in-game "Continue" entry. Load it asynchronously — until it's ready
// the menu's text fallback ("Continue") renders in its place.
V_RegisterPNGPatch('M_CONT', './M_CONT.png');

// ---------- Menu structure ----------
let _currentMenu = null;
let _selected    = 0;
let _menuStack   = [];
// Last M_Drawer letterbox geometry, used by M_HandleTap to invert a tap.
let _lastLayout  = null;

// m_menu.c:129 — LINEHEIGHT.
const LINE_HEIGHT = 16;

// Skull cursor — 2 frames, alternates each 8 tics.
const SKULL_NAMES = ['M_SKULL1', 'M_SKULL2'];
let _skullFrame   = 0;
let _skullTicker  = 0;

let _detailLevel  = 0;  // 0=high, 1=low
// screenSize is the menu's view-size index (0..8 — slider position).
// screenblocks is the corresponding renderer value (3..11) passed to
// R_SetViewSize. They move together: m_menu.c:1152 has
// `screenblocks-- ; screenSize--` and the inverse for grow.
// m_misc.c:279 uses screenblocks=9. The browser default is one step larger:
// screenblocks=10 gives a full-width view with the status bar still visible,
// at slider position screenSize = screenblocks - 3 = 7 (m_menu.c:1854).
function getScreenSize() { return R_GetScreenblocks() - 3; }

export function getScreenblocks() { return R_GetScreenblocks(); }
// st_stuff.c:1111 — automap always restores the status bar even when the
// first-person view-size slider is at fullscreen (screenblocks == 11).
export function isStatusBarVisible() {
  return R_GetScreenblocks() < 11 || automapactive === true;
}

// Save-slot descriptions and native LoadMenu status values. A missing save is
// still a cursor/alpha target, but its action is disabled.
const _saveStrings = new Array(SAVE_SLOTS).fill(EMPTYSTRING);
const _loadSlotEnabled = new Array(SAVE_SLOTS).fill(false);

// ---------- Menus ----------
const CONTINUE_ITEM = {
  menuKey: 'continue', patch: 'M_CONT', label: 'Continue', alphaKey: M_ALPHA_KEYS.continue,
  action: () => M_ClearMenus(),
};
const MAIN_MENU_ITEMS = {
  continue: CONTINUE_ITEM,
  newgame: { menuKey: 'newgame', patch: 'M_NGAME', label: 'New Game', alphaKey: M_ALPHA_KEYS.main[0], action: () => M_NewGame() },
  options: { menuKey: 'options', patch: 'M_OPTION', label: 'Options', alphaKey: M_ALPHA_KEYS.main[1], action: () => pushMenu(OPTIONS_MENU) },
  loadgame: { menuKey: 'loadgame', patch: 'M_LOADG', label: 'Load Game', alphaKey: M_ALPHA_KEYS.main[2], action: () => M_LoadGame() },
  savegame: { menuKey: 'savegame', patch: 'M_SAVEG', label: 'Save Game', alphaKey: M_ALPHA_KEYS.main[3], action: () => M_SaveGame() },
  readthis: { menuKey: 'readthis', patch: 'M_RDTHIS', label: 'Read This!', alphaKey: M_ALPHA_KEYS.main[4], action: () => pushMenu(READ_MENU_1) },
  quit: { menuKey: 'quit', patch: 'M_QUITG', label: 'Quit', alphaKey: M_ALPHA_KEYS.main[5], action: () => M_QuitDOOM() },
};
const MAIN_MENU_BASE_ITEMS = [
  MAIN_MENU_ITEMS.newgame,
  MAIN_MENU_ITEMS.options,
  MAIN_MENU_ITEMS.loadgame,
  MAIN_MENU_ITEMS.savegame,
  MAIN_MENU_ITEMS.readthis,
  MAIN_MENU_ITEMS.quit,
];
const MAIN_MENU = {
  name: 'Main', patch: 'M_DOOM', x: 97, y: 64,
  items: MAIN_MENU_BASE_ITEMS, lastOn: 0, lastItemKey: null,
};

// m_menu.c:1882 — shareware and registered show 3 episodes, retail shows 4.
// (Shareware fall-throughs to registered: `EpiDef.numitems--`.) In shareware,
// Ep2/3 are visible but _chooseEpisode routes them to the "order to play"
// ad-screen. Only Ep4 is hidden outside retail — and only retail ships M_EPI4
// as a WAD patch anyway, so this also keeps the text-fallback font from
// leaking into the menu.
const EPISODE_ITEMS = [
  { patch: 'M_EPI1', label: 'Knee-Deep in the Dead', alphaKey: M_ALPHA_KEYS.episode[0], action: () => _chooseEpisode(1) },
  { patch: 'M_EPI2', label: 'The Shores of Hell', alphaKey: M_ALPHA_KEYS.episode[1], action: () => _chooseEpisode(2) },
  { patch: 'M_EPI3', label: 'Inferno', alphaKey: M_ALPHA_KEYS.episode[2], action: () => _chooseEpisode(3) },
  { patch: 'M_EPI4', label: 'Thy Flesh Consumed', alphaKey: M_ALPHA_KEYS.episode[3], action: () => _chooseEpisode(4) },
];
const EPISODE_MENU = { name: 'Episode', x: 48, y: 63, items: EPISODE_ITEMS };
// m_menu.c:893-896 — episode heading above the unchanged item rows.
EPISODE_MENU.draw = (ctx, lx, ly, sx, sy) => {
  _drawPatchDoom(ctx, 'M_EPISOD', 54, 38, lx, ly, sx, sy);
};
function _openEpisodeMenu() {
  EPISODE_MENU.items = EPISODE_ITEMS.slice(0, gamemode === GameMode_t.retail ? 4 : 3);
  pushMenu(EPISODE_MENU);
}

// m_menu.c:873-885 — a live network game refuses replacement, Doom II skips
// episode selection, and Doom 1 keeps the episode menu.  `epi` remains zero in
// the commercial C path, so explicitly restore the JS port's 1-based equivalent
// before opening the skill menu.
function M_NewGame() {
  const route = M_NewGameRoute(netgame, demoplayback, gamemode);
  if (route === 'message') {
    M_StartMessage(NEWGAME, null, false);
    return;
  }
  if (route === 'skill') {
    _pendingEpisode = 1;
    pushMenu(SKILL_MENU);
    return;
  }
  _openEpisodeMenu();
}

// m_menu.c:324-332 — NewDef.lastOn starts on hurtme, not the first skill.
const SKILL_MENU = { name: 'Skill', x: 48, y: 63, lastOn: 2, items: [
  { patch: 'M_JKILL', label: "I'm too young to die.", alphaKey: M_ALPHA_KEYS.skill[0], action: () => _chooseSkill(0) },
  { patch: 'M_ROUGH', label: 'Hey, not too rough.', alphaKey: M_ALPHA_KEYS.skill[1], action: () => _chooseSkill(1) },
  { patch: 'M_HURT', label: 'Hurt me plenty.', alphaKey: M_ALPHA_KEYS.skill[2], action: () => _chooseSkill(2) },
  { patch: 'M_ULTRA', label: 'Ultra-Violence.', alphaKey: M_ALPHA_KEYS.skill[3], action: () => _chooseSkill(3) },
  { patch: 'M_NMARE', label: 'Nightmare!', alphaKey: M_ALPHA_KEYS.skill[4], action: () => _chooseSkill(4) },
]};
// m_menu.c:867-871 — New Game and Choose Skill headings.
SKILL_MENU.draw = (ctx, lx, ly, sx, sy) => {
  _drawPatchDoom(ctx, 'M_NEWG', 96, 14, lx, ly, sx, sy);
  _drawPatchDoom(ctx, 'M_SKILL', 54, 38, lx, ly, sx, sy);
};

// The browser menu intentionally omits the source OptionsDef "End Game" row;
// F7 still exposes that flow as a closed-menu shortcut. The remaining rows are
// compacted upward, while the two `status:-1` spacer rows (option_empty1/2)
// reserve the lines on which M_DrawOptions draws the screen-size and
// mouse-sensitivity thermos (one line BELOW each slider's label).
const OPTIONS_MENU = { name: 'Options', x: 60, y: 37, items: [
  { patch: 'M_MESSG', label: 'Messages', alphaKey: M_ALPHA_KEYS.options[0], action: () => HU_ToggleMessages() },
  { patch: 'M_DETAIL', label: 'Graphic Detail', alphaKey: M_ALPHA_KEYS.options[1], action: () => M_ChangeDetail() },
  { patch: 'M_SCRNSZ', label: 'Screen Size', alphaKey: M_ALPHA_KEYS.options[2], slider: true, get: () => getScreenSize(), set: (v) => M_SizeDisplay(v > getScreenSize() ? 1 : 0) },
  { spacer: true, alphaKey: M_ALPHA_KEYS.options[3] },
  { patch: 'M_MSENS', label: 'Mouse Sensitivity', alphaKey: M_ALPHA_KEYS.options[4], slider: true, get: () => mouseSensitivity, set: (v) => { set_mouseSensitivity(Math.max(0, Math.min(9, v | 0))); } },
  { spacer: true, alphaKey: M_ALPHA_KEYS.options[5] },
  { patch: 'M_SVOL', label: 'Sound Volume', alphaKey: M_ALPHA_KEYS.options[6], action: () => pushMenu(SOUND_MENU) },
]};
// Compacted row indices. Each thermo sits on the spacer row one line below its
// slider label, hence the `+ 1`.
const opt_messages = 0, opt_detail = 1, opt_scrnsize = 2, opt_mousesens = 4;
function M_ChangeDetail() { _detailLevel ^= 1; }
// m_menu.c:951-966 M_DrawOptions — title, on/off + hi/lo indicators, thermos.
OPTIONS_MENU.draw = (ctx, lx, ly, sx, sy) => {
  const x = OPTIONS_MENU.x, y = OPTIONS_MENU.y, LH = LINE_HEIGHT;
  _drawPatchDoom(ctx, 'M_OPTTTL', 108, 15, lx, ly, sx, sy);
  // detailNames[detailLevel] (0=high,1=low) beside the Graphic Detail label.
  _drawPatchDoom(ctx, _detailLevel === 0 ? 'M_GDHIGH' : 'M_GDLOW', x + 175, y + LH * opt_detail, lx, ly, sx, sy);
  // msgNames[showMessages] (0=off,1=on) beside the Messages label.
  _drawPatchDoom(ctx, showMessages === true ? 'M_MSGON' : 'M_MSGOFF', x + 120, y + LH * opt_messages, lx, ly, sx, sy);
  M_DrawThermo(ctx, x, y + LH * (opt_mousesens + 1), 10, mouseSensitivity, lx, ly, sx, sy);
  M_DrawThermo(ctx, x, y + LH * (opt_scrnsize  + 1),  9, getScreenSize(), lx, ly, sx, sy);
};

// m_menu.c:422-447 — SoundMenu also has spacer rows (sfx_empty1/2) holding the
// volume thermos (one line below each label).
const SOUND_MENU = { name: 'Sound', x: 80, y: 64, items: [
  { patch: 'M_SFXVOL', label: 'Sfx Volume', alphaKey: M_ALPHA_KEYS.sound[0], slider: true, get: () => sfxVolume, set: (v) => M_SetSfxVolume(v) },
  { spacer: true, alphaKey: M_ALPHA_KEYS.sound[1] },
  { patch: 'M_MUSVOL', label: 'Music Volume', alphaKey: M_ALPHA_KEYS.sound[2], slider: true, get: () => musicVolume, set: (v) => M_SetMusicVolume(v) },
  { spacer: true, alphaKey: M_ALPHA_KEYS.sound[3] },
]};
// m_menu.c:800-809 M_DrawSound — title + sfx/music thermos (width 16).
SOUND_MENU.draw = (ctx, lx, ly, sx, sy) => {
  const x = SOUND_MENU.x, y = SOUND_MENU.y, LH = LINE_HEIGHT;
  _drawPatchDoom(ctx, 'M_SVOL', 60, 38, lx, ly, sx, sy);
  M_DrawThermo(ctx, x, y + LH * 1, 16, sfxVolume,   lx, ly, sx, sy);  // sfx_vol+1
  M_DrawThermo(ctx, x, y + LH * 3, 16, musicVolume, lx, ly, sx, sy);  // music_vol+1
};

// Empty names match LoadMenu/SaveMenu in C: their draw routines render the
// bordered STCFN descriptions, while the generic item pass only advances rows.
const LOAD_MENU = { name: 'Load Game', x: 80, y: 54, items:
  Array.from({ length: SAVE_SLOTS }, (_, i) => ({
    patch: '', label: '', alphaKey: M_ALPHA_KEYS.slots[i],
    enabled: () => _loadSlotEnabled[i], action: () => M_LoadSelect(i),
  })),
};
LOAD_MENU.draw = (ctx, lx, ly, sx, sy) => M_DrawLoad(ctx, lx, ly, sx, sy);
const SAVE_MENU = { name: 'Save Game', x: 80, y: 54, items:
  Array.from({ length: SAVE_SLOTS }, (_, i) => ({
    patch: '', label: '', alphaKey: M_ALPHA_KEYS.slots[i],
    action: () => M_SaveSelect(i),
  })),
};
SAVE_MENU.draw = (ctx, lx, ly, sx, sy) => M_DrawSave(ctx, lx, ly, sx, sy);

const READ_MENU_1 = { name: 'Read This',
  get x() { return M_ReadThisPlan(gamemode).firstX; },
  get y() { return M_ReadThisPlan(gamemode).firstY; },
  get fullscreen() { return M_ReadThisPlan(gamemode).firstPatch; },
  items: [{ patch: '', label: '', alphaKey: 0, action: () => M_AdvanceReadThis() }],
};
const READ_MENU_2 = { name: 'Read This 2', x: 330, y: 175,
  get fullscreen() { return M_ReadThisPlan(gamemode).secondPatch; },
  items: [{ patch: '', label: '', alphaKey: 0, action: () => M_FinishReadThis() }],
};

// m_menu.c:M_Init changes commercial ReadDef1 into a one-page HELP screen.
// Other modes advance to ReadDef2; finishing always returns directly to MainDef.
function M_AdvanceReadThis() {
  if (M_ReadThisPlan(gamemode).firstAction === 'finish') M_FinishReadThis();
  else pushMenu(READ_MENU_2);
}

function M_FinishReadThis() {
  if (_currentMenu !== null) _currentMenu.lastOn = _selected;
  _currentMenu = MAIN_MENU;
  _menuStack = [];
  _restoreCursor(MAIN_MENU);
}

// m_menu.c:1536-1546 — F1 opens ReadDef2 directly for retail and ReadDef1 for
// every other mode. Preserve ReadDef2.prevMenu == ReadDef1 for retail Backspace.
function M_OpenHelpShortcut() {
  M_StartControlPanel();
  const plan = M_ReadThisPlan(gamemode);
  MAIN_MENU.lastOn = _selected;
  if (plan.shortcutPage === 'second') {
    _menuStack = [READ_MENU_1];
    _currentMenu = READ_MENU_2;
  } else {
    _menuStack = [MAIN_MENU];
    _currentMenu = READ_MENU_1;
  }
  _restoreCursor(_currentMenu);
}

// m_menu.c:M_SfxVol/M_MusicVol apply each slider step immediately through the
// sound module. Keeping these setters exported also gives config/UI code one
// path that cannot leave the displayed and effective volumes out of sync.
export function M_SetSfxVolume(value) {
  const volume = Math.max(0, Math.min(15, value | 0));
  S_ApplySfxVolume(volume);
  return volume;
}
export function M_SetMusicVolume(value) {
  const volume = Math.max(0, Math.min(15, value | 0));
  S_ApplyMusicVolume(volume);
  return volume;
}

// ---------- Modal message prompt ----------
let _message = null;    // { text, routine, input, tapKey, lastMenuActive }
let _saveStringEnter = false;
let _saveEditingSlot = -1;
let _saveOldString = EMPTYSTRING;
let _quickSaveSlot = QUICK_SAVE_NONE;

export function M_StartMessage(text, routine, input, tapKey = null) {
  _message = {
    text,
    routine,
    input: input === true,
    tapKey,
    lastMenuActive: menuactive,
  };
  set_menuactive(true);
}
export function M_StopMessage() {
  if (_message !== null) set_menuactive(_message.lastMenuActive);
  _message = null;
}

function dismissMessage(key) {
  const message = _message;
  if (message === null) return false;
  set_menuactive(message.lastMenuActive);
  _message = null;
  message.routine?.(key);
  // Vanilla closes the control panel after every message dismissal, even
  // when the message was opened from an active submenu.
  set_menuactive(false);
  S_StartSound(null, sfx_swtchx);
  return true;
}

// d_main owns the attract-loop state. Wire its synchronous title entry point
// when D_DoomLoop wires the other menu callbacks, avoiding a d_main <-> m_menu
// static import cycle or a mutable global function.
let _startTitle = null;
let _listSaves = () => [];
export function M_SetExternals(refs) {
  if (typeof refs?.D_StartTitle === 'function') _startTitle = refs.D_StartTitle;
  if (typeof refs?.listSaves === 'function') _listSaves = refs.listSaves;
}

// m_menu.c:996-1022 — only a lowercase Y ends the game. M_Responder closes
// every dismissed message after invoking its callback, matching the C flow.
function M_EndGameResponse(key) {
  if (key !== 0x79 /*y*/) return;
  if (_currentMenu !== null) _currentMenu.lastOn = _selected;
  M_ClearMenus();
  if (_startTitle === null) throw new Error('M_EndGame: D_StartTitle is not wired');
  _startTitle();
}

function M_EndGame() {
  const route = M_EndGameRoute(usergame, netgame);
  if (route === 'inactive') {
    S_StartSound(null, sfx_oof);
    return;
  }
  if (route === 'netgame') {
    M_StartMessage(NETEND, null, false);
    return;
  }
  M_StartMessage(ENDGAME, M_EndGameResponse, true);
}

// ---------- Navigation ----------
// m_menu.c:166 menu_t.lastOn — each menu remembers the cursor position the user
// was last on. M_SetupNextMenu restores it on entry; the key handlers save it on
// exit. We mirror that by stashing/restoring `lastOn` on the menu objects across
// push/pop, so backing out lands on the row you descended from (default 0).
function _rememberCursor(m) {
  m.lastOn = _selected;
  if (m === MAIN_MENU) m.lastItemKey = m.items[_selected]?.menuKey ?? null;
}
function _restoreCursor(m) {
  if (m === MAIN_MENU) {
    _selected = M_RestoreMainCursor(
      m.items.map((item) => item.menuKey),
      m.lastItemKey,
      m.lastOn,
    );
    // Normalize an unavailable browser-only/mode-specific row to the item
    // actually selected, so it cannot unexpectedly reappear on a later open.
    m.lastOn = _selected;
    m.lastItemKey = m.items[_selected]?.menuKey ?? null;
    return;
  }
  _selected = (m.lastOn === undefined) ? 0 : m.lastOn;
}
function pushMenu(m) { _rememberCursor(_currentMenu); _menuStack.push(_currentMenu); _currentMenu = m; _restoreCursor(m); }
function popMenu()   { _rememberCursor(_currentMenu); const prev = _menuStack.pop(); _currentMenu = (prev === undefined) ? MAIN_MENU : prev; _restoreCursor(_currentMenu); }
// m_menu.c:1686-1693 — Backspace backs out one level, playing sfx_swtchn only
// when there was a parent to pop to. Touch uses this as its mobile stand-in.
function M_Back() {
  const hadPrev = _menuStack.length > 0;
  popMenu();
  if (hadPrev === true) S_StartSound(null, sfx_swtchn);
  return hadPrev;
}
// m_menu.c:1624-1642 — move the cursor by `delta`, skipping spacer rows (status:-1).
function _moveCursor(m, delta) {
  const n = m.items.length;
  do { _selected = (_selected + delta + n) % n; } while (m.items[_selected].spacer === true);
  // m_menu.c:1630/1640 — cursor move plays sfx_pstop.
  S_StartSound(null, sfx_pstop);
}

function _chooseEpisode(ep) {
  if (gamemode === GameMode_t.shareware && ep > 1) {
    M_StartMessage('This is the shareware version of DOOM.\nYou need to order to play three more episodes.\n\n(Press y to order)\n(Press n to cancel)', null, false);
    return;
  }
  _pendingEpisode = ep;
  pushMenu(SKILL_MENU);
}

let _pendingEpisode = 1;
function _chooseSkill(skill) {
  if (skill === 4) {
    M_StartMessage('Are you sure? This skill level\nisn\'t even remotely fair.\n\n(Press y to confirm)', (key) => {
      if (key === 0x79 /*y*/) _doStart(skill);
    }, true);
    return;
  }
  _doStart(skill);
}
function _doStart(skill) {
  G_DeferedInitNew(skill, _pendingEpisode, 1);
  M_ClearMenus();
  D_AcquirePointerLock();
}

function M_ReadSaveStrings() {
  let records = [];
  try { records = _listSaves(); } catch (_) { records = []; }
  const slots = M_NormalizeSaveSlots(records);
  for (let i = 0; i < SAVE_SLOTS; i++) {
    _saveStrings[i] = slots[i].description;
    _loadSlotEnabled[i] = slots[i].occupied;
  }
}

function M_LoadSelect(slot) {
  G_QueueLoadGame(slot);
  M_ClearMenus();
}

function M_LoadGame() {
  if (netgame === true) {
    M_StartMessage(LOADNET, null, false);
    return;
  }
  pushMenu(LOAD_MENU);
  M_ReadSaveStrings();
}

function M_DoSave(slot) {
  G_QueueSaveGame(slot, _saveStrings[slot]);
  M_ClearMenus();
  if (_quickSaveSlot === QUICK_SAVE_PICKING) _quickSaveSlot = slot;
}

function M_SaveSelect(slot) {
  const edit = M_BeginSaveEdit(_saveStrings[slot]);
  _saveStringEnter = true;
  _saveEditingSlot = slot;
  _saveOldString = edit.oldText;
  _saveStrings[slot] = edit.text;
}

function M_SaveGame() {
  if (usergame !== true) {
    M_StartMessage(SAVEDEAD, null, false);
    return;
  }
  if (gamestate !== 0 /*GS_LEVEL*/) return;
  pushMenu(SAVE_MENU);
  M_ReadSaveStrings();
}

function M_QuickSaveResponse(key) {
  if (key !== 0x79 /*y*/) return;
  M_DoSave(_quickSaveSlot);
  // The outer message-dismiss path plays the same sound again, matching C.
  S_StartSound(null, sfx_swtchx);
}

function M_QuickSave() {
  switch (M_QuickSaveRoute(usergame, gamestate, _quickSaveSlot)) {
    case 'inactive':
      S_StartSound(null, sfx_oof);
      return;
    case 'nonlevel':
      return;
    case 'pick':
      M_StartControlPanel(false);
      M_ReadSaveStrings();
      pushMenu(SAVE_MENU);
      _quickSaveSlot = QUICK_SAVE_PICKING;
      return;
    case 'confirm':
      M_StartMessage(
        M_FormatSavePrompt(QSPROMPT, _saveStrings[_quickSaveSlot]),
        M_QuickSaveResponse,
        true,
      );
      return;
  }
}

function M_QuickLoadResponse(key) {
  if (key !== 0x79 /*y*/) return;
  M_LoadSelect(_quickSaveSlot);
  // The outer message-dismiss path plays the same sound again, matching C.
  S_StartSound(null, sfx_swtchx);
}

function M_QuickLoad() {
  switch (M_QuickLoadRoute(netgame, _quickSaveSlot)) {
    case 'netgame':
      M_StartMessage(QLOADNET, null, false);
      return;
    case 'no-slot':
      M_StartMessage(QSAVESPOT, null, false);
      return;
    case 'confirm':
      M_StartMessage(
        M_FormatSavePrompt(QLPROMPT, _saveStrings[_quickSaveSlot]),
        M_QuickLoadResponse,
        true,
      );
      return;
  }
}

// ---------- Quit ----------
const _quitLinkState = { linkOpened: false };
function M_QuitResponse(key) {
  M_ConfirmQuit(
    key,
    _quitLinkState,
    (...args) => globalThis.open?.(...args),
    I_Quit,
  );
}
function M_QuitDOOM() {
  // m_menu.c:1105 — deterministic by gametic so it's reproducible per session.
  M_StartMessage(
    M_QuitMessageForTic(gametic) + '\n\n(Press y or click to quit)',
    M_QuitResponse,
    true,
    QUIT_CONFIRM_KEY,
  );
}

// ---------- Lifecycle ----------
export function M_Init() {
  _menuStack = [];
  _currentMenu = MAIN_MENU;
  MAIN_MENU.y = M_ReadThisPlan(gamemode).mainY;
  // MainDef.lastOn is statically zero before the one real startup M_Init.
  // Reset both representations as well so an explicit browser re-init is a
  // fresh menu lifecycle rather than retaining state from an earlier run.
  MAIN_MENU.lastOn = 0;
  MAIN_MENU.lastItemKey = null;
  _selected = 0;
  _skullFrame = 0;
  _skullTicker = 0;
  _saveStringEnter = false;
  _saveEditingSlot = -1;
  _saveOldString = EMPTYSTRING;
  _quickSaveSlot = QUICK_SAVE_NONE;
}
export function M_StartControlPanel(playOpenSound = true) {
  if (menuactive) return;
  set_menuactive(true);
  // Continue is only meaningful when the user has started a game — i.e. a
  // level is active AND it isn't a title-screen demo playing in the
  // background.
  const inUserGame = gamestate === 0 /*GS_LEVEL*/ && demoplayback !== true;
  const plan = M_ReadThisPlan(gamemode, inUserGame);
  MAIN_MENU.items = plan.mainItems.map((name) => MAIN_MENU_ITEMS[name]);
  MAIN_MENU.y = plan.mainY;
  _currentMenu = MAIN_MENU;
  _menuStack = [];
  // m_menu.c:1729-1731 restores MainDef.lastOn whenever the panel opens. The
  // browser's row list is dynamic, so restore the remembered semantic item
  // rather than applying a stale numeric index to a different layout.
  _restoreCursor(MAIN_MENU);
  // m_menu.c:1614 — opening the control panel plays sfx_swtchn. Placed here
  // (rather than at each call site, as vanilla does) so every ordinary open
  // path — ESC, a title-screen key, pointer-lock loss — gets it. F4 suppresses
  // this until after SoundDef is installed to preserve its source call order.
  if (playOpenSound === true) S_StartSound(null, sfx_swtchn);
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
function M_HandleSaveStringKey(key) {
  const slot = _saveEditingSlot;
  if (slot < 0 || slot >= SAVE_SLOTS) {
    _saveStringEnter = false;
    return true;
  }
  const result = M_ApplySaveEditKey(
    _saveStrings[slot],
    _saveOldString,
    key,
    (text) => HU_TextWidth(text, HU_GetFont()),
  );
  _saveStrings[slot] = result.text;
  if (result.kind === 'editing') return true;

  _saveStringEnter = false;
  _saveEditingSlot = -1;
  if (result.kind === 'finish' && result.save === true) M_DoSave(slot);
  return true;
}

export function M_Responder(ev) {
  if (ev === undefined || ev === null) return false;
  if (ev.type !== 0 /*ev_keydown*/) return false;
  const key = ev.data1;
  // m_menu.c:1452 — save-name entry owns every key before messages, function
  // keys, and ordinary menu navigation.
  if (_saveStringEnter === true) return M_HandleSaveStringKey(key);
  // m_menu.c:1494-1512 — informational messages dismiss on any key. Prompts
  // that need input accept only Space/N/Y/Escape; every other key falls
  // through to the remaining responders.
  if (_message !== null) {
    if (M_MessageAcceptsKey(_message.input, key) !== true) return false;
    return dismissMessage(key);
  }
  // m_menu.c:1522-1534 — closed-map +/- are global view-size shortcuts.
  // When automap is active M_Responder declines them so AM_Responder can zoom.
  if (menuactive !== true && automapactive !== true &&
      (key === KEY_MINUS || key === KEY_EQUALS || key === 0x2b /*numpad +*/)) {
    M_SizeDisplay(key === KEY_MINUS ? 0 : 1);
    S_StartSound(null, sfx_stnmov);
    return true;
  }
  // m_menu.c:1548-1595 — closed-menu function-key actions and sound order.
  if (menuactive !== true) {
    switch (M_ClosedShortcutRoute(key)) {
      case 'save':
        M_StartControlPanel(false);
        S_StartSound(null, sfx_swtchn);
        M_SaveGame();
        return true;
      case 'load':
        M_StartControlPanel(false);
        S_StartSound(null, sfx_swtchn);
        M_LoadGame();
        return true;
      case 'sound':
        // SoundDef's source parent is OptionsDef, and F4 always starts on
        // sfx_vol. Install that state before the one switch-on sound.
        M_StartControlPanel(false);
        _currentMenu = SOUND_MENU;
        _menuStack = [OPTIONS_MENU];
        _selected = 0;
        S_StartSound(null, sfx_swtchn);
        return true;
      case 'detail':
        M_ChangeDetail();
        S_StartSound(null, sfx_swtchn);
        return true;
      case 'quicksave':
        S_StartSound(null, sfx_swtchn);
        M_QuickSave();
        return true;
      case 'endgame':
        S_StartSound(null, sfx_swtchn);
        M_EndGame();
        return true;
      case 'messages':
        HU_ToggleMessages();
        S_StartSound(null, sfx_swtchn);
        return true;
      case 'quickload':
        S_StartSound(null, sfx_swtchn);
        M_QuickLoad();
        return true;
      case 'quit':
        S_StartSound(null, sfx_swtchn);
        M_QuitDOOM();
        return true;
    }
  }
  // m_menu.c:1597-1603 — F11 is a global shortcut while the menu is closed.
  // Re-uploading PLAYPAL resets the active damage/bonus palette just like the
  // original I_SetPalette call; ST_doPaletteStuff can select it again next tic.
  if (key === KEY_F11 && menuactive !== true) {
    const gamma = (usegamma + 1) % gammatable.length;
    set_usegamma(gamma);
    const player = players[consoleplayer];
    if (player !== null && player !== undefined) player.message = GAMMA_MESSAGES[gamma];
    I_SetPalette(W_CacheLumpName('PLAYPAL', 0));
    return true;
  }
  if (key === KEY_F1 && menuactive !== true) {
    M_OpenHelpShortcut();
    return true;
  }
  if (key === KEY_ESCAPE) {
    // m_menu.c:1608-1617,1680-1684 — Escape opens a closed panel, but always
    // closes an active panel regardless of its current submenu. The open path
    // plays sfx_swtchn inside M_StartControlPanel in this port.
    if (menuactive !== true) { M_StartControlPanel(); return true; }
    if (_currentMenu !== null) _rememberCursor(_currentMenu);
    M_ClearMenus();
    S_StartSound(null, sfx_swtchx);
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
    if (it.slider === true) {
      _rememberCursor(m);
      it.set(it.get() + 1);
      S_StartSound(null, sfx_stnmov);
    } else if (it.action != null &&
               (typeof it.enabled !== 'function' || it.enabled() === true)) {
      _rememberCursor(m);
      it.action();
      S_StartSound(null, sfx_pistol);
    }
    return true;
  }
  // doomdef.h:KEY_BACKSPACE = 127 — d_keyboard sends 127 for Backspace per
  // the vanilla mapping.
  if (key === KEY_BACKSPACE) {
    // m_menu.c:1686-1693 — back out one level.
    M_Back();
    return true;
  }
  const alphaItem = M_FindAlphaItem(m.items, _selected, key);
  if (alphaItem !== -1) {
    _selected = alphaItem;
    S_StartSound(null, sfx_pstop);
    return true;
  }
  return false;
}

// Touch/pointer tap handling for mobile. (px,py) are overlay window pixels;
// returns true when the tap was consumed.
export function M_HandleTap(px, py) {
  if (menuactive !== true) return false;
  // Native maps the primary mouse button to Enter before saveStringEnter is
  // handled. A follow-up tap therefore commits the edited description.
  if (_saveStringEnter === true) return M_HandleSaveStringKey(KEY_ENTER);
  // Prompts remain keyboard-only unless their call site explicitly assigns a
  // tap key. Quit maps a tap to lowercase Y so touch users can confirm it.
  if (_message !== null) {
    if (_message.tapKey === null) return true;
    return dismissMessage(_message.tapKey);
  }
  const m = _currentMenu;
  if (m === null || _lastLayout === null) return true;
  const { lx, ly, sx, sy } = _lastLayout;
  // Window pixels → Doom 320x200 menu space.
  const dx = (px - lx) / sx;
  const dy = (py - ly) / sy;
  // Help pages advance on a tap anywhere ("any key").
  if (m.fullscreen) {
    const it = m.items[0];
    if (it !== undefined && it.action != null) { it.action(); S_StartSound(null, sfx_pistol); }
    return true;
  }
  // A tap off the rows backs out one level (closing at the root) — the
  // touch stand-in for ESC, which mobile users have no key for.
  const row = (dx < 0 || dx > 320) ? -1 : Math.floor((dy - m.y) / LINE_HEIGHT);
  if (row < 0 || row >= m.items.length) {
    if (M_Back() !== true) { M_ClearMenus(); S_StartSound(null, sfx_swtchx); }
    return true;
  }
  let idx = row;
  let it = m.items[idx];
  // A slider's thermo sits on the spacer row below its label — redirect there.
  if (it.spacer === true && idx > 0 && m.items[idx - 1].slider === true) {
    idx -= 1; it = m.items[idx];
  }
  if (it.spacer === true) return true;
  if (idx !== _selected) { _selected = idx; S_StartSound(null, sfx_pstop); }
  if (it.slider === true) {
    _rememberCursor(m);
    // Knob is at doom-x (m.x + 8) + value*8; tap left lowers, right raises.
    const knobX = m.x + 8 + it.get() * 8 + 4;
    it.set(dx < knobX ? it.get() - 1 : it.get() + 1);
    S_StartSound(null, sfx_stnmov);
  } else if (it.action != null &&
             (typeof it.enabled !== 'function' || it.enabled() === true)) {
    _rememberCursor(m);
    it.action();
    S_StartSound(null, sfx_pistol);
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

// m_menu.c:559-572 — the description box is one left cap, 24 center cells,
// and one right cap. Patch origins are honored by _drawPatchDoom.
function M_DrawSaveLoadBorder(ctx, x, y, lx, ly, sx, sy) {
  _drawPatchDoom(ctx, 'M_LSLEFT', x - 8, y + 7, lx, ly, sx, sy);
  for (let i = 0; i < 24; i++) {
    _drawPatchDoom(ctx, 'M_LSCNTR', x + i * 8, y + 7, lx, ly, sx, sy);
  }
  _drawPatchDoom(ctx, 'M_LSRGHT', x + 24 * 8, y + 7, lx, ly, sx, sy);
}

function M_DrawMenuText(ctx, text, x, y, lx, ly, sx, sy) {
  HU_DrawLayout(
    ctx,
    HU_LayoutText(text, HU_GetFont(), { x, y }),
    lx,
    ly,
    sx,
    sy,
  );
}

function M_DrawLoad(ctx, lx, ly, sx, sy) {
  _drawPatchDoom(ctx, 'M_LOADG', 72, 28, lx, ly, sx, sy);
  for (let i = 0; i < SAVE_SLOTS; i++) {
    const y = LOAD_MENU.y + LINE_HEIGHT * i;
    M_DrawSaveLoadBorder(ctx, LOAD_MENU.x, y, lx, ly, sx, sy);
    M_DrawMenuText(ctx, _saveStrings[i], LOAD_MENU.x, y, lx, ly, sx, sy);
  }
}

function M_DrawSave(ctx, lx, ly, sx, sy) {
  _drawPatchDoom(ctx, 'M_SAVEG', 72, 28, lx, ly, sx, sy);
  for (let i = 0; i < SAVE_SLOTS; i++) {
    const y = SAVE_MENU.y + LINE_HEIGHT * i;
    M_DrawSaveLoadBorder(ctx, SAVE_MENU.x, y, lx, ly, sx, sy);
    M_DrawMenuText(ctx, _saveStrings[i], SAVE_MENU.x, y, lx, ly, sx, sy);
  }
  if (_saveStringEnter === true && _saveEditingSlot >= 0) {
    const text = _saveStrings[_saveEditingSlot];
    M_DrawMenuText(
      ctx,
      '_',
      SAVE_MENU.x + HU_TextWidth(text, HU_GetFont()),
      SAVE_MENU.y + LINE_HEIGHT * _saveEditingSlot,
      lx,
      ly,
      sx,
      sy,
    );
  }
}

export function M_Drawer(overlayCtx, dstX, dstY, dstW, dstH) {
  // m_menu.c:1752-1779 — a modal message replaces the menu drawer completely.
  // Draw only its centered STCFN text, even when the underlying menu was open.
  if (_message !== null) {
    drawMessage(overlayCtx, dstX, dstY, dstW, dstH);
    return;
  }
  if (!menuactive) return;
  if (_currentMenu === null) return;
  const m = _currentMenu;
  // Letterbox the menu layout to a 4:3 box centered in the passed area so
  // patches and items don't stretch with window aspect. Vanilla draws the
  // menu patches directly over the current screen; it does not dim the
  // background (m_menu.c:M_Drawer).
  const scale = Math.min(dstW / 320, dstH / 200);
  const sx = scale, sy = scale;
  const lx = dstX + (dstW - 320 * scale) * 0.5;
  const ly = dstY + (dstH - 200 * scale) * 0.5;
  _lastLayout = { lx, ly, sx, sy };
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
      overlayCtx.fillStyle = V_PaletteCSS(6 * 16 + 8);
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
    overlayCtx.fillStyle = V_PaletteCSS(256 - 32 + 7);
    overlayCtx.font = `bold ${Math.round(14 * sy)}px monospace`;
    overlayCtx.fillText('►', lx + (baseX - 16) * sx, ly + (baseY + 12 + _selected * LINE_HEIGHT) * sy);
  }
}

function drawMessage(ctx, dstX, dstY, dstW, dstH) {
  // M_WriteText uses the same STCFN patches as the HUD. Keep the current
  // framebuffer visible and map Doom's 320x200 coordinates into its centered
  // 4:3 presentation box.
  const scale = Math.min(dstW / 320, dstH / 200);
  const lx = dstX + (dstW - 320 * scale) * 0.5;
  const ly = dstY + (dstH - 200 * scale) * 0.5;
  HU_DrawLayout(ctx, M_LayoutMessage(_message.text, HU_GetFont()), lx, ly, scale, scale);
}

// ---------- API expected by g_game.js ----------
// m_menu.c:1152 — M_SizeDisplay. Slider LEFT (choice=0) shrinks the view
// (decrement screenSize/screenblocks); RIGHT (choice=1) grows it. The
// vanilla bounds are screenSize in [0,8] mapping to screenblocks in [3,11].
// Once we reach the top, screenblocks=11 hides the bar in first-person view;
// an active automap still forces it on in ST_Ticker/ST_Drawer.
export function M_SizeDisplay(choice) {
  let blocks = R_GetScreenblocks();
  if (choice === 0) {
    if (blocks > 3) blocks--;
  } else if (choice === 1) {
    if (blocks < 11) blocks++;
  }
  R_SetViewSize(blocks);
}
