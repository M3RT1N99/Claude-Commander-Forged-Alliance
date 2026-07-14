import * as THREE from 'three'

// Shader-Quellen liegen als .glsl-Dateien daneben (siehe src/viewer/shaders/);
// diese Datei ist nur Loader + three.js-Aufbau.
import UNIT_VS from './shaders/unit.vert.glsl?raw'
import UNIT_FS from './shaders/unit.frag.glsl?raw'
import UNIT_SERAPHIM_FS from './shaders/unitSeraphim.frag.glsl?raw'

export interface UnitTextures {
  albedo: THREE.Texture
  normals: THREE.Texture | null
  specTeam: THREE.Texture | null
  /** Falloff-Ramp für den Seraphim-Shader */
  lookup?: THREE.Texture | null
}

export function createUnitMaterial(
  textures: UnitTextures,
  teamColor: THREE.Color,
  skinMatrices: THREE.Matrix4[],
  shader = 'Unit',
): THREE.ShaderMaterial {
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1)
  white.needsUpdate = true
  const flatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 128]), 1, 1)
  flatNormal.needsUpdate = true

  return new THREE.ShaderMaterial({
    vertexShader: UNIT_VS,
    fragmentShader: shader === 'Seraphim' && textures.lookup ? UNIT_SERAPHIM_FS : UNIT_FS,
    defines: { MAX_BONES: Math.max(skinMatrices.length, 1) },
    uniforms: {
      lookupMap: { value: textures.lookup ?? white },
      boneMatrices: { value: skinMatrices.length > 0 ? skinMatrices : [new THREE.Matrix4()] },
      albedoMap: { value: textures.albedo },
      normalsMap: { value: textures.normals ?? flatNormal },
      specTeamMap: { value: textures.specTeam ?? white },
      teamColor: { value: teamColor },
      sunDirection: { value: new THREE.Vector3(0.35, 0.8, 0.5).normalize() },
      sunColor: { value: new THREE.Color(1.3, 1.25, 1.15) },
      ambientColor: { value: new THREE.Color(0.28, 0.3, 0.35) },
      glowMultiplier: { value: 2.0 },
    },
    side: THREE.DoubleSide,
  })
}
