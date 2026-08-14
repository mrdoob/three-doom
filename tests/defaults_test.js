import * as doomstat from '../src/doomstat.js';
import { I_Quit, I_RegisterQuitGraphics } from '../src/i_system.js';
import { HU_SetShowMessages, showMessages } from '../src/hu_stuff.js';
import { myargv, set_myargv } from '../src/m_argv.js';
import { M_RegisterDoomDefaults } from '../src/m_defaults.js';
import {
  M_LoadDefaults, M_SaveDefaults, M_StartDefaultsPersistence,
  M_StopDefaultsPersistence,
} from '../src/m_misc.js';
import { set_usegamma, usegamma } from '../src/v_video.js';
import { R_GetScreenblocks, R_SetViewSize } from '../src/r_view.js';

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

class ListenerTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type) {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ type });
    }
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

Deno.test('input, sound, messages, and video round-trip through registered defaults', () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const values = new Map();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => values.set(key, String(value)),
    },
  });
  try {
    M_RegisterDoomDefaults();
    doomstat.set_mouseSensitivity(8);
    doomstat.set_snd_SfxVolume(12);
    doomstat.set_snd_MusicVolume(3);
    doomstat.set_numChannels(6);
    HU_SetShowMessages(0);
    set_usegamma(3);
    R_SetViewSize(10);
    M_SaveDefaults();
    assertEquals(
      values.get('doom:defaults'),
      'mouse_sensitivity\t\t8\nsfx_volume\t\t12\nmusic_volume\t\t3\nshow_messages\t\t0\nusegamma\t\t3\nscreenblocks\t\t10\nsnd_channels\t\t6',
      'saved defaults',
    );

    doomstat.set_mouseSensitivity(1);
    doomstat.set_snd_SfxVolume(1);
    doomstat.set_snd_MusicVolume(1);
    doomstat.set_numChannels(1);
    HU_SetShowMessages(1);
    set_usegamma(1);
    R_SetViewSize(3);
    M_LoadDefaults();
    assertEquals(doomstat.mouseSensitivity, 8, 'loaded mouse sensitivity');
    assertEquals(doomstat.snd_SfxVolume, 12, 'loaded sfx volume');
    assertEquals(doomstat.snd_MusicVolume, 3, 'loaded music volume');
    assertEquals(doomstat.numChannels, 6, 'loaded sound channels');
    assertEquals(showMessages, false, 'loaded message visibility');
    assertEquals(usegamma, 3, 'loaded gamma');
    assertEquals(R_GetScreenblocks(), 10, 'loaded screen blocks');

    values.delete('doom:defaults');
    M_LoadDefaults();
    assertEquals(doomstat.mouseSensitivity, 5, 'reference mouse default');
    assertEquals(doomstat.snd_SfxVolume, 8, 'reference sfx default');
    assertEquals(doomstat.snd_MusicVolume, 8, 'reference music default');
    assertEquals(doomstat.numChannels, 3, 'reference channel default');
    assertEquals(showMessages, true, 'reference message default');
    assertEquals(usegamma, 0, 'reference gamma default');
    assertEquals(R_GetScreenblocks(), 10, 'browser screen-block default');
  } finally {
    doomstat.set_mouseSensitivity(5);
    doomstat.set_snd_SfxVolume(8);
    doomstat.set_snd_MusicVolume(8);
    doomstat.set_numChannels(3);
    HU_SetShowMessages(1);
    set_usegamma(0);
    R_SetViewSize(10);
    if (oldStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', oldStorage);
  }
});

