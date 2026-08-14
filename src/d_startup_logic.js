// Pure command-line startup planning for d_main.c's skill / episode / warp
// arguments plus the browser port's named-map compatibility option.

import { GameMode_t } from './doomdef.js';

function optionIndex(argv, name) {
  for (let i = 1; i < argv.length; i++) {
    if (typeof argv[i] === 'string' && argv[i].toLowerCase() === name) return i;
  }
  return -1;
}

function integerValue(value) {
  if (typeof value !== 'string' || !/^[+-]?\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function integerArgument(argv, option) {
  const index = optionIndex(argv, option);
  return index < 0 || index + 1 >= argv.length ? null : integerValue(argv[index + 1]);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function episodeLimit(gamemode) {
  if (gamemode === GameMode_t.shareware) return 1;
  if (gamemode === GameMode_t.retail) return 4;
  return 3;
}

function normalizeTarget(gamemode, episode, map) {
  return {
    episode: clamp(episode, 1, episodeLimit(gamemode)),
    map: gamemode === GameMode_t.commercial ? Math.max(1, map) : clamp(map, 1, 9),
  };
}

function namedMap(value) {
  if (typeof value !== 'string') return null;
  const episodeMap = value.match(/^E(\d+)M(\d+)$/i);
  if (episodeMap !== null) {
    const episode = Number(episodeMap[1]);
    const map = Number(episodeMap[2]);
    if (Number.isSafeInteger(episode) && Number.isSafeInteger(map)) return { episode, map };
  }
  const commercialMap = value.match(/^MAP(\d+)$/i);
  if (commercialMap !== null) {
    const map = Number(commercialMap[1]);
    if (Number.isSafeInteger(map)) return { episode: 1, map };
  }
  return null;
}

function warpTarget(argv, gamemode, currentEpisode) {
  const index = optionIndex(argv, '-warp');
  if (index < 0 || index + 1 >= argv.length) return null;

  // Keep the original browser spelling (`-warp=E1M2` / `-warp=MAP02`) while
  // adding d_main.c's native numeric forms below.
  const compatible = namedMap(argv[index + 1]);
  if (compatible !== null) return normalizeTarget(gamemode, compatible.episode, compatible.map);

  const first = integerValue(argv[index + 1]);
  if (first === null) return null;
  if (gamemode === GameMode_t.commercial) {
    return normalizeTarget(gamemode, currentEpisode, first);
  }
  if (index + 2 >= argv.length) return null;
  const second = integerValue(argv[index + 2]);
  if (second === null) return null;
  return normalizeTarget(gamemode, first, second);
}

function mapTarget(argv, gamemode) {
  const index = optionIndex(argv, '-map');
  if (index < 0 || index + 1 >= argv.length) return null;
  const target = namedMap(argv[index + 1]);
  return target === null ? null : normalizeTarget(gamemode, target.episode, target.map);
}

export function D_StartupArgumentPlan(argv, gamemode) {
  let skill = 2;
  let episode = 1;
  let map = 1;
  let autostart = false;

  const requestedSkill = integerArgument(argv, '-skill');
  if (requestedSkill !== null) {
    // d_main.c stores the user-facing 1..5 value as the zero-based skill_t.
    // Match G_InitNew's safe clamping for out-of-range browser input so the
    // published start fields describe the level that will actually load.
    skill = clamp(requestedSkill - 1, 0, 4);
    autostart = true;
  }

  const requestedEpisode = integerArgument(argv, '-episode');
  if (requestedEpisode !== null) {
    const target = normalizeTarget(gamemode, requestedEpisode, 1);
    episode = target.episode;
    map = target.map;
    autostart = true;
  }

  // Preserve the existing precedence: a valid -warp wins over the browser's
  // -map alias regardless of argv order. A malformed -warp does not suppress
  // an otherwise valid compatibility map.
  const target = warpTarget(argv, gamemode, episode) ?? mapTarget(argv, gamemode);
  if (target !== null) {
    episode = target.episode;
    map = target.map;
    autostart = true;
  }

  return Object.freeze({ skill, episode, map, autostart });
}

function appendLmpExtension(value) {
  const suffixIndex = value.search(/[?#]/);
  const assetPath = suffixIndex < 0 ? value : value.slice(0, suffixIndex);
  const suffix = suffixIndex < 0 ? '' : value.slice(suffixIndex);
  return /\.lmp$/i.test(assetPath) ? value : `${assetPath}.lmp${suffix}`;
}

function lumpNameFromAsset(value) {
  const suffixIndex = value.search(/[?#]/);
  const assetPath = suffixIndex < 0 ? value : value.slice(0, suffixIndex);
  const slash = Math.max(assetPath.lastIndexOf('/'), assetPath.lastIndexOf('\\'));
  const basename = assetPath.slice(slash + 1);
  const dot = basename.indexOf('.');
  const lump = (dot < 0 ? basename : basename.slice(0, dot)).toUpperCase().slice(0, 8);
  return lump.length === 0 ? null : lump;
}

function demoOption(argv, option, kind) {
  const index = optionIndex(argv, option);
  if (index < 0 || index + 1 >= argv.length) return null;
  const argument = argv[index + 1];
  if (typeof argument !== 'string' || argument.length === 0 || argument.startsWith('-')) {
    return null;
  }
  const path = appendLmpExtension(argument);
  const lump = lumpNameFromAsset(path);
  if (lump === null) return null;
  return Object.freeze({ kind, argument, path, lump });
}

// Linux Doom gives -playdemo precedence over -timedemo when planning the
// optional external .lmp. Make that precedence explicit because the browser
// loop does return to its caller after scheduling a frame.
export function D_DemoArgumentPlan(argv) {
  return demoOption(argv, '-playdemo', 'playdemo') ??
    demoOption(argv, '-timedemo', 'timedemo');
}
