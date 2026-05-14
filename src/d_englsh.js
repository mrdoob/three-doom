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

// --- Ultimate Doom episode 4 ---
export const HUSTR_E4M1 = 'E4M1: Hell Beneath';
export const HUSTR_E4M2 = 'E4M2: Perfect Hatred';
export const HUSTR_E4M3 = 'E4M3: Sever The Wicked';
export const HUSTR_E4M4 = 'E4M4: Unruly Evil';
export const HUSTR_E4M5 = 'E4M5: They Will Repent';
export const HUSTR_E4M6 = 'E4M6: Against Thee Wickedly';
export const HUSTR_E4M7 = 'E4M7: And Hell Followed';
export const HUSTR_E4M8 = 'E4M8: Unto The Cruel';
export const HUSTR_E4M9 = 'E4M9: Fear';

// --- Doom 2 level titles ---
export const HUSTR_1  = "level 1: entryway";
export const HUSTR_2  = "level 2: underhalls";
export const HUSTR_3  = "level 3: the gantlet";
export const HUSTR_4  = "level 4: the focus";
export const HUSTR_5  = "level 5: the waste tunnels";
export const HUSTR_6  = "level 6: the crusher";
export const HUSTR_7  = "level 7: dead simple";
export const HUSTR_8  = "level 8: tricks and traps";
export const HUSTR_9  = "level 9: the pit";
export const HUSTR_10 = "level 10: refueling base";
export const HUSTR_11 = "level 11: 'o' of destruction!";
export const HUSTR_12 = "level 12: the factory";
export const HUSTR_13 = "level 13: downtown";
export const HUSTR_14 = "level 14: the inmost dens";
export const HUSTR_15 = "level 15: industrial zone";
export const HUSTR_16 = "level 16: suburbs";
export const HUSTR_17 = "level 17: tenements";
export const HUSTR_18 = "level 18: the courtyard";
export const HUSTR_19 = "level 19: the citadel";
export const HUSTR_20 = "level 20: gotcha!";
export const HUSTR_21 = "level 21: nirvana";
export const HUSTR_22 = "level 22: the catacombs";
export const HUSTR_23 = "level 23: barrels o' fun";
export const HUSTR_24 = "level 24: the chasm";
export const HUSTR_25 = "level 25: bloodfalls";
export const HUSTR_26 = "level 26: the abandoned mines";
export const HUSTR_27 = "level 27: monster condo";
export const HUSTR_28 = "level 28: the spirit world";
export const HUSTR_29 = "level 29: the living end";
export const HUSTR_30 = "level 30: icon of sin";
export const HUSTR_31 = "level 31: wolfenstein";
export const HUSTR_32 = "level 32: grosse";

// --- Multiplayer player names + chat keys ---
export const HUSTR_PLRGREEN  = 'Green: ';
export const HUSTR_PLRINDIGO = 'Indigo: ';
export const HUSTR_PLRBROWN  = 'Brown: ';
export const HUSTR_PLRRED    = 'Red: ';
export const HUSTR_KEYGREEN  = 'g';
export const HUSTR_KEYINDIGO = 'i';
export const HUSTR_KEYBROWN  = 'b';
export const HUSTR_KEYRED    = 'r';

// --- f_finale.c — episode ending text ---
export const E1TEXT =
  "Once you beat the big badasses and\nclean out the moon base you're supposed\n" +
  "to win, aren't you? Aren't you? Where's\nyour fat reward and ticket home? What\n" +
  "the hell is this? It's not supposed to\nend this way!\n\n" +
  "It stinks like rotten meat, but looks\nlike the lost Deimos base.  Looks like\n" +
  "you're stuck on The Shores of Hell.\nThe only way out is through.\n\n" +
  "To continue the DOOM experience, play\nThe Shores of Hell and its amazing\n" +
  "sequel, Inferno!\n";

export const E2TEXT =
  "You've done it! The hideous cyber-\ndemon lord that ruled the lost Deimos\n" +
  "moon base has been slain and you\nare triumphant! But ... where are\n" +
  "you? You clamber to the edge of the\nmoon and look down to see the awful\n" +
  "truth.\n\n" +
  "Deimos floats above Hell itself!\nYou've never heard of anyone escaping\n" +
  "from Hell, but you'll make the bastards\nsorry they ever heard of you! Quickly,\n" +
  "you rappel down to  the surface of\nHell.\n\n" +
  "Now, it's on to the final chapter of\nDOOM! -- Inferno.";

export const E3TEXT =
  "The loathsome spiderdemon that\nmasterminded the invasion of the moon\n" +
  "bases and caused so much death has had\nits ass kicked for all time.\n\n" +
  "A hidden doorway opens and you enter.\nYou've proven too tough for Hell to\n" +
  "contain, and now Hell at last plays\nfair -- for you emerge from the door\n" +
  "to see the green fields of Earth!\nHome at last.\n\n" +
  "You wonder what's been happening on\nEarth while you were battling evil\n" +
  "unleashed. It's good that no Hell-\nspawn could have come through that\n" +
  "door with you ...";

export const E4TEXT =
  "the spider mastermind must have sent forth\nits legions of hellspawn before your\n" +
  "final confrontation with that terrible\nbeast from hell.  but you stepped forward\n" +
  "and brought forth eternal damnation and\nsuffering upon the horde as a true hero\n" +
  "would in the face of something so evil.\n\n" +
  "besides, someone was gonna pay for what\nhappened to daisy, your pet rabbit.\n\n" +
  "but now, you see spread before you more\npotential pain and gibbitude as a nation\n" +
  "of demons run amok among our cities.\n\n" +
  "next stop, hell on earth!";

