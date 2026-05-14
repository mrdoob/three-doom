// Ported from: linuxdoom-1.10/d_event.h
// Event types, button codes, game action enum.

export const evtype_t = Object.freeze({
  ev_keydown: 0,
  ev_keyup:   1,
  ev_mouse:   2,
  ev_joystick:3,
});

export const gameaction_t = Object.freeze({
  ga_nothing:    0,
  ga_loadlevel:  1,
  ga_newgame:    2,
  ga_loadgame:   3,
  ga_savegame:   4,
  ga_playdemo:   5,
  ga_completed:  6,
  ga_victory:    7,
  ga_worlddone:  8,
  ga_screenshot: 9,
});

// Buttons in ticcmd_t.buttons.
export const BT_ATTACK      = 1;
export const BT_USE         = 2;
export const BT_SPECIAL     = 128;
export const BT_SPECIALMASK = 3;
export const BT_CHANGE      = 4;
export const BT_WEAPONMASK  = 8 + 16 + 32;
export const BT_WEAPONSHIFT = 3;

export const BTS_PAUSE     = 1;
export const BTS_SAVEGAME  = 2;
export const BTS_SAVEMASK  = 4 + 8 + 16;
export const BTS_SAVESHIFT = 2;

export const MAXEVENTS = 64;

// Event ring buffer (declared here, consumed by D_ProcessEvents in d_main.js).
export const events = new Array(MAXEVENTS);
for (let i = 0; i < MAXEVENTS; i++) {
  events[i] = { type: 0, data1: 0, data2: 0, data3: 0 };
}
export let eventhead = 0;
export let eventtail = 0;
export function set_eventhead(v) { eventhead = v; }
export function set_eventtail(v) { eventtail = v; }

export function D_PostEvent(ev) {
  const slot = events[eventhead];
  slot.type  = ev.type;
  slot.data1 = ev.data1;
  slot.data2 = ev.data2;
  slot.data3 = ev.data3;
  eventhead = (eventhead + 1) & (MAXEVENTS - 1);
}

export let gameaction = gameaction_t.ga_nothing;
export function set_gameaction(v) { gameaction = v; }
