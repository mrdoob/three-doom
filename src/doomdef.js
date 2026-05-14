// Ported from: linuxdoom-1.10/doomdef.h
// Internally used data structures for virtually everything, key definitions, etc.

export const VERSION = 110;

// Game mode handling - identify IWAD version
export const GameMode_t = Object.freeze({
  shareware:    0,
  registered:   1,
  commercial:   2,
  retail:       3,
  indetermined: 4,
});

// Mission packs
export const GameMission_t = Object.freeze({
  doom:      0,
  doom2:     1,
  pack_tnt:  2,
  pack_plut: 3,
  none:      4,
});

// Language
export const Language_t = Object.freeze({
  english: 0,
  french:  1,
  german:  2,
  unknown: 3,
});

export const RANGECHECK = true;

export const BASE_WIDTH       = 320;
export const SCREEN_MUL       = 1;
export const INV_ASPECT_RATIO = 0.625;
export const SCREENWIDTH      = 320;
export const SCREENHEIGHT     = 200;

// Multiplayer cap (kept for struct sizing — single-player port uses 1 active).
export const MAXPLAYERS = 4;

// State updates, number of tics / second.
export const TICRATE = 35;

// The current state of the game.
export const gamestate_t = Object.freeze({
  GS_LEVEL:        0,
  GS_INTERMISSION: 1,
  GS_FINALE:       2,
  GS_DEMOSCREEN:   3,
});

// Skill flags for map things.
export const MTF_EASY   = 1;
export const MTF_NORMAL = 2;
export const MTF_HARD   = 4;
export const MTF_AMBUSH = 8;

// Skill levels.
export const skill_t = Object.freeze({
  sk_baby:      0,
  sk_easy:      1,
  sk_medium:    2,
  sk_hard:      3,
  sk_nightmare: 4,
});

// Key cards.
export const card_t = Object.freeze({
  it_bluecard:   0,
  it_yellowcard: 1,
  it_redcard:    2,
  it_blueskull:  3,
  it_yellowskull:4,
  it_redskull:   5,
  NUMCARDS:      6,
});
export const NUMCARDS = 6;

// Weapons.
export const weapontype_t = Object.freeze({
  wp_fist:         0,
  wp_pistol:       1,
  wp_shotgun:      2,
  wp_chaingun:     3,
  wp_missile:      4,
  wp_plasma:       5,
  wp_bfg:          6,
  wp_chainsaw:     7,
  wp_supershotgun: 8,
  NUMWEAPONS:      9,
  wp_nochange:     10,
});
export const NUMWEAPONS = 9;

// Ammunition.
export const ammotype_t = Object.freeze({
  am_clip:  0,
  am_shell: 1,
  am_cell:  2,
  am_misl:  3,
  NUMAMMO:  4,
  am_noammo:5,
});
export const NUMAMMO = 4;

// Power up artifacts.
export const powertype_t = Object.freeze({
  pw_invulnerability: 0,
  pw_strength:        1,
  pw_invisibility:    2,
  pw_ironfeet:        3,
  pw_allmap:          4,
  pw_infrared:        5,
  NUMPOWERS:          6,
});
export const NUMPOWERS = 6;

// Power up durations (in tics; TICRATE = 35).
export const INVULNTICS = 30  * TICRATE;
export const INVISTICS  = 60  * TICRATE;
export const INFRATICS  = 120 * TICRATE;
export const IRONTICS   = 60  * TICRATE;

// DOOM keyboard definition.
export const KEY_RIGHTARROW = 0xae;
export const KEY_LEFTARROW  = 0xac;
export const KEY_UPARROW    = 0xad;
export const KEY_DOWNARROW  = 0xaf;
export const KEY_ESCAPE     = 27;
export const KEY_ENTER      = 13;
export const KEY_TAB        = 9;
export const KEY_F1  = 0x80 + 0x3b;
export const KEY_F2  = 0x80 + 0x3c;
export const KEY_F3  = 0x80 + 0x3d;
export const KEY_F4  = 0x80 + 0x3e;
export const KEY_F5  = 0x80 + 0x3f;
export const KEY_F6  = 0x80 + 0x40;
export const KEY_F7  = 0x80 + 0x41;
export const KEY_F8  = 0x80 + 0x42;
export const KEY_F9  = 0x80 + 0x43;
export const KEY_F10 = 0x80 + 0x44;
export const KEY_F11 = 0x80 + 0x57;
export const KEY_F12 = 0x80 + 0x58;

export const KEY_BACKSPACE = 127;
export const KEY_PAUSE     = 0xff;

export const KEY_EQUALS = 0x3d;
export const KEY_MINUS  = 0x2d;

export const KEY_RSHIFT = 0x80 + 0x36;
export const KEY_RCTRL  = 0x80 + 0x1d;
export const KEY_RALT   = 0x80 + 0x38;
export const KEY_LALT   = KEY_RALT;
