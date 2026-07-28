/**
 * Parser for the SCMAP map format (Moho engine, FA: major version 2,
 * minor versions 56-60). Layout verified by hex analysis of original maps and
 * cross-checked against community parsers (ozonex FAF Map Editor, Neroxis).
 */

export interface ScmapStratum {
  albedoPath: string
  albedoScale: number
}

/** One of the four scrolling wave normal-map layers (water2.fx). */
export interface ScmapWaveNormal {
  repeat: number
  movementX: number
  movementY: number
  path: string
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
  fresnelBias: number
  fresnelPower: number
  unitReflection: number
  skyReflection: number
  sunShininess: number
  sunStrength: number
  sunDirection: [number, number, number]
  sunColor: [number, number, number]
  sunReflection: number
  sunGlow: number
  /** The sky cubemap the water reflects (water2.fx SkySampler). */
  texPathCubemap: string
  texPathWaterRamp: string
  /** Exactly 4 layers (water2.fx NormalSampler0-3). */
  waveNormals: ScmapWaveNormal[]
}

/** A terrain decal (CDecalTypes.h SDecalInfo; type enum CWldTerrainDecalTYPE:
 *  1 Albedo, 2 Normals, 4 WaterAlbedo, 6 Glow, 8 GlowMask, 9 AlbedoXp). */
export interface ScmapDecal {
  type: number
  textures: string[]
  scale: [number, number, number]
  position: [number, number, number]
  rotation: [number, number, number]
  cutOffLOD: number
  nearCutOffLOD: number
  army: number
}

/** A map prop instance (render-details.md par. 1: 3x3 orthonormal rotation
 *  basis, verified over all 60 retail maps down to exact EOF). */
export interface ScmapProp {
  blueprintPath: string
  position: [number, number, number]
  rotationX: [number, number, number]
  rotationY: [number, number, number]
  rotationZ: [number, number, number]
  scale: [number, number, number]
}

/** The v60 skybox block (independently confirmed by sky.fx + SkyDome.cpp:
 *  dome 16x6, subHeight 1.2566371). */
export interface ScmapSkybox {
  position: [number, number, number]
  horizonHeight: number
  scale: number
  subHeight: number
  subDivAx: number
  subDivHeight: number
  zenithHeight: number
  horizonColor: [number, number, number]
  zenithColor: [number, number, number]
  decalGlowMultiplier: number
  albedo: string
  glow: string
  planets: { position: [number, number, number]; rotation: number; scale: [number, number]; uv: [number, number, number, number] }[]
  midRgbColor: [number, number, number]
  cirrusMultiplier: number
  cirrusColor: [number, number, number]
  cirrusTexture: string
  cirrusLayers: { frequency: [number, number]; speed: number; direction: [number, number] }[]
}

export interface ScmapLighting {
  sunDirection: [number, number, number]
  sunColor: [number, number, number]
  sunAmbience: [number, number, number]
  shadowFillColor: [number, number, number]
  specularColor: [number, number, number, number]
  lightingMultiplier: number
  /**
   * The map's glow/bloom amount (`CWldTerrainRes::mBloom`, default 0.08,
   * Cfile:1337597). The engine feeds it into the frame shader's `GlowCopyAdd`
   * var each frame — `GetBloom()` -> `DoBloom(amt)` -> `SetFloat(GlowCopyAdd,
   * amt)` (Cfile:1212932/1212943/1209602); with no map it is 0.0
   * (Cfile:1212939). Lifts the bright-pass floor of the bloom copy pass.
   */
  bloom: number
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
  /** Lower, Stratum0-7, Upper — exactly 10 layers (FA). */
  strata: ScmapStratum[]
  /** The 9 stratum normal-map layers (path + scale). */
  normalStrata: ScmapStratum[]
  /** Environment cubemaps for mesh.fx environmentSampler: name -> path. */
  envCubes: { name: string; path: string }[]
  decals: ScmapDecal[]
  /** Terrain type index per cell (width * height bytes) — GetTerrainType. */
  terrainTypeData: Uint8Array
  /** Only versionMinor >= 60 (older maps use the header background/skyCubemap). */
  skybox: ScmapSkybox | null
  props: ScmapProp[]
  /** Embedded DDS images. */
  previewDds: Uint8Array
  normalMapDds: Uint8Array | null
  /** UtilityA: masks for strata 0-3 (RGBA). */
  textureMaskLowDds: Uint8Array | null
  /** UtilityB: masks for strata 4-7 (RGBA). */
  textureMaskHighDds: Uint8Array | null
  /** UtilityC: water depth and more. */
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

