// Ported from: linuxdoom-1.10/dstrings.c, d_englsh.h, dstrings.h
// All printable strings (pickup, doors, menu, HUD, finale, chat, quit).

// Pickup.
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
export const GOTBFG9000  = 'You got the BFG9000!  Oh, yes.';
export const GOTCHAINGUN = 'You got the chaingun!';
export const GOTCHAINSAW = 'A chainsaw!  Find some meat!';
export const GOTLAUNCHER = 'You got the rocket launcher!';
export const GOTPLASMA   = 'You got the plasma gun!';
export const GOTSHOTGUN  = 'You got the shotgun!';
export const GOTSHOTGUN2 = 'You got the super shotgun!';

// Locked doors. d_englsh.h:125-130 — O suffix = "activate this object"
// (used by switch line-actions), K suffix = "open this door" (manual door
// line-actions). The previous mapping had these pairwise swapped.
export const PD_BLUEO   = 'You need a blue key to activate this object';
export const PD_REDO    = 'You need a red key to activate this object';
export const PD_YELLOWO = 'You need a yellow key to activate this object';
export const PD_BLUEK   = 'You need a blue key to open this door';
export const PD_REDK    = 'You need a red key to open this door';
export const PD_YELLOWK = 'You need a yellow key to open this door';

// Console / cheat / status messages.
export const GGSAVED       = 'game saved.';
export const HUSTR_MSGU    = '[Message unsent]';
export const STSTR_DQDON   = 'Degreelessness Mode On';
export const STSTR_DQDOFF  = 'Degreelessness Mode Off';
export const STSTR_KFAADDED= 'Very Happy Ammo Added';
export const STSTR_FAADDED = 'Ammo (no keys) Added';
export const STSTR_NCON    = 'No Clipping Mode ON';
export const STSTR_NCOFF   = 'No Clipping Mode OFF';
export const STSTR_BEHOLD  = 'inVuln, Str, Inviso, Rad, Allmap, or Lite-amp';
export const STSTR_BEHOLDX = 'Power-up Toggled';
export const STSTR_CHOPPERS= "... Doesn't suck - GM";
export const STSTR_CLEV    = 'Changing Level...';

// Level names (Doom 1 episodes 1-3).
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

// Quit confirmations.
export const QUITMSG = 'are you sure you want to\nquit this great game?';

// Chat macros (player presses T then 0..9).
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
