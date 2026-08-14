import { D_ShouldStartWipe } from '../src/d_display_logic.js';

const mainSource = await Deno.readTextFile(new URL('../src/d_main.js', import.meta.url));
const wipeSource = await Deno.readTextFile(new URL('../src/f_wipe.js', import.meta.url));
const finaleSource = await Deno.readTextFile(new URL('../src/f_finale.js', import.meta.url));
const gameSource = await Deno.readTextFile(new URL('../src/g_game.js', import.meta.url));

Deno.test('wipe transition predicate follows wipegamestate and does not re-enter', () => {
  if (D_ShouldStartWipe(0, 0, false)) throw new Error('equal states started a wipe');
  if (!D_ShouldStartWipe(2, 0, false)) throw new Error('state transition did not start a wipe');
  if (!D_ShouldStartWipe(2, -1, false)) throw new Error('forced finale wipe was ignored');
  if (D_ShouldStartWipe(2, -1, true)) throw new Error('active wipe was re-entered');
});

Deno.test('D_Display captures, composes, starts, and steps wipes in reference order', () => {
  const start = mainSource.indexOf('function D_Display()');
  const end = mainSource.indexOf('// D_DoomLoop:', start);
  const display = mainSource.slice(start, end);
  const startScreen = display.indexOf('_fwipeStart(0, 0, SCREENWIDTH, SCREENHEIGHT)');
  const palette = display.indexOf('I_SetPaletteIndex(0)', startScreen);
  const stateDrawer = display.lastIndexOf('_fDrawer(');
  const pause = display.indexOf('D_DrawPausePatch(overlay)', stateDrawer);
  const firstMenu = display.indexOf('_menuDrawer(overlay, 0, 0, _overlayCanvas.width, _overlayCanvas.height)', pause);
  const endScreen = display.indexOf('_fwipeEnd(0, 0, SCREENWIDTH, SCREENHEIGHT)', firstMenu);
  const step = display.indexOf('_fwipeStep(0, 0, 0, SCREENWIDTH, SCREENHEIGHT, tics)', endScreen);
  const completionGate = display.indexOf(
    'const wipeStillActive = _fwipeActive !== null && _fwipeActive()',
    step,
  );
  const draw = display.indexOf('_fwipeDraw(', step);
  const secondMenu = display.indexOf('_menuDrawer(overlay, 0, 0, _overlayCanvas.width, _overlayCanvas.height)', firstMenu + 1);
  const record = display.indexOf('_fwipeRecord()', draw);

  if (start < 0 || end < 0 || startScreen < 0 || palette <= startScreen ||
      stateDrawer <= palette || pause <= stateDrawer || firstMenu <= pause ||
      endScreen <= firstMenu || step <= endScreen || completionGate <= step ||
      draw <= completionGate ||
      secondMenu <= draw || record <= secondMenu) {
    throw new Error('D_Display wipe order is not start -> draw/UI -> end -> step -> wipe/menu -> record');
  }
  if (!display.slice(completionGate, draw).includes('if (wipeStillActive')) {
    throw new Error('completed wipe still clears the fully drawn destination frame');
  }

  const loopStart = mainSource.indexOf('async function D_DoomLoop()');
  const loop = mainSource.slice(loopStart);
  if (loop.includes('_fwipeStep(')) {
    throw new Error('wipe stepping escaped D_Display into the simulation ticker');
  }
  if (!display.slice(step, draw).includes('R_CalculateCanvasView(cw, ch)')) {
    throw new Error('wipe presentation is not confined to the logical 320x200 screen');
  }
});

Deno.test('active wipes gate the complete simulation tic pipeline', () => {
  const loopStart = mainSource.indexOf('async function D_DoomLoop()');
  const loop = mainSource.slice(loopStart);
  const wipeGate = loop.indexOf('const wipeActive = _fwipeActive !== null && _fwipeActive() === true');
  const clock = loop.indexOf('D_AdvanceSimulationClock(_ticAccum, dt, wipeActive', wipeGate);
  const ticLoop = loop.indexOf('while (dueTics-- > 0)', clock);
  const display = loop.indexOf('D_Display()', ticLoop);
  if (wipeGate < 0 || clock <= wipeGate || ticLoop <= clock || display <= ticLoop) {
    throw new Error('wipe gate is not ahead of the complete tic loop');
  }
  for (const ticker of [
    'D_KeyboardInput.buildCmd',
    '_menuTicker()',
    '_gTicker()',
    '_pTicker()',
    '_wiTicker()',
    '_fTicker()',
    'D_PageTicker()',
    'set_gametic(doomstat.gametic + 1)',
  ]) {
    const position = loop.indexOf(ticker, ticLoop);
    if (position <= ticLoop || position >= display) {
      throw new Error(`${ticker} escaped the wipe-gated tic loop`);
    }
  }
});

Deno.test('wipe snapshots compose WebGL below the Canvas overlay', () => {
  const capture = wipeSource.slice(
    wipeSource.indexOf('function _captureComposedFrame'),
    wipeSource.indexOf('function _copyCanvas'),
  );
  const webgl = capture.indexOf('ctx.drawImage(\n          rendererCanvas');
  const overlay = capture.indexOf('ctx.drawImage(overlay');
  if (webgl < 0 || overlay <= webgl) {
    throw new Error('composed wipe frame does not draw WebGL before the UI overlay');
  }
  if (!wipeSource.includes('export function wipe_RecordScreen()') ||
      !wipeSource.includes('_presentCanvas === null')) {
    throw new Error('wipe start does not retain the last completed composed frame');
  }
  if (!capture.includes('layout.screenX * scaleX') ||
      !capture.includes('layout.screenY * scaleY') ||
      !capture.includes('layout.screenX,') ||
      !capture.includes('layout.screenY,')) {
    throw new Error('wipe capture does not crop WebGL and Canvas to the logical screen');
  }
});

Deno.test('same-state finale and level transitions force wipes', () => {
  const stageChange = finaleSource.slice(
    finaleSource.indexOf("if (_stage === 0 && _finalecount"),
    finaleSource.indexOf('const _flatCanvasCache'),
  );
  const startCast = finaleSource.slice(
    finaleSource.indexOf('export function F_StartCast()'),
    finaleSource.indexOf('export function F_CastTicker()'),
  );
  const loadLevel = gameSource.slice(
    gameSource.indexOf('export function G_DoLoadLevel()'),
    gameSource.indexOf('export function G_DeferedInitNew'),
  );
  if (!stageChange.includes('set_wipegamestate(-1)')) {
    throw new Error('Doom 1 finale text-to-art transition does not force a wipe');
  }
  if (!startCast.includes('set_wipegamestate(-1)')) {
    throw new Error('MAP30 cast transition does not force a wipe');
  }
  if (!loadLevel.includes('wipegamestate === gamestate_t.GS_LEVEL') ||
      !loadLevel.includes('set_wipegamestate(-1)')) {
    throw new Error('same-state level load does not force a wipe');
  }
});
