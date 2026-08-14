import { D_FileArgumentPlan } from '../src/d_file_logic.js';
import { W_CacheLumpName, W_InitMultipleFiles } from '../src/w_wad.js';

function assertEquals(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

Deno.test('-file collects ordered overlays until the next option', () => {
  const plan = D_FileArgumentPlan([
    '', '-iwad', 'doom2.wad', '-file', 'base.wad', 'last.wad', '-warp', 'MAP02',
  ]);
  assertEquals(plan, { present: true, paths: ['base.wad', 'last.wad'] }, 'overlay plan');
});

Deno.test('-file matching is case-insensitive and only the first block is native', () => {
  const plan = D_FileArgumentPlan([
    '', '-FILE', 'first.wad', '-skill', '4', '-file', 'ignored.wad',
  ]);
  assertEquals(plan, { present: true, paths: ['first.wad'] }, 'first overlay block');
});

Deno.test('absent and empty -file plans preserve modified-game semantics', () => {
  assertEquals(
    D_FileArgumentPlan(['', '-warp', 'E1M1']),
    { present: false, paths: [] },
    'absent option',
  );
  assertEquals(
    D_FileArgumentPlan(['', '-file', '-warp', 'E1M1']),
    { present: true, paths: [] },
    'present option without files',
  );
  assertEquals(
    D_FileArgumentPlan(['', '-file', '', '-warp', 'E1M1']),
    { present: true, paths: [] },
    'empty equals value',
  );
});

function oneLumpPwad(name, payload) {
  const bytes = new Uint8Array(12 + payload.length + 16);
  const view = new DataView(bytes.buffer);
  bytes.set([0x50, 0x57, 0x41, 0x44], 0);
  view.setInt32(4, 1, true);
  view.setInt32(8, 12 + payload.length, true);
  bytes.set(payload, 12);
  view.setInt32(12 + payload.length, 12, true);
  view.setInt32(16 + payload.length, payload.length, true);
  for (let i = 0; i < name.length && i < 8; i++) {
    bytes[20 + payload.length + i] = name.charCodeAt(i);
  }
  return bytes.buffer;
}

Deno.test('cache-busted PWAD URLs are classified by pathname', () => {
  W_InitMultipleFiles([{
    name: 'mods/example.wad?v=7#download',
    buffer: oneLumpPwad('PWAUDIT', new Uint8Array([4, 5, 6])),
  }]);
  assertEquals([...W_CacheLumpName('PWAUDIT', 0)], [4, 5, 6], 'PWAD payload');
});
