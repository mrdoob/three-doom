import { M_ParseArgvSearch } from '../src/m_argv.js';

function assertEquals(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}: expected ${e}, got ${a}`);
}

Deno.test('query argv preserves encoded filename delimiters', () => {
  assertEquals(
    M_ParseArgvSearch('?-file=my%20wad.wad&extra%26patch.wad&-warp=E1M2'),
    ['', '-file', 'my wad.wad', 'extra&patch.wad', '-warp', 'E1M2'],
    'encoded overlay arguments',
  );
});

Deno.test('query argv retains ampersand, equals, and literal-space forms', () => {
  assertEquals(
    M_ParseArgvSearch('?-devparm&-warp=E1M3'),
    ['', '-devparm', '-warp', 'E1M3'],
    'ampersand and equals',
  );
  assertEquals(
    M_ParseArgvSearch('?-devparm -warp E1M3'),
    ['', '-devparm', '-warp', 'E1M3'],
    'literal spaces',
  );
  assertEquals(
    M_ParseArgvSearch('?-warp%20E1M3'),
    ['', '-warp', 'E1M3'],
    'encoded legacy option separator',
  );
});

Deno.test('query argv decodes form plus and empty values after tokenization', () => {
  assertEquals(
    M_ParseArgvSearch('?-file=my+wad.wad&-record='),
    ['', '-file', 'my wad.wad', '-record', ''],
    'form decoding',
  );
  assertEquals(M_ParseArgvSearch(''), [''], 'empty query');
  assertEquals(M_ParseArgvSearch('x'), ['', 'x'], 'single raw token');
});
