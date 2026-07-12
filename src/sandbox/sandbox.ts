import * as THREE from 'three'
import { SimWorld, statsFromBlueprint, type SimUnit } from '../sim/simWorld'
import type { UnitViewer, SceneUnit } from '../viewer/unitViewer'
import type { UnitTextures } from '../viewer/unitMaterial'
import type { ScmModel } from '../formats/scm'
import type { ScaAnim } from '../formats/sca'
import { bpGet, stripLoc, type BpObject } from '../formats/blueprint'

/**
 * Sandbox (M4): bindet den deterministischen Sim-Kern an den Renderer.
 * Die Sim läuft mit festen 10-Hz-Ticks; der Renderer interpoliert zwischen
 * dem vorherigen und dem aktuellen Tick-Zustand.
 *
 * Steuerung nach SupCom-Schema (Verdrahtung in main.ts):
 * Linksklick = Auswahl, Links-Drag = Box-Selektion, Rechtsklick = Move
 * (Shift = Warteschlange), Leertaste + Maus = Kamera drehen.
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
  ring: THREE.Mesh
  selected: boolean
  id: string
  name: string
  /** RULEUCC_*-Fähigkeiten aus General.CommandCaps (bestimmt Order-Buttons) */
  caps: ReadonlySet<string>
}

/** Momentaufnahme für das HUD. */
export interface HudUnitInfo {
  id: string
  name: string
  health: number
  maxHealth: number
  selected: boolean
  x: number
  z: number
  army: number
}

const SIM_STEP = 0.1

function readCommandCaps(bp: BpObject): ReadonlySet<string> {
  const caps = new Set<string>()
  const raw = bpGet(bp, 'General.CommandCaps')
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (value === true) caps.add(key)
    }
  }
  return caps
}

const ringGeometry = (() => {
  const g = new THREE.RingGeometry(0.85, 1, 40)
  g.rotateX(-Math.PI / 2)
  return g
})()

export class SandboxController {
  readonly world = new SimWorld()
  private readonly bindings: Binding[] = []
  private accumulator = 0

  constructor(private readonly viewer: UnitViewer) {
    viewer.setRtsControls(true)
    viewer.onUpdate((dt) => this.update(dt))
  }

