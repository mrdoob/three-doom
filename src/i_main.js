// Ported from: linuxdoom-1.10/i_main.c
// Main program, simply calls D_DoomMain.

import { M_InitArgvFromLocation } from './m_argv.js';
import { D_DoomMain } from './d_main.js';

M_InitArgvFromLocation();

// D_DoomMain returns a promise (it awaits the WAD fetch).
D_DoomMain().catch((err) => { console.error(err); });
