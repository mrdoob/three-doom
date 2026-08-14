import {
  DOOM_QUIT_MESSAGES,
  M_ConfirmQuit,
  M_QuitMessageForTic,
  QUIT_CONFIRM_KEY,
  QUIT_LINK,
} from '../src/m_menu_quit_logic.js';

function assertEquals(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

Deno.test('quit messages follow the compiled 20-entry Linux Doom cycle', () => {
  assertEquals(DOOM_QUIT_MESSAGES, [
    "please don't leave, there's more\ndemons to toast!",
    "let's beat it -- this is turning\ninto a bloodbath!",
    "i wouldn't leave if i were you.\ndos is much worse.",
    "you're trying to say you like dos\nbetter than me, right?",
    "don't leave yet -- there's a\ndemon around that corner!",
    "ya know, next time you come in here\ni'm gonna toast ya.",
    'go ahead and leave. see if i care.you want to quit?\nthen, thou hast lost an eighth!',
    "don't go now, there's a \ndimensional shambler waiting\nat the dos prompt!",
    'get outta here and go back\nto your boring programs.',
    "if i were your boss, i'd \n deathmatch ya in a minute!",
    'look, bud. you leave now\nand you forfeit your body count!',
    "just leave. when you come\nback, i'll be waiting with a bat.",
    "you're lucky i don't smack\nyou for thinking about leaving.fuck you, pussy!\nget the fuck out!",
    "you quit and i'll jizz\nin your cystholes!",
    "if you leave, i'll make\nthe lord drink my jizz.",
    "hey, ron! can we say\n'fuck' in the game?",
    "i'd leave: this is just\nmore monsters and levels.\nwhat a load.",
    "suck it down, asshole!\nyou're a fucking wimp!",
    "don't quit now! we're \nstill spending your money!",
    'THIS IS NO MESSAGE!\nPage intentionally left blank.',
  ], 'compiled dstrings.c entries');

  for (let tic = 0; tic < 40; tic++) {
    assertEquals(
      M_QuitMessageForTic(tic),
      DOOM_QUIT_MESSAGES[tic % 20],
      `gametic ${tic}`,
    );
  }
});

Deno.test('quit confirmation opens the requested tab without shutting down Doom', () => {
  const calls = [];
  const state = { linkOpened: false };
  const confirmed = M_ConfirmQuit(
    QUIT_CONFIRM_KEY,
    state,
    (...args) => { calls.push(['open', ...args]); },
    () => { calls.push(['save']); },
  );
  assertEquals(confirmed, true, 'confirmation result');
  assertEquals(calls, [
    ['open', QUIT_LINK, '_blank', 'noopener,noreferrer'],
    ['save'],
  ], 'new-tab request and defaults save');
  assertEquals(state, { linkOpened: true }, 'open guard state');
});

Deno.test('non-Y responses do not open the link', () => {
  const calls = [];
  const confirmed = M_ConfirmQuit(
    0x6e /*n*/,
    { linkOpened: false },
    () => { calls.push('open'); },
    () => { calls.push('save'); },
  );
  assertEquals(confirmed, false, 'decline result');
  assertEquals(calls, [], 'decline side effects');
});

Deno.test('popup failure still consumes the confirmation', () => {
  const calls = [];
  const confirmed = M_ConfirmQuit(
    QUIT_CONFIRM_KEY,
    { linkOpened: false },
    () => { calls.push('open'); throw new Error('blocked'); },
    () => { calls.push('save'); },
  );
  assertEquals(confirmed, true, 'blocked-popup result');
  assertEquals(calls, ['open', 'save'], 'blocked-popup attempt');
});

Deno.test('repeated confirmation callback opens at most one tab', () => {
  const calls = [];
  const state = { linkOpened: false };
  const open = () => { calls.push('open'); };
  const save = () => { calls.push('save'); };
  M_ConfirmQuit(QUIT_CONFIRM_KEY, state, open, save);
  M_ConfirmQuit(QUIT_CONFIRM_KEY, state, open, save);
  assertEquals(calls, ['open', 'save', 'save'], 'repeated confirmation');
});
