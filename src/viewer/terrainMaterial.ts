import * as THREE from 'three'

// Der Shader-Text liegt in eigenen Dateien (kein GLSL in TS-Template-Literalen);
// Vite laedt ?raw als String — wie die .lua-Dateien im Projekt.
import vertexShader from './shaders/terrain.vert.glsl?raw'
import fragmentShader from './shaders/terrain.frag.glsl?raw'

export interface TerrainLayerTextures {
  lower: THREE.Texture
  strata: THREE.Texture[] // 8 Einträge (fehlende: 1x1-Dummy)
  upper: THREE.Texture
  lowerScale: number
  strataScales: number[] // 8 Einträge
  upperScale: number
  /** 1 = Stratum vorhanden, 0 = Maske ignorieren — 8 Einträge */
  strataEnabled: number[]
}

export interface TerrainMaterialOptions {
  heightTex: THREE.Texture
  heightScale: number
  hmWidth: number // Heightmap-Samples in x (mapWidth + 1)
  hmHeight: number
  mapWidth: number
  mapHeight: number
  maskA: THREE.Texture
  maskB: THREE.Texture
  layers: TerrainLayerTextures
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

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      heightTex: { value: o.heightTex },
      heightScale: { value: o.heightScale },
      // Texel-Zentren statt Kanten sampeln
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
    },
  })
}
