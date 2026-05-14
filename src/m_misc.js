// Ported from: linuxdoom-1.10/m_misc.c
// Default config file (localStorage in browser), file I/O, screenshots.

import { SCREENWIDTH, SCREENHEIGHT } from './doomdef.js';
import { I_Error } from './i_system.js';
import { M_CheckParm, myargc, myargv } from './m_argv.js';

// ---------- Filesystem (browser stubs) ----------

// Persisted virtual filesystem backed by localStorage.
const KEY_PREFIX = 'doom:fs:';

export function M_WriteFile(name, source, length) {
  try {
    const arr = source instanceof Uint8Array ? source.subarray(0, length) : new Uint8Array(source.buffer || source, source.byteOffset || 0, length);
    // localStorage stores strings; encode binary as base64.
    let bin = '';
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    localStorage.setItem(KEY_PREFIX + name, btoa(bin));
    return true;
  } catch (e) {
    return false;
  }
}

// Returns the buffer length, populates result.buffer with a Uint8Array.
export function M_ReadFile(name, result) {
  const v = localStorage.getItem(KEY_PREFIX + name);
  if (v == null) I_Error("Couldn't read file " + name);
  const bin = atob(v);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  result.buffer = buf;
  return buf.length;
}

// ---------- Defaults (config) ----------

// The defaults array is built lazily because the values it points at live in
// other modules that may not be initialised yet. Other modules call
// M_RegisterDefault(name, ref, defaultvalue) during their init.
//
// ref is { get(): val, set(v): void } so we can persist either ints or strings
// without losing the C "*int_pointer" pattern.

const defaults = [];
let numdefaults = 0;
let defaultfile = 'default.cfg';

export function M_RegisterDefault(name, ref, defaultvalue) {
  defaults.push({ name, ref, defaultvalue });
  numdefaults = defaults.length;
}

export function M_SaveDefaults() {
  const lines = [];
  for (const d of defaults) {
    const v = d.ref.get();
    if (typeof v === 'string') {
      lines.push(`${d.name}\t\t"${v}"`);
    } else {
      lines.push(`${d.name}\t\t${v | 0}`);
    }
  }
  try { localStorage.setItem('doom:defaults', lines.join('\n')); } catch (e) {}
}

export function M_LoadDefaults() {
  // 1) Reset everything to the registered base values.
  for (const d of defaults) d.ref.set(d.defaultvalue);

  // 2) Honour -config <name> (URL param).
  const i = M_CheckParm('-config');
  if (i !== 0 && i < myargc - 1) {
    defaultfile = myargv[i + 1];
    console.log('  default file:', defaultfile);
  }

  // 3) Apply persisted overrides.
  const text = localStorage.getItem('doom:defaults');
  if (text == null) return;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const m = line.match(/^(\S+)\s+(.*)$/);
    if (m === null) continue;
    const [, name, valStr] = m;
    let parsed;
    if (valStr.charAt(0) === '"') {
      parsed = valStr.slice(1, valStr.lastIndexOf('"'));
    } else if (valStr.startsWith('0x')) {
      parsed = parseInt(valStr.slice(2), 16);
    } else {
      parsed = parseInt(valStr, 10);
    }
    for (const d of defaults) {
      if (d.name === name) { d.ref.set(parsed); break; }
    }
  }
}

// ---------- Screenshot (canvas.toBlob) ----------

export function M_ScreenShot() {
  // Best-effort browser screenshot. We grab the WebGL canvas + 2D overlay
  // and trigger a download. Implementation lives in i_video.js so we just
  // dispatch a synthetic event here.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('doom:screenshot'));
  }
}

// M_DrawText lives in hu_stuff/v_video — we provide it once those exist.
