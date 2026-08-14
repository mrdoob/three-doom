// Content-based IWAD mode detection. The browser can fetch any WAD under any
// filename, so unlike the original filesystem probe we classify by map lumps.

import { GameMode_t } from './doomdef.js';
import { W_ParseWadDirectory } from './w_wad_logic.js';

// Match linuxdoom's full-game-first search order. The repository includes
// doom1.wad, so putting shareware first would otherwise mask any full IWAD a
// user adds alongside it. `-iwad` remains the explicit override.
export const D_DEFAULT_IWAD_NAMES = Object.freeze([
  'doom2f.wad',
  'doom2.wad',
  'plutonia.wad',
  'tnt.wad',
  'doomu.wad',
  'doom.wad',
  'doom1.wad',
]);

export function D_GuessGameModeFromWad(buffer) {
  const parsed = W_ParseWadDirectory(buffer);
  if (parsed.valid !== true) return GameMode_t.indetermined;

  let hasMap01 = false;
  let hasE1M1 = false;
  let hasE2M1 = false;
  let hasE3M1 = false;
  let hasE4M1 = false;
  for (const lump of parsed.lumps) {
    const name = lump.name;
    if (name === 'MAP01') hasMap01 = true;
    else if (name === 'E1M1') hasE1M1 = true;
    else if (name === 'E2M1') hasE2M1 = true;
    else if (name === 'E3M1') hasE3M1 = true;
    else if (name === 'E4M1') hasE4M1 = true;
  }

  // Doom II, TNT and Plutonia all use MAPxx. Ultimate Doom adds E4; the
  // registered game adds E2/E3; shareware contains only E1.
  if (hasMap01) return GameMode_t.commercial;
  if (hasE4M1) return GameMode_t.retail;
  if (hasE2M1 || hasE3M1) return GameMode_t.registered;
  if (hasE1M1) return GameMode_t.shareware;
  return GameMode_t.indetermined;
}
