import {
  makeEfxCurve,
  sampleCurve,
  wrapEmitterTime,
  type EfxCurve,
  type EfxCurveBp,
} from './curves'

/**
 * Die Emitter-Laufzeit der Engine — `Moho::CEfxEmitter::Tick` (@0x65CE00,
 * Cfile:894567-894932) und `OnTick` (@0x65DAC0, Cfile:894937 ff.), 1:1.
 *
 * Beim SPAWN wird jedes Partikel vollständig „gebrannt": alle Kurven werden
 * mit der Emitter-Zeit gesampelt und in die Instanz-Attribute des
 * Partikel-Shaders geschrieben (Upload: faf-re ParticleRenderBuckets.cpp:
 * 4480-4512 — exakt die 23 Floats aus particle.fx). KEINE Kurve wird pro
 * Frame ausgewertet; danach lebt das Partikel nur noch im Vertex-Shader.
 *
 * Bewusste Stufe-1-Vereinfachungen (dokumentiert, kein Raten):
 *  - Kein Catch-up über die Entity-Positionshistorie (OnTick spielt im
 *    Original bis min(24, mMaxLifetime) versäumte Ticks nach,
 *    Cfile:894983-894993): unsere Sim meldet pro Beat genau EINEN Tick,
 *    es gibt keine versäumten Ticks (lag = 0).
 *  - InterpolateEmission staffelt Kurvenzeit und Geburt (j/N) wie im
 *    Original (Cfile:894685/894712-894717); die POSITION entlang der
 *    Bewegung zwischen zwei Ticks braucht die Positionshistorie — wir
 *    nutzen die zuletzt gemeldete Bone-Position für alle j.
 *  - Sichtbarkeits-Gates (EmitIfVisible/CreateIfVisible/LODCutoff,
 *    SnapToWaterline/OnlyEmitOnWater) sind noch nicht angebunden — es wird
 *    immer emittiert.
 */

/** Die Blueprint-Felder, die die Laufzeit liest (Defaults: effects-audio.md). */
export interface EmitterBpData {
  Lifetime?: number
  Repeattime?: number
  TextureFramecount?: number
  TextureStripcount?: number
  Blendmode?: number
  LocalVelocity?: boolean
  LocalAcceleration?: boolean
  Gravity?: boolean
  Flat?: boolean
  AlignToBone?: boolean
  ParticleResistance?: boolean
  InterpolateEmission?: boolean
  Texture?: string
  RampTexture?: string
  SizeCurve?: EfxCurveBp
  XDirectionCurve?: EfxCurveBp
  YDirectionCurve?: EfxCurveBp
  ZDirectionCurve?: EfxCurveBp
  EmitRateCurve?: EfxCurveBp
  LifetimeCurve?: EfxCurveBp
  VelocityCurve?: EfxCurveBp
  XAccelCurve?: EfxCurveBp
  YAccelCurve?: EfxCurveBp
  ZAccelCurve?: EfxCurveBp
  ResistanceCurve?: EfxCurveBp
  StartSizeCurve?: EfxCurveBp
  EndSizeCurve?: EfxCurveBp
  InitialRotationCurve?: EfxCurveBp
  RotationRateCurve?: EfxCurveBp
  FrameRateCurve?: EfxCurveBp
  TextureSelectionCurve?: EfxCurveBp
  XPosCurve?: EfxCurveBp
  YPosCurve?: EfxCurveBp
  ZPosCurve?: EfxCurveBp
  RampSelectionCurve?: EfxCurveBp
}

/** Der Zustand des Emitters, wie die Sim ihn pro Beat meldet. */
export interface EmitterState {
  x: number
  y: number
  z: number
  /** Bone-Orientierung (w,x,y,z). */
  qw: number
  qx: number
  qy: number
  qz: number
  /** ScaleEmitter-Faktor (EFFECT_SCALE, Param 18). */
  scale: number
  /** OffsetEmitter — LOKAL zum Bone, UNSKALIERT (Cfile:907969/894720). */
  ox?: number
  oy?: number
  oz?: number
  enabled: boolean
}