  /** Null-terminated string. */
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

/** Reads an embedded DDS block: u32 length + data. */
function embeddedDds(r: Reader): Uint8Array {
  const len = r.u32()
  if (len === 0 || len > r.data.length - r.pos) {
    throw new Error(`SCMAP: invalid embedded DDS length ${len} @${r.pos - 4}`)
  }
  return r.bytes(len)
}

export function parseScmap(data: Uint8Array): ScmapData {
  const r = new Reader(data)

  const magic = r.u32()
  if (magic !== 0x1a70614d) throw new Error('SCMAP: invalid magic (expected "Map\\x1a")')
  const versionMajor = r.u32()
  if (versionMajor !== 2) throw new Error(`SCMAP: major version ${versionMajor} is not supported`)
  r.u32() // 0xBEEFFEED
  r.u32() // 2
  r.f32() // width as float (redundant)
  r.f32() // height as float (redundant)
  r.u32() // 0

  // Preview: some files have an additional u16 field here. Robustly, the u32
  // directly before the "DDS " magic is the length of the preview block.
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
  if (!previewDds) throw new Error('SCMAP: preview DDS not found')

  const versionMinor = r.u32()
  if (versionMinor < 56) {
    throw new Error(`SCMAP: minor version ${versionMinor} (< 56, SC1 format) is not supported`)
  }

  // --- Terrain ---------------------------------------------------------------
  const width = r.u32()
  const height = r.u32()
  const heightScale = r.f32() // almost always 1/128
  const hmSamples = (width + 1) * (height + 1)
  const heightmapBytes = r.bytes(hmSamples * 2)
  const heightmap = new Uint16Array(hmSamples)
  for (let i = 0; i < hmSamples; i++) {
    heightmap[i] = heightmapBytes[i * 2]! | (heightmapBytes[i * 2 + 1]! << 8)
  }
  if (versionMinor >= 56) r.skip(1) // unknown byte

  // --- Shader/environment ------------------------------------------------------
  const terrainShader = r.cstr()
  const background = r.cstr()
  const skyCubemap = r.cstr()
  const envCubeCount = r.u32()
  const envCubes: { name: string; path: string }[] = []
  for (let i = 0; i < envCubeCount; i++) {
    envCubes.push({ name: r.cstr(), path: r.cstr() })
  }

  // --- Lighting ----------------------------------------------------------------
  const lightingMultiplier = r.f32()
  const sunDirection = r.vec3()
  const sunAmbience = r.vec3()
  const sunColor = r.vec3()
  const shadowFillColor = r.vec3()
  const specularColor = r.vec4()
  const bloom = r.f32() // CWldTerrainRes::mBloom -> frame shader GlowCopyAdd
  r.vec3() // fogColor
  r.f32() // fogStart
  r.f32() // fogEnd

  // --- Water -------------------------------------------------------------------
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
  const unitReflection = r.f32()
  const skyReflection = r.f32()
  const sunShininess = r.f32()
  const sunStrength = r.f32()
  const waterSunDirection = r.vec3()
  const waterSunColor = r.vec3()
  const sunReflection = r.f32()
  const sunGlow = r.f32()
  const texPathCubemap = r.cstr()
  const texPathWaterRamp = r.cstr()

  // Wave normal maps: ALL 4 repeat values first, then 4 x (movement + path).
  const waveRepeats: number[] = []
  for (let i = 0; i < 4; i++) waveRepeats.push(r.f32())
  const waveNormals: ScmapWaveNormal[] = []
  for (let i = 0; i < 4; i++) {
    const movementX = r.f32()
    const movementY = r.f32()
    waveNormals.push({ repeat: waveRepeats[i]!, movementX, movementY, path: r.cstr() })
  }
  // WaveGenerators
  const waveGenCount = r.u32()
  for (let i = 0; i < waveGenCount; i++) {
    r.cstr() // texture
    r.cstr() // Ramp
    r.vec3() // position
    r.f32() // rotation
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

  // --- Texture layers (FA: 10 albedo + 9 normal) --------------------------------
  // Minimap representation: contourInterval + 5 packed colors
  for (let i = 0; i < 6; i++) r.i32()
  if (versionMinor > 56) r.f32() // unknown (v57+/v60 only)
  const strata: ScmapStratum[] = []
  for (let i = 0; i < 10; i++) {
    const albedoPath = r.cstr()
    const albedoScale = r.f32()
    strata.push({ albedoPath, albedoScale })
  }
  const normalStrata: ScmapStratum[] = []
  for (let i = 0; i < 9; i++) {
    normalStrata.push({ albedoPath: r.cstr(), albedoScale: r.f32() })
  }

  r.u32() // unknown
  r.u32() // unknown

  // --- Decals (SDecalInfo, CDecalTypes.h:89-101) --------------------------------
  const decalCount = r.u32()
  const decals: ScmapDecal[] = []
  for (let i = 0; i < decalCount; i++) {
    r.u32() // id
    const type = r.u32()
    const texCount = r.u32()
    const textures: string[] = []
    for (let t = 0; t < texCount; t++) {
      const strLen = r.u32()
      textures.push(new TextDecoder('ascii').decode(r.data.subarray(r.pos, r.pos + strLen)))
      r.skip(strLen)
    }
    decals.push({
      type,
      textures,
      scale: r.vec3(),
      position: r.vec3(),
      rotation: r.vec3(),
      cutOffLOD: r.f32(),
      nearCutOffLOD: r.f32(),
      army: r.u32(),
    })
  }
  const decalGroupCount = r.u32()
  for (let i = 0; i < decalGroupCount; i++) {
    r.u32()
    r.cstr()
    const n = r.u32()
    r.skip(n * 4)
  }

  r.u32() // width (again)
  r.u32() // height (again)

  // --- Embedded utility maps ------------------------------------------------------
  const normalMapCount = r.u32() // always 1
  let normalMapDds: Uint8Array | null = null
  for (let i = 0; i < normalMapCount; i++) {
    const dds = embeddedDds(r)
    if (i === 0) normalMapDds = dds
  }
  const textureMaskLowDds = embeddedDds(r) // strata 0-3 (BGRA channels)
  const textureMaskHighDds = embeddedDds(r) // strata 4-7 (v>=56 only)
  const waterMapCount = r.u32() // always 1
  void waterMapCount
  const waterMapDds = embeddedDds(r)

  // --- Tail (render-details.md par. 1 — verified over all 60 retail maps
  // down to exact EOF): foam/flatness/depthBias masks, terrain type,
  // v60 skybox block, then the props list.
  const maskBytes = (width / 2) * (height / 2)
  r.skip(maskBytes) // waterFoamMask
  r.skip(maskBytes) // waterFlatnessMask
  r.skip(maskBytes) // waterDepthBiasMask
  const terrainTypeData = r.data.subarray(r.pos, r.pos + width * height)
  r.skip(width * height)

  let skybox: ScmapSkybox | null = null
  if (versionMinor >= 60) {
    const position = r.vec3()
    const horizonHeight = r.f32()
    const scale = r.f32()
    const subHeight = r.f32()
    const subDivAx = r.i32()
    const subDivHeight = r.i32()
    const zenithHeight = r.f32()
    const horizonColor = r.vec3()
    const zenithColor = r.vec3()
    const decalGlowMultiplier = r.f32()
    const albedo = r.cstr()
    const glow = r.cstr()
    const planetCount = r.i32()
    const planets: ScmapSkybox['planets'] = []
    for (let i = 0; i < planetCount; i++) {
      planets.push({ position: r.vec3(), rotation: r.f32(), scale: [r.f32(), r.f32()], uv: r.vec4() })
    }
    const midRgbColor: [number, number, number] = [r.data[r.pos]!, r.data[r.pos + 1]!, r.data[r.pos + 2]!]
    r.skip(3)
    const cirrusMultiplier = r.f32()
    const cirrusColor = r.vec3()
    const cirrusTexture = r.cstr()
    const cirrusLayerCount = r.i32()
    const cirrusLayers: ScmapSkybox['cirrusLayers'] = []
    for (let i = 0; i < cirrusLayerCount; i++) {
      cirrusLayers.push({ frequency: [r.f32(), r.f32()], speed: r.f32(), direction: [r.f32(), r.f32()] })
    }
    r.f32() // clouds7 (always 0.0)
    skybox = {
      position, horizonHeight, scale, subHeight, subDivAx, subDivHeight,
      zenithHeight, horizonColor, zenithColor, decalGlowMultiplier, albedo,
      glow, planets, midRgbColor, cirrusMultiplier, cirrusColor,
      cirrusTexture, cirrusLayers,
    }
  }

  const propCount = r.u32()
  const props: ScmapProp[] = []
  for (let i = 0; i < propCount; i++) {
    props.push({
      blueprintPath: r.cstr(),
      position: r.vec3(),
      rotationX: r.vec3(),
      rotationY: r.vec3(),
      rotationZ: r.vec3(),
      scale: r.vec3(),
    })
  }
  // The tail structure is fully decoded — anything left over is a parse
  // error, not something to ignore.
  if (r.pos !== r.data.length) {
    throw new Error(`SCMAP: ${r.data.length - r.pos} bytes left after props (parsed ${r.pos})`)
  }

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
      bloom,
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
      fresnelBias,
      fresnelPower,
      unitReflection,
      skyReflection,
      sunShininess,
      sunStrength,
      sunDirection: waterSunDirection,
      sunColor: waterSunColor,
      sunReflection,
      sunGlow,
      texPathCubemap,
      texPathWaterRamp,
      waveNormals,
    },
    strata,
    normalStrata,
    envCubes,
    decals,
    terrainTypeData,
    skybox,
    props,
    previewDds,
    normalMapDds,
    textureMaskLowDds,
    textureMaskHighDds,
    waterMapDds,
  }
}
