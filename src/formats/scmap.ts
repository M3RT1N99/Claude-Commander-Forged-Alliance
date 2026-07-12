/**
 * Parser für das SCMAP-Kartenformat (Moho-Engine, FA: Version major 2,
 * minor 56-60). Layout verifiziert per Hex-Analyse der Original-Karten und
 * abgeglichen mit den Community-Parsern (ozonex FAF Map Editor, Neroxis).
 */

export interface ScmapStratum {
  albedoPath: string
  albedoScale: number
}

export interface ScmapWater {
  hasWater: boolean
  elevation: number
  elevationDeep: number
  elevationAbyss: number
  surfaceColor: [number, number, number]
  colorLerpMin: number
  colorLerpMax: number
  refractionScale: number
  texPathWaterRamp: string
}

export interface ScmapLighting {
  sunDirection: [number, number, number]
  sunColor: [number, number, number]
  sunAmbience: [number, number, number]
  shadowFillColor: [number, number, number]
  specularColor: [number, number, number, number]
  lightingMultiplier: number
}

export interface ScmapData {
  versionMinor: number
  width: number
  height: number
  heightScale: number
  /** (width+1) * (height+1) Samples, row-major */
  heightmap: Uint16Array
  terrainShader: string
  background: string
  skyCubemap: string
  lighting: ScmapLighting
  water: ScmapWater
  /** Lower, Stratum0-7, Upper — genau 10 Lagen (FA) */
  strata: ScmapStratum[]
  /** Eingebettete DDS-Bilder */
  previewDds: Uint8Array
  normalMapDds: Uint8Array | null
  /** UtilityA: Masken Stratum 0-3 (RGBA) */
  textureMaskLowDds: Uint8Array | null
  /** UtilityB: Masken Stratum 4-7 (RGBA) */
  textureMaskHighDds: Uint8Array | null
  /** UtilityC: Wassertiefe u.a. */
  waterMapDds: Uint8Array | null
}

class Reader {
  pos = 0
  readonly view: DataView

  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, true)
    this.pos += 2
    return v
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true)
    this.pos += 4
    return v
  }

  i32(): number {
    const v = this.view.getInt32(this.pos, true)
    this.pos += 4
    return v
  }

  f32(): number {
    const v = this.view.getFloat32(this.pos, true)
    this.pos += 4
    return v
  }

  vec3(): [number, number, number] {
    return [this.f32(), this.f32(), this.f32()]
  }

  vec4(): [number, number, number, number] {
    return [this.f32(), this.f32(), this.f32(), this.f32()]
  }

  /** Null-terminierter String */
  cstr(): string {
    const start = this.pos
    while (this.pos < this.data.length && this.data[this.pos] !== 0) this.pos++
    const s = new TextDecoder('utf-8').decode(this.data.subarray(start, this.pos))
    this.pos++ // NUL
    return s
  }

  bytes(n: number): Uint8Array {
    const b = this.data.subarray(this.pos, this.pos + n)
    this.pos += n
    return b
  }

  skip(n: number): void {
    this.pos += n
  }
}

/** Liest einen eingebetteten DDS-Block: u32 Länge + Daten. */
function embeddedDds(r: Reader): Uint8Array {
  const len = r.u32()
  if (len === 0 || len > r.data.length - r.pos) {
    throw new Error(`SCMAP: ungültige eingebettete DDS-Länge ${len} @${r.pos - 4}`)
  }
  return r.bytes(len)
}

