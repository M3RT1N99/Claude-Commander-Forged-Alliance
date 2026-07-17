import * as THREE from 'three'

// Shader sources live in their own .glsl files (see shaders/water.*.glsl);
// this file is only the three.js setup.
import vertexShader from './shaders/water.vert.glsl?raw'
import fragmentShader from './shaders/water.frag.glsl?raw'

/** One scrolling wave normal layer (SCMAP water block, water2.fx). */
export interface WaterWaveLayer {
  texture: THREE.Texture
  movement: THREE.Vector2
  repeat: number
}

export interface WaterMaterialOptions {
  heightTex: THREE.Texture
  heightScale: number
  hmWidth: number
  hmHeight: number
  mapWidth: number
  mapHeight: number
  elevation: number
  depthToG: number
  colorLerpMin: number
  colorLerpMax: number
  surfaceColor: THREE.Color
  fresnelBias: number
  fresnelPower: number
  skyReflectionAmount: number
  sunShininess: number
  /** The water block's own sun (NOT the map lighting sun). */
  sunDirection: THREE.Vector3
  sunColor: THREE.Color
  /** Baked water texture (UtilitySamplerC): R flatness, G depth, B mask, A 1-foam. */
  waterMap: THREE.Texture
  /** The four wave normal layers, in file order. */
  waves: WaterWaveLayer[]
  /** Sky cubemap (texPathCubemap). */
  skyCube: THREE.Texture
}

export function createWaterMaterial(o: WaterMaterialOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    // The original writes opaquely over the refraction RT; our premultiplied
    // chain needs ONE / ONE_MINUS_SRC_ALPHA blending (water.frag.glsl).
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    depthWrite: false,
    uniforms: {
      heightTex: { value: o.heightTex },
      heightScale: { value: o.heightScale },
      hmUvScale: {
        value: new THREE.Vector2((o.hmWidth - 1) / o.hmWidth, (o.hmHeight - 1) / o.hmHeight),
      },
      hmUvOffset: { value: new THREE.Vector2(0.5 / o.hmWidth, 0.5 / o.hmHeight) },
      mapSize: { value: new THREE.Vector2(o.mapWidth, o.mapHeight) },
      elevation: { value: o.elevation },
      depthToG: { value: o.depthToG },
      colorLerpMin: { value: o.colorLerpMin },
      colorLerpMax: { value: o.colorLerpMax },
      surfaceColor: { value: o.surfaceColor },
      fresnelBias: { value: o.fresnelBias },
      fresnelPower: { value: o.fresnelPower },
      skyReflectionAmount: { value: o.skyReflectionAmount },
      sunShininess: { value: o.sunShininess },
      sunDirection: { value: o.sunDirection },
      sunColor: { value: o.sunColor },
      waterMap: { value: o.waterMap },
      wave0: { value: o.waves[0]?.texture ?? null },
      wave1: { value: o.waves[1]?.texture ?? null },
      wave2: { value: o.waves[2]?.texture ?? null },
      wave3: { value: o.waves[3]?.texture ?? null },
      waveMovement: { value: o.waves.map((w) => w.movement) },
      waveRepeat: { value: new THREE.Vector4(...o.waves.map((w) => w.repeat)) },
      skyCube: { value: o.skyCube },
      time: { value: 0 },
    },
  })
}