Deno.test('page lifecycle persists isolated config profiles and tolerates blocked storage', () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const oldArgv = [...myargv];
  const values = new Map([
    ['doom:defaults', 'mouse_sensitivity\t\t7'],
    ['doom:defaults:practice.cfg', 'mouse_sensitivity\t\t9'],
  ]);
  const writes = [];
  let failGet = false;
  let failSet = false;
  const fakeWindow = new ListenerTarget();
  const fakeDocument = new ListenerTarget();
  fakeDocument.visibilityState = 'visible';
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: fakeDocument,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => {
        if (failGet) throw new DOMException('blocked', 'SecurityError');
        return values.has(key) ? values.get(key) : null;
      },
      setItem: (key, value) => {
        if (failSet) throw new DOMException('full', 'QuotaExceededError');
        writes.push(key);
        values.set(key, String(value));
      },
    },
  });
  try {
    M_RegisterDoomDefaults();
    set_myargv(['', '-config', 'practice.cfg']);
    M_LoadDefaults();
    assertEquals(doomstat.mouseSensitivity, 9, 'named profile load');
    assertEquals(fakeWindow.listenerCount('pagehide'), 1, 'pagehide listener count');
    assertEquals(fakeDocument.listenerCount('visibilitychange'), 1, 'visibility listener count');

    M_StartDefaultsPersistence();
    assertEquals(fakeWindow.listenerCount('pagehide'), 1, 'idempotent pagehide listener');
    assertEquals(fakeDocument.listenerCount('visibilitychange'), 1, 'idempotent visibility listener');

    doomstat.set_mouseSensitivity(10);
    fakeDocument.dispatch('visibilitychange');
    assertEquals(writes.length, 0, 'visible page does not save');
    fakeDocument.visibilityState = 'hidden';
    fakeDocument.dispatch('visibilitychange');
    assertEquals(writes.join(','), 'doom:defaults:practice.cfg', 'hidden profile save key');
    assertEquals(
      values.get('doom:defaults:practice.cfg').startsWith('mouse_sensitivity\t\t10\n'),
      true,
      'hidden profile value',
    );
    assertEquals(values.get('doom:defaults'), 'mouse_sensitivity\t\t7', 'base profile isolation');

    doomstat.set_mouseSensitivity(11);
    fakeWindow.dispatch('pagehide');
    assertEquals(
      values.get('doom:defaults:practice.cfg').startsWith('mouse_sensitivity\t\t11\n'),
      true,
      'pagehide profile value',
    );

    M_StopDefaultsPersistence();
    assertEquals(fakeWindow.listenerCount('pagehide'), 0, 'removed pagehide listener');
    assertEquals(fakeDocument.listenerCount('visibilitychange'), 0, 'removed visibility listener');
    doomstat.set_mouseSensitivity(12);
    fakeWindow.dispatch('pagehide');
    assertEquals(
      values.get('doom:defaults:practice.cfg').startsWith('mouse_sensitivity\t\t11\n'),
      true,
      'stopped lifecycle does not save',
    );

    set_myargv(['']);
    fakeDocument.visibilityState = 'visible';
    M_LoadDefaults();
    assertEquals(doomstat.mouseSensitivity, 7, 'base profile restored');

    failGet = true;
    M_LoadDefaults();
    assertEquals(doomstat.mouseSensitivity, 5, 'blocked read falls back to default');
    failGet = false;
    failSet = true;
    doomstat.set_mouseSensitivity(13);
    fakeWindow.dispatch('pagehide');
    assertEquals(values.get('doom:defaults'), 'mouse_sensitivity\t\t7', 'blocked write is harmless');
  } finally {
    failGet = false;
    failSet = false;
    M_StopDefaultsPersistence();
    set_myargv(oldArgv);
    doomstat.set_mouseSensitivity(5);
    doomstat.set_snd_SfxVolume(8);
    doomstat.set_snd_MusicVolume(8);
    doomstat.set_numChannels(3);
    HU_SetShowMessages(1);
    set_usegamma(0);
    R_SetViewSize(10);
    if (oldStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', oldStorage);
    if (oldWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, 'window', oldWindow);
    if (oldDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', oldDocument);
  }
});

