// Headless integration check for DOM input responder precedence. Start a
// static server at the repository root, then run with:
//   NODE_PATH=/path/to/node_modules node tests/input_responder_playwright.mjs

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const launchOptions = { headless: true };
if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
  launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
}

let browser = null;
const watchdog = setTimeout(() => {
  console.error('input responder Playwright test exceeded 60 seconds');
  process.exit(1);
}, 60000);
const pageErrors = [];

try {
  browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const baseUrl = process.env.DOOM_URL ?? 'http://127.0.0.1:8094/';
  const url = new URL(baseUrl);
  url.searchParams.set('-map', 'E1M1');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    window.renderer !== undefined &&
    window.scene?.getObjectByName('level') !== undefined &&
    window.renderer.info.render.frame > 2,
  { timeout: 30000 });

  const result = await page.evaluate(async () => {
    const keyboard = await import('/src/d_keyboard.js');
    await import('/src/am_map.js');
    const cheat = await import('/src/m_cheat.js');
    const events = await import('/src/d_event.js');
    const doomstat = await import('/src/doomstat.js');
    const finale = await import('/src/f_finale.js');
    const game = await import('/src/g_game.js');
    const menu = await import('/src/m_menu.js');
    const loop = await import('/src/d_loop.js');

    // Own the clock so the production loop cannot consume input between a DOM
    // event and the command sampled immediately after it.
    loop.D_DoomRafLoop.stop();
    keyboard.D_KeyboardInput.shutdown();
    keyboard.D_KeyboardInput.init(null);
    doomstat.set_gamestate(0 /*GS_LEVEL*/);
    doomstat.set_demoplayback(false);
    doomstat.set_netgame(true);
    menu.M_ClearMenus();

    const canvas = window.renderer.domElement;
    let lockedCanvas = null;
    let pointerRequests = 0;
    Object.defineProperty(document, 'pointerLockElement', {
      configurable: true,
      get: () => lockedCanvas,
    });
    Object.defineProperty(canvas, 'requestPointerLock', {
      configurable: true,
      value: () => { pointerRequests++; lockedCanvas = canvas; },
    });

    const player = { cmd: {} };
    const sample = () => {
      keyboard.D_KeyboardInput.buildCmd(player);
      return {
        forwardmove: player.cmd.forwardmove,
        sidemove: player.cmd.sidemove,
        angleturn: player.cmd.angleturn,
        buttons: player.cmd.buttons,
      };
    };
    const key = (type, code, value) => document.dispatchEvent(new KeyboardEvent(type, {
      code,
      key: value,
      bubbles: true,
      cancelable: true,
    }));
    const mouseMove = (x, y) => {
      const event = new MouseEvent('mousemove', { bubbles: true, cancelable: true });
      Object.defineProperties(event, {
        movementX: { value: x },
        movementY: { value: y },
      });
      document.dispatchEvent(event);
    };

    // A press captured before the menu remains vanilla gameplay state until
    // its keyup. The release must still clear it while a netgame menu is open.
    key('keydown', 'KeyW', 'w');
    const beforeMenu = sample();
    menu.M_StartControlPanel();
    key('keyup', 'KeyW', 'w');
    const releasedInMenu = sample();

    // Navigation keys consumed by M_Responder must not enter the gameplay
    // state even while a netgame continues ticking behind the menu.
    key('keydown', 'ArrowUp', 'ArrowUp');
    key('keydown', 'ArrowRight', 'ArrowRight');
    const menuKeys = sample();
    key('keyup', 'ArrowUp', 'ArrowUp');
    key('keyup', 'ArrowRight', 'ArrowRight');

    // m_menu.c returns false for a key with no matching alphaKey, allowing
    // G_Responder to see it. W is not a shortcut on MainDef.
    key('keydown', 'KeyW', 'w');
    const unsupportedMenuKey = sample();
    key('keyup', 'KeyW', 'w');
    const unsupportedMenuReleased = sample();

    // A menu-consumed mouse press cannot become BT_ATTACK or recapture the
    // pointer; locked motion is likewise unavailable to gameplay.
    lockedCanvas = canvas;
    document.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
    mouseMove(7, -3);
    const menuMouse = sample();
    const menuPointerRequests = pointerRequests;
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));

    // Outside the menu the same browser event still reaches gameplay and the
    // interactive level is allowed to reacquire pointer lock.
    menu.M_ClearMenus();
    lockedCanvas = null;
    document.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
    const gameplayMouse = sample();
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
    const gameplayRelease = sample();

    // Navigate the real Options menu to its Mouse Sensitivity slider. The
    // slider's live doomstat binding must feed the DOM movement adapter, whose
    // 7-pixel axes truncate at sensitivity 4 from 6.3 to 6.
    key('keydown', 'Escape', 'Escape');
    key('keydown', 'ArrowDown', 'ArrowDown');
    key('keydown', 'ArrowDown', 'ArrowDown');
    key('keydown', 'Enter', 'Enter');
    key('keydown', 'ArrowDown', 'ArrowDown');
    key('keydown', 'ArrowDown', 'ArrowDown');
    key('keydown', 'ArrowDown', 'ArrowDown');
    const sensitivityBefore = doomstat.mouseSensitivity;
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    const sensitivityAfter = doomstat.mouseSensitivity;
    key('keydown', 'Escape', 'Escape');
    lockedCanvas = canvas;
    mouseMove(7, -7);
    const sensitivityMovement = sample();

    // Browsers may omit the matching keyup/mouseup when focus moves to
    // another window. Blur must clear held keys/buttons, queued Pause, and
    // pointer axes while keeping the installed adapter ready for new input.
    key('keydown', 'KeyW', 'w');
    key('keydown', 'ControlLeft', 'Control');
    key('keydown', 'Space', ' ');
    key('keydown', 'Pause', 'Pause');
    lockedCanvas = canvas;
    document.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
    mouseMove(11, -7);
    const heldBeforeBlur = keyboard.D_KeyboardInput.isPressed('KeyW');
    window.dispatchEvent(new Event('blur'));
    const afterBlur = sample();
    const heldAfterBlur = keyboard.D_KeyboardInput.isPressed('KeyW');
    key('keyup', 'KeyW', 'w');
    key('keyup', 'ControlLeft', 'Control');
    key('keyup', 'Space', ' ');
    key('keyup', 'Pause', 'Pause');
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));

    // Turning accelerates after six tics. A focus boundary starts a new
    // gesture even if a fresh keydown arrives before any neutral ticcmd.
    key('keydown', 'ArrowRight', 'ArrowRight');
    let acceleratedTurn = null;
    for (let i = 0; i < 7; i++) acceleratedTurn = sample();
    window.dispatchEvent(new Event('blur'));
    key('keydown', 'ArrowLeft', 'ArrowLeft');
    const turnAfterBlur = sample();
    key('keyup', 'ArrowRight', 'ArrowRight');
    key('keyup', 'ArrowLeft', 'ArrowLeft');

    // Focus loss also ends a mouse gesture. A click before leaving the page
    // must not become the first half of a double-click Use after returning.
    window.dispatchEvent(new Event('blur'));
    for (let i = 0; i < 3; i++) sample();
    lockedCanvas = canvas;
    document.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true }));
    const rightClickBeforeBlur = sample();
    window.dispatchEvent(new Event('blur'));
    for (let i = 0; i < 6; i++) sample();
    document.dispatchEvent(new MouseEvent('mousedown', { button: 2, bubbles: true, cancelable: true }));
    const rightClickAfterBlur = sample();
    document.dispatchEvent(new MouseEvent('mouseup', { button: 2, bubbles: true, cancelable: true }));

    // A visible visibilitychange is not an ownership loss. Once hidden, the
    // same complete reset applies; becoming visible must leave input live.
    let forcedVisibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => forcedVisibility,
    });
    key('keydown', 'KeyW', 'w');
    document.dispatchEvent(new Event('visibilitychange'));
    const heldAfterVisibleEvent = keyboard.D_KeyboardInput.isPressed('KeyW');
    key('keyup', 'KeyW', 'w');
    sample();
    key('keydown', 'KeyW', 'w');
    key('keydown', 'ControlLeft', 'Control');
    key('keydown', 'Pause', 'Pause');
    lockedCanvas = canvas;
    document.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
    mouseMove(13, -9);
    forcedVisibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    const afterHidden = sample();
    const heldAfterHidden = keyboard.D_KeyboardInput.isPressed('KeyW');
    key('keyup', 'KeyW', 'w');
    key('keyup', 'ControlLeft', 'Control');
    key('keyup', 'Pause', 'Pause');
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
    forcedVisibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.visibilityState;
    key('keydown', 'KeyW', 'w');
    const listenerAfterVisibility = sample();
    key('keyup', 'KeyW', 'w');
    sample();

    // Stage every command-building input, including the queued Pause special,
    // then run the real G_DoLoadLevel -> d_main loadLevel path. The new level
    // must start neutral, and its already-installed listener must stay live.
    doomstat.set_mouseSensitivity(5);
    doomstat.set_paused(true);
    key('keydown', 'KeyW', 'w');
    key('keydown', 'ControlLeft', 'Control');
    key('keydown', 'Space', ' ');
    key('keydown', 'Pause', 'Pause');
    lockedCanvas = canvas;
    document.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
    mouseMove(9, -5);
    game.G_DoLoadLevel();
    const afterLevelLoad = sample();
    const pausedAfterLevelLoad = doomstat.paused;
    key('keydown', 'KeyW', 'w');
    const listenerAfterLevelLoad = sample();
    key('keyup', 'KeyW', 'w');
    key('keyup', 'ControlLeft', 'Control');
    key('keyup', 'Space', ' ');
    key('keyup', 'Pause', 'Pause');
    document.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
    sample();

    // G_BuildTiccmd runs outside GS_LEVEL too. A weapon key therefore remains
    // a nonzero finale button byte, and Pause is encoded as the same special
    // command G_Ticker processes before F_Ticker.
    doomstat.set_gamestate(2 /*GS_FINALE*/);
    key('keydown', 'Digit3', '3');
    const finaleWeapon = sample();
    key('keyup', 'Digit3', '3');
    key('keydown', 'Pause', 'Pause');
    const finalePause = sample();
    key('keyup', 'Pause', 'Pause');
    doomstat.set_gamestate(0 /*GS_LEVEL*/);

    // Demo interception is independent of gamestate. Both keyboard and mouse
    // button presses during a demo intermission open the menu without entering
    // the live command state.
    doomstat.set_gamestate(1 /*GS_INTERMISSION*/);
    doomstat.set_demoplayback(true);
    menu.M_ClearMenus();
    lockedCanvas = canvas;
    mouseMove(4, -6);
    const demoMotion = sample();
    key('keydown', 'ControlLeft', 'Control');
    const demoKeyboard = sample();
    const demoKeyboardMenu = doomstat.menuactive;
    key('keyup', 'ControlLeft', 'Control');
    menu.M_ClearMenus();
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
    canvas.dispatchEvent(new MouseEvent('click', { button: 0, bubbles: true, cancelable: true }));
    const demoMouse = sample();
    const demoMouseMenu = doomstat.menuactive;
    canvas.dispatchEvent(new MouseEvent('mouseup', { button: 0, bubbles: true, cancelable: true }));
    menu.M_ClearMenus();
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 1, buttons: 4, bubbles: true, cancelable: true }));
    const demoMiddleMenu = doomstat.menuactive;
    canvas.dispatchEvent(new MouseEvent('mouseup', { button: 1, bubbles: true, cancelable: true }));
    menu.M_ClearMenus();
    canvas.dispatchEvent(new MouseEvent('mousedown', { button: 2, buttons: 2, bubbles: true, cancelable: true }));
    const demoRightMenu = doomstat.menuactive;
    canvas.dispatchEvent(new MouseEvent('mouseup', { button: 2, bubbles: true, cancelable: true }));

    // Explicit -playdemo mode and queued game actions bypass the attract-menu
    // interception exactly as G_Responder's two guards require.
    menu.M_ClearMenus();
    doomstat.set_singledemo(true);
    key('keydown', 'ControlLeft', 'Control');
    const singleDemoInput = sample();
    const singleDemoMenu = doomstat.menuactive;
    key('keyup', 'ControlLeft', 'Control');
    doomstat.set_singledemo(false);
    doomstat.set_gameaction(events.gameaction_t.ga_worlddone);
    key('keydown', 'ControlLeft', 'Control');
    const queuedActionInput = sample();
    const queuedActionMenu = doomstat.menuactive;
    key('keyup', 'ControlLeft', 'Control');
    doomstat.set_gameaction(events.gameaction_t.ga_nothing);
    doomstat.set_demoplayback(false);
    doomstat.set_gamestate(0 /*GS_LEVEL*/);

    // F_Responder precedes KEY_PAUSE during the MAP30 cast. Pause must kill
    // the actor and be consumed instead of latching BT_SPECIAL|BTS_PAUSE.
    menu.M_ClearMenus();
    finale.F_StartFinale();
    finale.F_StartCast();
    key('keydown', 'Pause', 'Pause');
    const castPause = sample();
    key('keyup', 'Pause', 'Pause');
    const castWasActive = finale.F_CastActive();
    finale.F_Shutdown();
    doomstat.set_gamestate(0 /*GS_LEVEL*/);
    const netgameDuringCheck = doomstat.netgame;

    // ST_Responder returns before advancing any cheat sequence in a netgame.
    const gamePlayer = doomstat.players[doomstat.consoleplayer];
    gamePlayer.cheats &= ~2; // CF_GODMODE
    for (const ch of 'iddq') cheat.cht_HandleKey(ch.charCodeAt(0));
    const godAfterNetPrefix = (gamePlayer.cheats & 2) !== 0;
    doomstat.set_netgame(false);
    cheat.cht_HandleKey('d'.charCodeAt(0));
    const godAfterNetSuffix = (gamePlayer.cheats & 2) !== 0;
    for (const ch of 'iddqd') cheat.cht_HandleKey(ch.charCodeAt(0));
    const godAfterLiveCheat = (gamePlayer.cheats & 2) !== 0;
    gamePlayer.cheats &= ~2;

    // Closed-map minus belongs to M_Responder's view-size shortcut. Once Tab
    // opens automap, every IDFA letter still reaches the cheat sequencer and F
    // then fans out to the active map responder.
    const blocksBeforeMinus = menu.getScreenblocks();
    key('keydown', 'Minus', '-');
    key('keyup', 'Minus', '-');
    const blocksAfterMinus = menu.getScreenblocks();
    const mapBeforeTab = doomstat.automapactive;
    key('keydown', 'Tab', 'Tab');
    key('keyup', 'Tab', 'Tab');
    for (const [code, value] of [['KeyI', 'i'], ['KeyD', 'd'], ['KeyF', 'f'], ['KeyA', 'a']]) {
      key('keydown', code, value);
      key('keyup', code, value);
    }
    for (let i = 0; i < 100; i++) {
      if (doomstat.automapactive === true &&
          doomstat.players[doomstat.consoleplayer]?.armorpoints === 200) break;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const mapAfterIdfa = doomstat.automapactive;
    const armorAfterIdfa = doomstat.players[doomstat.consoleplayer]?.armorpoints;
    key('keydown', 'Tab', 'Tab');
    key('keyup', 'Tab', 'Tab');

    keyboard.D_KeyboardInput.shutdown();
    doomstat.set_netgame(false);
    doomstat.set_mouseSensitivity(5);
    menu.M_ClearMenus();
    return {
      beforeMenu,
      releasedInMenu,
      menuKeys,
      unsupportedMenuKey,
      unsupportedMenuReleased,
      menuMouse,
      menuPointerRequests,
      gameplayMouse,
      gameplayRelease,
      pointerRequests,
      netgameDuringCheck,
      godAfterNetPrefix,
      godAfterNetSuffix,
      godAfterLiveCheat,
      sensitivityBefore,
      sensitivityAfter,
      sensitivityMovement,
      heldBeforeBlur,
      afterBlur,
      heldAfterBlur,
      acceleratedTurn,
      turnAfterBlur,
      rightClickBeforeBlur,
      rightClickAfterBlur,
      heldAfterVisibleEvent,
      afterHidden,
      heldAfterHidden,
      listenerAfterVisibility,
      afterLevelLoad,
      pausedAfterLevelLoad,
      listenerAfterLevelLoad,
      finaleWeapon,
      finalePause,
      expectedFinaleWeapon: events.BT_CHANGE | (2 << events.BT_WEAPONSHIFT),
      expectedFinalePause: events.BT_SPECIAL | events.BTS_PAUSE,
      demoKeyboard,
      demoKeyboardMenu,
      demoMotion,
      demoMouse,
      demoMouseMenu,
      demoMiddleMenu,
      demoRightMenu,
      singleDemoInput,
      singleDemoMenu,
      queuedActionInput,
      queuedActionMenu,
      castPause,
      castWasActive,
      blocksBeforeMinus,
      blocksAfterMinus,
      mapBeforeTab,
      mapAfterIdfa,
      armorAfterIdfa,
    };
  });

  const zero = (cmd) => cmd.forwardmove === 0 && cmd.sidemove === 0 &&
    cmd.angleturn === 0 && cmd.buttons === 0;
  const failures = [];
  if (result.beforeMenu.forwardmove !== 25) failures.push('gameplay keydown was not captured before menu');
  if (!zero(result.releasedInMenu)) failures.push('keyup did not clear movement while menu was open');
  if (!zero(result.menuKeys)) failures.push('menu-consumed keyboard input leaked into ticcmd');
  if (result.unsupportedMenuKey.forwardmove !== 25 ||
      !zero(result.unsupportedMenuReleased)) {
    failures.push(`unsupported menu key did not fall through: ${JSON.stringify({
      down: result.unsupportedMenuKey,
      up: result.unsupportedMenuReleased,
    })}`);
  }
  if (!zero(result.menuMouse)) failures.push('menu-consumed mouse input leaked into ticcmd');
  if (result.menuPointerRequests !== 0) failures.push('menu mouse press recaptured pointer lock');
  if ((result.gameplayMouse.buttons & 1) === 0) failures.push('gameplay mouse press did not set BT_ATTACK');
  if (!zero(result.gameplayRelease)) failures.push('mouseup did not clear gameplay button');
  if (result.pointerRequests !== 1) failures.push(`pointer lock requests: expected 1, got ${result.pointerRequests}`);
  if (result.netgameDuringCheck !== true) failures.push('netgame responder case was not exercised');
  if (result.godAfterNetPrefix !== false || result.godAfterNetSuffix !== false ||
      result.godAfterLiveCheat !== true) {
    failures.push(`netgame cheat guard mismatch: prefix=${result.godAfterNetPrefix}, suffix=${result.godAfterNetSuffix}, live=${result.godAfterLiveCheat}`);
  }
  if (result.sensitivityBefore !== 5 || result.sensitivityAfter !== 4) {
    failures.push(`mouse slider did not update doomstat (before ${result.sensitivityBefore}, after ${result.sensitivityAfter})`);
  }
  if (result.sensitivityMovement.forwardmove !== 6 ||
      result.sensitivityMovement.sidemove !== 0 ||
      result.sensitivityMovement.angleturn !== -48 ||
      result.sensitivityMovement.buttons !== 0) {
    failures.push(`scaled mouse movement mismatch: ${JSON.stringify(result.sensitivityMovement)}`);
  }
  if (result.heldBeforeBlur !== true || result.heldAfterBlur !== false ||
      !zero(result.afterBlur)) {
    failures.push(`blur retained input: ${JSON.stringify({
      before: result.heldBeforeBlur,
      after: result.heldAfterBlur,
      cmd: result.afterBlur,
    })}`);
  }
  if (result.acceleratedTurn.angleturn !== -640 || result.turnAfterBlur.angleturn !== 320) {
    failures.push(`blur retained turn acceleration: ${JSON.stringify({
      before: result.acceleratedTurn,
      after: result.turnAfterBlur,
    })}`);
  }
  if (result.rightClickBeforeBlur.forwardmove !== 25 ||
      (result.rightClickBeforeBlur.buttons & 2) !== 0 ||
      result.rightClickAfterBlur.forwardmove !== 25 ||
      (result.rightClickAfterBlur.buttons & 2) !== 0) {
    failures.push(`blur joined separate mouse clicks: ${JSON.stringify({
      before: result.rightClickBeforeBlur,
      after: result.rightClickAfterBlur,
    })}`);
  }
  if (result.heldAfterVisibleEvent !== true || result.heldAfterHidden !== false ||
      !zero(result.afterHidden) || result.listenerAfterVisibility.forwardmove !== 25) {
    failures.push(`visibility input reset mismatch: ${JSON.stringify({
      visibleHeld: result.heldAfterVisibleEvent,
      hiddenHeld: result.heldAfterHidden,
      hiddenCmd: result.afterHidden,
      resumedCmd: result.listenerAfterVisibility,
    })}`);
  }
  if (!zero(result.afterLevelLoad) || result.pausedAfterLevelLoad !== false) {
    failures.push(`level load retained input/pause: ${JSON.stringify({
      cmd: result.afterLevelLoad,
      paused: result.pausedAfterLevelLoad,
    })}`);
  }
  if (result.listenerAfterLevelLoad.forwardmove !== 25) {
    failures.push('level input reset removed or disabled the DOM listener');
  }
  if (result.finaleWeapon.buttons !== result.expectedFinaleWeapon) {
    failures.push(`finale weapon command mismatch: ${JSON.stringify(result.finaleWeapon)}`);
  }
  if (result.finalePause.buttons !== result.expectedFinalePause) {
    failures.push(`finale Pause command mismatch: ${JSON.stringify(result.finalePause)}`);
  }
  if (!zero(result.demoKeyboard) || result.demoKeyboardMenu !== true) {
    failures.push(`demo-intermission key leaked or missed menu: ${JSON.stringify(result.demoKeyboard)}`);
  }
  if (result.demoMotion.forwardmove !== 6 || result.demoMotion.sidemove !== 0 ||
      result.demoMotion.angleturn !== -32 || result.demoMotion.buttons !== 0) {
    failures.push(`zero-button demo motion was swallowed: ${JSON.stringify(result.demoMotion)}`);
  }
  if (!zero(result.demoMouse) || result.demoMouseMenu !== true) {
    failures.push(`demo-intermission mouse leaked or missed menu: ${JSON.stringify(result.demoMouse)}`);
  }
  if (result.demoMiddleMenu !== true || result.demoRightMenu !== true) {
    failures.push(`non-primary demo mouse did not open menu: middle=${result.demoMiddleMenu}, right=${result.demoRightMenu}`);
  }
  if ((result.singleDemoInput.buttons & 1) === 0 || result.singleDemoMenu !== false) {
    failures.push(`singledemo input was intercepted: ${JSON.stringify(result.singleDemoInput)}`);
  }
  if ((result.queuedActionInput.buttons & 1) === 0 || result.queuedActionMenu !== false) {
    failures.push(`queued-action input was intercepted: ${JSON.stringify(result.queuedActionInput)}`);
  }
  if (!zero(result.castPause) || result.castWasActive !== true) {
    failures.push(`cast did not consume Pause before ticcmd capture: ${JSON.stringify(result.castPause)}`);
  }
  if (result.blocksAfterMinus !== result.blocksBeforeMinus - 1 || result.mapBeforeTab !== false) {
    failures.push(`closed-map minus routing mismatch: ${result.blocksBeforeMinus} -> ${result.blocksAfterMinus}`);
  }
  if (result.mapAfterIdfa !== true || result.armorAfterIdfa !== 200) {
    failures.push(`IDFA/automap fan-out mismatch: map=${result.mapAfterIdfa}, armor=${result.armorAfterIdfa}`);
  }
  if (pageErrors.length !== 0) failures.push(`page errors: ${pageErrors.join('; ')}`);
  if (failures.length !== 0) throw new Error(failures.join('\n'));
  console.log(JSON.stringify(result));
} finally {
  if (browser !== null) await browser.close();
  clearTimeout(watchdog);
}
