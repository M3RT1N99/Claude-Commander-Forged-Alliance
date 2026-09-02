import * as THREE from 'three'
import type { UnitViewer, SceneUnit } from '../viewer/unitViewer'
import type { SandboxUnitAssets } from '../sandbox/sandbox'
import { snapToGrid } from './worldCommands'
import { bpGet } from '../formats/blueprint'
import type { Validity } from '../sim/ogrid'

/**
 * Ghost tints. These colours are a UI affordance (like the translucency below),
 * NOT engine values — but WHICH one is shown is the engine's verdict
 * (canBuildStructureAt, src/sim/ogrid.ts): green = buildable here, red = blocked,
 * blue = we cannot judge faithfully (mobile / deposit-restricted, no markers).
 */
const TINT_VALID = new THREE.Color(0x33ff66)
const TINT_INVALID = new THREE.Color(0xff3333)
const TINT_UNKNOWN = new THREE.Color(0x66ccff)
const TINT: Record<Validity, THREE.Color> = {
  valid: TINT_VALID,
  invalid: TINT_INVALID,
  unknown: TINT_UNKNOWN,
}

/**
 * Die Bau-Vorschau: das Geistergebäude am gerasterten Punkt unter dem Cursor.
 *
 * Das ist ENGINE-Arbeit, keine Lua-Sache: die Original-Lua kennt keine Vorschau
 * (es gibt keinen einzigen Treffer für „Ghost"/„BuildPreview" in `lua/**`), die
 * Weltansicht der Engine zeichnet sie selbst — `Moho::UIBuildDragger`
 * (Cfile:1243616) hängt an der Maus, solange der Command-Mode `build` läuft.
 *
 * Die Daten kommen trotzdem alle aus dem Spiel: das MODELL ist das Modell des
 * Blueprints, und die POSITION ist exakt der Raster-Snap der Engine
 * (`COORDS_GridSnap` @0x50B1E0 — `cell = trunc(p − size/2)`, zurück `+ size/2`,
 * Höhe erst nach dem Snap; unter Wasser auf die Oberfläche geklemmt, s.
 * snapToGrid). Erfunden ist hier nichts außer der Tatsache, dass ein Geist
 * durchscheinend gezeichnet wird.
 *
 * Rot/Grün-Validität: das Urteil kommt aus `canBuildStructureAt`
 * (src/sim/ogrid.ts) und wird oben eingehängt — der Geist ist also NICHT
 * einfarbig. Dieser Absatz behauptete bis eben das Gegenteil, direkt über dem
 * Code, der die Prüfung verdrahtet.
 *
 * Was daran noch NÄHERUNG ist, und zwar benannt: der maßgebliche Test der
 * Engine ist `CAiBrain::CanBuildStructureAt` (@0x57cbb0) mit
 * `func_LocationIsFree(bp, mOGrid, pos)` — eine Abfrage des echten
 * OCCUPANCY-GRID (`COGrid`, pro Zelle Layer UND Belegung), dazu reservierte
 * Bau-Positionen. Beides gibt es hier nicht: unsere Prüfung arbeitet mit
 * Skirt-Overlap und der Wasser-/Land-Ebene aus der Karte. In Randfällen kann
 * das Urteil deshalb vom Spiel abweichen — nicht aber im Regelfall, und die
 * Abweichung ist eine benannte Näherung, keine erfundene Zusage.
 */
export class BuildPreview {
  private mesh: THREE.Mesh | null = null
  /** Der Szenen-Eintrag — er muss beim Aufräumen AUS DER TREFFERLISTE raus. */
  private unit: SceneUnit | null = null
  private blueprintId = ''
  private loading = ''
  private validity: Validity = 'unknown'
  /**
   * Answers "can this blueprint be built at the snapped centre (x, z)?" — the
   * host wires it to canBuildStructureAt with the map's terrain/water/occupancy
   * (src/main.ts). Absent -> the ghost stays neutral (the old behaviour).
   */
  private validityAt: ((blueprintId: string, x: number, z: number) => Validity) | null = null

  constructor(
    private readonly viewer: UnitViewer,
    private readonly loadAssets: (id: string) => Promise<SandboxUnitAssets | null>,
  ) {}