/**
 * Ein gespawntes Partikel — exakt die 23 Instanz-Floats des Shaders
 * (Pos4 + Size2 + Velocity4 + Accel3 + inTime4 + inTexOffset3 + dragCoeff3).
 */
export interface SpawnedParticle {
  px: number
  py: number
  pz: number
  angle: number
  beginSize: number
  sizeRate: number
  vx: number
  vy: number
  vz: number
  rotRate: number
  ax: number
  ay: number
  az: number
  birth: number
  lifetime: number
  framerate: number
  frameSize: number
  texRow: number
  rampV: number
  rowHeight: number
  dragX: number
  dragY: number
  dragZ: number
}

/** Grad → Bogenmaß, exakt der Faktor aus dem Binary (Cfile:894896). */
const DEG = 0.017453292

/** v um Quaternion (w,x,y,z) drehen. */
function qrot(
  qw: number,
  qx: number,
  qy: number,
  qz: number,
  x: number,
  y: number,
  z: number,
): [number, number, number] {
  // q * v * q^-1, ausmultipliziert.
  const tx = 2 * (qy * z - qz * y)
  const ty = 2 * (qz * x - qx * z)
  const tz = 2 * (qx * y - qy * x)
  return [
    x + qw * tx + qy * tz - qz * ty,
    y + qw * ty + qz * tx - qx * tz,
    z + qw * tz + qx * ty - qy * tx,
  ]
}

export class EmitterRuntime {
  /** TICKCOUNT: startet 0, += TICKINCREMENT (Default 1) NACH dem Tick
   *  (Cfile:894994; Ctor-Defaults 893976-893979). */
  private tickCount = 0
  /** Der EmitRate-Akkumulator: Bruchteile tragen über (Cfile:894662-894679). */
  private totalEmissions = 0

  private readonly c: Record<string, EfxCurve>
  private readonly repeat: number
  private readonly frameSize: number
  private readonly rowHeight: number
  private readonly interpolate: boolean
  private readonly gravity: boolean
  private readonly localVel: boolean
  private readonly localAccel: boolean
  private readonly drag: boolean
  private readonly alignToBone: boolean
  private readonly flat: boolean
  /** Emitter-Lebensdauer in Ticks; -1 = unendlich (ProcessLifetime,
   *  Cfile:894318-894366). Unsere Sim kennt das Blueprint-Lifetime nicht —
   *  die Laufzeit hört danach selbst auf zu emittieren. */
  private readonly life: number

  constructor(
    readonly bp: EmitterBpData,
    private readonly rand: () => number = Math.random,
  ) {
    this.c = {
      Size: makeEfxCurve(bp.SizeCurve),
      XDir: makeEfxCurve(bp.XDirectionCurve),
      YDir: makeEfxCurve(bp.YDirectionCurve),
      ZDir: makeEfxCurve(bp.ZDirectionCurve),
      EmitRate: makeEfxCurve(bp.EmitRateCurve),
      Lifetime: makeEfxCurve(bp.LifetimeCurve),
      Velocity: makeEfxCurve(bp.VelocityCurve),
      XAccel: makeEfxCurve(bp.XAccelCurve),
      YAccel: makeEfxCurve(bp.YAccelCurve),
      ZAccel: makeEfxCurve(bp.ZAccelCurve),
      Resistance: makeEfxCurve(bp.ResistanceCurve),
      StartSize: makeEfxCurve(bp.StartSizeCurve),
      EndSize: makeEfxCurve(bp.EndSizeCurve),
      InitialRotation: makeEfxCurve(bp.InitialRotationCurve),
      RotationRate: makeEfxCurve(bp.RotationRateCurve),
      FrameRate: makeEfxCurve(bp.FrameRateCurve),
      TextureSelection: makeEfxCurve(bp.TextureSelectionCurve),
      XPos: makeEfxCurve(bp.XPosCurve),
      YPos: makeEfxCurve(bp.YPosCurve),
      ZPos: makeEfxCurve(bp.ZPosCurve),
      RampSelection: makeEfxCurve(bp.RampSelectionCurve),
    }
    this.repeat = bp.Repeattime ?? 0
    this.frameSize = 1 / Math.max(bp.TextureFramecount ?? 0, 1)
    this.rowHeight = 1 / Math.max(bp.TextureStripcount ?? 1, 1)
    this.interpolate = bp.InterpolateEmission !== false
    this.gravity = bp.Gravity === true
    this.localVel = bp.LocalVelocity !== false
    this.localAccel = bp.LocalAcceleration === true
    this.drag = bp.ParticleResistance === true
    this.alignToBone = bp.AlignToBone === true
    this.flat = bp.Flat === true
    this.life = bp.Lifetime ?? 0
  }

