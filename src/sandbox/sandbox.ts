import * as THREE from 'three'
import { SimWorld, statsFromBlueprint, type SimUnit } from '../sim/simWorld'
import type { UnitViewer, SceneUnit } from '../viewer/unitViewer'
import type { UnitTextures } from '../viewer/unitMaterial'
import type { ScmModel } from '../formats/scm'
import type { ScaAnim } from '../formats/sca'
import { bpGet, type BpObject } from '../formats/blueprint'

/**
 * Sandbox (M4): bindet den deterministischen Sim-Kern an den Renderer.
 * Die Sim läuft mit festen 10-Hz-Ticks; der Renderer interpoliert zwischen
 * dem vorherigen und dem aktuellen Tick-Zustand. Höhe/Animation sind rein
 * visuell und beeinflussen die Sim nicht.
 */

export interface SandboxUnitAssets {
  id: string
  model: ScmModel
  textures: UnitTextures
  bp: BpObject
  walkAnim: ScaAnim | null
}

interface Binding {
  sim: SimUnit
  scene: SceneUnit
  walkAnim: ScaAnim | null
  walkRate: number
  wasMoving: boolean
}

const SIM_STEP = 0.1

export class SandboxController {
  readonly world = new SimWorld()
  private readonly bindings: Binding[] = []
  private accumulator = 0
  private selected: Binding | null = null
  private readonly ring: THREE.Mesh

  constructor(private readonly viewer: UnitViewer) {
    const ringGeo = new THREE.RingGeometry(0.85, 1, 40)
    ringGeo.rotateX(-Math.PI / 2)
    this.ring = new THREE.Mesh(
      ringGeo,
      new THREE.MeshBasicMaterial({
        color: 0x44ff66,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      }),
    )
    this.ring.visible = false
    this.ring.renderOrder = 10
    viewer.addHelper(this.ring)
    viewer.onUpdate((dt) => this.update(dt))
  }

  spawn(assets: SandboxUnitAssets, x: number, z: number, teamColor: THREE.Color): Binding {
    const scene = this.viewer.addUnit(assets.model, assets.textures, teamColor)

    const uniformScale = bpGet(assets.bp, 'Display.UniformScale')
    if (typeof uniformScale === 'number' && uniformScale > 0) {
      scene.mesh.scale.setScalar(uniformScale)
    }

    const walkRateRaw = bpGet(assets.bp, 'Display.AnimationWalkRate')
    const sim = this.world.spawn(statsFromBlueprint(assets.id, assets.bp), x, z)

    const binding: Binding = {
      sim,
      scene,
      walkAnim: assets.walkAnim,
      walkRate: typeof walkRateRaw === 'number' && walkRateRaw > 0 ? walkRateRaw : 1,
      wasMoving: false,
    }
    this.bindings.push(binding)

    scene.mesh.position.set(sim.x, this.viewer.heightAt(sim.x, sim.z), sim.z)
    return binding
  }

  get selectedUnit(): SimUnit | null {
    return this.selected?.sim ?? null
  }

  get unitCount(): number {
    return this.bindings.length
  }

  /** Klick: Einheit anwählen oder — mit Auswahl — Bewegungsbefehl geben. */
  handleClick(clientX: number, clientY: number, append = false): string | null {
    const hitUnit = this.viewer.pickUnit(clientX, clientY)
    if (hitUnit) {
      this.selected = this.bindings.find((b) => b.scene === hitUnit) ?? null
      return this.selected ? `Ausgewählt: ${this.selected.sim.stats.blueprintId.toUpperCase()}` : null
    }
    if (this.selected) {
      const hit = this.viewer.pickTerrain(clientX, clientY)
      if (hit) {
        this.world.issueMove(this.selected.sim, hit.x, hit.z, append)
        return `Bewegung → ${hit.x.toFixed(0)}, ${hit.z.toFixed(0)}`
      }
    }
    return null
  }

  selectFirst(): void {
    this.selected = this.bindings[0] ?? null
  }

  moveSelected(x: number, z: number, append = false): void {
    if (this.selected) this.world.issueMove(this.selected.sim, x, z, append)
  }

  private update(dt: number): void {
    // Fixe Sim-Schritte; Obergrenze verhindert Spiralen nach Tab-Pausen
    this.accumulator = Math.min(this.accumulator + dt, SIM_STEP * 10)
    while (this.accumulator >= SIM_STEP) {
      this.world.tick()
      this.accumulator -= SIM_STEP
    }
    const alpha = this.accumulator / SIM_STEP

    for (const b of this.bindings) {
      const x = b.sim.prevX + (b.sim.x - b.sim.prevX) * alpha
      const z = b.sim.prevZ + (b.sim.z - b.sim.prevZ) * alpha
      let dh = b.sim.heading - b.sim.prevHeading
      while (dh > Math.PI) dh -= 2 * Math.PI
      while (dh < -Math.PI) dh += 2 * Math.PI
      const heading = b.sim.prevHeading + dh * alpha

      b.scene.mesh.position.set(x, this.viewer.heightAt(x, z), z)
      b.scene.mesh.rotation.set(0, heading, 0)

      const moving = b.sim.speed > 0.05
      if (moving !== b.wasMoving) {
        b.wasMoving = moving
        b.scene.play(moving ? b.walkAnim : null, b.walkRate)
      }
    }

    if (this.selected) {
      const m = this.selected.scene.mesh
      this.ring.visible = true
      this.ring.position.set(m.position.x, m.position.y + 0.05, m.position.z)
      const r = Math.max(this.selected.sim.stats.arriveRadius * 1.6, 0.7)
      this.ring.scale.setScalar(r)
    } else {
      this.ring.visible = false
    }
  }
}
