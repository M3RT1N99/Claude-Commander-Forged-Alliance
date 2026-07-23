import * as THREE from 'three'
import { applyBlend } from './particleMaterial'

/**
 * Beams — Energiestrahlen (BeamBlueprint, `CreateBeamEmitterOnEntity` /
 * `AttachBeamEntityToEntity`), gerendert nach `BeamVS`/`BeamPS` aus dem
 * echten effects/particle.fx (Zeilen 300-344) mit den
 * TBeam_OneTexture_<BLEND>-Techniques (AlphaStates wie die Partikel).
 *
 * Semantik aus dem Shader und CEfxBeam (faf-re CEfxBeam.cpp):
 *  - Ein Beam ist EIN Quad zwischen zwei Endpunkten. Der Quer-Versatz kommt
 *    im View-Space aus cross((0,0,1), beamDirView), normalisiert × Size.w
 *    (±Thickness je Seite).
 *  - Endpunkte (CEfxBeam::Update @0x654F30): mit End-Entity Start=sourceBone,
 *    Ende=targetBone; ohne End-Entity Ende = Start + (0,0,Length) im
 *    Bone-Raum (der Strahl zeigt entlang der Bone-Z-Achse).
 *  - Farbe: StartColor am Start, EndColor am Ende (RGBA aus dem Blueprint,
 *    CEfxBeam::Reset @0x654D40), im Pixelshader multipliziert.
 *  - UVs scrollen mit der Zeit: mUv0 = Basis + (UShift, VShift)·time
 *    (particle.fx:322-323); die Textur wickelt in beiden Achsen
 *    (ParticleSampler0Wrap).
 *
 * Abgeleitet, OFFEN (der SWorldBeam-Vertex-Fill ist nicht dekompiliert):
 *  - U-Basis läuft 0 → max(RepeatRate, 1) über die Länge, V-Basis 0/1 quer.
 */

export interface BeamBpData {
  Lifetime?: number
  TextureName?: string
  Thickness?: number
  StartColor?: { x: number; y: number; z: number; w: number }
  EndColor?: { x: number; y: number; z: number; w: number }
  Length?: number
  UShift?: number
  VShift?: number
  RepeatRate?: number
  BlendMode?: number
  Blendmode?: number
  LODCutoff?: number
}

const VERTEX = /* glsl */ `
  attribute vec3 bDir;    // Beam-Richtung (Welt, normiert)
  attribute float bSide;  // ±Thickness (Vorzeichen = Quadseite)
  attribute vec4 bColor;  // Start/EndColor per end
  attribute vec2 bUv;     // UV-Basis (U längs, V quer)

  uniform float uTime;
  uniform vec2 uShift; // (UShift, VShift) — particle.fx:322-323

  varying vec4 vColor;
  varying vec2 vUv0;

  void main() {
    // BeamVS (particle.fx:300-327): point and direction in the view space,
    // Quer-Versatz = normalize(cross((0,0,1), dirView)) * Size.w.
    vec3 posView = (viewMatrix * vec4(position, 1.0)).xyz;
    vec3 dirView = mat3(viewMatrix) * bDir;
    vec3 off = cross(vec3(0.0, 0.0, 1.0), dirView);
    float len = length(off);
    if (len > 0.0001) posView += (off / len) * bSide;
    gl_Position = projectionMatrix * vec4(posView, 1.0);
    vColor = bColor;
    vUv0 = bUv + uShift * uTime;
  }
`

const FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform sampler2D uTex;
  varying vec4 vColor;
  varying vec2 vUv0;

  void main() {
    // BeamPS OneTexture (particle.fx:330-336): Textur × Vertex-Farbe.
    gl_FragColor = texture2D(uTex, vUv0) * vColor;
  }
