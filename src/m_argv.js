// Ported from: linuxdoom-1.10/m_argv.c
// Command-line argument utilities. In the browser, "argv" comes from the
// URL query string (?-foo&-warp=E1M3 -> ['', '-foo', '-warp', 'E1M3']).

export let myargc = 0;
export let myargv = [];

export function set_myargc(v) { myargc = v; }
export function set_myargv(v) { myargv = v; myargc = v.length; }

function decodeQueryPart(value) {
  return decodeURIComponent(value.replace(/\+/g, ' '));
}

// Convert the raw query into argv without decoding separators inside values.
// `?-file=my%20wad.wad&extra%26patch.wad` must produce two intact filenames;
// decoding the complete query first would turn both escapes into delimiters.
export function M_ParseArgvSearch(search) {
  const args = [''];
  const query = typeof search === 'string'
    ? (search[0] === '?' ? search.slice(1) : search)
    : '';
  if (query.length !== 0) {
    // Split raw delimiters first. Percent-encoded `&` and whitespace remain
    // within their component until decodeQueryPart runs below.
    for (const rawPart of query.split(/[&\s]+/)) {
      if (rawPart.length === 0) continue;
      const eq = rawPart.indexOf('=');
      if (eq < 0) {
        const decoded = decodeQueryPart(rawPart);
        // Preserve the legacy `?-warp%20E1M1` spelling for option components,
        // while treating non-option components as atomic filenames.
        if (decoded.startsWith('-') && /\s/.test(decoded)) {
          for (const token of decoded.split(/\s+/)) {
            if (token.length !== 0) args.push(token);
          }
        } else {
          args.push(decoded);
        }
      } else {
        args.push(decodeQueryPart(rawPart.slice(0, eq)));
        args.push(decodeQueryPart(rawPart.slice(eq + 1)));
      }
    }
  }
  return args;
}

// Initialise from window.location.search.
export function M_InitArgvFromLocation() {
  set_myargv(M_ParseArgvSearch(
    typeof location === 'undefined' ? '' : location.search,
  ));
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
