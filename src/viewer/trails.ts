import * as THREE from 'three'
import { applyBlend } from './particleMaterial'

/**
 * Poly-Trails — die Leucht-Spuren der Projektile (TrailEmitterBlueprint,
 * `CreateTrail`), gerendert nach `TrailVS`/`TrailPS` aus dem echten
 * effects/particle.fx (Zeilen 348-401) mit den TPolyTrail_<BLEND>-Techniques
 * (identische AlphaStates wie die Partikel, particle.fx:1269-1332).
 *
 * Semantik aus dem Shader:
 *  - Ein Trail ist ein RIBBON aus Segment-Punkten; jeder Punkt trägt seine
 *    Lege-Zeit (startTime). `TrailPS` zeichnet ein Fragment NUR, wenn
 *    0 < (time − startTime)/lifetime < 1 — so läuft die Spur von selbst aus.
 *  - Quer-Versatz im View-Space: cross((0,0,1), dirView), normalisiert,
 *    × Width.x — die beiden Ribbon-Seiten unterscheiden sich im Vorzeichen.
 *  - UVs: U quer (0/1 je Seite) auf der RepeatTexture (WRAP längs über
 *    V = (startTime − originTime)/lifetime · TextureRepeatRate); die
 *    RampTexture wird mit (t, Seite) gesampelt.
 *
 * Abgeleitet, noch OFFEN (im Spiel gegenprüfen, Cfile-Rumpf von
 * CEfxTrailEmitter::Tick ist nicht dekompiliert):
 *  - Segment-Lebenszeit = TrailLength in Ticks (die Spur bleibt TrailLength
 *    Ticks sichtbar; gestützt von ProcessLifetime: der Emitter stirbt bei
 *    mTotalTicks ≥ Lifetime − TrailLength, faf-re CEfxTrailEmitter.cpp:214).
 *  - Width.x = Size · ScaleEmitter — die Halbbreite, analog zur
 *    Partikel-Semantik (Size skaliert dort das ±1-Quad).
 */

/** Die Felder eines TrailEmitterBlueprints (effects-audio.md). */
export interface TrailBpData {
  Lifetime?: number
  TrailLength?: number
  Size?: number
  TextureRepeatRate?: number
  RepeatTexture?: string
  RampTexture?: string
  Blendmode?: number
  BlendMode?: number
  LODCutoff?: number
}

const MAX_POINTS = 64

const VERTEX = /* glsl */ `
  attribute vec3 tDirection; // Spur-Richtung am Punkt (Welt)
  attribute vec2 tLife;      // x = startTime (Tick), y = lifetime (Ticks)
  attribute vec2 tUv;        // x = Quer-U (0/1), y = repeatvee (längs)
  attribute float tWidth;    // ±Halbbreite (Vorzeichen = Ribbon-Seite)

  uniform float uTime;

  varying vec2 vUv0;
  varying vec2 vUv1;

  void main() {
    // TrailVS (particle.fx:355-392): Punkt und Richtung in den View-Space,
    // Quer-Versatz = normalize(cross((0,0,1), dirView)) * Width.
    vec3 posView = (viewMatrix * vec4(position, 1.0)).xyz;
    vec3 dirView = mat3(viewMatrix) * tDirection;
    vec3 off = cross(vec3(0.0, 0.0, 1.0), dirView);
    float len = length(off);
    if (len > 0.0001) posView += (off / len) * tWidth;
    gl_Position = projectionMatrix * vec4(posView, 1.0);

    float t = (uTime - tLife.x) / tLife.y;
    vUv0 = vec2(tUv.x, tUv.y); // RepeatTexture: U quer, V längs (WRAP)
    vUv1 = vec2(t, tUv.x);     // Ramp: U = Alter, V = Seite
  }
`

const FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform sampler2D uTex;  // RepeatTexture
  uniform sampler2D uRamp; // RampTexture
  varying vec2 vUv0;
  varying vec2 vUv1;

  void main() {
    // TrailPS (particle.fx:395-401): nur lebende Segmente (0 < t < 1).
    if (vUv1.x <= 0.0 || vUv1.x >= 1.0) discard;
    gl_FragColor = texture2D(uRamp, vUv1) * texture2D(uTex, vUv0);
  }
