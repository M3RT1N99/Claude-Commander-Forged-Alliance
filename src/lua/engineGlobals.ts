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

/** Verdrahtet die Terrain-Höhe der geladenen Karte (GetTerrainHeight). */
export function setTerrainSource(host: LuaHost, heightAt: (x: number, z: number) => number): void {
  host.setGlobal('__terrainHeight', heightAt)
}
