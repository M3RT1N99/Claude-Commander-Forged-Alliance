import * as THREE from 'three'

// Shader sources live in their own files (no GLSL in TS template literals);
// Vite loads ?raw as a string — like the .lua files in this project.
import vertexShader from './shaders/terrain.vert.glsl?raw'
import fragmentShader from './shaders/terrain.frag.glsl?raw'
import type { ShadowUniforms } from './shadow'

export interface TerrainLayerTextures {
  lower: THREE.Texture
  strata: THREE.Texture[] // 8 entries (missing ones: 1x1 dummy)
  upper: THREE.Texture
  lowerScale: number
  strataScales: number[] // 8 entries
  upperScale: number
  /** 1 = stratum present, 0 = ignore its mask — 8 entries */
  strataEnabled: number[]
}

/** Stratum normal maps (terrain.fx TerrainNormalsPS/XP): lower + 8 strata. */
export interface TerrainNormalTextures {
  lower: THREE.Texture | null
  strata: (THREE.Texture | null)[] // 8 entries
  lowerScale: number
  strataScales: number[] // 8 entries
}

export interface TerrainMaterialOptions {
  /** scmap terrainShader string: 'TTerrain' | 'TTerrainXP' | 'TTerrainGlow'. */
  terrainShader: string
  /** Shared shadow uniforms (ShadowRenderer.uniforms). */
  shadow: ShadowUniforms
  heightTex: THREE.Texture
  heightScale: number
  hmWidth: number // heightmap samples in x (mapWidth + 1)
  hmHeight: number
  mapWidth: number
  mapHeight: number
  maskA: THREE.Texture
  maskB: THREE.Texture
  layers: TerrainLayerTextures
  normals: TerrainNormalTextures
  waterRamp: THREE.Texture | null
  waterElevation: number
  depthToG: number
  lighting: {
    sunDirection: THREE.Vector3
    sunColor: THREE.Color
    sunAmbience: THREE.Color
    shadowFillColor: THREE.Color
    specularColor: THREE.Vector4
    lightingMultiplier: number
  }
}

export function createTerrainMaterial(o: TerrainMaterialOptions): THREE.ShaderMaterial {
  const dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
  dummy.needsUpdate = true
  // Flat tangent normal (0,0 in the two used channels after *2-1).
  const flatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 255]), 1, 1)
  flatNormal.needsUpdate = true

  // Shader variant per the scmap terrainShader string (terrain.fx):
  // TTerrainXP = 8 strata + XP lighting; TTerrain/TTerrainGlow = 4 strata +
  // CalculateLighting; TTerrainGlow additionally scrolls stratum1.
  const defines: Record<string, boolean> = {}
  if (o.terrainShader === 'TTerrainXP') defines.XP = true
  if (o.terrainShader === 'TTerrainGlow') defines.GLOW = true

  const normalEnabled = (t: THREE.Texture | null): number => (t ? 1 : 0)

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    defines,
    uniforms: {
      ...o.shadow,
      heightTex: { value: o.heightTex },
      heightScale: { value: o.heightScale },
      // Sample texel centers instead of edges
      hmUvScale: {
        value: new THREE.Vector2((o.hmWidth - 1) / o.hmWidth, (o.hmHeight - 1) / o.hmHeight),
      },
      hmUvOffset: { value: new THREE.Vector2(0.5 / o.hmWidth, 0.5 / o.hmHeight) },
      hmTexel: { value: new THREE.Vector2(1 / o.hmWidth, 1 / o.hmHeight) },
      mapSize: { value: new THREE.Vector2(o.mapWidth, o.mapHeight) },
      maskA: { value: o.maskA },
      maskB: { value: o.maskB },
      lowerAlbedo: { value: o.layers.lower },
      stratum0Albedo: { value: o.layers.strata[0] ?? dummy },
      stratum1Albedo: { value: o.layers.strata[1] ?? dummy },
      stratum2Albedo: { value: o.layers.strata[2] ?? dummy },
      stratum3Albedo: { value: o.layers.strata[3] ?? dummy },
      stratum4Albedo: { value: o.layers.strata[4] ?? dummy },
      stratum5Albedo: { value: o.layers.strata[5] ?? dummy },
      stratum6Albedo: { value: o.layers.strata[6] ?? dummy },
      stratum7Albedo: { value: o.layers.strata[7] ?? dummy },
      upperAlbedo: { value: o.layers.upper },
      lowerTile: { value: o.layers.lowerScale },
      stratumTile: { value: o.layers.strataScales },
      upperTile: { value: o.layers.upperScale },
      stratumEnable0: { value: new THREE.Vector4(...o.layers.strataEnabled.slice(0, 4)) },
      stratumEnable1: { value: new THREE.Vector4(...o.layers.strataEnabled.slice(4, 8)) },
      lowerNormalMap: { value: o.normals.lower ?? flatNormal },
      stratum0Normal: { value: o.normals.strata[0] ?? flatNormal },
      stratum1Normal: { value: o.normals.strata[1] ?? flatNormal },
      stratum2Normal: { value: o.normals.strata[2] ?? flatNormal },
      stratum3Normal: { value: o.normals.strata[3] ?? flatNormal },
      stratum4Normal: { value: o.normals.strata[4] ?? flatNormal },
      stratum5Normal: { value: o.normals.strata[5] ?? flatNormal },
      stratum6Normal: { value: o.normals.strata[6] ?? flatNormal },
      stratum7Normal: { value: o.normals.strata[7] ?? flatNormal },
      lowerNormalTile: { value: o.normals.lowerScale },
      stratumNormalTile: { value: o.normals.strataScales },
      normalEnable0: {
        value: new THREE.Vector4(...o.normals.strata.slice(0, 4).map(normalEnabled)),
      },
      normalEnable1: {
        value: new THREE.Vector4(...o.normals.strata.slice(4, 8).map(normalEnabled)),
      },
      waterRamp: { value: o.waterRamp ?? dummy },
      hasWater: { value: o.waterRamp ? 1 : 0 },
      waterElevation: { value: o.waterElevation },
      depthToG: { value: o.depthToG },
      sunDirection: { value: o.lighting.sunDirection },
      sunColor: { value: o.lighting.sunColor },
      sunAmbience: { value: o.lighting.sunAmbience },
      shadowFillColor: { value: o.lighting.shadowFillColor },
      specularColor: { value: o.lighting.specularColor },
      lightingMultiplier: { value: o.lighting.lightingMultiplier },
      time: { value: 0 },
    },
  })
}
