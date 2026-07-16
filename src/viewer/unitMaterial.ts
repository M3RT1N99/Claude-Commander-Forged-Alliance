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

/**
 * Die Beleuchtung der KARTE (scmap-Lighting-Block) — dieselben Werte, mit
 * denen das Terrain rechnet. mesh.fx ComputeLight (Zeilen 552-560) mischt
 * daraus das Einheiten-Licht; mit anderen Werten passen Einheiten und Boden
 * nie zusammen (genau das war der „dunkel/flach"-Eindruck).
 */
export interface MapLighting {
  sunDirection: THREE.Vector3
  sunColor: THREE.Color
  sunAmbience: THREE.Color
  shadowFillColor: THREE.Color
  lightingMultiplier: number
}

/** Werkzeug-Licht für den Unit-VIEWER (kein Spiel, keine Karte geladen). */
const VIEWER_LIGHT: MapLighting = {
  sunDirection: new THREE.Vector3(0.35, 0.8, 0.5).normalize(),
  sunColor: new THREE.Color(1.3, 1.25, 1.15),
  sunAmbience: new THREE.Color(0.28, 0.3, 0.35),
  shadowFillColor: new THREE.Color(0.5, 0.5, 0.55),
  lightingMultiplier: 1.0,
}

export function createUnitMaterial(
  textures: UnitTextures,
  teamColor: THREE.Color,
  skinMatrices: THREE.Matrix4[],
  shader = 'Unit',
  lighting: MapLighting = VIEWER_LIGHT,
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
      sunDirection: { value: lighting.sunDirection },
      // mesh.fx-Namen (unit.frag.glsl) …
      sunDiffuse: { value: lighting.sunColor },
      sunAmbient: { value: lighting.sunAmbience },
      shadowFill: { value: lighting.shadowFillColor },
      lightMultiplier: { value: lighting.lightingMultiplier },
      // … und die scmap-Namen des Seraphim-Ports (bekam sie vorher NIE —
      // Seraphim-Einheiten rechneten mit Null-Licht).
      sunAmbience: { value: lighting.sunAmbience },
      shadowFillColor: { value: lighting.shadowFillColor },
      glowMultiplier: { value: 2.0 }, // mesh.fx:56
    },
    side: THREE.DoubleSide,
  })
}