  /** Wire the placement-validity query (canBuildStructureAt). */
  setValidityProvider(fn: (blueprintId: string, x: number, z: number) => Validity): void {
    this.validityAt = fn
  }

  /** Kein Bau-Modus mehr (oder Cursor außerhalb der Karte): Geist verschwindet. */
  hide(): void {
    if (this.mesh) this.mesh.visible = false
  }

  /**
   * Cursor bewegt sich im Bau-Modus: den Geist auf das Raster setzen.
   *
   * `footprint` sind die ganzzahligen `Footprint.SizeX/SizeZ` des Blueprints —
   * dieselben Zahlen, mit denen die Sim das Gebäude gleich platziert. Vorschau
   * und Ergebnis können also gar nicht auseinanderlaufen.
   */
  async show(
    blueprintId: string,
    hit: { x: number; z: number },
    footprint: [number, number],
    waterElevation?: number,
  ): Promise<void> {
    const pos = snapToGrid(
      hit.x,
      hit.z,
      footprint[0],
      footprint[1],
      (x, z) => this.viewer.heightAt(x, z),
      waterElevation,
    )

    if (this.blueprintId !== blueprintId) {
      // Ein anderes Gebäude: das alte Modell weg, das neue laden.
      this.dispose()
      this.blueprintId = blueprintId
      if (this.loading === blueprintId) return
      this.loading = blueprintId
      const assets = await this.loadAssets(blueprintId)
      this.loading = ''
      // Während des Ladens kann der Modus schon weitergezogen sein.
      if (!assets || this.blueprintId !== blueprintId) return

      const unit = this.viewer.addUnit(
        assets.model,
        assets.textures,
        new THREE.Color(0x66ccff),
        assets.shader,
      )
      this.unit = unit
      this.mesh = unit.mesh
      // Die GRÖSSE steht im Blueprint: `Display.UniformScale`. Das Modell selbst
      // ist in Modell-Einheiten gebaut, nicht in Weltmetern — jede echte Einheit
      // wird damit skaliert (main.ts:addLuaUnitToScene). Ohne diese Zeile stand
      // der Geist um ein Vielfaches zu groß auf der Karte.
      const scale = bpGet(assets.bp, 'Display.UniformScale')
      if (typeof scale === 'number' && scale > 0) this.mesh.scale.setScalar(scale)
      // Durchscheinend — sonst ist der Geist von einem fertigen Gebäude nicht zu
      // unterscheiden.
      const mat = this.mesh.material as THREE.Material
      mat.transparent = true
      mat.opacity = 0.45
      mat.depthWrite = false
      this.mesh.renderOrder = 8
    }

    if (this.mesh) {
      this.mesh.position.set(pos.x, pos.y, pos.z)
      this.mesh.visible = true
      // Red/green feedback — recomputed every move, since the same ghost turns
      // valid/invalid as it slides across cells and over other structures.
      this.validity = this.validityAt ? this.validityAt(blueprintId, pos.x, pos.z) : 'unknown'
      const mat = this.mesh.material as THREE.ShaderMaterial
      if (mat.uniforms && mat.uniforms.teamColor) {
        ;(mat.uniforms.teamColor.value as THREE.Color).copy(TINT[this.validity])
      }
    }
  }

  /** Wo steht der Geist gerade? (Für den Selbsttest — er muss auf dem Raster sitzen.) */
  debugPosition(): string | null {
    if (!this.mesh || !this.mesh.visible) return null
    const p = this.mesh.position
    return `${this.blueprintId} @ ${p.x.toFixed(1)}, ${p.z.toFixed(1)} [${this.validity}]`
  }

  /**
   * Modell aus der Szene nehmen (Modus beendet, Karte gewechselt).
   *
   * Über `viewer.removeUnit` — nicht nur `removeFromParent()`: der Geist muss
   * auch aus der TREFFERLISTE des Renderers verschwinden. Der Raycaster von
   * three.js prüft `visible` nicht, und ein liegengebliebener Geist fängt danach
   * jeden Klick ab. Genau daran ließ sich die ACU nach dem ersten Bau-Befehl
   * nicht mehr auswählen.
   */
  dispose(): void {
    if (this.unit) {
      this.viewer.removeUnit(this.unit)
      this.unit = null
      this.mesh = null
    }
    this.blueprintId = ''
  }
}
