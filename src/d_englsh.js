// Ported from: linuxdoom-1.10/d_englsh.h
// English-language string table. The #define macros are exported as `const`s
// keeping their vanilla identifiers so caller code reads the same.

// --- d_main.c ---
export const D_DEVSTR = 'Development mode ON.\n';
export const D_CDROM  = 'CD-ROM Version: default.cfg from c:\\doomdata\n';

// --- m_menu.c ---
export const PRESSKEY  = 'press a key.';
export const PRESSYN   = 'press y or n.';
export const QUITMSG   = 'are you sure you want to\nquit this great game?';
export const LOADNET   = "you can't do load while in a net game!\n\n" + PRESSKEY;
export const QLOADNET  = "you can't quickload during a netgame!\n\n" + PRESSKEY;
export const QSAVESPOT = "you haven't picked a quicksave slot yet!\n\n" + PRESSKEY;
export const SAVEDEAD  = "you can't save if you aren't playing!\n\n" + PRESSKEY;
export const QSPROMPT  = "quicksave over your game named\n\n'%s'?\n\n" + PRESSYN;
export const QLPROMPT  = "do you want to quickload the game named\n\n'%s'?\n\n" + PRESSYN;
export const NEWGAME   = "you can't start a new game\nwhile in a network game.\n\n" + PRESSKEY;
export const NIGHTMARE = "are you sure? this skill level\nisn't even remotely fair.\n\n" + PRESSYN;
export const SWSTRING  = 'this is the shareware version of doom.\n\nyou need to order the entire trilogy.\n\n' + PRESSKEY;
export const MSGOFF    = 'Messages OFF';
export const MSGON     = 'Messages ON';
export const NETEND    = "you can't end a netgame!\n\n" + PRESSKEY;
export const ENDGAME   = 'are you sure you want to end the game?\n\n' + PRESSYN;
export const DOSY      = '(press y to quit)';
export const DETAILHI  = 'High detail';
export const DETAILLO  = 'Low detail';
export const GAMMALVL0 = 'Gamma correction OFF';
export const GAMMALVL1 = 'Gamma correction level 1';
export const GAMMALVL2 = 'Gamma correction level 2';
export const GAMMALVL3 = 'Gamma correction level 3';
export const GAMMALVL4 = 'Gamma correction level 4';
export const EMPTYSTRING = 'empty slot';

// --- p_inter.c (pickup messages) ---
export const GOTARMOR    = 'Picked up the armor.';
export const GOTMEGA     = 'Picked up the MegaArmor!';
export const GOTHTHBONUS = 'Picked up a health bonus.';
export const GOTARMBONUS = 'Picked up an armor bonus.';
export const GOTSTIM     = 'Picked up a stimpack.';
export const GOTMEDINEED = 'Picked up a medikit that you REALLY need!';
export const GOTMEDIKIT  = 'Picked up a medikit.';
export const GOTSUPER    = 'Supercharge!';
export const GOTBLUECARD = 'Picked up a blue keycard.';
export const GOTYELWCARD = 'Picked up a yellow keycard.';
export const GOTREDCARD  = 'Picked up a red keycard.';
export const GOTBLUESKUL = 'Picked up a blue skull key.';
export const GOTYELWSKUL = 'Picked up a yellow skull key.';
export const GOTREDSKULL = 'Picked up a red skull key.';
export const GOTINVUL    = 'Invulnerability!';
export const GOTBERSERK  = 'Berserk!';
export const GOTINVIS    = 'Partial Invisibility';
export const GOTSUIT     = 'Radiation Shielding Suit';
export const GOTMAP      = 'Computer Area Map';
export const GOTVISOR    = 'Light Amplification Visor';
export const GOTMSPHERE  = 'MegaSphere!';
export const GOTCLIP     = 'Picked up a clip.';
export const GOTCLIPBOX  = 'Picked up a box of bullets.';
export const GOTROCKET   = 'Picked up a rocket.';
export const GOTROCKBOX  = 'Picked up a box of rockets.';
export const GOTCELL     = 'Picked up an energy cell.';
export const GOTCELLBOX  = 'Picked up an energy cell pack.';
export const GOTSHELLS   = 'Picked up 4 shotgun shells.';
export const GOTSHELLBOX = 'Picked up a box of shotgun shells.';
export const GOTBACKPACK = 'Picked up a backpack full of ammo!';
export const GOTBFG9000   = 'You got the BFG9000!  Oh, yes.';
export const GOTCHAINGUN  = 'You got the chaingun!';
export const GOTCHAINSAW  = 'A chainsaw!  Find some meat!';
export const GOTLAUNCHER  = 'You got the rocket launcher!';
export const GOTPLASMA    = 'You got the plasma gun!';
export const GOTSHOTGUN   = 'You got the shotgun!';
export const GOTSHOTGUN2  = 'You got the super shotgun!';

// --- Door / keycard required ---
export const PD_BLUEO   = 'You need a blue key to activate this object';
export const PD_REDO    = 'You need a red key to activate this object';
export const PD_YELLOWO = 'You need a yellow key to activate this object';
export const PD_BLUEK   = 'You need a blue key to open this door';
export const PD_REDK    = 'You need a red key to open this door';
export const PD_YELLOWK = 'You need a yellow key to open this door';

// --- g_game.c ---
export const GGSAVED = 'game saved.';

