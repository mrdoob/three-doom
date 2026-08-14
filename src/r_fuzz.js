// Shared, deterministic implementation details for Doom's spectre / partial-
// invisibility fuzz. The original column drawer ignores the sprite's source
// colour: opaque patch pixels copy a framebuffer pixel one row above or below
// and pass that palette index through COLORMAP row 6.

export const R_FUZZ_TABLE_LENGTH = 50;
export const R_FUZZ_COLORMAP_ROW = 6;

// linuxdoom-1.10/r_draw.c:fuzzoffset, divided by SCREENWIDTH. Despite the
// source comment saying "left or right", +/-SCREENWIDTH selects an adjacent
// framebuffer row.
export const R_FUZZ_OFFSETS = Object.freeze([
  1, -1, 1, -1, 1, 1, -1,
  1, 1, -1, 1, 1, 1, -1,
  1, 1, 1, -1, -1, -1, -1,
  1, -1, -1, 1, 1, 1, 1, -1,
  1, -1, 1, 1, -1, -1, 1,
  1, -1, -1, -1, -1, 1, 1,
  1, 1, -1, 1, 1, -1, 1,
]);

let _fuzzPhase = 0;
let _pspriteCaptureRequested = false;
let _pspriteCaptureReady = false;
let _pspriteCaptureIndices = null;

function wrapFuzzIndex(value) {
  const wrapped = Math.trunc(value) % R_FUZZ_TABLE_LENGTH;
  return wrapped < 0 ? wrapped + R_FUZZ_TABLE_LENGTH : wrapped;
}

export function R_FuzzOffsetAt(position, phase = 0) {
  return R_FUZZ_OFFSETS[wrapFuzzIndex(position + phase)];
}

export function R_GetFuzzPhase() { return _fuzzPhase; }

export function R_SetFuzzPhase(phase) {
  _fuzzPhase = wrapFuzzIndex(phase);
  return _fuzzPhase;
}

// A small guaranteed step keeps the parallel GPU approximation moving even
// when a sprite happens to cover a multiple of all 50 offsets. Canvas fuzz
// subsequently commits its exact number of visited mask pixels.
export function R_BeginFuzzFrame() {
  return R_SetFuzzPhase(_fuzzPhase + 1);
}

// R_SetupFrame announces whether this frame's weapon sprites will use the
// partial-invisibility drawer. i_video consumes the flag exactly once before
// rendering so an omitted/aborted frame cannot accidentally reuse it later.
export function R_RequestPspriteFuzzCapture(requested) {
  _pspriteCaptureRequested = requested === true;
}

export function R_TakePspriteFuzzCaptureRequest() {
  const requested = _pspriteCaptureRequested;
  _pspriteCaptureRequested = false;
  return requested;
}

export function R_ClearPspriteFuzzCapture() {
  _pspriteCaptureReady = false;
}

// Convert a logical-view-sized RGBA8 readback into Doom's top-origin 320x200
// index screen. WebGL readback rows are bottom-origin. The red byte already is
// the exact post-COLORMAP palette index, so there is no RGB reverse mapping.
export function R_StorePspriteFuzzCapture(
  rgba,
  captureWidth,
  captureHeight,
  viewWindowX,
  viewWindowY,
  screenWidth = 320,
  screenHeight = 200,
) {
  const width = Math.max(0, captureWidth | 0);
  const height = Math.max(0, captureHeight | 0);
  const required = Math.max(0, screenWidth | 0) * Math.max(0, screenHeight | 0);
  if (_pspriteCaptureIndices === null || _pspriteCaptureIndices.length !== required) {
    _pspriteCaptureIndices = new Uint8Array(required);
  } else {
    _pspriteCaptureIndices.fill(0);
  }
  const destinationWidth = Math.max(0, screenWidth | 0);
  const destinationHeight = Math.max(0, screenHeight | 0);
  const originX = viewWindowX | 0;
  const originY = viewWindowY | 0;
  for (let sourceY = 0; sourceY < height; sourceY++) {
    const destinationY = originY + height - 1 - sourceY;
    if (destinationY < 0 || destinationY >= destinationHeight) continue;
    for (let sourceX = 0; sourceX < width; sourceX++) {
      const destinationX = originX + sourceX;
      if (destinationX < 0 || destinationX >= destinationWidth) continue;
      _pspriteCaptureIndices[destinationY * destinationWidth + destinationX] =
        rgba[(sourceY * width + sourceX) * 4];
    }
  }
  _pspriteCaptureReady = true;
  return _pspriteCaptureIndices;
}

export function R_GetPspriteFuzzCapture() {
  return _pspriteCaptureReady ? _pspriteCaptureIndices : null;
}

export function R_ShutdownFuzz() {
  _fuzzPhase = 0;
  _pspriteCaptureRequested = false;
  _pspriteCaptureReady = false;
  _pspriteCaptureIndices = null;
}

// CPU counterpart used by Canvas psprites. Both buffers contain one palette
// index per pixel. `background` is mutated as well as `output`, matching the
// original framebuffer dependency when a later fuzz pixel samples a row
// already processed in the same column. `outputAlpha` distinguishes an
// authored index 0 from untouched transparent output pixels.
export function R_RasterizeFuzzPatch({
  background,
  output,
  outputAlpha,
  screenWidth,
  screenHeight,
  mask,
  sourceWidth,
  sourceHeight,
  bounds,
  flip = false,
  clipLeft = 0,
  clipTop = 0,
  clipRight = screenWidth,
  clipBottom = screenHeight,
  phase = 0,
  colormaps,
}) {
  const left = Math.max(0, clipLeft, Math.ceil(bounds.left));
  const top = Math.max(0, clipTop, Math.ceil(bounds.top));
  const right = Math.min(screenWidth, clipRight, Math.ceil(bounds.right));
  const bottom = Math.min(screenHeight, clipBottom, Math.ceil(bounds.bottom));
  const drawWidth = bounds.width;
  const drawHeight = bounds.height;
  let cursor = wrapFuzzIndex(phase);
  let pixels = 0;

  if (drawWidth <= 0 || drawHeight <= 0 || left >= right || top >= bottom) {
    return { phase: cursor, pixels };
  }

  for (let x = left; x < right; x++) {
    let sourceX = Math.floor((x - bounds.left) * sourceWidth / drawWidth);
    sourceX = Math.max(0, Math.min(sourceWidth - 1, sourceX));
    if (flip) sourceX = sourceWidth - 1 - sourceX;
    for (let y = top; y < bottom; y++) {
      // R_DrawFuzzColumn leaves the first and last rows of the view alone so
      // its +/-SCREENWIDTH read never escapes the framebuffer.
      if (y <= clipTop || y >= clipBottom - 1) continue;
      let sourceY = Math.floor((y - bounds.top) * sourceHeight / drawHeight);
      sourceY = Math.max(0, Math.min(sourceHeight - 1, sourceY));
      if (mask[sourceY * sourceWidth + sourceX] === 0) continue;

      const sampleY = y + R_FUZZ_OFFSETS[cursor];
      const sample = sampleY * screenWidth + x;
      const paletteIndex = background[sample];
      const mapped = colormaps[R_FUZZ_COLORMAP_ROW * 256 + paletteIndex];
      const target = y * screenWidth + x;
      background[target] = mapped;
      output[target] = mapped;
      outputAlpha[target] = 255;
      cursor = (cursor + 1) % R_FUZZ_TABLE_LENGTH;
      pixels++;
    }
  }
  return { phase: cursor, pixels };
}
