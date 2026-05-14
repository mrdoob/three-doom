// Ported from: linuxdoom-1.10/z_zone.c, z_zone.h
// Zone Memory Allocation — JS uses GC, so most of this is a stub.
//
// We honour the PU_* tag distinction only where it matters for
// purgable caches (PU_CACHE). Z_Malloc returns plain JS allocations
// (Uint8Array, Array, or a passed-in factory). Z_Free is a no-op.

// Purge tags (preserved for API compatibility).
export const PU_STATIC     = 1;
export const PU_SOUND      = 2;
export const PU_MUSIC      = 3;
export const PU_DAVE       = 4;
export const PU_LEVEL      = 50;
export const PU_LEVSPEC    = 51;
export const PU_PURGELEVEL = 100;
export const PU_CACHE      = 101;

export function Z_Init() {
  // JS GC replaces the zone allocator — nothing to set up.
}

// Allocate `size` raw bytes as a Uint8Array. Tag is recorded but ignored.
// `user` would back-reference the pointer in C — we ignore it in JS.
export function Z_Malloc(size, _tag, _user) {
  return new Uint8Array(size);
}

export function Z_Free(_ptr) {
  // No-op — GC handles it.
}

export function Z_FreeTags(_lowtag, _hightag) {
  // No-op.
}

export function Z_DumpHeap(_lowtag, _hightag) {
  // No-op.
}

export function Z_FileDumpHeap(_f) {
  // No-op.
}

export function Z_CheckHeap() {
  // No-op.
}

export function Z_ChangeTag2(_ptr, _tag) {
  // No-op.
}

export function Z_ChangeTag(p, t) { Z_ChangeTag2(p, t); }

export function Z_FreeMemory() {
  // JS doesn't expose available memory; report a large number so any
  // "do I have room?" checks pass.
  return 0x7fffffff;
}