Deno.test('I_Quit saves defaults before late-registered graphics shutdown', async () => {
  const oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const values = new Map();
  const calls = [];
  const fakeWindow = new ListenerTarget();
  const fakeDocument = new ListenerTarget();
  fakeDocument.visibilityState = 'visible';
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: fakeWindow,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: fakeDocument,
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key) => values.has(key) ? values.get(key) : null,
      setItem: (key, value) => {
        calls.push('save');
        values.set(key, String(value));
      },
    },
  });
  try {
    M_RegisterDoomDefaults();
    M_LoadDefaults();
    doomstat.set_mouseSensitivity(7);
    doomstat.set_snd_SfxVolume(11);
    doomstat.set_snd_MusicVolume(4);
    doomstat.set_numChannels(7);
    HU_SetShowMessages(0);
    set_usegamma(4);
    R_SetViewSize(8);
    const firstQuit = I_Quit();
    const secondQuit = I_Quit();
    assertEquals(firstQuit === secondQuit, true, 'quit promise identity');
    assertEquals(calls.join(','), 'save', 'defaults before graphics registration');
    assertEquals(fakeWindow.listenerCount('pagehide'), 0, 'quit removes pagehide listener');
    assertEquals(fakeDocument.listenerCount('visibilitychange'), 0, 'quit removes visibility listener');
    I_RegisterQuitGraphics(() => { calls.push('graphics'); });
    assertEquals(calls.join(','), 'save,graphics', 'late graphics registration is synchronous');
    await firstQuit;
    assertEquals(calls.join(','), 'save,graphics', 'observable quit lifecycle order');
    assertEquals(
      values.get('doom:defaults'),
      'mouse_sensitivity\t\t7\nsfx_volume\t\t11\nmusic_volume\t\t4\nshow_messages\t\t0\nusegamma\t\t4\nscreenblocks\t\t8\nsnd_channels\t\t7',
      'quit defaults',
    );
  } finally {
    doomstat.set_mouseSensitivity(5);
    doomstat.set_snd_SfxVolume(8);
    doomstat.set_snd_MusicVolume(8);
    doomstat.set_numChannels(3);
    HU_SetShowMessages(1);
    set_usegamma(0);
    R_SetViewSize(10);
    if (oldStorage === undefined) delete globalThis.localStorage;
    else Object.defineProperty(globalThis, 'localStorage', oldStorage);
    if (oldWindow === undefined) delete globalThis.window;
    else Object.defineProperty(globalThis, 'window', oldWindow);
    if (oldDocument === undefined) delete globalThis.document;
    else Object.defineProperty(globalThis, 'document', oldDocument);
  }
});

Deno.test('startup registers defaults before loading and menu quit leaves Doom running', async () => {
  const main = await Deno.readTextFile(new URL('../src/d_main.js', import.meta.url));
  const boot = main.slice(main.indexOf('export async function D_DoomMain()'));
  const register = boot.indexOf('M_RegisterDoomDefaults()');
  const load = boot.indexOf('M_LoadDefaults()');
  if (register < 0 || load <= register) {
    throw new Error('D_DoomMain does not register defaults before loading them');
  }
  if (!boot.includes('S.S_Init(doomstat.snd_SfxVolume, doomstat.snd_MusicVolume)')) {
    throw new Error('sound startup ignores loaded volume defaults');
  }

  const menu = await Deno.readTextFile(new URL('../src/m_menu.js', import.meta.url));
  const quitResponse = menu.slice(
    menu.indexOf('function M_QuitResponse(key)'),
    menu.indexOf('function M_QuitDOOM()'),
  );
  const quit = menu.slice(menu.indexOf('function M_QuitDOOM()'), menu.indexOf('// ---------- Lifecycle ----------'));
  if (!quitResponse.includes('M_ConfirmQuit(') ||
      !quitResponse.includes('(...args) => globalThis.open?.(...args)') ||
      !quitResponse.includes('M_SaveDefaults') ||
      quitResponse.includes('I_Quit') ||
      !quit.includes('M_QuitResponse') ||
      quit.includes('window.location.reload')) {
    throw new Error('menu quit does not save and open its link while leaving Doom running');
  }
});
