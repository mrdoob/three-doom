import { GameMode_t } from '../src/doomdef.js';
import { D_GuessGameModeFromWad } from '../src/d_iwad.js';
import {
  W_CacheLumpName, W_CheckNumForName, W_InitMultipleFiles,
} from '../src/w_wad.js';
import { W_ParseWadDirectory } from '../src/w_wad_logic.js';

function assertEquals(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

function assertIncludes(actual, expected, message) {
  if (typeof actual !== 'string' || !actual.includes(expected)) {
    throw new Error(`${message}: expected ${JSON.stringify(actual)} to include ${JSON.stringify(expected)}`);
  }
}

function wadHeader(length = 12, identification = 'PWAD') {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < 4 && i < bytes.length; i++) {
    bytes[i] = identification.charCodeAt(i) || 0;
  }
  return bytes;
}

function oneLumpWad(name, payload) {
  const bytes = new Uint8Array(12 + payload.length + 16);
  const view = new DataView(bytes.buffer);
  const directory = 12 + payload.length;
  bytes.set([0x50, 0x57, 0x41, 0x44], 0);
  view.setInt32(4, 1, true);
  view.setInt32(8, directory, true);
  bytes.set(payload, 12);
  view.setInt32(directory, 12, true);
  view.setInt32(directory + 4, payload.length, true);
  for (let i = 0; i < name.length && i < 8; i++) {
    bytes[directory + 8 + i] = name.toUpperCase().charCodeAt(i);
  }
  return bytes;
}

function assertInvalid(bytes, expected, message) {
  const result = W_ParseWadDirectory(bytes);
  assertEquals(result.valid, false, message);
  assertIncludes(result.error, expected, message);
  assertEquals(D_GuessGameModeFromWad(bytes), GameMode_t.indetermined, `${message} mode`);
}

Deno.test('WAD parser rejects malformed headers, counts, and directories', () => {
  assertInvalid(new Uint8Array(11), 'header is shorter than 12 bytes', 'short header');

  const badId = wadHeader();
  badId.set([0x4e, 0x4f, 0x50, 0x45]);
  assertInvalid(badId, 'is not IWAD or PWAD', 'bad identification');

  const negativeCount = wadHeader();
  const negativeCountView = new DataView(negativeCount.buffer);
  negativeCountView.setInt32(4, -1, true);
  negativeCountView.setInt32(8, 12, true);
  assertInvalid(negativeCount, 'lump count -1 is negative', 'negative lump count');

  const negativeDirectory = wadHeader();
  const negativeDirectoryView = new DataView(negativeDirectory.buffer);
  negativeDirectoryView.setInt32(4, 0, true);
  negativeDirectoryView.setInt32(8, -1, true);
  assertInvalid(negativeDirectory, 'directory offset -1 is negative', 'negative directory');

  const earlyDirectory = wadHeader(28);
  const earlyDirectoryView = new DataView(earlyDirectory.buffer);
  earlyDirectoryView.setInt32(4, 1, true);
  earlyDirectoryView.setInt32(8, 8, true);
  assertInvalid(earlyDirectory, 'directory offset 8 is before', 'directory overlaps header');

  const emptyAtZero = wadHeader();
  const emptyAtZeroView = new DataView(emptyAtZero.buffer);
  emptyAtZeroView.setInt32(4, 0, true);
  emptyAtZeroView.setInt32(8, 0, true);
  assertEquals(W_ParseWadDirectory(emptyAtZero).valid, true, 'empty WAD ignores directory pointer');

  const lateDirectory = wadHeader();
  const lateDirectoryView = new DataView(lateDirectory.buffer);
  lateDirectoryView.setInt32(4, 0, true);
  lateDirectoryView.setInt32(8, 13, true);
  assertInvalid(lateDirectory, 'directory offset 13 exceeds file size 12', 'late directory');

  const truncatedDirectory = wadHeader();
  const truncatedDirectoryView = new DataView(truncatedDirectory.buffer);
  truncatedDirectoryView.setInt32(4, 1, true);
  truncatedDirectoryView.setInt32(8, 12, true);
  assertInvalid(truncatedDirectory, 'only 0 fit in the file', 'truncated directory');
});

