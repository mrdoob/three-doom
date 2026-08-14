// Renderer-free DoomEd-number lookup from p_mobj.c:P_SpawnMapThing.

export function P_FindMapThingType(mthing, mobjinfo, fail) {
  for (let type = 0; type < mobjinfo.length; type++) {
    if (mobjinfo[type].doomednum === mthing.type) return type;
  }

  fail(
    `P_SpawnMapThing: Unknown type ${mthing.type} at (${mthing.x}, ${mthing.y})`,
  );
}
