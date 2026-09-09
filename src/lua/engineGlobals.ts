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
   * The stored sample at an integer corner of the heightfield (0..width,
   * 0..height), for the height pyramid below: the world query `heightAt`
   * clamps to width - 0.001 and blends at the far edge, the engine's
   * GetTierBoundsUWord reads the raw sample (Cfile:525225-525250).
   */
  sampleAt?: (ix: number, iz: number) => number
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
  // CHeightField's tiers (the ctor 525543-525580: msb(largest - 1) + 1
  // tiers of (width >> tier) x (height >> tier) cells, at least 1;
  // UpdateBounds 526184-526330: tier 1 holds the min/max of the samples
  // 2x..2x+2 of each cell pair, every higher tier the min/max of the 2 x 2
  // cells below it) and GetTierBoundsUWord (525225-525290: tier 0 is the
  // extreme of a cell's four corner samples, a higher tier the stored
  // cell). The air motion's terrain look-ahead (STIMap::LookAheadForMaxTerrain
  // 859169-859220) reads the max per tick. Built once per map from the same
  // sampler; only the max is kept (the look-ahead reads no min).
  const width = size?.width ?? 256
  const height = size?.height ?? 256
  let tiers: Float32Array[] | undefined
  const buildTiers = (): Float32Array[] => {
    // Level 0: a cell's four corners, the samples x..x+1 and z..z+1.
    const sample = size?.sampleAt ?? heightAt
    const base = new Float32Array(width * height)
    for (let z = 0; z < height; z++) {
      for (let x = 0; x < width; x++) {
        base[z * width + x] = Math.max(sample(x, z), sample(x + 1, z), sample(x, z + 1), sample(x + 1, z + 1))
      }
    }
    const out = [base]
    let w = width
    let h = height
    let prev = base
    while (w > 1 || h > 1) {
      const nw = Math.max(1, w >> 1)
      const nh = Math.max(1, h >> 1)
      const next = new Float32Array(nw * nh)
      for (let z = 0; z < nh; z++) {
        for (let x = 0; x < nw; x++) {
          let m = -Infinity
          for (let dz = 0; dz < 2; dz++) {
            for (let dx = 0; dx < 2; dx++) {
              const sx = Math.min(w - 1, x * 2 + dx)
              const sz = Math.min(h - 1, z * 2 + dz)
              const v = prev[sz * w + sx]!
              if (v > m) m = v
            }
          }
          next[z * nw + x] = m
        }
      }
      out.push(next)
      prev = next
      w = nw
      h = nh
    }
    return out
  }
  host.setGlobal('__terrainMaxTier', (tier: number, bx: number, bz: number): number => {
    tiers ??= buildTiers()
    const level = Math.max(0, Math.min(tiers.length - 1, Math.floor(tier)))
    const lw = Math.max(1, width >> level)
    const lh = Math.max(1, height >> level)
    const x = Math.max(0, Math.min(lw - 1, Math.floor(bx)))
    const z = Math.max(0, Math.min(lh - 1, Math.floor(bz)))
    return tiers[level]![z * lw + x]!
  })
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