  /**
   * Ein Sim-Tick des Emitters (`simTick` = absoluter Sim-Tick als Uhr-Basis
   * für `birth`; der Shader läuft mit uTime = Sim-Tick + Frame-Anteil).
   * Liefert die in diesem Tick gespawnten Partikel.
   */
  tick(state: EmitterState, simTick: number): SpawnedParticle[] {
    // ProcessLifetime: Lifetime >= 0 und TICKCOUNT drüber → keine Emission
    // mehr. (Lifetime 0 heißt im Blueprint-Default „sofort fertig" — solche
    // Emitter leben über ihre Partikel, nicht über den Emitter selbst.
    // Beobachtung aus den Daten: 0 kommt praktisch nicht vor; -1 oder >0.)
    const expired = this.life >= 0 && this.tickCount >= this.life && this.life > 0
    if (expired || !state.enabled) {
      this.tickCount += 1
      return []
    }

    // Emit-Takt (Cfile:894655-894679): Kurvenzeit = TICKCOUNT mod Repeattime
    // (floored), Akkumulator sammelt Bruchteile.
    const t = wrapEmitterTime(this.tickCount, this.repeat)
    this.totalEmissions += sampleCurve(this.c.EmitRate!, t, this.rand)
    const n = Math.floor(this.totalEmissions)
    this.totalEmissions -= n

    const out: SpawnedParticle[] = []
    for (let j = 0; j < n; j++) {
      // InterpolateEmission: Kurvenzeit + j/N, Geburt um j/N gestaffelt
      // (Cfile:894685, 894712-894717, 894868, 894922).
      const stagger = this.interpolate && n > 1 ? j / n : 0
      const a2 = wrapEmitterTime(this.tickCount + stagger, this.repeat)
      out.push(this.spawnOne(state, a2, simTick + stagger))
    }

    this.tickCount += 1
    return out
  }

