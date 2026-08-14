import { GameMode_t, Language_t } from '../src/doomdef.js';
import { D_IwadLanguage } from '../src/d_iwad.js';

const mainSource = await Deno.readTextFile(new URL('../src/d_main.js', import.meta.url));

function assertEquals(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}: expected ${expected}, got ${actual}`);
}

Deno.test('doom2f basename selects French for the commercial IWAD', () => {
  for (const name of [
    'doom2f.wad',
    'DOOM2F.WAD',
    '/games/doom2f.wad?cache=7#download',
    String.raw`C:\DOOM\doom2f.wad`,
  ]) {
    assertEquals(
      D_IwadLanguage(name, GameMode_t.commercial),
      Language_t.french,
      name,
    );
  }
});

Deno.test('IWAD language detection is exact and resets to English', () => {
  for (const name of [
    'doom2.wad',
    'mydoom2f.wad',
    'doom2f.wad.backup',
    '/download?name=doom2f.wad',
    '',
  ]) {
    assertEquals(
      D_IwadLanguage(name, GameMode_t.commercial),
      Language_t.english,
      name,
    );
  }
  assertEquals(
    D_IwadLanguage('doom2f.wad', GameMode_t.registered),
    Language_t.english,
    'noncommercial mode guard',
  );
  assertEquals(
    D_IwadLanguage(undefined, GameMode_t.commercial),
    Language_t.english,
    'missing filename',
  );
});

Deno.test('startup publishes IWAD language after content mode detection', () => {
  const mode = mainSource.indexOf('set_gamemode(detectedMode)');
  const language = mainSource.indexOf(
    'doomstat.set_language(D_IwadLanguage(iwad.name, detectedMode))',
  );
  const startup = mainSource.indexOf('D_StartupArgumentPlan(myargv, detectedMode)');
  if (!(mode >= 0 && language > mode && startup > language)) {
    throw new Error('IWAD language is not published between mode detection and startup planning');
  }
});
