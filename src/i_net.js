// Ported from: linuxdoom-1.10/i_net.c, i_net.h
// Network interface — single-player browser port has no UDP, so this is a
// behaviour-faithful single-player stub: I_InitNetwork sets up a doomcom with
// numplayers=1 and netgame=false; I_NetCmd is a no-op. Matches the C path when
// the `-net` argv parameter is absent.

import { M_CheckParm } from './m_argv.js';
import { I_Error } from './i_system.js';

export const DOOMCOM_ID = 0x12345678; // vanilla magic
export const MAXNETNODES = 8;
export const CMD_SEND = 1;
export const CMD_GET  = 2;
export const NCMD_EXIT       = 0x80000000;
export const NCMD_RETRANSMIT = 0x40000000;
export const NCMD_SETUP      = 0x20000000;
export const NCMD_KILL       = 0x10000000;
export const NCMD_CHECKSUM   = 0x0fffffff;

// doomcom mirrors the C struct shape; only the fields the rest of the engine
// actually reads need to be populated.
export let doomcom = null;

let _netsend = null, _netget = null;

function packetSend() { /* UDP write — single-player no-op */ }
function packetGet()  {
  if (doomcom !== null) doomcom.remotenode = -1;
}

export function I_InitNetwork() {
  doomcom = {
    id: DOOMCOM_ID,
    intnum: 0,
    command: 0,
    remotenode: -1,
    datalength: 0,
    numnodes: 1,
    ticdup: 1,
    extratics: 0,
    deathmatch: 0,
    savegame: 0,
    episode: 1,
    map: 1,
    skill: 2,
    consoleplayer: 0,
    numplayers: 1,
    angleoffset: 0,
    gametype: 0,
    drone: 0,
    data: new Uint8Array(1024),
  };
  // The `-net` argv path requires UDP sockets that don't exist in the browser.
  // If the user supplies it, fail loudly rather than pretending to be online.
  if (M_CheckParm('-net') !== 0) {
    I_Error('Networking is not available in the browser port.');
  }
  _netsend = packetSend;
  _netget  = packetGet;
}

export function I_NetCmd() {
  if (doomcom === null) return;
  if      (doomcom.command === CMD_SEND) _netsend?.();
  else if (doomcom.command === CMD_GET)  _netget?.();
  else I_Error(`Bad net cmd: ${doomcom.command}`);
}