  private spawnOne(s: EmitterState, a2: number, birth: number): SpawnedParticle {
    const r = this.rand
    const scale = s.scale

    // --- Spawn-Position -----------------------------------------------------
    // Lokaler Offset: PosCurves · Scale + OffsetEmitter (UNSKALIERT), dann
    // durch die Attachment-Matrix in die Welt (Cfile:894706-894733).
    let lx = sampleCurve(this.c.XPos!, a2, r) * scale + (s.ox ?? 0)
    let ly = sampleCurve(this.c.YPos!, a2, r) * scale + (s.oy ?? 0)
    let lz = sampleCurve(this.c.ZPos!, a2, r) * scale + (s.oz ?? 0)
    ;[lx, ly, lz] = qrot(s.qw, s.qx, s.qy, s.qz, lx, ly, lz)
    let px = s.x + lx
    let py = s.y + ly
    let pz = s.z + lz
    // SizeCurve ist KEIN Shader-Attribut: zufälliger Einheitsvektor in der
    // XZ-Ebene × (rand−0.5)·Size(a2)·Scale als Positions-Jitter
    // (Cfile:894772, 894791-894808).
    const jitter = (r() - 0.5) * sampleCurve(this.c.Size!, a2, r) * scale
    const jang = r() * Math.PI * 2
    px += Math.cos(jang) * jitter
    pz += Math.sin(jang) * jitter

    // --- Richtung/Geschwindigkeit -------------------------------------------
    // mDir = Dir(a2) · Scale — KEIN normalize (Cfile:894838-894848); dann
    // komponentenweise × Velocity-Skalar (Cfile:894860-894864).
    const vel = sampleCurve(this.c.Velocity!, a2, r)
    let vx = sampleCurve(this.c.XDir!, a2, r) * scale * vel
    let vy = sampleCurve(this.c.YDir!, a2, r) * scale * vel
    let vz = sampleCurve(this.c.ZDir!, a2, r) * scale * vel
    if (this.localVel) {
      ;[vx, vy, vz] = qrot(s.qw, s.qx, s.qy, s.qz, vx, vy, vz)
    }

    // --- Beschleunigung -----------------------------------------------------
    let ax = sampleCurve(this.c.XAccel!, a2, r) * scale
    let ay = sampleCurve(this.c.YAccel!, a2, r) * scale
    let az = sampleCurve(this.c.ZAccel!, a2, r) * scale
    if (this.localAccel) {
      ;[ax, ay, az] = qrot(s.qw, s.qx, s.qy, s.qz, ax, ay, az)
    }
    // Gravity: −0.02 pro Tick² auf Y, NACH der lokalen Drehung
    // (Cfile:894809-894837).
    if (this.gravity) ay -= 0.02

    // --- Rotation -----------------------------------------------------------
    // Grad → Bogenmaß mit exakt 0.017453292 (Cfile:894896, 894915-894917).
    let angle = sampleCurve(this.c.InitialRotation!, a2, r) * DEG
    const rotRate = sampleCurve(this.c.RotationRate!, a2, r) * DEG
    // AlignToBone: ohne Flat ersetzt die Bone-Z-Achse die Geschwindigkeit
    // (Alignment-Achse, Cfile:894911-894913); mit Flat wird der Winkel aus
    // der Achse gerechnet (Cfile:894899-894908).
    if (this.alignToBone) {
      const axis = qrot(s.qw, s.qx, s.qy, s.qz, 0, 0, 1)
      if (this.flat) {
        angle = Math.atan2(-axis[0], axis[2])
      } else {
        ;[vx, vy, vz] = axis
      }
    }

    // --- Lebenszeit/Größe ---------------------------------------------------
    const lifetime = Math.max(sampleCurve(this.c.Lifetime!, a2, r), 0)
    const beginSize = sampleCurve(this.c.StartSize!, a2, r) * scale
    const endSize = sampleCurve(this.c.EndSize!, a2, r) * scale
    // Die Rate entsteht beim UPLOAD: (End − Begin) / Lifetime (faf-re
    // ParticleRenderBuckets.cpp:4493-4494). Lifetime 0 → Partikel ist sofort
    // tot, die Rate ist dann egal (0 statt Division durch 0).
    const sizeRate = lifetime > 0 ? (endSize - beginSize) / lifetime : 0

    // --- Textur/Ramp --------------------------------------------------------
    const texRow = Math.floor(sampleCurve(this.c.TextureSelection!, a2, r)) * this.rowHeight
    const rampV = sampleCurve(this.c.RampSelection!, a2, r) // roh (Cfile:894884)
    const framerate = sampleCurve(this.c.FrameRate!, a2, r)

    // --- Drag ---------------------------------------------------------------
    // dragCoeff = (r, 1/r, 1/r²) — beim Upload gerechnet (faf-re
    // ParticleRenderBuckets.cpp:4509-4511).
    let dragX = 0
    let dragY = 0
    let dragZ = 0
    if (this.drag) {
      const res = sampleCurve(this.c.Resistance!, a2, r)
      dragX = res
      dragY = res !== 0 ? 1 / res : 0
      dragZ = res !== 0 ? 1 / (res * res) : 0
    }

    return {
      px,
      py,
      pz,
      angle,
      beginSize,
      sizeRate,
      vx,
      vy,
      vz,
      rotRate,
      ax,
      ay,
      az,
      birth,
      lifetime,
      framerate,
      frameSize: this.frameSize,
      texRow,
      rampV,
      rowHeight: this.rowHeight,
      dragX,
      dragY,
      dragZ,
    }
  }
}
