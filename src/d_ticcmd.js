// Ported from: linuxdoom-1.10/d_ticcmd.h
// Per-tick player input packet.

export class ticcmd_t {
  constructor() {
    this.forwardmove = 0;  // signed 8-bit, *2048 for movement units
    this.sidemove    = 0;  // signed 8-bit, *2048 for movement units
    this.angleturn   = 0;  // signed 16-bit, <<16 for angle delta
    this.consistancy = 0;  // signed 16-bit, net consistency check
    this.chatchar    = 0;  // unsigned 8-bit
    this.buttons     = 0;  // unsigned 8-bit (BT_* flags)
  }
}
