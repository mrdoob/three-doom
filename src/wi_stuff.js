// Ported from: linuxdoom-1.10/wi_stuff.c — intermission screen between maps.
// Two-phase state machine matching vanilla:
//   StatCount   — Kills/Items/Secrets/Time count up with per-tick sound.
//   ShowNextLoc — "Entering …" with the level-name patch.
// Player presses a key to skip ahead; auto-advances after configured wait.

import { gameepisode, gamemap, players, consoleplayer } from './doomstat.js';
import { S_StartSound } from './s_sound.js';

const TICRATE = 35;

// Phases — match vanilla `stateenum_t` (we add `Done`).
const Ph = { StatCount: 0, ShowNextLoc: 1, Done: 2 };

// Per-episode level titles for the screen header.
const HU_TITLES_E = {
  1: ['Hangar','Nuclear Plant','Toxin Refinery','Command Control','Phobos Lab',
      'Central Processing','Computer Station','Phobos Anomaly','Military Base'],
  2: ['Deimos Anomaly','Containment Area','Refinery','Deimos Lab','Command Center',
      'Halls of the Damned','Spawning Vats','Tower of Babel','Fortress of Mystery'],
  3: ['Hell Keep','Slough of Despair','Pandemonium','House of Pain','Unholy Cathedral',
      "Mt. Erebus",'Limbo','Dis','Warrens'],
};

let _active   = false;
let _onDone   = null;
let _phase    = Ph.StatCount;
let _phaseTic = 0;
let _wbs      = null; // wbstartstruct: { plyr:[], next: int, last: int, maxkills, maxitems, maxsecret, partime }

// Counted-up values; ramp to their target over StatCount duration.
let _cntKills = 0, _cntItems = 0, _cntSecret = 0, _cntTime = 0, _cntPar = 0;
let _cntStage = 0; // 0 kills, 1 items, 2 secret, 3 time/par, 4 done

const STAT_RAMP_TICS = TICRATE; // 1s per stat (vanilla varies 24..30)
let _stageTic = 0;
let _tickedSound = false;

export function WI_Start(wbstartstruct, onDone) {
  _wbs = wbstartstruct !== null && wbstartstruct !== undefined ? wbstartstruct : {};
  // ?? not || — Doom permits 0 for partime / maxkills / etc. (a level with
  // zero secrets is legal, and `|| 100` would wrongly substitute 100).
  _wbs.plyr      = _wbs.plyr      ?? [{ skills: 0, sitems: 0, ssecret: 0, stime: 0 }];
  _wbs.maxkills  = _wbs.maxkills  ?? 100;
  _wbs.maxitems  = _wbs.maxitems  ?? 100;
  _wbs.maxsecret = _wbs.maxsecret ?? 100;
  _wbs.partime   = _wbs.partime   ?? 60;
  _wbs.last      = _wbs.last      ?? gamemap;
  _wbs.next      = _wbs.next      ?? gamemap + 1;
  _onDone   = onDone || (() => {});
  _phase    = Ph.StatCount; _phaseTic = 0;
  _cntKills = _cntItems = _cntSecret = _cntTime = _cntPar = 0;
  _cntStage = 0; _stageTic = 0; _tickedSound = false;
  _active   = true;
}
export function WI_End() { _active = false; }
export function WI_isActive() { return _active; }

// ---------- Phase: StatCount ----------
function rampTo(target, tic) {
  if (tic >= STAT_RAMP_TICS) return target;
  return ((target * tic) / STAT_RAMP_TICS) | 0;
}

function WI_updateStats() {
  const p = _wbs.plyr[0];
  _stageTic++;
  if (_cntStage === 0) {
    _cntKills = rampTo(p.skills, _stageTic);
    if (_stageTic % 3 === 0 && !_tickedSound) S_StartSound(null, 1 /*sfx_pistol*/);
    if (_stageTic >= STAT_RAMP_TICS) { _cntKills = p.skills; _cntStage = 1; _stageTic = 0; S_StartSound(null, 82 /*sfx_barexp*/); }
  } else if (_cntStage === 1) {
    _cntItems = rampTo(p.sitems, _stageTic);
    if (_stageTic >= STAT_RAMP_TICS) { _cntItems = p.sitems; _cntStage = 2; _stageTic = 0; S_StartSound(null, 82 /*sfx_barexp*/); }
  } else if (_cntStage === 2) {
    _cntSecret = rampTo(p.ssecret, _stageTic);
    if (_stageTic >= STAT_RAMP_TICS) { _cntSecret = p.ssecret; _cntStage = 3; _stageTic = 0; S_StartSound(null, 82 /*sfx_barexp*/); }
  } else if (_cntStage === 3) {
    _cntTime = rampTo(((p.stime / 35) | 0), _stageTic);
    _cntPar  = rampTo(_wbs.partime, _stageTic);
    if (_stageTic >= STAT_RAMP_TICS) {
      _cntTime = (p.stime / 35) | 0; _cntPar = _wbs.partime;
      _cntStage = 4; _stageTic = 0; S_StartSound(null, 82 /*sfx_barexp*/);
    }
  }
}

