import { I_RunCleanupSteps, I_RunQuitSequence } from '../src/i_shutdown.js';

function assertEquals(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function assertArray(actual, expected, message) {
  assertEquals(JSON.stringify(actual), JSON.stringify(expected), message);
}

Deno.test('I_Quit invokes every source stage in order before awaiting browser cleanup', async () => {
  const calls = [];
  let finishSound;
  const soundClose = new Promise((resolve) => { finishSound = resolve; });
  const graphicsReport = { contextLost: true };

  const resultPromise = I_RunQuitSequence({
    D_QuitNetGame: () => { calls.push('net'); },
    I_ShutdownSound: () => { calls.push('sound'); return soundClose; },
    I_ShutdownMusic: () => { calls.push('music'); },
    M_SaveDefaults: () => { calls.push('defaults'); },
    I_ShutdownGraphics: () => { calls.push('graphics'); return graphicsReport; },
  });

  // AudioContext.close() may still be pending, but all C-equivalent calls have
  // synchronously claimed their resources in the reference order.
  assertArray(calls, ['net', 'sound', 'music', 'defaults', 'graphics'], 'immediate quit order');
  finishSound();
  assertEquals(await resultPromise, graphicsReport, 'graphics diagnostics result');
});

Deno.test('I_Quit aggregates failures without suppressing later stages', async () => {
  const calls = [];
  const netError = new Error('net failed');
  const soundError = new Error('sound failed');
  const defaultsError = new Error('defaults failed');
  const resultPromise = I_RunQuitSequence({
    D_QuitNetGame: () => { calls.push('net'); throw netError; },
    I_ShutdownSound: () => { calls.push('sound'); return Promise.reject(soundError); },
    I_ShutdownMusic: () => { calls.push('music'); },
    M_SaveDefaults: () => { calls.push('defaults'); throw defaultsError; },
    I_ShutdownGraphics: () => { calls.push('graphics'); },
  });

  let failure = null;
  try { await resultPromise; } catch (error) { failure = error; }
  assertEquals(failure instanceof AggregateError, true, 'aggregate failure type');
  assertArray(failure.errors, [netError, soundError, defaultsError], 'source-ordered failures');
  assertArray(calls, ['net', 'sound', 'music', 'defaults', 'graphics'], 'failure continuation order');
});

Deno.test('a failed cleanup import equivalent cannot skip remaining graphics cleanup', async () => {
  const calls = [];
  const errors = [];
  const importError = new Error('module import failed');
  await I_RunCleanupSteps([
    async () => { calls.push('first import'); throw importError; },
    async () => { calls.push('second cleanup'); },
    async () => { calls.push('third cleanup'); },
  ], errors);

  assertArray(calls, ['first import', 'second cleanup', 'third cleanup'], 'cleanup continuation');
  assertArray(errors, [importError], 'cleanup errors');
});

Deno.test('Web Audio shutdown claims resources once and prevents recreation', async () => {
  const sound = await Deno.readTextFile(new URL('../src/i_sound.js', import.meta.url));
  if (!sound.includes('if (_soundShutdownPromise !== null) return _soundShutdownPromise;') ||
      !sound.includes('_soundShutdownStarted = true;') ||
      !sound.includes('if (_soundShutdownStarted === true) return null;')) {
    throw new Error('I_ShutdownSound is not terminal and idempotent');
  }
  const claim = sound.indexOf('const ownedContext = _ctx;\n  _ctx = null;');
  const stopSources = sound.indexOf('stopSourceQuietly(entry.src);');
  const clearSources = sound.indexOf('_activeSources.clear();');
  const clearCache = sound.indexOf('_bufferCache.clear();');
  const close = sound.indexOf('await ownedContext.close();');
  if (claim < 0 || stopSources <= claim || clearSources <= stopSources ||
      clearCache <= clearSources || close <= clearCache) {
    throw new Error('Web Audio resources are not synchronously claimed and stopped before close');
  }
});