`

interface SharedBp {
  material: THREE.ShaderMaterial
  bp: BeamBpData
}

class BeamInstance {
  readonly mesh: THREE.Mesh
  private readonly geometry: THREE.BufferGeometry
  private readonly pos: THREE.BufferAttribute
  private readonly dir: THREE.BufferAttribute
  lastSeenTick = 0

  constructor(shared: SharedBp) {
    const bp = shared.bp
    const g = new THREE.BufferGeometry()
    this.pos = new THREE.BufferAttribute(new Float32Array(4 * 3), 3)
    this.pos.setUsage(THREE.DynamicDrawUsage)
    this.dir = new THREE.BufferAttribute(new Float32Array(4 * 3), 3)
    this.dir.setUsage(THREE.DynamicDrawUsage)
    g.setAttribute('position', this.pos)
    g.setAttribute('bDir', this.dir)

    const w = bp.Thickness ?? 1
    g.setAttribute('bSide', new THREE.BufferAttribute(new Float32Array([-w, w, -w, w]), 1))

    const s = bp.StartColor ?? { x: 1, y: 1, z: 1, w: 1 }
    const e = bp.EndColor ?? s
    g.setAttribute(
      'bColor',
      new THREE.BufferAttribute(
        new Float32Array([s.x, s.y, s.z, s.w, s.x, s.y, s.z, s.w, e.x, e.y, e.z, e.w, e.x, e.y, e.z, e.w]),
        4,
      ),
    )
    const uMax = Math.max(bp.RepeatRate ?? 0, 1)
    g.setAttribute(
      'bUv',
      new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, uMax, 0, uMax, 1]), 2),
    )
    g.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2, 1, 3, 2]), 1))
    this.geometry = g
    this.mesh = new THREE.Mesh(g, shared.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 21
  }

  setEndpoints(sx: number, sy: number, sz: number, ex: number, ey: number, ez: number): void {
    let dx = ex - sx
    let dy = ey - sy
    let dz = ez - sz
    const l = Math.hypot(dx, dy, dz)
    if (l > 0.0001) {
      dx /= l
      dy /= l
      dz /= l
    } else {
      dz = 1
    }
    this.pos.set([sx, sy, sz, sx, sy, sz, ex, ey, ez, ex, ey, ez], 0)
    for (let v = 0; v < 4; v++) this.dir.set([dx, dy, dz], v * 3)
    this.pos.needsUpdate = true
    this.dir.needsUpdate = true
  }

  dispose(): void {
    this.geometry.dispose()
  }
}

export class BeamSystem {
  private readonly shared = new Map<string, SharedBp>()
  private readonly instances = new Map<number, BeamInstance>()

  constructor(private readonly attach: (mesh: THREE.Mesh) => void) {}

  hasBp(bpId: string): boolean {
    return this.shared.has(bpId)
  }

  registerBp(bpId: string, bp: BeamBpData, tex: THREE.Texture): void {
    if (this.shared.has(bpId)) return
    // ParticleSampler0Wrap: the beam texture wraps in both axes.
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uShift: { value: new THREE.Vector2(bp.UShift ?? 0, bp.VShift ?? 0) },
        uTex: { value: tex },
      },
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      transparent: true,
    })
    applyBlend(material, bp.BlendMode ?? bp.Blendmode ?? 3)
    this.shared.set(bpId, { material, bp })
  }

  /**
   * Pro Sim-Tick den Beam nachziehen. Ohne zweiten Endpunkt zeigt der Strahl
   * entlang der Bone-Z-Achse mit Blueprint-Länge (CEfxBeam::Update:
   * mEnd = (0,0,Length) im Bone-Raum).
   */
  set(
    emitterId: number,
    bpId: string,
    s: { x: number; y: number; z: number; qw: number; qx: number; qy: number; qz: number; x2?: number; y2?: number; z2?: number },
    tick: number,
  ): void {
    const shared = this.shared.get(bpId)
    if (!shared) return
    let inst = this.instances.get(emitterId)
    if (!inst) {
      inst = new BeamInstance(shared)
      this.instances.set(emitterId, inst)
      this.attach(inst.mesh)
    }
    inst.lastSeenTick = tick
    let ex = s.x2
    let ey = s.y2
    let ez = s.z2
    if (ex === undefined || ey === undefined || ez === undefined) {
      // (0,0,Length) rotated around the bone orientation.
      const L = shared.bp.Length ?? 10
      const { qw, qx, qy, qz } = s
      const tx = 2 * (qy * L - qz * 0)
      const ty = 2 * (qz * 0 - qx * L)
      const tz = 0
      ex = s.x + (0 + qw * tx + qy * tz - qz * ty)
      ey = s.y + (0 + qw * ty + qz * tx - qx * tz)
      ez = s.z + (L + qw * tz + qx * ty - qy * tx)
    }
    inst.setEndpoints(s.x, s.y, s.z, ex, ey, ez)
  }

  /** Set the clock + clear beams that the sim no longer reports. */
  update(timeTicks: number): void {
    for (const sh of this.shared.values()) {
      sh.material.uniforms.uTime!.value = timeTicks
    }
    for (const [id, inst] of this.instances) {
      if (timeTicks - inst.lastSeenTick > 2) {
        inst.mesh.removeFromParent()
        inst.dispose()
        this.instances.delete(id)
      }
    }
  }

  totalBeams(): number {
    return this.instances.size
  }

  dispose(): void {
    for (const inst of this.instances.values()) inst.dispose()
    this.instances.clear()
    for (const sh of this.shared.values()) sh.material.dispose()
    this.shared.clear()
  }
}
