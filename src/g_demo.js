// Pure codec for Doom v1.9's four-byte per-player demo command.

export const DEMO_DEFAULT_BUFFER_SIZE = 0x20000;
export const DEMO_WRITE_TAIL_RESERVE = 16;
export const DEMO_VERSION = 109;
export const DEMO_MARKER = 0x80;
export const DEMO_PLAYER_COUNT = 4;
export const DEMO_HEADER_SIZE = 9 + DEMO_PLAYER_COUNT;

function invalidDemo(error) {
  return { valid: false, error };
}

// Validate the complete byte stream before it can mutate game topology or
// load a level. Native Doom trusted WAD lumps, but browser-supplied .lmp files
// can be truncated or malformed. A marker is recognized only where playback
// would read the first byte of a four-byte ticcmd.
export function G_ValidateDemoStream(bytes) {
  if (bytes === null || bytes === undefined ||
      typeof bytes.length !== 'number' || bytes.length < DEMO_HEADER_SIZE) {
    return invalidDemo(`header is shorter than ${DEMO_HEADER_SIZE} bytes`);
  }
  const version = bytes[0];
  if (version !== DEMO_VERSION) {
    return invalidDemo(`version ${version} does not match engine ${DEMO_VERSION}`);
  }

  const consoleplayer = bytes[8];
  const playeringame = new Array(DEMO_PLAYER_COUNT);
  let activePlayers = 0;
  for (let i = 0; i < playeringame.length; i++) {
    playeringame[i] = bytes[9 + i] !== 0;
    if (playeringame[i] === true) activePlayers++;
  }
  if (activePlayers === 0) return invalidDemo('header has no active players');
  if (consoleplayer >= playeringame.length || playeringame[consoleplayer] !== true) {
    return invalidDemo(`console player ${consoleplayer} is not active`);
  }

  let markerOffset = DEMO_HEADER_SIZE;
  while (markerOffset < bytes.length) {
    if (bytes[markerOffset] === DEMO_MARKER) {
      return {
        valid: true,
        header: {
          skill: bytes[1],
          episode: bytes[2],
          map: bytes[3],
          deathmatch: bytes[4],
          respawn: bytes[5] !== 0,
          fast: bytes[6] !== 0,
          nomonsters: bytes[7] !== 0,
          consoleplayer,
          playeringame,
        },
        commandOffset: DEMO_HEADER_SIZE,
        markerOffset,
      };
    }
    if (markerOffset + 4 > bytes.length) {
      return invalidDemo(`ticcmd at byte ${markerOffset} is truncated`);
    }
    markerOffset += 4;
  }
  return invalidDemo('stream has no end marker');
}

// g_game.c:G_WriteDemoTiccmd checks `demo_p > demoend - 16` after a
// provisional write and rewind. Testing the command's starting offset before
// appending is equivalent and avoids ever writing beyond a browser buffer.
export function G_DemoCanWriteTiccmd(bufferLength, maxBytes) {
  return Math.trunc(bufferLength) <=
    Math.trunc(maxBytes) - DEMO_WRITE_TAIL_RESERVE;
}

function signedByte(value) {
  return ((value & 0xff) << 24) >> 24;
}

function signedAngleByte(value) {
  // g_game.c assigns `(unsigned char)value << 8` into ticcmd_t.angleturn,
  // whose type is signed short. Narrow after the shift to preserve 0x80..ff
  // as -32768..-256 instead of JavaScript's positive 32768..65280.
  return (((value & 0xff) << 8) << 16) >> 16;
}

export function G_EncodeDemoTiccmd(cmd) {
  return [
    cmd.forwardmove & 0xff,
    cmd.sidemove & 0xff,
    ((cmd.angleturn + 128) >> 8) & 0xff,
    cmd.buttons & 0xff,
  ];
}

export function G_DecodeDemoTiccmd(bytes, offset, cmd) {
  cmd.forwardmove = signedByte(bytes[offset]);
  cmd.sidemove = signedByte(bytes[offset + 1]);
  cmd.angleturn = signedAngleByte(bytes[offset + 2]);
  cmd.buttons = bytes[offset + 3] & 0xff;
  return offset + 4;
}
