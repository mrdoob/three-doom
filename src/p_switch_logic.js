// Renderer-free button-slot lifecycle from p_switch.c:P_StartButton and
// p_spec.c:P_UpdateSpecials/P_SpawnSpecials. Kept separate so the fixed-capacity
// behavior can be tested without loading the browser renderer dependencies
// imported by p_switch.js.

function P_ClearButtonSlot(button) {
  button.line = null;
  button.where = 0;
  button.btexture = 0;
  button.btimer = 0;
}

export function P_ResetButtonsInList(buttonlist) {
  for (const button of buttonlist) P_ClearButtonSlot(button);
}

export function P_UpdateButtonsInList(buttonlist, onElapsed) {
  for (const button of buttonlist) {
    if (button.btimer === 0) continue;
    button.btimer--;
    if (button.btimer !== 0) continue;
    onElapsed(button);
    P_ClearButtonSlot(button);
  }
}

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
