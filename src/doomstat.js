// Ported from: linuxdoom-1.10/doomstat.c, doomstat.h
// All global state variables.

import { GameMode_t, GameMission_t, Language_t, MAXPLAYERS, NUMAMMO } from './doomdef.js';
import { mapthing_t } from './doomdata.js';
import { ticcmd_t } from './d_ticcmd.js';

// ---------- Command line flags ----------
export let nomonsters  = false;
export let respawnparm = false;
export let fastparm    = false;
export let devparm     = false;
export function set_nomonsters(v)  { nomonsters = v; }
export function set_respawnparm(v) { respawnparm = v; }
export function set_fastparm(v)    { fastparm = v; }
export function set_devparm(v)     { devparm = v; }

// ---------- Game mode/mission/language ----------
export let gamemode    = GameMode_t.indetermined;
export let gamemission = GameMission_t.doom;
export let language    = Language_t.english;
export let modifiedgame = false;
export function set_gamemode(v)    { gamemode = v; }
export function set_gamemission(v) { gamemission = v; }
export function set_language(v)    { language = v; }
export function set_modifiedgame(v){ modifiedgame = v; }

// ---------- Skill/map ----------
export let startskill   = 2;
export let startepisode = 1;
export let startmap     = 1;
export let autostart    = false;
export let gameskill    = 2;
export let gameepisode  = 1;
export let gamemap      = 1;
export let respawnmonsters = false;
export function set_startskill(v)   { startskill = v; }
export function set_startepisode(v) { startepisode = v; }
export function set_startmap(v)     { startmap = v; }
export function set_autostart(v)    { autostart = v; }
export function set_gameskill(v)    { gameskill = v; }
export function set_gameepisode(v)  { gameepisode = v; }
export function set_gamemap(v)      { gamemap = v; }
export function set_respawnmonsters(v) { respawnmonsters = v; }

// ---------- Netgame ----------
export let netgame    = false;
// deathmatch is 0=cooperative, 1=deathmatch, 2=altdeath. Vanilla treats it
// as an integer; p_mobj.c:582's P_RespawnSpecials gates on `deathmatch == 2`.
export let deathmatch = 0;
export function set_netgame(v)    { netgame = v; }
export function set_deathmatch(v) {
  deathmatch = v;
  if (typeof globalThis !== 'undefined') globalThis.__doom_deathmatch = v;
}
// Initialise the globalThis mirror so reads before any setter call still work.
if (typeof globalThis !== 'undefined') globalThis.__doom_deathmatch = deathmatch;

// ---------- Sound volume ----------
export let snd_SfxVolume   = 8;
export let snd_MusicVolume = 8;
export let snd_MusicDevice = 0;
export let snd_SfxDevice   = 0;
export let snd_DesiredMusicDevice = 0;
export let snd_DesiredSfxDevice   = 0;
export function set_snd_SfxVolume(v)   { snd_SfxVolume = v; }
export function set_snd_MusicVolume(v) { snd_MusicVolume = v; }

// ---------- Refresh state flags ----------
export let statusbaractive = true;
export let automapactive   = false;
export let menuactive      = false;
export let paused          = false;
export let viewactive      = false;
export let nodrawers       = false;
export let noblit          = false;
export let viewwindowx     = 0;
export let viewwindowy     = 0;
export let viewheight      = 0;
export let viewwidth       = 0;
export let scaledviewwidth = 0;
export let viewangleoffset = 0;
export function set_statusbaractive(v) { statusbaractive = v; }
export function set_automapactive(v)   { automapactive = v; }
export function set_menuactive(v)      { menuactive = v; }
export function set_paused(v)          { paused = v; }
export function set_viewactive(v)      { viewactive = v; }
export function set_viewwindowx(v)     { viewwindowx = v; }
export function set_viewwindowy(v)     { viewwindowy = v; }
export function set_viewheight(v)      { viewheight = v; }
export function set_viewwidth(v)       { viewwidth = v; }
export function set_scaledviewwidth(v) { scaledviewwidth = v; }

