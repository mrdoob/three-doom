// Startup metadata derived from the selected IWAD path.

import { GameMode_t, Language_t } from './doomdef.js';

export function D_IwadLanguage(filename, gamemode) {
  if (gamemode !== GameMode_t.commercial || typeof filename !== 'string') {
    return Language_t.english;
  }
  const suffix = filename.search(/[?#]/);
  const assetPath = suffix < 0 ? filename : filename.slice(0, suffix);
  const slash = Math.max(assetPath.lastIndexOf('/'), assetPath.lastIndexOf('\\'));
  const basename = assetPath.slice(slash + 1);
  return basename.toLowerCase() === 'doom2f.wad'
    ? Language_t.french
    : Language_t.english;
}
