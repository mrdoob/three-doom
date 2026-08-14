// Pure validation and directory decoding for Doom WAD byte sources.

const WAD_HEADER_SIZE = 12;
const WAD_DIRECTORY_ENTRY_SIZE = 16;

function invalidWad(error) {
  return { valid: false, error };
}

// Return a zero-copy byte view whose offsets are relative to the supplied
// source, including when that source is itself a sliced typed-array view.
export function W_ByteView(source) {
  try {
    if (ArrayBuffer.isView(source)) {
      return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
    }
    if (source instanceof ArrayBuffer) return new Uint8Array(source);
  } catch (_) {
    // Detached or otherwise inaccessible buffers are invalid byte sources.
  }
  return null;
}

function readAsciiName(bytes, offset) {
  let name = '';
  for (let i = 0; i < 8; i++) {
    const value = bytes[offset + i];
    if (value === 0) break;
    name += String.fromCharCode(value);
  }
  return name.toUpperCase();
}

// Decode a complete WAD directory without throwing or copying the source.
// Callers decide whether an invalid result means "not an IWAD" or a fatal
// error. Bounds checks use subtraction so position + size cannot overflow.
export function W_ParseWadDirectory(source) {
  const bytes = W_ByteView(source);
  if (bytes === null) return invalidWad('source is not an ArrayBuffer or typed-array view');
  if (bytes.byteLength < WAD_HEADER_SIZE) {
    return invalidWad(`header is shorter than ${WAD_HEADER_SIZE} bytes`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const identification = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (identification !== 'IWAD' && identification !== 'PWAD') {
    return invalidWad(`identification ${JSON.stringify(identification)} is not IWAD or PWAD`);
  }

  const lumpCount = view.getInt32(4, true);
  const directoryOffset = view.getInt32(8, true);
  if (lumpCount < 0) return invalidWad(`lump count ${lumpCount} is negative`);
  if (directoryOffset < 0) {
    return invalidWad(`directory offset ${directoryOffset} is negative`);
  }
  // The directory pointer is unused for an empty WAD, and the native loader
  // accepts zero there. A non-empty directory must not overlap its header.
  if (lumpCount > 0 && directoryOffset < WAD_HEADER_SIZE) {
    return invalidWad(`directory offset ${directoryOffset} is before the ${WAD_HEADER_SIZE}-byte header`);
  }
  if (directoryOffset > bytes.byteLength) {
    return invalidWad(`directory offset ${directoryOffset} exceeds file size ${bytes.byteLength}`);
  }
  const availableEntries = Math.floor(
    (bytes.byteLength - directoryOffset) / WAD_DIRECTORY_ENTRY_SIZE,
  );
  if (lumpCount > availableEntries) {
    return invalidWad(
      `directory has ${lumpCount} entries but only ${availableEntries} fit in the file`,
    );
  }

  const lumps = new Array(lumpCount);
  for (let i = 0; i < lumpCount; i++) {
    const offset = directoryOffset + i * WAD_DIRECTORY_ENTRY_SIZE;
    const position = view.getInt32(offset, true);
    const size = view.getInt32(offset + 4, true);
    const name = readAsciiName(bytes, offset + 8);
    if (position < 0) {
      return invalidWad(`lump ${i} (${name}) has negative position ${position}`);
    }
    if (size < 0) return invalidWad(`lump ${i} (${name}) has negative size ${size}`);
    if (position > bytes.byteLength || size > bytes.byteLength - position) {
      return invalidWad(
        `lump ${i} (${name}) span ${position}+${size} exceeds file size ${bytes.byteLength}`,
      );
    }
    lumps[i] = { filepos: position, size, name };
  }

  return {
    valid: true,
    bytes,
    identification,
    directoryOffset,
    lumps,
  };
}
