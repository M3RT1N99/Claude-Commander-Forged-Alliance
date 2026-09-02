import type { LuaHost } from './host'
import ENGINE_LUA from '../engine-lua/globals.lua?raw'
import INFLUENCE_LUA from '../engine-lua/influence.lua?raw'

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
  // Die Bedrohungskarte. Eigene Datei, weil sie ein eigenes Subsystem ist
  // (Moho::CInfluenceMap, eine Karte je Armee) und globals.lua ohnehin schon
  // gross genug ist.
  host.eval(INFLUENCE_LUA)
}

/**
 * Die Masse der geladenen Karte, wie `setTerrainSource` sie erwartet. Als
 * eigener Typ, weil `installEngine` sie durchreicht: die Engine kennt die
 * Karte, BEVOR sie die Armeen erzeugt (Cfile:1017315-1017333).
 */
export interface TerrainSize {
  width: number
  height: number
  waterElevation?: number
  /**
   * Der TYPCODE der Terrain-Typ-Ebene an einer Zelle
   * (`scmap.terrainTypeData`, ein Byte je Zelle).
   *
   * Ohne ihn beantwortet `GetTerrainType` jede Position mit 'Default'
   * (`STIMap::GetTerrainType`, Cfile:1087705 liest genau diese Ebene) — und
   * damit sind Bewegungs-, Effekt- und Geräuschentscheidungen, die daran
   * hängen, auf jeder Karte gleich.
   */
  terrainTypeAt?: (x: number, z: number) => number
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
  size?: TerrainSize,
): void {
  host.setGlobal('__terrainHeight', heightAt)
  if (size) {
    host.setGlobal('__mapSizeX', size.width)
    host.setGlobal('__mapSizeZ', size.height)
    // The map's water surface, from the same STIMap step that loads the
    // heightfield. Absent water is exactly -10000 (Entity::GetStartingLayer,
    // Cfile:857506-857510), which is what `__setWaterLevel(nil)` stores — so a
    // caller with no water (every synthetic test terrain) keeps the
    // mWaterEnabled = false behaviour and GetSurfaceHeight stays the raw
    // elevation.
    host.eval(`__setWaterLevel(${size.waterElevation ?? 'nil'})`)
    if (size.terrainTypeAt) host.setGlobal('__terrainTypeAt', size.terrainTypeAt)
  }
}
