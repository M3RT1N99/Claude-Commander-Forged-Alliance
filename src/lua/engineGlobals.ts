import type { LuaHost } from './host'
import ENGINE_LUA from '../engine-lua/globals.lua?raw'

/**
 * Echte Engine-Globals, die die Original-Lua aufruft.
 *
 * Diese Funktionen sind im Original C++-Globals (`CScrLuaInitForm` mit
 * mClassName `"<global>"`). Bisher lieferte der Stub-Trap dafür stumme
 * Identitätsfunktionen — mit dem Ergebnis, dass Guards in der Original-Lua
 * kippten (`IsDestroyed(lebende Unit)` → true, `EntityCategoryContains(AIR,
 * ACU)` → true). Hier sind sie ECHT implementiert.
 *
 * Das Kategorie-System entspricht der Engine: `categories.X` liefert eine
 * EntityCategory, die `+` (ODER), `*` (UND) und `-` (Differenz) unterstützt;
 * getestet wird gegen die `Categories`-Liste des Blueprints.
 */


/** Installiert die echten Engine-Globals (Vektoren, Kategorien, Manipulatoren …). */
export function installEngineGlobals(host: LuaHost): void {
  host.eval(ENGINE_LUA)
}

/**
 * Verdrahtet die Terrain-Höhe der geladenen Karte (GetTerrainHeight) und die
 * Kartenmaße (GetMapSize). Das Heightfield hat (width+1)×(height+1) Samples, die
 * Engine liefert `field->width - 1` / `field->height - 1` — also genau die
 * Zell-Maße width/height (Cfile:1089736/1089738).
 */
export function setTerrainSource(
  host: LuaHost,
  heightAt: (x: number, z: number) => number,
  size?: { width: number; height: number },
): void {
  host.setGlobal('__terrainHeight', heightAt)
  if (size) {
    host.setGlobal('__mapSizeX', size.width)
    host.setGlobal('__mapSizeZ', size.height)
  }
}
