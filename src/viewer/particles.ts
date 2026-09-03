import * as THREE from 'three'
import { createParticleMaterial } from './particleMaterial'
import type { SpawnedParticle, EmitterBpData } from '../effects/emitterRuntime'

/**
 * Das Partikelsystem — die Render-Seite von CWorldParticles.
 *
 * Ein BATCH pro Emitter-Blueprint (gleiche Texturen, gleicher Blend-Zustand,
 * gleiche Technique-Flags): eine InstancedBufferGeometry, deren Instanzen die
 * 23 Spawn-Floats tragen (particle.fx-Layout, siehe particleMaterial.ts).
 * Partikel leben danach NUR im Vertex-Shader (alpha = t/lifetime ≥ 1 ⇒ das
 * Quad degeneriert) — genau wie im Original leben sie unabhängig von ihrem
 * Emitter weiter.
 *
 * Der Instanz-Puffer ist ein RING: Neue Partikel überschreiben die ältesten
 * Slots. Die Kapazität pro Blueprint ist großzügig gegen die Emit-Raten der
 * echten Daten gewählt; ein überschriebener Slot wäre ohnehin fast immer
 * schon tot.
 */

const CAPACITY = 1024

/** Die 4 Ecken des ±1-Quads (particle.fx: Corner), zwei Dreiecke. */
function quadGeometry(): { position: THREE.BufferAttribute; index: THREE.BufferAttribute } {
  const corners = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0])
  const idx = new Uint16Array([0, 1, 2, 0, 2, 3])
  return {
    position: new THREE.BufferAttribute(corners, 3),
    index: new THREE.BufferAttribute(idx, 1),
  }
}

class Batch {
  readonly mesh: THREE.Mesh
  private readonly geometry: THREE.InstancedBufferGeometry
  private readonly material: THREE.ShaderMaterial
  private readonly pos: THREE.InstancedBufferAttribute
  private readonly size: THREE.InstancedBufferAttribute
  private readonly vel: THREE.InstancedBufferAttribute
  private readonly accel: THREE.InstancedBufferAttribute
  private readonly time: THREE.InstancedBufferAttribute
  private readonly tex: THREE.InstancedBufferAttribute
  private readonly drag: THREE.InstancedBufferAttribute
  private write = 0
  private count = 0

  constructor(bp: EmitterBpData, texture: THREE.Texture, ramp: THREE.Texture, depthTest = true) {
    // Sampler-Zustände aus particle.fx:33-51: die Partikeltextur wickelt in U
    // (Frame-Strips) und klemmt in V; die Ramp klemmt in beiden Achsen.
    texture.wrapS = THREE.RepeatWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
    ramp.wrapS = THREE.ClampToEdgeWrapping
    ramp.wrapT = THREE.ClampToEdgeWrapping

    this.material = createParticleMaterial({
      texture,
      ramp,
      blendMode: bp.Blendmode ?? 0,
      animated: (bp.TextureFramecount ?? 0) > 1,
      flat: bp.Flat === true,
      drag: bp.ParticleResistance === true,
      depthTest,
    })

    const g = new THREE.InstancedBufferGeometry()
    const quad = quadGeometry()
    g.setAttribute('position', quad.position)
    g.setIndex(quad.index)
    const mk = (n: number): THREE.InstancedBufferAttribute => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(CAPACITY * n), n)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.pos = mk(4)
    this.size = mk(2)
    this.vel = mk(4)
    this.accel = mk(3)
    this.time = mk(4)
    this.tex = mk(3)
    this.drag = mk(3)
    // Tote Slots (lifetime 0) degenerieren im Shader — der Puffer darf voll
    // gezeichnet werden, ohne dass leere Slots sichtbar sind.
    g.setAttribute('pPos', this.pos)
    g.setAttribute('pSize', this.size)
    g.setAttribute('pVelocity', this.vel)
    g.setAttribute('pAccel', this.accel)
    g.setAttribute('pTime', this.time)
    g.setAttribute('pTexOffset', this.tex)
    g.setAttribute('pDrag', this.drag)
    g.instanceCount = 0
    this.geometry = g

