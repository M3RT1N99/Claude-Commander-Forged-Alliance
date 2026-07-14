import * as THREE from 'three'

// Shader-Quelltext liegt in eigenen .glsl-Dateien (siehe shaders/water.*.glsl);
// hier steht nur noch der three.js-Aufbau.
import vertexShader from './shaders/water.vert.glsl?raw'
import fragmentShader from './shaders/water.frag.glsl?raw'

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
  sunDirection: THREE.Vector3
  sunColor: THREE.Color
}

export function createWaterMaterial(o: WaterMaterialOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
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
      skyColor: { value: new THREE.Color(0.42, 0.5, 0.58) },
      sunDirection: { value: o.sunDirection },
      sunColor: { value: o.sunColor },
      skyReflectionAmount: { value: 0.65 },
      sunShininess: { value: 60 },
    },
  })
}