// Doom 2 finale (between chapters of MAP01-30).
export const C1TEXT =
  "YOU HAVE ENTERED DEEPLY INTO THE INFESTED\nSTARPORT. BUT SOMETHING IS WRONG. THE\n" +
  "MONSTERS HAVE BROUGHT THEIR OWN REALITY\nWITH THEM, AND THE STARPORT'S TECHNOLOGY\n" +
  "IS BEING SUBVERTED BY THEIR PRESENCE.\n\n" +
  "AHEAD, YOU SEE AN OUTPOST OF HELL, A\nFORTIFIED ZONE. IF YOU CAN GET PAST IT,\n" +
  "YOU CAN PENETRATE INTO THE HAUNTED HEART\nOF THE STARBASE AND FIND THE CONTROLLING\n" +
  "SWITCH WHICH HOLDS EARTH'S POPULATION\nHOSTAGE.";

export const C2TEXT =
  "YOU HAVE WON! YOUR VICTORY HAS ENABLED\nHUMANKIND TO EVACUATE EARTH AND ESCAPE\n" +
  "THE NIGHTMARE.  NOW YOU ARE THE ONLY\nHUMAN LEFT ON THE FACE OF THE PLANET.\n" +
  "CANNIBAL MUTATIONS, CARNIVOROUS ALIENS,\nAND EVIL SPIRITS ARE YOUR ONLY NEIGHBORS.\n" +
  "YOU SIT BACK AND WAIT FOR DEATH, CONTENT\nTHAT YOU HAVE SAVED YOUR SPECIES.\n\n" +
  "BUT THEN, EARTH CONTROL BEAMS DOWN A\nMESSAGE FROM SPACE: \"SENSORS HAVE LOCATED\n" +
  "THE SOURCE OF THE ALIEN INVASION. IF YOU\nGO THERE, YOU MAY BE ABLE TO BLOCK THEIR\n" +
  "ENTRY.  THE ALIEN BASE IS IN THE HEART OF\nYOUR OWN HOME CITY, NOT FAR FROM THE\n" +
  "STARPORT.\" SLOWLY AND PAINFULLY YOU GET\nUP AND RETURN TO THE FRAY.";

export const C3TEXT =
  "YOU ARE AT THE CORRUPT HEART OF THE CITY,\nSURROUNDED BY THE CORPSES OF YOUR ENEMIES.\n" +
  "YOU SEE NO WAY TO DESTROY THE CREATURES'\nENTRYWAY ON THIS SIDE, SO YOU CLENCH YOUR\n" +
  "TEETH AND PLUNGE THROUGH IT.\n\n" +
  "THERE MUST BE A WAY TO CLOSE IT ON THE\nOTHER SIDE. WHAT DO YOU CARE IF YOU'VE\n" +
  "GOT TO GO THROUGH HELL TO GET TO IT?";

export const C4TEXT =
  "THE HORRENDOUS VISAGE OF THE BIGGEST\nDEMON YOU'VE EVER SEEN CRUMBLES BEFORE\n" +
  "YOU, AFTER YOU PUMP YOUR ROCKETS INTO\nHIS EXPOSED BRAIN. THE MONSTER SHRIVELS\n" +
  "UP AND DIES, ITS THRASHING LIMBS\nDEVASTATING UNTOLD MILES OF HELL'S\n" +
  "SURFACE.\n\n" +
  "YOU'VE DONE IT. THE INVASION IS OVER.\nEARTH IS SAVED. HELL IS A WRECK. YOU\n" +
  "WONDER WHERE BAD FOLKS WILL GO WHEN THEY\nDIE, NOW. WIPING THE SWEAT FROM YOUR\n" +
  "FOREHEAD YOU BEGIN THE LONG TREK BACK\nHOME. REBUILDING EARTH OUGHT TO BE A\n" +
  "LOT MORE FUN THAN RUINING IT WAS.\n";

export const C5TEXT =
  "CONGRATULATIONS, YOU'VE FOUND THE SECRET\nLEVEL! LOOKS LIKE IT'S BEEN BUILT BY\n" +
  "HUMANS, RATHER THAN DEMONS. YOU WONDER\nWHO THE INMATES OF THIS CORNER OF HELL\nWILL BE.";

export const C6TEXT =
  "CONGRATULATIONS, YOU'VE FOUND THE\nSUPER SECRET LEVEL!  YOU'D BETTER\nBLAZE THROUGH THIS ONE!\n";

// Character cast strings (f_finale.c).
export const CC_ZOMBIE  = 'ZOMBIEMAN';
export const CC_SHOTGUN = 'SHOTGUN GUY';
export const CC_HEAVY   = 'HEAVY WEAPON DUDE';
export const CC_IMP     = 'IMP';
export const CC_DEMON   = 'DEMON';
export const CC_LOST    = 'LOST SOUL';
export const CC_CACO    = 'CACODEMON';
export const CC_HELL    = 'HELL KNIGHT';
export const CC_BARON   = 'BARON OF HELL';
export const CC_ARACH   = 'ARACHNOTRON';
export const CC_PAIN    = 'PAIN ELEMENTAL';
export const CC_REVEN   = 'REVENANT';
export const CC_MANCU   = 'MANCUBUS';
export const CC_ARCH    = 'ARCH-VILE';
export const CC_SPIDER  = 'THE SPIDER MASTERMIND';
export const CC_CYBER   = 'THE CYBERDEMON';
export const CC_HERO    = 'OUR HERO';

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
