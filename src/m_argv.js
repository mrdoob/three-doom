// Ported from: linuxdoom-1.10/m_argv.c
// Command-line argument utilities. In the browser, "argv" comes from the
// URL query string (?-foo&-warp=E1M3 -> ['', '-foo', '-warp', 'E1M3']).

export let myargc = 0;
export let myargv = [];

export function set_myargc(v) { myargc = v; }
export function set_myargv(v) { myargv = v; myargc = v.length; }

// Initialise from window.location.search.
export function M_InitArgvFromLocation() {
  const args = [''];
  if (typeof location !== 'undefined' && location.search.length > 1) {
    const q = decodeURIComponent(location.search.slice(1));
    // Accept `-flag` and `-flag=value` forms separated by `&` or space.
    for (const part of q.split(/[&\s]+/)) {
      if (part.length === 0) continue;
      const eq = part.indexOf('=');
      if (eq < 0) {
        args.push(part);
      } else {
        args.push(part.slice(0, eq));
        args.push(part.slice(eq + 1));
      }
    }
  }
  set_myargv(args);
}

// Returns the argument number (1..argc-1) or 0 if not present.
export function M_CheckParm(check) {
  for (let i = 1; i < myargc; i++) {
    if (typeof myargv[i] === 'string' && myargv[i].toLowerCase() === check.toLowerCase()) {
      return i;
    }
  }
  return 0;
}
