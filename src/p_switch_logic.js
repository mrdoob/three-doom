// Renderer-free button-slot allocation from p_switch.c:P_StartButton.
// Kept separate so the fixed-capacity behavior can be tested without loading
// the browser renderer dependencies imported by p_switch.js.

export function P_StartButtonInList(buttonlist, line, where, texture, time, fail) {
  // Pressing an already-running button does not consume another slot.
  for (const button of buttonlist) {
    if (button.btimer !== 0 && button.line === line) return;
  }

  for (const button of buttonlist) {
    if (button.btimer !== 0) continue;
    button.line = line;
    button.where = where;
    button.btexture = texture;
    button.btimer = time;
    return;
  }

  fail('P_StartButton: no button slots left!');
}
