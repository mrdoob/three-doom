import { M_SHA256Hex } from '../src/m_sha256.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const encoder = new TextEncoder();

Deno.test('synchronous SHA-256 matches standard vectors', () => {
  assert(
    M_SHA256Hex(new Uint8Array()) ===
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    'empty SHA-256 vector mismatch',
  );
  assert(
    M_SHA256Hex(encoder.encode('abc')) ===
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'abc SHA-256 vector mismatch',
  );
  assert(
    M_SHA256Hex(encoder.encode(
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    )) === '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    'multi-block SHA-256 vector mismatch',
  );
});

Deno.test('synchronous SHA-256 respects typed-array view bounds', () => {
  const backing = encoder.encode('xxabczz');
  assert(
    M_SHA256Hex(backing.subarray(2, 5)) ===
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    'bytes outside the supplied view affected SHA-256',
  );
});
