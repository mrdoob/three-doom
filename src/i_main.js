// Ported from: linuxdoom-1.10/i_main.c
// Browser entry point and startup error boundary.

import { M_InitArgvFromLocation } from './m_argv.js';
import { I_ShowStartupError } from './i_startup_error.js';

async function startDoom() {
  try {
    // Query decoding can fail synchronously. Import the game dynamically so
    // module evaluation and asynchronous startup share this error boundary.
    M_InitArgvFromLocation();
    const { D_DoomMain } = await import('./d_main.js');
    await D_DoomMain();
  } catch (error) {
    console.error('DOOM startup failed:', error);
    I_ShowStartupError(error);
  }
}

void startDoom();