Deno.test('WAD parser rejects negative and out-of-range lump spans', () => {
  const mutateEntry = (position, size) => {
    const bytes = oneLumpWad('PWAUDIT', new Uint8Array([1]));
    const directory = new DataView(bytes.buffer).getInt32(8, true);
    const view = new DataView(bytes.buffer);
    view.setInt32(directory, position, true);
    view.setInt32(directory + 4, size, true);
    return bytes;
  };

  assertInvalid(mutateEntry(-1, 0), 'negative position -1', 'negative lump position');
  assertInvalid(mutateEntry(12, -1), 'negative size -1', 'negative lump size');
  assertInvalid(mutateEntry(30, 0), 'span 30+0 exceeds file size 29', 'position past EOF');
  assertInvalid(mutateEntry(28, 2), 'span 28+2 exceeds file size 29', 'span past EOF');

  const emptyAtEnd = mutateEntry(29, 0);
  assertEquals(W_ParseWadDirectory(emptyAtEnd).valid, true, 'zero-size EOF lump');
});

Deno.test('typed WAD views remain zero-copy through parsing and lump caching', () => {
  const wad = oneLumpWad('MAP01', new Uint8Array([4, 5, 6]));
  const wrapped = new Uint8Array(11 + wad.length + 7);
  wrapped.set(wad, 11);
  const source = wrapped.subarray(11, 11 + wad.length);
  const parsed = W_ParseWadDirectory(source);
  assertEquals(parsed.valid, true, 'typed view parse');
  assertEquals(parsed.bytes.buffer === wrapped.buffer, true, 'parser backing buffer');
  assertEquals(parsed.bytes.byteOffset, source.byteOffset, 'parser byte offset');
  assertEquals(D_GuessGameModeFromWad(source), GameMode_t.commercial, 'typed view IWAD mode');

  W_InitMultipleFiles([{ name: 'offset.wad', buffer: source }]);
  const cached = W_CacheLumpName('MAP01', 0);
  assertEquals([...cached], [4, 5, 6], 'typed view payload');
  assertEquals(cached.buffer === wrapped.buffer, true, 'cache backing buffer');
  assertEquals(cached.byteOffset, source.byteOffset + 12, 'cache byte offset');
  wrapped[source.byteOffset + 12] = 9;
  assertEquals(cached[0], 9, 'cache remains a source view');
});

Deno.test('WAD loader reports contextual validation errors', () => {
  let message = '';
  try {
    W_InitMultipleFiles([{
      name: 'mods/broken.wad?v=4',
      buffer: new Uint8Array(3),
    }]);
  } catch (error) {
    message = error.message;
  }
  assertIncludes(message, 'Wad file mods/broken.wad?v=4 is invalid', 'filename context');
  assertIncludes(message, 'header is shorter than 12 bytes', 'validation context');
});

Deno.test('failed multi-file initialization leaves the prior directory and cache intact', () => {
  W_InitMultipleFiles([{
    name: 'old.wad',
    buffer: oneLumpWad('OLD', new Uint8Array([1])),
  }]);
  const oldCached = W_CacheLumpName('OLD', 0);

  try {
    W_InitMultipleFiles([
      {
        name: 'new.wad',
        buffer: oneLumpWad('NEW', new Uint8Array([2])),
      },
      { name: 'broken.wad', buffer: new Uint8Array(3) },
    ]);
  } catch (_) {
    // The old directory remains usable after callers catch a startup error.
  }

  assertEquals(W_CheckNumForName('OLD'), 0, 'old directory retained');
  assertEquals(W_CheckNumForName('NEW'), -1, 'partial directory not published');
  assertEquals(W_CacheLumpName('OLD', 0), oldCached, 'old cache identity retained');
  assertEquals([...W_CacheLumpName('OLD', 0)], [1], 'old cache bytes retained');
});

Deno.test('cache-busted standalone lump names use the normalized asset path', () => {
  const wrapped = new Uint8Array([99, 7, 8, 99]);
  const source = wrapped.subarray(1, 3);
  W_InitMultipleFiles([{
    name: 'mods/TROOA1.lmp?v=7#download',
    buffer: source,
  }]);
  assertEquals(W_CheckNumForName('TROOA1'), 0, 'standalone lump name');
  const cached = W_CacheLumpName('TROOA1', 0);
  assertEquals([...cached], [7, 8], 'standalone payload');
  assertEquals(cached.buffer === wrapped.buffer, true, 'standalone backing buffer');
  assertEquals(cached.byteOffset, source.byteOffset, 'standalone byte offset');
});
