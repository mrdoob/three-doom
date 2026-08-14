// Page Visibility must suspend the live Web Audio graph while the tab is in
// the background, then resume the same graph when the player returns. The RAF
// suspension test covers simulation time separately; this test owns audio.

import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
}

const watchdog = setTimeout(() => {
  console.error('music visibility Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);

let browser;
try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const NativeAudioContext = globalThis.AudioContext || globalThis.webkitAudioContext;
    const contexts = [];
    const visibilityListeners = new Set();
    const nativeDocumentAdd = document.addEventListener.bind(document);
    const nativeDocumentRemove = document.removeEventListener.bind(document);
    let forcedVisibility = 'visible';
    let holdNextResume = false;
    let releaseHeldResume = null;
    let suspendDirectly = async () => {};
    let resumeDirectly = async () => {};
    const calls = {
      suspend: 0,
      suspendSettled: 0,
      resume: 0,
      resumeSettled: 0,
      close: 0,
      closeSettled: 0,
    };

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => forcedVisibility,
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => forcedVisibility === 'hidden',
    });
    document.addEventListener = (type, listener, eventOptions) => {
      if (type === 'visibilitychange') visibilityListeners.add(listener);
      nativeDocumentAdd(type, listener, eventOptions);
    };
    document.removeEventListener = (type, listener, eventOptions) => {
      if (type === 'visibilitychange') visibilityListeners.delete(listener);
      nativeDocumentRemove(type, listener, eventOptions);
    };

    if (NativeAudioContext !== undefined) {
      const TrackedAudioContext = new Proxy(NativeAudioContext, {
        construct(target, args) {
          const audioContext = Reflect.construct(target, args, target);
          contexts.push(audioContext);
          return audioContext;
        },
      });
      globalThis.AudioContext = TrackedAudioContext;
      if (globalThis.webkitAudioContext === NativeAudioContext) {
        globalThis.webkitAudioContext = TrackedAudioContext;
      }

      const nativeSuspend = NativeAudioContext.prototype.suspend;
      suspendDirectly = () => nativeSuspend.call(contexts[0]);
      NativeAudioContext.prototype.suspend = function(...args) {
        calls.suspend++;
        return Promise.resolve(nativeSuspend.apply(this, args)).then((result) => {
          calls.suspendSettled++;
          return result;
        });
      };
      const nativeResume = NativeAudioContext.prototype.resume;
      resumeDirectly = () => nativeResume.call(contexts[0]);
      NativeAudioContext.prototype.resume = function(...args) {
        calls.resume++;
        let held = Promise.resolve();
        if (holdNextResume === true) {
          holdNextResume = false;
          held = new Promise((resolve) => { releaseHeldResume = resolve; });
        }
        return Promise.all([nativeResume.apply(this, args), held]).then(([result]) => {
          calls.resumeSettled++;
          return result;
        });
      };
      const nativeClose = NativeAudioContext.prototype.close;
      NativeAudioContext.prototype.close = function(...args) {
        calls.close++;
        return Promise.resolve(nativeClose.apply(this, args)).then((result) => {
          calls.closeSettled++;
          return result;
        });
      };
    }

    globalThis.__doomMusicVisibility = {
      forceSuspend: () => suspendDirectly(),
      forceResume: () => resumeDirectly(),
      holdNextResume: () => { holdNextResume = true; },
      releaseResume() {
        const release = releaseHeldResume;
        releaseHeldResume = null;
        release?.();
      },
      setVisibility(state) {
        forcedVisibility = state;
        document.dispatchEvent(new Event('visibilitychange'));
      },
      snapshot: () => ({
        visibility: forcedVisibility,
        listenerCount: visibilityListeners.size,
        contextCount: contexts.length,
        contextStates: contexts.map((audioContext) => audioContext.state),
        resumeHeld: releaseHeldResume !== null,
        ...calls,
      }),
    };
  });

  const url = new URL(process.env.DOOM_URL ?? 'http://127.0.0.1:8095/');
  url.searchParams.set('-map', 'E1M1');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    globalThis.renderer !== undefined &&
    globalThis.scene?.getObjectByName('level') !== undefined &&
    globalThis.__doomMusicVisibility.snapshot().contextCount === 1,
  { timeout: 30000 });

  // Grant Web Audio its normal user activation and prove E1M1 music owns the
  // graph before exercising background-tab suspension.
  await page.mouse.click(320, 200);
  await page.waitForFunction(() =>
    globalThis.__doomMusicVisibility.snapshot().contextStates[0] === 'running',
  { timeout: 5000 });
  const before = await page.evaluate(async () => ({
    audio: globalThis.__doomMusicVisibility.snapshot(),
    musicPlaying: (await import('/src/i_sound.js')).I_QrySongPlaying(0),
    loopRunning: (await import('/src/d_loop.js')).D_DoomRafLoop.isRunning(),
  }));

  await page.evaluate(() => globalThis.__doomMusicVisibility.setVisibility('hidden'));
  await page.waitForFunction((previousSuspend) => {
    const audio = globalThis.__doomMusicVisibility.snapshot();
    return audio.suspend > previousSuspend &&
      audio.suspendSettled === audio.suspend &&
      audio.contextStates[0] === 'suspended';
  }, before.audio.suspend, { timeout: 5000 });
  const hidden = await page.evaluate(async () => ({
    audio: globalThis.__doomMusicVisibility.snapshot(),
    musicPlaying: (await import('/src/i_sound.js')).I_QrySongPlaying(0),
    loopRunning: (await import('/src/d_loop.js')).D_DoomRafLoop.isRunning(),
  }));

  await page.evaluate(() => globalThis.__doomMusicVisibility.setVisibility('visible'));
  await page.waitForFunction((previousResume) => {
    const audio = globalThis.__doomMusicVisibility.snapshot();
    return audio.resume > previousResume &&
      audio.resumeSettled === audio.resume &&
      audio.contextStates[0] === 'running';
  }, hidden.audio.resume, { timeout: 5000 });
  const resumed = await page.evaluate(async () => ({
    audio: globalThis.__doomMusicVisibility.snapshot(),
    musicPlaying: (await import('/src/i_sound.js')).I_QrySongPlaying(0),
    loopRunning: (await import('/src/d_loop.js')).D_DoomRafLoop.isRunning(),
  }));

  // Reproduce the inverse race: a gesture starts resuming a visible, suspended
  // context, then the page becomes hidden before that resume promise settles.
  // The hidden request must run after the pending gesture and win.
  await page.evaluate(async () => {
    const harness = globalThis.__doomMusicVisibility;
    await harness.forceSuspend();
    harness.holdNextResume();
    globalThis.dispatchEvent(new Event('pointerdown'));
  });
  await page.waitForFunction((previousResume) => {
    const audio = globalThis.__doomMusicVisibility.snapshot();
    return audio.resume > previousResume && audio.resumeHeld === true;
  }, resumed.audio.resume, { timeout: 5000 });
  const gesturePending = await page.evaluate(() =>
    globalThis.__doomMusicVisibility.snapshot());
  await page.evaluate(() =>
    globalThis.__doomMusicVisibility.setVisibility('hidden'));
  await page.waitForFunction((previous) => {
    const audio = globalThis.__doomMusicVisibility.snapshot();
    return audio.resumeHeld === true &&
      audio.suspend > previous.suspend &&
      audio.suspendSettled === audio.suspend &&
      audio.contextStates[0] === 'suspended';
  }, gesturePending, { timeout: 5000 });
  const gestureSilenced = await page.evaluate(() =>
    globalThis.__doomMusicVisibility.snapshot());
  await page.evaluate(() => globalThis.__doomMusicVisibility.releaseResume());
  await page.waitForFunction((previous) => {
    const audio = globalThis.__doomMusicVisibility.snapshot();
    return audio.resumeSettled > previous.resumeSettled &&
      audio.contextStates[0] === 'suspended';
  }, gestureSilenced, { timeout: 5000 });
  const gestureHidden = await page.evaluate(() =>
    globalThis.__doomMusicVisibility.snapshot());
  await page.evaluate(() =>
    globalThis.__doomMusicVisibility.setVisibility('visible'));
  await page.waitForFunction((previousResume) => {
    const audio = globalThis.__doomMusicVisibility.snapshot();
    return audio.resume > previousResume &&
      audio.resumeSettled === audio.resume &&
      audio.contextStates[0] === 'running';
  }, gestureHidden.resume, { timeout: 5000 });
  const gestureResumed = await page.evaluate(() =>
    globalThis.__doomMusicVisibility.snapshot());

  // A foreground return can race an unresolved suspend request. Final state
  // must follow the latest visibility value, not the last promise to settle.
  const beforeRapid = gestureResumed;
  await page.evaluate(async () => {
    globalThis.__doomMusicVisibility.setVisibility('hidden');
    // Let the hidden reconciliation begin, but do not wait for its asynchronous
    // AudioContext.suspend() request before returning to the foreground.
    await Promise.resolve();
    globalThis.__doomMusicVisibility.setVisibility('visible');
  });
  await page.waitForFunction((previous) => {
    const audio = globalThis.__doomMusicVisibility.snapshot();
    return audio.suspend > previous.suspend &&
      audio.suspendSettled === audio.suspend &&
      audio.resume > previous.resume &&
      audio.resumeSettled === audio.resume &&
      audio.contextStates[0] === 'running';
  }, beforeRapid, { timeout: 5000 });
  const rapid = await page.evaluate(() => globalThis.__doomMusicVisibility.snapshot());

  // An autoplay/browser-owned suspended context is not ours to resume. If the
  // browser later starts it while the page is still hidden, statechange must
  // notice and suspend it without requiring a second visibility event.
  const beforeStateChange = rapid;
  await page.evaluate(async () => {
    const harness = globalThis.__doomMusicVisibility;
    await harness.forceSuspend();
    harness.setVisibility('hidden');
    await harness.forceResume();
  });
  await page.waitForFunction((previousSuspend) => {
    const audio = globalThis.__doomMusicVisibility.snapshot();
    return audio.suspend > previousSuspend &&
      audio.suspendSettled === audio.suspend &&
      audio.contextStates[0] === 'suspended';
  }, beforeStateChange.suspend, { timeout: 5000 });
  const hiddenStateChange = await page.evaluate(() =>
    globalThis.__doomMusicVisibility.snapshot());
  await page.evaluate(() =>
    globalThis.__doomMusicVisibility.setVisibility('visible'));
  await page.waitForFunction((previousResume) => {
    const audio = globalThis.__doomMusicVisibility.snapshot();
    return audio.resume > previousResume &&
      audio.resumeSettled === audio.resume &&
      audio.contextStates[0] === 'running';
  }, hiddenStateChange.resume, { timeout: 5000 });
  const stateChangeResumed = await page.evaluate(() =>
    globalThis.__doomMusicVisibility.snapshot());

  // A visibility-owned resume can still be settling when the player hides and
  // re-shows the page. Its stale completion must not erase ownership of the
  // newer suspend request or strand the final visible page in suspension.
  await page.evaluate(() =>
    globalThis.__doomMusicVisibility.setVisibility('hidden'));
  await page.waitForFunction((previousSuspend) => {
    const audio = globalThis.__doomMusicVisibility.snapshot();
    return audio.suspend > previousSuspend &&
      audio.suspendSettled === audio.suspend &&
      audio.contextStates[0] === 'suspended';
  }, stateChangeResumed.suspend, { timeout: 5000 });
  await page.evaluate(() => {
    const harness = globalThis.__doomMusicVisibility;
    harness.holdNextResume();
    harness.setVisibility('visible');
  });
  await page.waitForFunction((previousResume) => {
    const audio = globalThis.__doomMusicVisibility.snapshot();
    return audio.resume > previousResume && audio.resumeHeld === true;
  }, stateChangeResumed.resume, { timeout: 5000 });
  const ownedResumePending = await page.evaluate(() =>
    globalThis.__doomMusicVisibility.snapshot());
  await page.evaluate(() =>
    globalThis.__doomMusicVisibility.setVisibility('hidden'));
  await page.waitForFunction((previousSuspend) => {
    const audio = globalThis.__doomMusicVisibility.snapshot();
    return audio.resumeHeld === true &&
      audio.suspend > previousSuspend &&
      audio.suspendSettled === audio.suspend &&
      audio.contextStates[0] === 'suspended';
  }, ownedResumePending.suspend, { timeout: 5000 });
  const ownedHidden = await page.evaluate(() =>
    globalThis.__doomMusicVisibility.snapshot());
  await page.evaluate(() =>
    globalThis.__doomMusicVisibility.setVisibility('visible'));
  const ownedVisibleWaiting = await page.evaluate(() =>
    globalThis.__doomMusicVisibility.snapshot());
  await page.evaluate(() => globalThis.__doomMusicVisibility.releaseResume());
  try {
    await page.waitForFunction((previousResume) => {
      const audio = globalThis.__doomMusicVisibility.snapshot();
      return audio.resume > previousResume &&
        audio.resumeSettled === audio.resume &&
        audio.contextStates[0] === 'running';
    }, ownedResumePending.resume, { timeout: 5000 });
  } catch (error) {
    const state = await page.evaluate(() =>
      globalThis.__doomMusicVisibility.snapshot());
    throw new Error(`visibility-owned resume did not recover: ${JSON.stringify(state)}`, {
      cause: error,
    });
  }
  const ownedRecovered = await page.evaluate(() =>
    globalThis.__doomMusicVisibility.snapshot());

  // Sound shutdown owns its visibility listener and must prevent a later
  // event from recreating or touching the terminal AudioContext. The Doom-loop
  // timing listener has an independent lifecycle.
  const shutdown = await page.evaluate(async () => {
    const sound = await import('/src/i_sound.js');
    const main = await import('/src/d_main.js');
    const harness = globalThis.__doomMusicVisibility;
    const beforeSound = harness.snapshot();
    await sound.I_ShutdownSound();
    const afterSound = harness.snapshot();
    main.D_ShutdownDoomLoop();
    const afterLoop = harness.snapshot();
    harness.setVisibility('hidden');
    harness.setVisibility('visible');
    await Promise.resolve();
    return {
      beforeSound,
      afterSound,
      afterLoop,
      afterEvents: harness.snapshot(),
    };
  });

  const result = {
    before,
    hidden,
    resumed,
    gesturePending,
    gestureSilenced,
    gestureHidden,
    gestureResumed,
    rapid,
    hiddenStateChange,
    stateChangeResumed,
    ownedResumePending,
    ownedHidden,
    ownedVisibleWaiting,
    ownedRecovered,
    shutdown,
    errors,
  };
  const failures = [];
  if (before.musicPlaying !== true || before.loopRunning !== true ||
      before.audio.contextCount !== 1 || before.audio.contextStates[0] !== 'running' ||
      before.audio.listenerCount < 2) {
    failures.push(`active music setup: ${JSON.stringify(before)}`);
  }
  if (hidden.musicPlaying !== true || hidden.loopRunning !== true ||
      hidden.audio.contextCount !== 1 || hidden.audio.contextStates[0] !== 'suspended') {
    failures.push(`hidden audio: ${JSON.stringify(hidden)}`);
  }
  if (resumed.musicPlaying !== true || resumed.loopRunning !== true ||
      resumed.audio.contextCount !== 1 || resumed.audio.contextStates[0] !== 'running') {
    failures.push(`resumed audio: ${JSON.stringify(resumed)}`);
  }
  if (gesturePending.resumeHeld !== true ||
      gestureSilenced.resumeHeld !== true ||
      gestureSilenced.contextStates[0] !== 'suspended' ||
      gestureSilenced.suspend <= gesturePending.suspend ||
      gestureHidden.visibility !== 'hidden' || gestureHidden.contextCount !== 1 ||
      gestureHidden.contextStates[0] !== 'suspended' ||
      gestureResumed.visibility !== 'visible' || gestureResumed.contextCount !== 1 ||
      gestureResumed.contextStates[0] !== 'running') {
    failures.push(`gesture/hidden race: ${JSON.stringify({
      gesturePending,
      gestureSilenced,
      gestureHidden,
      gestureResumed,
    })}`);
  }
  if (rapid.visibility !== 'visible' || rapid.contextCount !== 1 ||
      rapid.contextStates[0] !== 'running') {
    failures.push(`rapid visibility transition: ${JSON.stringify(rapid)}`);
  }
  if (hiddenStateChange.visibility !== 'hidden' ||
      hiddenStateChange.contextStates[0] !== 'suspended' ||
      hiddenStateChange.suspend <= beforeStateChange.suspend ||
      stateChangeResumed.visibility !== 'visible' ||
      stateChangeResumed.contextStates[0] !== 'running') {
    failures.push(`hidden statechange reconciliation: ${JSON.stringify({
      hiddenStateChange,
      stateChangeResumed,
    })}`);
  }
  if (ownedResumePending.resumeHeld !== true ||
      ownedHidden.visibility !== 'hidden' || ownedHidden.resumeHeld !== true ||
      ownedHidden.contextStates[0] !== 'suspended' ||
      ownedVisibleWaiting.visibility !== 'visible' ||
      ownedVisibleWaiting.contextStates[0] !== 'suspended' ||
      ownedRecovered.visibility !== 'visible' ||
      ownedRecovered.contextStates[0] !== 'running' ||
      ownedRecovered.resume <= ownedResumePending.resume) {
    failures.push(`visibility-owned resume race: ${JSON.stringify({
      ownedResumePending,
      ownedHidden,
      ownedVisibleWaiting,
      ownedRecovered,
    })}`);
  }
  if (shutdown.afterSound.listenerCount !== shutdown.beforeSound.listenerCount - 1 ||
      shutdown.afterSound.close !== shutdown.beforeSound.close + 1 ||
      shutdown.afterSound.closeSettled !== shutdown.afterSound.close ||
      shutdown.afterSound.contextStates[0] !== 'closed') {
    failures.push(`sound visibility shutdown: ${JSON.stringify(shutdown)}`);
  }
  if (shutdown.afterLoop.listenerCount !== shutdown.afterSound.listenerCount - 1) {
    failures.push(`loop visibility shutdown: ${JSON.stringify(shutdown)}`);
  }
  if (shutdown.afterEvents.contextCount !== shutdown.afterLoop.contextCount ||
      shutdown.afterEvents.suspend !== shutdown.afterLoop.suspend ||
      shutdown.afterEvents.resume !== shutdown.afterLoop.resume ||
      shutdown.afterEvents.close !== shutdown.afterLoop.close) {
    failures.push(`post-shutdown visibility event: ${JSON.stringify(shutdown)}`);
  }
  if (errors.length !== 0) failures.push(`page errors: ${errors.join('; ')}`);
  if (failures.length !== 0) throw new Error(failures.join('\n'));
  console.log(JSON.stringify(result));
} finally {
  clearTimeout(watchdog);
  if (browser !== undefined) await browser.close();
}
