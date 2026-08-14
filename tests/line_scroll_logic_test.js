import {
  P_AdvanceScrollTextureOffset,
  SCROLL_TEXTURE_STEP,
} from '../src/p_spec_logic.js';

Deno.test('line special 48 advances one fixed-point texture column with C wrapping', () => {
  if (SCROLL_TEXTURE_STEP !== 65536) throw new Error('scroll step is not FRACUNIT');
  if (P_AdvanceScrollTextureOffset(0) !== 65536) throw new Error('zero offset did not advance');
  if (P_AdvanceScrollTextureOffset(-65536) !== 0) throw new Error('negative offset did not advance');
  if (P_AdvanceScrollTextureOffset(0x7fff0000) !== -0x80000000) {
    throw new Error('fixed-point offset does not wrap like signed C arithmetic');
  }
});

Deno.test('scrolling lines update sidedefs and their baked Three.js UV slices', async () => {
  const spec = await Deno.readTextFile(new URL('../src/p_spec.js', import.meta.url));
  const renderer = await Deno.readTextFile(new URL('../src/r_segs.js', import.meta.url));
  const main = await Deno.readTextFile(new URL('../src/d_main.js', import.meta.url));
  for (const required of [
    '_scrollLines.push(lines[i])',
    'side.textureoffset = P_AdvanceScrollTextureOffset(side.textureoffset)',
    '_RUpdateLineTextureOffset(line)',
  ]) {
    if (!spec.includes(required)) throw new Error(`missing scrolling-line step: ${required}`);
  }
  if (!renderer.includes('export function R_UpdateLineTextureOffset(line)') ||
      !renderer.includes('uv.setX(c.baseIdx + 0, u0)') ||
      !renderer.includes('c.length, c.columnPeriod') ||
      !renderer.includes('length, columnPeriod }')) {
    throw new Error('scrolling linedef UVs are not updated in place');
  }
  if (!main.includes('R_UpdateLineTextureOffset: rSegs.R_UpdateLineTextureOffset')) {
    throw new Error('scrolling-line renderer hook is not wired');
  }
});
