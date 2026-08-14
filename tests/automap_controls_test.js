import {
  KEY_EQUALS, KEY_LEFTARROW, KEY_MINUS, KEY_RIGHTARROW,
} from '../src/doomdef.js';
import { evtype_t } from '../src/d_event.js';
import { FixedDiv, FixedMul, FRACUNIT } from '../src/m_fixed.js';
import { MAXINT } from '../src/doomtype.js';
import {
  AM_ApplyControlEvent, AM_CalculateLevelBounds, AM_CreateViewState,
  AM_FRAME_HEIGHT, AM_FRAME_WIDTH, AM_INITIAL_SCALE_DIVISOR,
  AM_PAN_PIXELS, AM_ResetHeldControls, AM_TickViewState, AM_ZOOM_IN, AM_ZOOM_OUT,
} from '../src/am_map_logic.js';

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function rectangleVertices() {
  return [
    { x: -100 * FRACUNIT, y: -50 * FRACUNIT },
    { x:  100 * FRACUNIT, y:  50 * FRACUNIT },
    { x:  100 * FRACUNIT, y: -50 * FRACUNIT },
    { x: -100 * FRACUNIT, y:  50 * FRACUNIT },
  ];
}

const keyEvent = (type, data1) => ({ type, data1 });

Deno.test('automap scale limits come from the 320x168 window and map vertices', () => {
  const bounds = AM_CalculateLevelBounds(rectangleVertices());
  const expectedMin = Math.min(
    FixedDiv(AM_FRAME_WIDTH * FRACUNIT, 200 * FRACUNIT),
    FixedDiv(AM_FRAME_HEIGHT * FRACUNIT, 100 * FRACUNIT),
  );
  assertEquals(bounds.minX, -100 * FRACUNIT, 'minimum x');
  assertEquals(bounds.maxY, 50 * FRACUNIT, 'maximum y');
  assertEquals(bounds.minScaleMtof, expectedMin, 'minimum scale');
  assertEquals(bounds.maxScaleMtof, FixedDiv(168 * FRACUNIT, 32 * FRACUNIT), 'maximum scale');
  assertEquals(
    bounds.initialScaleMtof,
    FixedDiv(expectedMin, AM_INITIAL_SCALE_DIVISOR),
    'initial 0.7 inset scale',
  );
});

Deno.test('follow-mode arrows filter through, while free-map arrows pan until keyup', () => {
  let state = AM_CreateViewState(rectangleVertices(), { x: 0, y: 0 });
  const followed = AM_ApplyControlEvent(
    state,
    keyEvent(evtype_t.ev_keydown, KEY_RIGHTARROW),
  );
  assertEquals(followed.handled, false, 'follow arrow ownership');
  assertEquals(followed.state.panX, 0, 'follow arrow pan');

  let response = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, 0x66));
  state = response.state;
  assertEquals(response.message, 'followOff', 'follow-off message');
  response = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, KEY_RIGHTARROW));
  state = response.state;
  assertEquals(response.handled, true, 'free-map arrow ownership');
  assertEquals(
    state.panX,
    FixedMul(AM_PAN_PIXELS * FRACUNIT, state.scaleFtom),
    'four-frame-pixel pan increment',
  );
  const beforeX = state.mX;
  state = AM_TickViewState(state, { x: 0, y: 0 });
  assertEquals(state.mX, beforeX + state.panX, 'held arrow pans once per tic');
  response = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keyup, KEY_RIGHTARROW));
  assertEquals(response.handled, false, 'arrow release filters down');
  assertEquals(response.state.panX, 0, 'arrow release stops panning');

  // Opposite arrow replaces the axis increment, as in the single m_paninc.
  response = AM_ApplyControlEvent(response.state, keyEvent(evtype_t.ev_keydown, KEY_LEFTARROW));
  assertEquals(response.state.panX < 0, true, 'left pan direction');
});

Deno.test('zoom multipliers apply on every ticker and stop on filtering keyup', () => {
  let state = AM_CreateViewState(rectangleVertices(), { x: 0, y: 0 });
  const initial = state.scaleMtof;
  let response = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, KEY_EQUALS));
  state = response.state;
  assertEquals(response.handled, true, 'zoom-in key ownership');
  assertEquals(state.zoomMtof, AM_ZOOM_IN, 'truncated zoom-in multiplier');
  state = AM_TickViewState(state, { x: 0, y: 0 });
  assertEquals(state.scaleMtof, FixedMul(initial, AM_ZOOM_IN), 'first held zoom tic');
  const once = state.scaleMtof;
  state = AM_TickViewState(state, { x: 0, y: 0 });
  assertEquals(state.scaleMtof, FixedMul(once, AM_ZOOM_IN), 'second held zoom tic');
  response = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keyup, KEY_EQUALS));
  assertEquals(response.handled, false, 'zoom release filters down');
  const released = response.state.scaleMtof;
  state = AM_TickViewState(response.state, { x: 0, y: 0 });
  assertEquals(state.scaleMtof, released, 'released zoom stays fixed');

  response = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, KEY_MINUS));
  state = response.state;
  assertEquals(state.zoomMtof, AM_ZOOM_OUT, 'truncated zoom-out multiplier');
  for (let i = 0; i < 500; i++) state = AM_TickViewState(state, { x: 0, y: 0 });
  assertEquals(state.scaleMtof, state.minScaleMtof, 'zoom-out lower bound');
  state = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keyup, KEY_MINUS)).state;
  state = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, KEY_EQUALS)).state;
  for (let i = 0; i < 500; i++) state = AM_TickViewState(state, { x: 0, y: 0 });
  assertEquals(state.scaleMtof, state.maxScaleMtof, 'zoom-in upper bound');
});