// --- HU_stuff.c — multiplayer chat ---
export const HUSTR_MSGU       = '[Message unsent]';
export const HUSTR_MESSAGESENT = '[Message Sent]';
export const HUSTR_CHATMACRO0 = 'No';
export const HUSTR_CHATMACRO1 = "I'm ready to kick butt!";
export const HUSTR_CHATMACRO2 = "I'm OK.";
export const HUSTR_CHATMACRO3 = "I'm not looking too good!";
export const HUSTR_CHATMACRO4 = 'Help!';
export const HUSTR_CHATMACRO5 = 'You suck!';
export const HUSTR_CHATMACRO6 = 'Next time, scumbag...';
export const HUSTR_CHATMACRO7 = 'Come here!';
export const HUSTR_CHATMACRO8 = "I'll take care of it.";
export const HUSTR_CHATMACRO9 = 'Yes';
export const HUSTR_TALKTOSELF1 = 'You mumble to yourself';
export const HUSTR_TALKTOSELF2 = 'Who\'s there?';
export const HUSTR_TALKTOSELF3 = 'You scare yourself';
export const HUSTR_TALKTOSELF4 = 'You start to rave';
export const HUSTR_TALKTOSELF5 = 'You\'ve lost it...';

// --- am_map.c (automap key labels) ---
export const AMSTR_FOLLOWON  = 'Follow Mode ON';
export const AMSTR_FOLLOWOFF = 'Follow Mode OFF';
export const AMSTR_GRIDON    = 'Grid ON';
export const AMSTR_GRIDOFF   = 'Grid OFF';
export const AMSTR_MARKEDSPOT = 'Marked Spot';
export const AMSTR_MARKSCLEARED = 'All Marks Cleared';

// --- st_stuff.c (cheat acknowledgements) ---
export const STSTR_MUS       = 'Music Change';
export const STSTR_NOMUS     = 'IMPOSSIBLE SELECTION';
export const STSTR_DQDON     = 'Degreelessness Mode On';
export const STSTR_DQDOFF    = 'Degreelessness Mode Off';
export const STSTR_KFAADDED  = 'Very Happy Ammo Added';
export const STSTR_FAADDED   = 'Ammo (no keys) Added';
export const STSTR_NCON      = 'No Clipping Mode ON';
export const STSTR_NCOFF     = 'No Clipping Mode OFF';
export const STSTR_BEHOLD    = 'inVuln, Str, Inviso, Rad, Allmap, or Lite-amp';
export const STSTR_BEHOLDX   = 'Power-up Toggled';
export const STSTR_CHOPPERS  = '... doesn\'t suck - GM';
export const STSTR_CLEV      = 'Changing Level...';

// --- Level titles — Doom 1 ---
export const HUSTR_E1M1 = 'E1M1: Hangar';
export const HUSTR_E1M2 = 'E1M2: Nuclear Plant';
export const HUSTR_E1M3 = 'E1M3: Toxin Refinery';
export const HUSTR_E1M4 = 'E1M4: Command Control';
export const HUSTR_E1M5 = 'E1M5: Phobos Lab';
export const HUSTR_E1M6 = 'E1M6: Central Processing';
export const HUSTR_E1M7 = 'E1M7: Computer Station';
export const HUSTR_E1M8 = 'E1M8: Phobos Anomaly';
export const HUSTR_E1M9 = 'E1M9: Military Base';
export const HUSTR_E2M1 = 'E2M1: Deimos Anomaly';
export const HUSTR_E2M2 = 'E2M2: Containment Area';
export const HUSTR_E2M3 = 'E2M3: Refinery';
export const HUSTR_E2M4 = 'E2M4: Deimos Lab';
export const HUSTR_E2M5 = 'E2M5: Command Center';
export const HUSTR_E2M6 = 'E2M6: Halls of the Damned';
export const HUSTR_E2M7 = 'E2M7: Spawning Vats';
export const HUSTR_E2M8 = 'E2M8: Tower of Babel';
export const HUSTR_E2M9 = 'E2M9: Fortress of Mystery';
export const HUSTR_E3M1 = 'E3M1: Hell Keep';
export const HUSTR_E3M2 = 'E3M2: Slough of Despair';
export const HUSTR_E3M3 = 'E3M3: Pandemonium';
export const HUSTR_E3M4 = 'E3M4: House of Pain';
export const HUSTR_E3M5 = 'E3M5: Unholy Cathedral';
export const HUSTR_E3M6 = 'E3M6: Mt. Erebus';
export const HUSTR_E3M7 = 'E3M7: Limbo';
export const HUSTR_E3M8 = 'E3M8: Dis';
export const HUSTR_E3M9 = 'E3M9: Warrens';

// --- f_finale.c — episode ending text (re-exports of strings already in f_finale.js) ---
export const E1TEXT =
  "Once you beat the big badasses and\nclean out the moon base you're supposed\n" +
  "to win, aren't you? Aren't you? Where's\nyour fat reward and ticket home? What\n" +
  "the hell is this? It's not supposed to\nend this way!\n\n" +
  "It stinks like rotten meat, but looks\nlike the lost Deimos base.  Looks like\n" +
  "you're stuck on The Shores of Hell.\nThe only way out is through.\n\n" +
  "To continue the DOOM experience, play\nThe Shores of Hell and its amazing\n" +
  "sequel, Inferno!";

// --- Cheats (vanilla scramble-obfuscated; we expose the plaintext sequences) ---
export const IDDQD    = 'iddqd';
export const IDKFA    = 'idkfa';
export const IDFA     = 'idfa';
export const IDSPISPOPD = 'idspispopd';
export const IDCLIP   = 'idclip';
export const IDBEHOLD = 'idbehold';
export const IDCHOPPERS = 'idchoppers';
export const IDCLEV   = 'idclev';
export const IDMYPOS  = 'idmypos';