export function parseScmap(data: Uint8Array): ScmapData {
  const r = new Reader(data)

  const magic = r.u32()
  if (magic !== 0x1a70614d) throw new Error('SCMAP: falsches Magic (erwartet "Map\\x1a")')
  const versionMajor = r.u32()
  if (versionMajor !== 2) throw new Error(`SCMAP: Version major ${versionMajor} nicht unterstützt`)
  r.u32() // 0xBEEFFEED
  r.u32() // 2
  r.f32() // width als float (redundant)
  r.f32() // height als float (redundant)
  r.u32() // 0

  // Preview: manche Dateien haben hier ein zusätzliches u16-Feld. Robust:
  // Der u32 direkt vor dem "DDS "-Magic ist die Länge des Preview-Blocks.
  const probe = r.pos
  let previewDds: Uint8Array | null = null
  for (const extra of [0, 2]) {
    r.pos = probe + extra
    const len = r.view.getUint32(r.pos, true)
    const magicOff = r.pos + 4
    if (
      len > 128 &&
      magicOff + len <= data.length &&
      r.view.getUint32(magicOff, true) === 0x20534444 // "DDS "
    ) {
      r.pos = magicOff
      previewDds = r.bytes(len)
      break
    }
  }
  if (!previewDds) throw new Error('SCMAP: Preview-DDS nicht gefunden')

  const versionMinor = r.u32()
  if (versionMinor < 56) {
    throw new Error(`SCMAP: Version minor ${versionMinor} (< 56, SC1-Format) nicht unterstützt`)
  }

  // --- Terrain ---------------------------------------------------------------
  const width = r.u32()
  const height = r.u32()
  const heightScale = r.f32() // praktisch immer 1/128
  const hmSamples = (width + 1) * (height + 1)
  const heightmapBytes = r.bytes(hmSamples * 2)
  const heightmap = new Uint16Array(hmSamples)
  for (let i = 0; i < hmSamples; i++) {
    heightmap[i] = heightmapBytes[i * 2]! | (heightmapBytes[i * 2 + 1]! << 8)
  }
  if (versionMinor >= 56) r.skip(1) // unknown byte

  // --- Shader/Umgebung --------------------------------------------------------
  const terrainShader = r.cstr()
  const background = r.cstr()
  const skyCubemap = r.cstr()
  const envCubeCount = r.u32()
  for (let i = 0; i < envCubeCount; i++) {
    r.cstr() // Name
    r.cstr() // Pfad
  }

  // --- Lighting ----------------------------------------------------------------
  const lightingMultiplier = r.f32()
  const sunDirection = r.vec3()
  const sunAmbience = r.vec3()
  const sunColor = r.vec3()
  const shadowFillColor = r.vec3()
  const specularColor = r.vec4()
  r.f32() // bloom
  r.vec3() // fogColor
  r.f32() // fogStart
  r.f32() // fogEnd

  // --- Wasser -------------------------------------------------------------------
  const hasWater = r.data[r.pos] !== 0
  r.skip(1)
  const elevation = r.f32()
  const elevationDeep = r.f32()
  const elevationAbyss = r.f32()
  const surfaceColor = r.vec3()
  const colorLerpMin = r.f32()
  const colorLerpMax = r.f32()
  const refractionScale = r.f32()
  const fresnelBias = r.f32()
  const fresnelPower = r.f32()
  void fresnelBias
  void fresnelPower
  r.f32() // unitReflection
  r.f32() // skyReflection
  r.f32() // waveTexture-Skalen: sunShininess
  r.f32() // sunStrength
  r.vec3() // sunDirection (Wasser)
  r.vec3() // sunColor (Wasser)
  r.f32() // sunReflection
  r.f32() // sunGlow
  r.cstr() // texPathCubemap
  const texPathWaterRamp = r.cstr()

  // Wellen-Normal-Maps: erst ALLE 4 Repeat-Werte, dann 4 × (Movement + Pfad)
  for (let i = 0; i < 4; i++) r.f32() // waveNormalRepeat[4]
  for (let i = 0; i < 4; i++) {
    r.f32() // normalMovement.x
    r.f32() // normalMovement.y
    r.cstr() // texPath
  }
  // WaveGenerators
  const waveGenCount = r.u32()
  for (let i = 0; i < waveGenCount; i++) {
    r.cstr() // Textur
    r.cstr() // Ramp
    r.vec3() // Position
    r.f32() // Rotation
    r.vec3() // Velocity
    r.f32() // LifetimeFirst
    r.f32() // LifetimeSecond
    r.f32() // PeriodFirst
    r.f32() // PeriodSecond
    r.f32() // ScaleFirst
    r.f32() // ScaleSecond
    r.f32() // FrameCount
    r.f32() // FrameRateFirst
    r.f32() // FrameRateSecond
    r.f32() // StripCount
  }

  // --- Texturlagen (FA: 10 Albedo + 9 Normal) ----------------------------------
  // Minimap-Darstellung: contourInterval + 5 gepackte Farben
  for (let i = 0; i < 6; i++) r.i32()
  if (versionMinor > 56) r.f32() // unknown (nur v57+/v60)
  const strata: ScmapStratum[] = []
  for (let i = 0; i < 10; i++) {
    const albedoPath = r.cstr()
    const albedoScale = r.f32()
    strata.push({ albedoPath, albedoScale })
  }
  for (let i = 0; i < 9; i++) {
    r.cstr() // Normal-Pfad (später für Stratum-Normals)
    r.f32() // Normal-Skalierung
  }

  r.u32() // unknown
  r.u32() // unknown

  // --- Decals (überspringen) -----------------------------------------------------
  const decalCount = r.u32()
  for (let i = 0; i < decalCount; i++) {
    r.u32() // id
    r.u32() // type
    const texCount = r.u32()
    for (let t = 0; t < texCount; t++) {
      const strLen = r.u32()
      r.skip(strLen)
    }
    r.vec3() // scale
    r.vec3() // position
    r.vec3() // rotation
    r.f32() // cutOffLOD
    r.f32() // nearCutOffLOD
    r.u32() // ownerArmy
  }
  const decalGroupCount = r.u32()
  for (let i = 0; i < decalGroupCount; i++) {
    r.u32()
    r.cstr()
    const n = r.u32()
    r.skip(n * 4)
  }

  r.u32() // width (nochmal)
  r.u32() // height (nochmal)

  // --- Eingebettete Utility-Maps ---------------------------------------------------
  const normalMapCount = r.u32() // immer 1
  let normalMapDds: Uint8Array | null = null
  for (let i = 0; i < normalMapCount; i++) {
    const dds = embeddedDds(r)
    if (i === 0) normalMapDds = dds
  }
  const textureMaskLowDds = embeddedDds(r) // Stratum 0-3 (BGRA-Kanäle)
  const textureMaskHighDds = embeddedDds(r) // Stratum 4-7 (nur v>=56)
  const waterMapCount = r.u32() // immer 1
  void waterMapCount
  const waterMapDds = embeddedDds(r)
  // Danach: Foam/Flatness/Depth-Bias-Masken (je (w/2)*(h/2) Bytes), Terrain-Type,
  // Props — für das Rendering des Terrains nicht nötig; hier beenden wir.

  return {
    versionMinor,
    width,
    height,
    heightScale,
    heightmap,
    terrainShader,
    background,
    skyCubemap,
    lighting: {
      sunDirection,
      sunColor,
      sunAmbience,
      shadowFillColor,
      specularColor,
      lightingMultiplier,
    },
    water: {
      hasWater,
      elevation,
      elevationDeep,
      elevationAbyss,
      surfaceColor,
      colorLerpMin,
      colorLerpMax,
      refractionScale,
      texPathWaterRamp,
    },
    strata,
    previewDds,
    normalMapDds,
    textureMaskLowDds,
    textureMaskHighDds,
    waterMapDds,
  }
}
