// Ported from: linuxdoom-1.10/i_main.c
// Main program, simply calls D_DoomMain.

import { M_InitArgvFromLocation } from './m_argv.js';
import { D_DoomMain } from './d_main.js';

window.addEventListener('error', (e) => {
  const status = document.getElementById('status');
  if (status) status.textContent = 'Error: ' + (e.error?.message ?? e.message);
});
window.addEventListener('doom:error', (e) => {
  const status = document.getElementById('status');
  if (status) status.textContent = 'I_Error: ' + e.detail;
});

M_InitArgvFromLocation();

// D_DoomMain returns a promise (it awaits the WAD fetch).
D_DoomMain().catch((err) => {
  console.error(err);
  const status = document.getElementById('status');
  if (status) status.textContent = 'Fatal: ' + err.message;
});
