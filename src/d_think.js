// Ported from: linuxdoom-1.10/d_think.h
// Doubly-linked list of actors ("thinkers"): anything that runs per-tic logic.

export class thinker_t {
  constructor() {
    this.prev     = null;
    this.next     = null;
    this.function = null; // function reference, name string, or null (= removed marker)
  }
}
