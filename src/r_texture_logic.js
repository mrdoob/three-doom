// Pure horizontal wall-texture addressing helpers. Vanilla R_GetColumn masks
// every requested column with texturewidthmask[texnum], whose period is the
// largest power of two no greater than the declared texture width.

export function R_TextureColumnPeriod(width) {
  let period = 1;
  while (period * 2 <= width) period *= 2;
  return period;
}

export function R_WallTextureUV(textureOffset, length, columnPeriod) {
  return {
    u0: textureOffset / columnPeriod,
    u1: (textureOffset + length) / columnPeriod,
  };
}

// Wall geometry remains normalized to the texture period it was built with.
// When a switch or animation selects a frame with another mask period, scale
// the sampler coordinate back to the active frame's column addressing.
export function R_WallTextureUScale(baseColumnPeriod, frameColumnPeriod) {
  return baseColumnPeriod / frameColumnPeriod;
}