  spawn(assets: SandboxUnitAssets, x: number, z: number, teamColor: THREE.Color): void {
    const scene = this.viewer.addUnit(assets.model, assets.textures, teamColor)

    const uniformScale = bpGet(assets.bp, 'Display.UniformScale')
    if (typeof uniformScale === 'number' && uniformScale > 0) {
      scene.mesh.scale.setScalar(uniformScale)
    }

    const walkRateRaw = bpGet(assets.bp, 'Display.AnimationWalkRate')
    const sim = this.world.spawn(statsFromBlueprint(assets.id, assets.bp), x, z)

    const ring = new THREE.Mesh(
      ringGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x44ff66,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
      }),
    )
    ring.visible = false
    ring.renderOrder = 10
    this.viewer.addHelper(ring)

    this.bindings.push({
      sim,
      scene,
      walkAnim: assets.walkAnim,
      walkRate: typeof walkRateRaw === 'number' && walkRateRaw > 0 ? walkRateRaw : 1,
      wasMoving: false,
      ring,
      selected: false,
      id: assets.id,
      name:
        stripLoc(bpGet(assets.bp, 'General.UnitName')) ??
        stripLoc(bpGet(assets.bp, 'Description')) ??
        assets.id.toUpperCase(),
      caps: readCommandCaps(assets.bp),
    })

    scene.mesh.position.set(sim.x, this.viewer.heightAt(sim.x, sim.z), sim.z)
  }

  get unitCount(): number {
    return this.bindings.length
  }

  get selectedCount(): number {
    return this.bindings.filter((b) => b.selected).length
  }

  /** Linksklick: Einheit unter dem Cursor exklusiv auswählen (oder leeren). */
  clickSelect(clientX: number, clientY: number): string | null {
    const hit = this.viewer.pickUnit(clientX, clientY)
    for (const b of this.bindings) b.selected = hit !== null && b.scene === hit
    if (hit) {
      const b = this.bindings.find((x) => x.scene === hit)
      return b ? `Ausgewählt: ${b.sim.stats.blueprintId.toUpperCase()}` : null
    }
    return null
  }

  /** Box-Selektion: alle Einheiten, deren Position im Bildschirmrechteck liegt. */
  boxSelect(x1: number, y1: number, x2: number, y2: number): string | null {
    const minX = Math.min(x1, x2)
    const maxX = Math.max(x1, x2)
    const minY = Math.min(y1, y2)
    const maxY = Math.max(y1, y2)
    let count = 0
    for (const b of this.bindings) {
      const s = this.viewer.worldToScreen(b.scene.mesh.position)
      b.selected = s !== null && s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY
      if (b.selected) count++
    }
    return count > 0 ? `${count} Einheit(en) ausgewählt` : null
  }

  selectFirst(): void {
    this.bindings.forEach((b, i) => {
      b.selected = i === 0
    })
  }

  stopSelected(): void {
    for (const b of this.bindings) {
      if (b.selected) this.world.stop(b.sim)
    }
  }

  /** Spielzeit in Sekunden (Sim-Ticks). */
  get gameTime(): number {
    return this.world.tickCount * SIM_STEP
  }

  /** Gemeinsame Command-Caps der Auswahl (Schnittmenge, wie das Original). */
  selectedCaps(): ReadonlySet<string> {
    const selected = this.bindings.filter((b) => b.selected)
    if (selected.length === 0) return new Set()
    const caps = new Set(selected[0]!.caps)
    for (const b of selected.slice(1)) {
      for (const c of caps) if (!b.caps.has(c)) caps.delete(c)
    }
    return caps
  }

  /** Zustands-Snapshot für das HUD (Einheiten + Auswahl). */
  hudUnits(): HudUnitInfo[] {
    return this.bindings.map((b) => ({
      id: b.id,
      name: b.name,
      health: b.sim.health,
      maxHealth: b.sim.stats.maxHealth,
      selected: b.selected,
      x: b.sim.x,
      z: b.sim.z,
      army: b.sim.army,
    }))
  }

  /** Rechtsklick: Move-Befehl für die Auswahl, in lockerer Formation. */
  commandMove(clientX: number, clientY: number, append = false): string | null {
    const hit = this.viewer.pickTerrain(clientX, clientY)
    if (!hit) return null
    this.moveSelectedTo(hit.x, hit.z, append)
    const n = this.selectedCount
    return n > 0 ? `Move (${n}) → ${hit.x.toFixed(0)}, ${hit.z.toFixed(0)}` : null
  }

  moveSelectedTo(x: number, z: number, append = false): void {
    const selected = this.bindings.filter((b) => b.selected)
    if (selected.length === 0) return
    const spacing = Math.max(...selected.map((b) => b.sim.stats.arriveRadius)) * 3 + 1
    const cols = Math.ceil(Math.sqrt(selected.length))
    selected.forEach((b, i) => {
      const col = i % cols
      const row = Math.floor(i / cols)
      const tx = x + (col - (cols - 1) / 2) * spacing
      const tz = z + (row - (Math.ceil(selected.length / cols) - 1) / 2) * spacing
      this.world.issueMove(b.sim, tx, tz, append)
    })
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

      const y = this.viewer.heightAt(x, z)
      b.scene.mesh.position.set(x, y, z)
      b.scene.mesh.rotation.set(0, heading, 0)

      const moving = b.sim.speed > 0.05
      if (moving !== b.wasMoving) {
        b.wasMoving = moving
        b.scene.play(moving ? b.walkAnim : null, b.walkRate)
      }

      b.ring.visible = b.selected
      if (b.selected) {
        b.ring.position.set(x, y + 0.05, z)
        b.ring.scale.setScalar(Math.max(b.sim.stats.arriveRadius * 1.6, 0.7))
      }
    }
  }
}