// ---------- Player ----------
export let consoleplayer = 0;
export let displayplayer = 0;
export function set_consoleplayer(v) { consoleplayer = v; }
export function set_displayplayer(v) { displayplayer = v; }

// ---------- Statistics ----------
export let totalkills   = 0;
export let totalitems   = 0;
export let totalsecret  = 0;
export let levelstarttic = 0;
export let leveltime    = 0;
export function set_totalkills(v)   { totalkills = v; }
export function set_totalitems(v)   { totalitems = v; }
export function set_totalsecret(v)  { totalsecret = v; }
export function set_levelstarttic(v){ levelstarttic = v; }
export { gameaction, set_gameaction } from './d_event.js';
export function set_leveltime(v)    { leveltime = v; if (typeof globalThis !== 'undefined') globalThis.__doom_leveltime = v; }

// ---------- Demo state ----------
export let usergame      = false;
export let demoplayback  = false;
export let demorecording = false;
export let singledemo    = false;
export function set_usergame(v)      { usergame = v; }
export function set_demoplayback(v)  { demoplayback = v; }
export function set_demorecording(v) { demorecording = v; }
export function set_singledemo(v)    { singledemo = v; }

// ---------- Game state ----------
export let gamestate = 3; // GS_DEMOSCREEN
export let wipegamestate = 3;
export function set_gamestate(v)     { gamestate = v; }
export function set_wipegamestate(v) { wipegamestate = v; }

// ---------- Tic counter ----------
export let gametic = 0;
export function set_gametic(v) { gametic = v; }

// ---------- Players ----------
export const players = new Array(MAXPLAYERS);
export const playeringame = new Array(MAXPLAYERS);
for (let i = 0; i < MAXPLAYERS; i++) { playeringame[i] = false; }

export const MAX_DM_STARTS = 10;
export const deathmatchstarts = new Array(MAX_DM_STARTS);
for (let i = 0; i < MAX_DM_STARTS; i++) deathmatchstarts[i] = new mapthing_t();
export let deathmatch_p = 0;
export function set_deathmatch_p(v) { deathmatch_p = v; }

export const playerstarts = new Array(MAXPLAYERS);
for (let i = 0; i < MAXPLAYERS; i++) playerstarts[i] = new mapthing_t();

export let wminfo = null;
export function set_wminfo(v) { wminfo = v; }

export const maxammo = [200, 50, 300, 50]; // [am_clip, am_shell, am_cell, am_misl]

// ---------- Engine knobs ----------
export let basedefault = 'default.cfg';
export let debugfile   = null;
export let precache    = true;
export let mouseSensitivity = 5;
export let singletics  = false;
export let bodyqueslot = 0;
export let skyflatnum  = -1;
export function set_singletics(v)  { singletics = v; }
export function set_bodyqueslot(v) { bodyqueslot = v; }
// p_map.js / p_mobj.js read skyflatnum off globalThis to avoid an import
// cycle. Mirror writes so the sky-hack check fires; without this, hitscans
// passing through "F_SKY1" doorways spawn puffs (and 4 extra P_Random calls)
// that desync DEMO1 around tic 2763.
export function set_skyflatnum(v) {
  skyflatnum = v;
  if (typeof globalThis !== 'undefined') globalThis.__doom_skyflatnum = v;
}
if (typeof globalThis !== 'undefined') globalThis.__doom_skyflatnum = skyflatnum;

// ---------- Net buffers (kept for API parity, unused in single-player) ----------
export const BACKUPTICS    = 12;
export const MAXNETNODES   = 8;
export const localcmds  = Array.from({ length: BACKUPTICS }, () => new ticcmd_t());
export const nettics    = new Int32Array(MAXNETNODES);
export const netcmds    = Array.from({ length: MAXPLAYERS }, () =>
  Array.from({ length: BACKUPTICS }, () => new ticcmd_t())
);
export let maketic = 0;
export let ticdup  = 1;
export function set_maketic(v) { maketic = v; }
export function set_ticdup(v)  { ticdup = v; }