// ---------- Phase: ShowNextLoc ----------
function WI_initShowNextLoc() { _phase = Ph.ShowNextLoc; _phaseTic = 0; }

// ---------- Tick / draw ----------
export function WI_Ticker() {
  if (!_active) return;
  _phaseTic++;
  if (_phase === Ph.StatCount) {
    WI_updateStats();
    if (_cntStage === 4 && _phaseTic > 6 * TICRATE) WI_initShowNextLoc();
  } else if (_phase === Ph.ShowNextLoc) {
    if (_phaseTic > 4 * TICRATE) { _active = false; _onDone(); }
  }
}

export function WI_Responder(ev) {
  if (!_active) return false;
  if (ev && ev.type === 0) {
    if (_phase === Ph.StatCount) {
      // Skip the count animation.
      const p = _wbs.plyr[0];
      _cntKills = p.skills; _cntItems = p.sitems; _cntSecret = p.ssecret;
      _cntTime  = (p.stime / 35) | 0; _cntPar = _wbs.partime;
      _cntStage = 4;
      WI_initShowNextLoc();
    } else {
      _active = false; _onDone();
    }
    return true;
  }
  return false;
}

function lvlName(ep, map) {
  const t = HU_TITLES_E[ep];
  if (t && map >= 1 && map <= 9) return t[map - 1];
  return `E${ep}M${map}`;
}

export function WI_Drawer(ctx, dx, dy, dw, dh) {
  if (!_active) return;
  ctx.fillStyle = '#000';
  ctx.fillRect(dx, dy, dw, dh);
  ctx.textAlign = 'center';
  if (_phase === Ph.StatCount) {
    ctx.fillStyle = '#ffcf00';
    ctx.font = `bold ${Math.round(dh * 0.08)}px monospace`;
    ctx.fillText(lvlName(gameepisode, _wbs.last) + ' FINISHED', dx + dw * 0.5, dy + dh * 0.15);
    ctx.fillStyle = '#fff';
    ctx.font = `${Math.round(dh * 0.045)}px monospace`;
    const left = dx + dw * 0.30;
    const right = dx + dw * 0.70;
    let y = dy + dh * 0.32; const ly = dh * 0.07;
    ctx.textAlign = 'left';  ctx.fillText('Kills',   left, y);
    ctx.textAlign = 'right'; ctx.fillText(`${_cntKills}%`, right, y); y += ly;
    ctx.textAlign = 'left';  ctx.fillText('Items',   left, y);
    ctx.textAlign = 'right'; ctx.fillText(`${_cntItems}%`, right, y); y += ly;
    ctx.textAlign = 'left';  ctx.fillText('Secrets', left, y);
    ctx.textAlign = 'right'; ctx.fillText(`${_cntSecret}%`, right, y); y += ly;
    ctx.textAlign = 'left';  ctx.fillText('Time',    left, y);
    ctx.textAlign = 'right';
    ctx.fillText(`${(_cntTime / 60) | 0}:${String(_cntTime % 60).padStart(2, '0')}`, right, y);
    y += ly;
    ctx.textAlign = 'left';  ctx.fillText('Par',     left, y);
    ctx.textAlign = 'right';
    ctx.fillText(`${(_cntPar / 60) | 0}:${String(_cntPar % 60).padStart(2, '0')}`, right, y);
  } else if (_phase === Ph.ShowNextLoc) {
    ctx.fillStyle = '#ffcf00';
    ctx.font = `bold ${Math.round(dh * 0.05)}px monospace`;
    ctx.fillText('Entering', dx + dw * 0.5, dy + dh * 0.35);
    ctx.font = `bold ${Math.round(dh * 0.075)}px monospace`;
    ctx.fillText(lvlName(gameepisode, _wbs.next), dx + dw * 0.5, dy + dh * 0.50);
  }
  ctx.font = `${Math.round(dh * 0.03)}px monospace`;
  ctx.fillStyle = '#888';
  ctx.fillText('press any key to continue', dx + dw * 0.5, dy + dh * 0.92);
  ctx.textAlign = 'left';
}