    this.mesh = new THREE.Mesh(g, this.material)
    this.mesh.frustumCulled = false
    // Additive/modulierende Partikel nach den opaken Meshes zeichnen.
    this.mesh.renderOrder = 20
  }

  add(p: SpawnedParticle): void {
    const i = this.write
    this.write = (this.write + 1) % CAPACITY
    this.count = Math.min(this.count + 1, CAPACITY)
    this.pos.set([p.px, p.py, p.pz, p.angle], i * 4)
    this.size.set([p.beginSize, p.sizeRate], i * 2)
    this.vel.set([p.vx, p.vy, p.vz, p.rotRate], i * 4)
    this.accel.set([p.ax, p.ay, p.az], i * 3)
    this.time.set([p.birth, p.lifetime, p.framerate, p.frameSize], i * 4)
    this.tex.set([p.texRow, p.rampV, p.rowHeight], i * 3)
    this.drag.set([p.dragX, p.dragY, p.dragZ], i * 3)
    for (const a of [this.pos, this.size, this.vel, this.accel, this.time, this.tex, this.drag]) {
      a.needsUpdate = true
    }
    this.geometry.instanceCount = this.count
  }

  update(timeTicks: number, camRight: THREE.Vector3, camUp: THREE.Vector3): void {
    const u = this.material.uniforms
    u.uTime!.value = timeTicks
    ;(u.uCamRight!.value as THREE.Vector3).copy(camRight)
    ;(u.uCamUp!.value as THREE.Vector3).copy(camUp)
  }

  get particleCount(): number {
    return this.count
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}

export class ParticleSystem {
  private readonly batches = new Map<string, Batch>()
  private readonly camRight = new THREE.Vector3()
  private readonly camUp = new THREE.Vector3()

  constructor(
    /** Hängt das Batch-Mesh in die Szene (z. B. viewer.addHelper). */
    private readonly attach: (mesh: THREE.Mesh) => void,
  ) {}

  /** Batch je Emitter-Blueprint — beim ersten Partikel dieses Typs angelegt. */
  batchFor(bpId: string, bp: EmitterBpData, texture: THREE.Texture, ramp: THREE.Texture, depthTest = true): void {
    if (this.batches.has(bpId)) return
    const batch = new Batch(bp, texture, ramp, depthTest)
    this.batches.set(bpId, batch)
    this.attach(batch.mesh)
  }

  hasBatch(bpId: string): boolean {
    return this.batches.has(bpId)
  }

  add(bpId: string, p: SpawnedParticle): void {
    this.batches.get(bpId)?.add(p)
  }

  /** Pro Frame: die Uhr (Sim-Ticks + Frame-Anteil) und die Billboard-Achsen
   *  (InverseViewMatrix[0/1] = Spalten der Kamera-Weltmatrix). */
  update(timeTicks: number, camera: THREE.Camera): void {
    const m = camera.matrixWorld.elements
    this.camRight.set(m[0]!, m[1]!, m[2]!)
    this.camUp.set(m[4]!, m[5]!, m[6]!)
    for (const b of this.batches.values()) b.update(timeTicks, this.camRight, this.camUp)
  }

  /** The batch keys with their particle counts (self-test / CDP probes). */
  batchCounts(): Record<string, number> {
    const out: Record<string, number> = {}
    for (const [k, b] of this.batches) out[k] = b.particleCount
    return out
  }

  /** Gesamtzahl der Slots mit je gespawnten Partikeln (für den Selbsttest). */
  totalParticles(): number {
    let n = 0
    for (const b of this.batches.values()) n += b.particleCount
    return n
  }

  dispose(): void {
    for (const b of this.batches.values()) b.dispose()
    this.batches.clear()
  }
}
