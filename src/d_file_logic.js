// Browser command-line planning for d_main.c's `-file` WAD overlays.

export function D_FileArgumentPlan(argv) {
  let index = -1;
  for (let i = 1; i < argv.length; i++) {
    if (typeof argv[i] === 'string' && argv[i].toLowerCase() === '-file') {
      index = i;
      break;
    }
  }
  if (index < 0) return Object.freeze({ present: false, paths: Object.freeze([]) });

  const paths = [];
  for (let i = index + 1; i < argv.length; i++) {
    const value = argv[i];
    if (typeof value !== 'string' || value.startsWith('-')) break;
    // `-file=` is an empty browser query value, not a request to fetch the
    // current HTML document as a single-lump resource.
    if (value.length !== 0) paths.push(value);
  }
  return Object.freeze({ present: true, paths: Object.freeze(paths) });
}
