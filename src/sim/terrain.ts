/**
 * Das Heightfield der geladenen Karte — die EINE Quelle für die Geländehöhe.
 *
 * Renderer und Sim müssen dieselbe Höhe sehen. Vorher gab es die bilineare
 * Abfrage nur im Renderer (`UnitViewer.heightAt`), während `GetTerrainHeight`
 * in der Lua-VM still 0 lieferte: die Sim fuhr Units auf Höhe 0 durch die Berge,
 * das Bild zeigte etwas anderes, und beide Positionen drifteten in Y auseinander.
 *
 * Das Format kommt aus der .scmap: `(width+1) × (height+1)` uint16-Samples,
 * row-major, multipliziert mit `heightScale`.
 */
export interface HeightfieldData {
  data: Uint16Array
  width: number
  height: number
  scale: number
}

export class Heightfield {
  private readonly stride: number

  constructor(private readonly hf: HeightfieldData) {
    this.stride = hf.width + 1
  }

  /** Höhe an der Weltposition (bilinear zwischen den vier Nachbar-Samples). */
  at(x: number, z: number): number {
    const { data, width, height, scale } = this.hf
    const cx = Math.min(Math.max(x, 0), width - 0.001)
    const cz = Math.min(Math.max(z, 0), height - 0.001)
    const x0 = Math.floor(cx)
    const z0 = Math.floor(cz)
    const fx = cx - x0
    const fz = cz - z0
    const h00 = data[z0 * this.stride + x0]!
    const h10 = data[z0 * this.stride + x0 + 1]!
    const h01 = data[(z0 + 1) * this.stride + x0]!
    const h11 = data[(z0 + 1) * this.stride + x0 + 1]!
    return ((h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz) * scale
  }
}

/**
 * Flaches Testgelände. NUR für Verify-Suiten, die keine Karte laden — und
 * bewusst benannt, damit es niemand für Produktionsverhalten hält. Im Spiel
 * muss immer eine echte Karte gesetzt sein, sonst knallt GetTerrainHeight.
 */
export const FLAT_TEST_TERRAIN = (): number => 0

/**
 * Die MASSE des flachen Testgelaendes — ebenfalls nur fuer Suiten.
 *
 * Eine Sim ohne Kartenmasse ist keine Sim: `GetMapSize()` wirft dann, und daran
 * haengt mehr, als es aussieht. Die Bedrohungskarte etwa (`CInfluenceMap`)
 * leitet ihre Zellgroesse daraus ab und entsteht in der Armee-Erzeugung
 * (Cfile:1017315-1017333); `MobileUnit.OnKilled` schreibt bei JEDEM Tod hinein
 * (defaultunits.lua:1229-1235). Eine Suite, die nur eine Hoehe setzt, laesst
 * den Todes-Pfad also auflaufen.
 *
 * 256 ist die kleinste Groesse, die das Spiel ausliefert — keine erfundene
 * Zahl, sondern die untere echte Kante (und der 8x8-Fall der IMAP-Formel).
 */
export const FLAT_TEST_MAP_SIZE = { width: 256, height: 256 }
