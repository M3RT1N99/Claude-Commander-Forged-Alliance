import * as THREE from 'three'
import type { UnitViewer } from '../viewer/unitViewer'
import type { UnitTextures } from '../viewer/unitMaterial'
import type { ScmModel } from '../formats/scm'
import type { ScaAnim } from '../formats/sca'
import type { BpObject } from '../formats/blueprint'

/** Geladene Render-Assets einer Unit für die Sandbox. */
export interface SandboxUnitAssets {
  id: string
  model: ScmModel
  textures: UnitTextures
  bp: BpObject
  walkAnim: ScaAnim | null
  shader: string
}

/**
 * Schlanke Sandbox-Ansicht: RTS-Kamera + Mass-Punkt-Marker. Die Simulation
 * selbst läuft über die eingebettete **Original-Lua-Engine** (LuaSim) — der
 * frühere TS-Nachbau (SimWorld) wurde entfernt.
 */
export class SandboxController {
  constructor(private readonly viewer: UnitViewer) {
    viewer.setRtsControls(true)
  }

  /** Zeichnet die Mass-Punkt-Marker der Karte (aus den _save.lua-Markern). */
  setMassSpots(spots: { x: number; z: number }[]): void {
    const geo = new THREE.RingGeometry(0.6, 0.9, 24)
    geo.rotateX(-Math.PI / 2)
    for (const s of spots) {
      const marker = new THREE.Mesh(
        geo,
        new THREE.MeshBasicMaterial({ color: 0x9be045, transparent: true, opacity: 0.85 }),
      )
      marker.position.set(s.x, this.viewer.heightAt(s.x, s.z) + 0.06, s.z)
      marker.renderOrder = 5
      this.viewer.addHelper(marker)
    }
  }
}