Deno.test('automap held-control reset preserves the current view', () => {
  let state = AM_CreateViewState(rectangleVertices(), { x: 0, y: 0 });
  state = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, 0x66)).state;
  state = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, KEY_RIGHTARROW)).state;
  state = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, KEY_EQUALS)).state;
  assertEquals(state.panX !== 0, true, 'pan staged');
  assertEquals(state.zoomMtof !== FRACUNIT, true, 'zoom staged');

  const before = {
    mX: state.mX,
    mY: state.mY,
    mW: state.mW,
    mH: state.mH,
    scaleMtof: state.scaleMtof,
    scaleFtom: state.scaleFtom,
    followPlayer: state.followPlayer,
    grid: state.grid,
  };
  state = AM_ResetHeldControls(state);
  assertEquals(state.panX, 0, 'horizontal pan reset');
  assertEquals(state.panY, 0, 'vertical pan reset');
  assertEquals(state.zoomMtof, FRACUNIT, 'map-to-frame zoom reset');
  assertEquals(state.zoomFtom, FRACUNIT, 'frame-to-map zoom reset');
  for (const [field, expected] of Object.entries(before)) {
    assertEquals(state[field], expected, `${field} preserved`);
  }

  const ticked = AM_TickViewState(state, { x: 0, y: 0 });
  assertEquals(ticked.mX, before.mX, 'reset view does not keep panning');
  assertEquals(ticked.scaleMtof, before.scaleMtof, 'reset view does not keep zooming');
});

Deno.test('stationary follow preserves the zoom center until the player moves', () => {
  const player = { x: 13 * FRACUNIT, y: 7 * FRACUNIT };
  let state = AM_CreateViewState(rectangleVertices(), player);
  state = AM_TickViewState(state, player);
  assertEquals(state.followOldX, player.x, 'first follow records x');
  assertEquals(state.followOldY, player.y, 'first follow records y');
  const centerX = state.mX + Math.trunc(state.mW / 2);
  const centerY = state.mY + Math.trunc(state.mH / 2);

  state = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, KEY_EQUALS)).state;
  state = AM_TickViewState(state, player);
  assertEquals(state.mX + Math.trunc(state.mW / 2), centerX, 'first zoom keeps x center');
  assertEquals(state.mY + Math.trunc(state.mH / 2), centerY, 'first zoom keeps y center');
  state = AM_TickViewState(state, player);
  assertEquals(state.mX + Math.trunc(state.mW / 2), centerX, 'second zoom keeps x center');
  assertEquals(state.mY + Math.trunc(state.mH / 2), centerY, 'second zoom keeps y center');

  const moved = { x: player.x + FRACUNIT, y: player.y };
  state = AM_TickViewState(state, moved);
  assertEquals(state.followOldX, moved.x, 'movement refreshes old x');
  assertEquals(state.followOldY, moved.y, 'movement refreshes old y');

  state = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, 0x66)).state;
  state = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, 0x66)).state;
  assertEquals(state.followOldX, MAXINT, 'follow toggle invalidates old x');
  assertEquals(state.followOldY, MAXINT, 'follow toggle invalidates old y');

  state = AM_TickViewState(state, moved);
  state = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, 0x66)).state;
  state = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, KEY_RIGHTARROW)).state;
  state = AM_TickViewState(state, moved);
  assertEquals(state.followOldX, MAXINT, 'panning invalidates old x');
  assertEquals(state.followOldY, MAXINT, 'panning invalidates old y');
});

Deno.test('grid defaults off and big-map toggle restores the saved free-map window', () => {
  let state = AM_CreateViewState(rectangleVertices(), { x: 0, y: 0 });
  assertEquals(state.grid, false, 'default grid');
  let response = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, 0x67));
  state = response.state;
  assertEquals(state.grid, true, 'grid toggled on');
  assertEquals(response.message, 'gridOn', 'grid-on message');

  state = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, 0x66)).state;
  state = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, KEY_RIGHTARROW)).state;
  state = AM_TickViewState(state, { x: 0, y: 0 });
  state = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keyup, KEY_RIGHTARROW)).state;
  const saved = { mX: state.mX, mY: state.mY, mW: state.mW, mH: state.mH };
  response = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, 0x30), { x: 0, y: 0 });
  state = response.state;
  assertEquals(state.bigState, true, 'big state entered');
  assertEquals(state.scaleMtof, state.minScaleMtof, 'big map uses minimum scale');
  response = AM_ApplyControlEvent(state, keyEvent(evtype_t.ev_keydown, 0x30), { x: 0, y: 0 });
  state = response.state;
  assertEquals(state.bigState, false, 'big state exited');
  assertEquals(state.mX, saved.mX, 'saved x restored');
  assertEquals(state.mY, saved.mY, 'saved y restored');
  assertEquals(state.mW, saved.mW, 'saved width restored');
  assertEquals(state.mH, saved.mH, 'saved height restored');
  assertEquals(
    state.scaleMtof,
    FixedDiv(AM_FRAME_WIDTH * FRACUNIT, saved.mW),
    'restored scale is derived from saved window width',
  );
});
