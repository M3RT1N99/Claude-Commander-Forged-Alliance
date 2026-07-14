import * as THREE from 'three'
import type { UnitViewer } from '../viewer/unitViewer'
import type { SandboxUnitAssets } from '../sandbox/sandbox'
import { snapToGrid } from './worldCommands'

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
 * Höhe erst nach dem Snap). Erfunden ist hier nichts außer der Tatsache, dass ein
 * Geist durchscheinend gezeichnet wird.
 */
export class BuildPreview {
  private mesh: THREE.Mesh | null = null
  private blueprintId = ''
  private loading = ''

  constructor(
    private readonly viewer: UnitViewer,
    private readonly loadAssets: (id: string) => Promise<SandboxUnitAssets | null>,
  ) {}

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
  ): Promise<void> {
    const pos = snapToGrid(hit.x, hit.z, footprint[0], footprint[1], (x, z) =>
      this.viewer.heightAt(x, z),
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
      this.mesh = unit.mesh
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
    }
  }

  /** Wo steht der Geist gerade? (Für den Selbsttest — er muss auf dem Raster sitzen.) */
  debugPosition(): string | null {
    if (!this.mesh || !this.mesh.visible) return null
    const p = this.mesh.position
    return `${this.blueprintId} @ ${p.x.toFixed(1)}, ${p.z.toFixed(1)}`
  }

  /** Modell aus der Szene nehmen (Modus beendet, Karte gewechselt). */
  dispose(): void {
    if (this.mesh) {
      this.mesh.removeFromParent()
      this.mesh.geometry.dispose()
      this.mesh = null
    }
    this.blueprintId = ''
  }
}
