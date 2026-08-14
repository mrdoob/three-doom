import {
  D_FetchStartupAsset, D_STARTUP_ASSET_FETCH,
} from '../src/d_asset_fetch.js';

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

async function captureFailure(path, policy, fetchAsset) {
  const warnings = [];
  const fatals = [];
  let result;
  let thrown = null;
  try {
    result = await D_FetchStartupAsset(path, policy, {
      fetchAsset,
      warn: (...args) => warnings.push(args.join(' ')),
      fatal: (message) => {
        fatals.push(message);
        throw new Error(message);
      },
    });
  } catch (error) {
    thrown = error;
  }
  return { result, warnings, fatals, thrown };
}

Deno.test('default IWAD discovery misses stay silent', async () => {
  const cases = [
    () => Promise.reject(new Error('offline')),
    () => Promise.resolve({ ok: false, status: 404 }),
    () => Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.reject(new Error('body failed')),
    }),
  ];
  for (const fetchAsset of cases) {
    const outcome = await captureFailure(
      'doom2.wad',
      D_STARTUP_ASSET_FETCH.defaultIwadProbe,
      fetchAsset,
    );
    assertEquals(outcome.result, null, 'probe result');
    assertEquals(outcome.warnings, [], 'probe warnings');
    assertEquals(outcome.fatals, [], 'probe fatals');
    assertEquals(outcome.thrown, null, 'probe exception');
  }
});

Deno.test('required IWAD failures are fatal for load and body errors', async () => {
  const cases = [
    [
      () => Promise.reject(new Error('offline')),
      'Failed to load custom.wad: offline',
    ],
    [
      () => Promise.resolve({ ok: false, status: 403 }),
      'Failed to load custom.wad: 403',
    ],
    [
      () => Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.reject(new Error('body failed')),
      }),
      'Failed to read custom.wad: body failed',
    ],
  ];
  for (const [fetchAsset, expected] of cases) {
    const outcome = await captureFailure(
      'custom.wad',
      D_STARTUP_ASSET_FETCH.requiredIwad,
      fetchAsset,
    );
    assertEquals(outcome.warnings, [], 'required warnings');
    assertEquals(outcome.fatals, [expected], 'required fatal callback');
    assertIncludes(outcome.thrown?.message, expected, 'required exception');
  }
});

Deno.test('optional PWAD failures warn with PWAD terminology', async () => {
  const unavailable = await captureFailure(
    'mods/maps.wad',
    D_STARTUP_ASSET_FETCH.optionalPwad,
    () => Promise.reject(new Error('offline')),
  );
  assertEquals(unavailable.result, null, 'unavailable PWAD result');
  assertEquals(
    unavailable.warnings,
    ['Skipping unavailable PWAD mods/maps.wad (offline)'],
    'unavailable PWAD warning',
  );

  const unreadable = await captureFailure(
    'mods/maps.wad',
    D_STARTUP_ASSET_FETCH.optionalPwad,
    () => Promise.resolve({
      ok: true,
      arrayBuffer: () => Promise.reject(new Error('body failed')),
    }),
  );
  assertEquals(
    unreadable.warnings,
    ['Skipping unreadable PWAD mods/maps.wad (body failed)'],
    'unreadable PWAD warning',
  );
});

Deno.test('external demo failures remain nonfatal for IWAD lump fallback', async () => {
  const outcome = await captureFailure(
    'demos/DEMO1.lmp',
    D_STARTUP_ASSET_FETCH.externalDemo,
    () => Promise.resolve({ ok: false, status: 404 }),
  );
  assertEquals(outcome.result, null, 'demo fallback result');
  assertEquals(outcome.fatals, [], 'demo fallback fatals');
  assertEquals(outcome.thrown, null, 'demo fallback exception');
  assertEquals(
    outcome.warnings,
    ['Skipping unavailable demo demos/DEMO1.lmp (404)'],
    'demo warning terminology',
  );
});

Deno.test('successful startup asset fetch preserves its name and buffer', async () => {
  const buffer = new Uint8Array([1, 2, 3]).buffer;
  const warnings = [];
  const result = await D_FetchStartupAsset(
    'mods/maps.wad',
    D_STARTUP_ASSET_FETCH.optionalPwad,
    {
      fetchAsset: () => Promise.resolve({
        ok: true,
        arrayBuffer: () => Promise.resolve(buffer),
      }),
      warn: (...args) => warnings.push(args.join(' ')),
    },
  );
  assertEquals(result.name, 'mods/maps.wad', 'successful asset name');
  assertEquals(result.buffer === buffer, true, 'successful asset buffer');
  assertEquals(warnings, [], 'successful asset warnings');
});