`

interface SharedBp {
  material: THREE.ShaderMaterial
  segmentLife: number
  repeatRate: number
  halfWidth: number
}

/** Ein lebendes Ribbon: der Punkte-Ring eines Trail-Emitters. */
class TrailInstance {
  readonly mesh: THREE.Mesh
  private readonly geometry: THREE.BufferGeometry
  private readonly pos: THREE.BufferAttribute
  private readonly dir: THREE.BufferAttribute
  private readonly life: THREE.BufferAttribute
  private readonly uv: THREE.BufferAttribute
  private readonly width: THREE.BufferAttribute
  private count = 0
  private write = 0
  private prev: [number, number, number] | null = null
  /** Tick des letzten gelegten Punkts — zum Aufräumen ausgelaufener Spuren. */
  lastPointTick = 0
  private readonly originTime: number

  constructor(
    private readonly shared: SharedBp,
    firstTick: number,
    private readonly scale: number,
  ) {
    this.originTime = firstTick
    const g = new THREE.BufferGeometry()
    const mk = (n: number): THREE.BufferAttribute => {
      const a = new THREE.BufferAttribute(new Float32Array(MAX_POINTS * 2 * n), n)
      a.setUsage(THREE.DynamicDrawUsage)
      return a
    }
    this.pos = mk(3)
    this.dir = mk(3)
    this.life = mk(2)
    this.uv = mk(2)
    this.width = mk(1)
    g.setAttribute('position', this.pos)
    g.setAttribute('tDirection', this.dir)
    g.setAttribute('tLife', this.life)
    g.setAttribute('tUv', this.uv)
    g.setAttribute('tWidth', this.width)
    // Triangle-Strip als Indexliste: je zwei aufeinanderfolgende Punkt-Paare
    // bilden zwei Dreiecke. Der Ring wird NICHT über den Umbruch verbunden —
    // dort ist die Spur ohnehin längst ausgelaufen (MAX_POINTS >> TrailLength).
    const idx = new Uint16Array((MAX_POINTS - 1) * 6)
    for (let i = 0; i < MAX_POINTS - 1; i++) {
      const a = i * 2
      idx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6)
    }
    g.setIndex(new THREE.BufferAttribute(idx, 1))
    g.setDrawRange(0, 0)
    this.geometry = g
    this.mesh = new THREE.Mesh(g, shared.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 19
  }

  /** Ein Segment-Punkt pro Sim-Tick — wie die Engine die Spur legt. */
  addPoint(x: number, y: number, z: number, tick: number): void {
    this.lastPointTick = tick
    let dx = 0
    let dy = 0
    let dz = 1
    if (this.prev) {
      dx = x - this.prev[0]
      dy = y - this.prev[1]
      dz = z - this.prev[2]
      const l = Math.hypot(dx, dy, dz)
      if (l > 0.0001) {
        dx /= l
        dy /= l
        dz /= l
      } else {
        dz = 1
      }
    }
    this.prev = [x, y, z]

    const s = this.shared
    const repeatvee =
      s.segmentLife > 0 ? ((tick - this.originTime) / s.segmentLife) * s.repeatRate : 0
    const i = this.write
    this.write = (this.write + 1) % MAX_POINTS
    this.count = Math.min(this.count + 1, MAX_POINTS)
    const w = s.halfWidth * this.scale
    for (const side of [0, 1]) {
      const v = i * 2 + side
      this.pos.set([x, y, z], v * 3)
      this.dir.set([dx, dy, dz], v * 3)
      this.life.set([tick, s.segmentLife], v * 2)
      this.uv.set([side, repeatvee], v * 2)
      this.width.set([side === 0 ? -w : w], v)
    }
    for (const a of [this.pos, this.dir, this.life, this.uv, this.width]) a.needsUpdate = true
    // Zeichnen bis zum letzten geschriebenen Paar (der Ring läuft linear, bis
    // MAX_POINTS erreicht ist — ältere Segmente discardet der Pixelshader).
    this.geometry.setDrawRange(0, (Math.min(this.count, MAX_POINTS) - 1) * 6)
  }

  dispose(): void {
    this.geometry.dispose()
  }
}

export class TrailSystem {
  private readonly shared = new Map<string, SharedBp>()
  private readonly instances = new Map<number, TrailInstance>()

  constructor(private readonly attach: (mesh: THREE.Mesh) => void) {}

  hasBp(bpId: string): boolean {
    return this.shared.has(bpId)
  }

  registerBp(bpId: string, bp: TrailBpData, tex: THREE.Texture, ramp: THREE.Texture): void {
    if (this.shared.has(bpId)) return
    // Sampler wie ParticleSampler0Wrap (WRAP/WRAP) bzw. Sampler1 (CLAMP).
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    ramp.wrapS = THREE.ClampToEdgeWrapping
    ramp.wrapT = THREE.ClampToEdgeWrapping
    const material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      uniforms: {
        uTime: { value: 0 },
        uTex: { value: tex },
        uRamp: { value: ramp },
      },
      depthTest: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      transparent: true,
    })
    applyBlend(material, bp.Blendmode ?? bp.BlendMode ?? 0)
    this.shared.set(bpId, {
      material,
      segmentLife: Math.max(bp.TrailLength ?? 10, 1),
      repeatRate: bp.TextureRepeatRate ?? 1,
      halfWidth: bp.Size ?? 0.1,
    })
  }

  /** Pro Sim-Tick: die aktuelle Position des Trail-Emitters als Segment. */
  point(emitterId: number, bpId: string, x: number, y: number, z: number, tick: number, scale: number): void {
    const shared = this.shared.get(bpId)
    if (!shared) return
    let inst = this.instances.get(emitterId)
    if (!inst) {
      inst = new TrailInstance(shared, tick, scale)
      this.instances.set(emitterId, inst)
      this.attach(inst.mesh)
    }
    inst.addPoint(x, y, z, tick)
  }

  /** Uhr stellen + ausgelaufene Spuren (Emitter weg, Segmente tot) abräumen. */
  update(timeTicks: number): void {
    for (const s of this.shared.values()) {
      s.material.uniforms.uTime!.value = timeTicks
    }
    for (const [id, inst] of this.instances) {
      if (timeTicks - inst.lastPointTick > 2 * 64) {
        inst.mesh.removeFromParent()
        inst.dispose()
        this.instances.delete(id)
      }
    }
  }

  /** Anzahl lebender Ribbons (für den Selbsttest). */
  totalTrails(): number {
    return this.instances.size
  }

  dispose(): void {
    for (const inst of this.instances.values()) inst.dispose()
    this.instances.clear()
    for (const s of this.shared.values()) s.material.dispose()
    this.shared.clear()
  }
}
