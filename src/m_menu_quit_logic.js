// Browser-specific destination shown after the player confirms Quit.
export const QUIT_LINK = 'https://x.com/mrdoob/status/2059803097367732614';
export const QUIT_CONFIRM_KEY = 0x79; // lowercase y

// The checked-in Linux Doom dstrings.c omits a comma at each game-family
// boundary. C concatenates those adjacent literals, leaving exactly the 20
// entries selected by (gametic % (NUM_QUITMESSAGES - 2)) + 1. Preserve the
// compiled table, including its reachable internal-debug entry.
export const DOOM_QUIT_MESSAGES = Object.freeze([
  "please don't leave, there's more\ndemons to toast!",
  "let's beat it -- this is turning\ninto a bloodbath!",
  "i wouldn't leave if i were you.\ndos is much worse.",
  "you're trying to say you like dos\nbetter than me, right?",
  "don't leave yet -- there's a\ndemon around that corner!",
  "ya know, next time you come in here\ni'm gonna toast ya.",
  'go ahead and leave. see if i care.' +
    'you want to quit?\nthen, thou hast lost an eighth!',
  "don't go now, there's a \ndimensional shambler waiting\nat the dos prompt!",
  'get outta here and go back\nto your boring programs.',
  "if i were your boss, i'd \n deathmatch ya in a minute!",
  'look, bud. you leave now\nand you forfeit your body count!',
  "just leave. when you come\nback, i'll be waiting with a bat.",
  "you're lucky i don't smack\nyou for thinking about leaving." +
    'fuck you, pussy!\nget the fuck out!',
  "you quit and i'll jizz\nin your cystholes!",
  "if you leave, i'll make\nthe lord drink my jizz.",
  "hey, ron! can we say\n'fuck' in the game?",
  "i'd leave: this is just\nmore monsters and levels.\nwhat a load.",
  "suck it down, asshole!\nyou're a fucking wimp!",
  "don't quit now! we're \nstill spending your money!",
  'THIS IS NO MESSAGE!\nPage intentionally left blank.',
]);

export function M_QuitMessageForTic(gametic) {
  let index = Math.trunc(gametic) % DOOM_QUIT_MESSAGES.length;
  if (index < 0) index += DOOM_QUIT_MESSAGES.length;
  return DOOM_QUIT_MESSAGES[index];
}

export function M_ConfirmQuit(key, state, openTab, saveDefaults) {
  if (key !== QUIT_CONFIRM_KEY) return false;

  // Keep this synchronous: browsers grant popup permission only while the
  // keyboard/click user activation is still on the stack. The browser port
  // leaves Doom running in the original page after opening the farewell tab.
  if (state.linkOpened !== true) {
    state.linkOpened = true;
    try {
      if (typeof openTab === 'function') {
        openTab(QUIT_LINK, '_blank', 'noopener,noreferrer');
      }
    } catch {
      // Dismiss the prompt even when the browser refuses the new tab.
    }
  }
  saveDefaults();
  return true;
}
