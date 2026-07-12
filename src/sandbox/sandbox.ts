import * as THREE from 'three'
import type { UnitViewer, SceneUnit } from '../viewer/unitViewer'
import type { ScaAnim } from '../formats/sca'
import type { BpObject } from '../formats/blueprint'
import { bpGet } from '../formats/blueprint'

/**
 * Minimaler Sandbox-Controller (M4-Preview): eine Einheit steht auf der
 * Karte, Klick setzt ein Bewegungsziel. Geradeaus-Bewegung mit
 * Blueprint-Geschwindigkeit, Drehung zum Ziel, Walk-Animation während der
 * Fahrt, Boden-Clamping über das Heightfield. Noch kein Pathfinding und
 * keine deterministische Sim — das kommt in M4/M5.
 */
export class Sandbox {
  private readonly pos: THREE.Vector3
  private target: THREE.Vector3 | null = null
  private heading = 0
  private moving = false

  private readonly maxSpeed: number
  private readonly turnRate: number
  private readonly walkAnimSpeed: number

  constructor(
    private readonly viewer: UnitViewer,
    private readonly unit: SceneUnit,
    private readonly walkAnim: ScaAnim | null,
    blueprint: BpObject,
    spawn: THREE.Vector3,
  ) {
    this.pos = spawn.clone()
    const maxSpeed = bpGet(blueprint, 'Physics.MaxSpeed')
    const turnRate = bpGet(blueprint, 'Physics.TurnRate')
    const walkRate = bpGet(blueprint, 'Display.AnimationWalkRate')
    this.maxSpeed = typeof maxSpeed === 'number' && maxSpeed > 0 ? maxSpeed : 1.7
    // TurnRate ist in Grad/s
    this.turnRate = ((typeof turnRate === 'number' && turnRate > 0 ? turnRate : 90) * Math.PI) / 180
    // AnimationWalkRate ist ein direkter Abspielraten-Multiplikator
    this.walkAnimSpeed = typeof walkRate === 'number' && walkRate > 0 ? walkRate : 1

    const uniformScale = bpGet(blueprint, 'Display.UniformScale')
    if (typeof uniformScale === 'number' && uniformScale > 0) {
      unit.mesh.scale.setScalar(uniformScale)
    }

    this.pos.y = viewer.heightAt(this.pos.x, this.pos.z)
    this.apply()
    viewer.onUpdate((dt) => this.tick(dt))
  }

  moveTo(point: THREE.Vector3): void {
    this.target = point.clone()
  }

  get position(): THREE.Vector3 {
    return this.pos.clone()
  }

  private tick(dt: number): void {
    if (!this.target) return

    const dx = this.target.x - this.pos.x
    const dz = this.target.z - this.pos.z
    const dist = Math.hypot(dx, dz)

    if (dist < 0.15) {
      this.target = null
      if (this.moving) {
        this.moving = false
        this.unit.play(null, 1)
      }
      return
    }

    if (!this.moving) {
      this.moving = true
      if (this.walkAnim) this.unit.play(this.walkAnim, this.walkAnimSpeed)
    }

    // Richtung Ziel drehen (SCM-Modelle schauen entlang +z)
    const wanted = Math.atan2(dx, dz)
    let diff = wanted - this.heading
    while (diff > Math.PI) diff -= 2 * Math.PI
    while (diff < -Math.PI) diff += 2 * Math.PI
    const maxTurn = this.turnRate * dt
    this.heading += Math.abs(diff) <= maxTurn ? diff : Math.sign(diff) * maxTurn

    // Nur fahren, wenn grob Richtung Ziel ausgerichtet
    if (Math.abs(diff) < Math.PI / 3) {
      const step = Math.min(this.maxSpeed * dt, dist)
      this.pos.x += Math.sin(this.heading) * step
      this.pos.z += Math.cos(this.heading) * step
    }
    this.pos.y = this.viewer.heightAt(this.pos.x, this.pos.z)
    this.apply()
  }

  private apply(): void {
    this.unit.mesh.position.copy(this.pos)
    this.unit.mesh.rotation.set(0, this.heading, 0)
  }
}
