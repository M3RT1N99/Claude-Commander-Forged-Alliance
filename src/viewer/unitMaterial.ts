import * as THREE from 'three'

// Shader-Quellen liegen als .glsl-Dateien daneben (siehe src/viewer/shaders/);
// diese Datei ist nur Loader + three.js-Aufbau.
import UNIT_VS from './shaders/unit.vert.glsl?raw'
import UNIT_FS from './shaders/unit.frag.glsl?raw'
import UNIT_SERAPHIM_FS from './shaders/unitSeraphim.frag.glsl?raw'
import WRECKAGE_VS from './shaders/wreckage.vert.glsl?raw'
import WRECKAGE_FS from './shaders/wreckage.frag.glsl?raw'
import BUILD_UEF_FS from './shaders/buildUef.frag.glsl?raw'
import BUILD_OVERLAY_VS from './shaders/buildOverlay.vert.glsl?raw'
import BUILD_OVERLAY_FS from './shaders/buildOverlay.frag.glsl?raw'
import BUILD_FACTION_VS from './shaders/buildFaction.vert.glsl?raw'
import BUILD_AEON_FS from './shaders/buildAeon.frag.glsl?raw'
import BUILD_AEON_OVERLAY_FS from './shaders/buildAeonOverlay.frag.glsl?raw'
import BUILD_CYBRAN_FS from './shaders/buildCybran.frag.glsl?raw'
import BUILD_CYBRAN_OVERLAY_VS from './shaders/buildCybranOverlay.vert.glsl?raw'
import BUILD_CYBRAN_OVERLAY_FS from './shaders/buildCybranOverlay.frag.glsl?raw'
import BUILD_SERAPHIM_FS from './shaders/buildSeraphim.frag.glsl?raw'

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
  /** Map env cube for the mesh.fx environmentSampler (2 * env * spec.r). */
  envCube: THREE.Texture | null = null,
): THREE.ShaderMaterial {
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1)
  white.needsUpdate = true
  const flatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 128]), 1, 1)
  flatNormal.needsUpdate = true

  const defines: Record<string, number | boolean> = {
    MAX_BONES: Math.max(skinMatrices.length, 1),
  }
  if (envCube) defines.ENVCUBE = true

  return new THREE.ShaderMaterial({
    vertexShader: UNIT_VS,
    fragmentShader: shader === 'Seraphim' && textures.lookup ? UNIT_SERAPHIM_FS : UNIT_FS,
    defines,
    uniforms: {
      environmentMap: { value: envCube },
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

/**
 * Die BAUSTELLEN-Materialien (mesh.fx technique UEFBuild, :5627-5683):
 * Pass P0 = das Gebäude blau-durchscheinend (UEFBuildHiFiPS:2928,
 * AlphaBlend SrcAlpha/InvSrcAlpha), Pass P1 = das scrollende Bau-Gitter
 * (UEFBuildOverlayHiFiPS:2977 auf EffectVertexNormalHiFiVS:1513).
 * material.y = FractionComplete (PARAM_FRACTIONCOMPLETE), material.x =
 * Alter der Unit in Sekunden. `fraction`/`time` werden pro Frame über die
 * zurückgegebenen Uniform-Referenzen gestellt.
 */
export function createUefBuildMaterials(
  textures: UnitTextures,
  /** Das Bau-Gitter: /textures/effects/UEFBuildSpecular.dds (kachelnd). */
  buildSpecular: THREE.Texture,
  teamColor: THREE.Color,
  skinMatrices: THREE.Matrix4[],
  lighting: MapLighting = VIEWER_LIGHT,
): { base: THREE.ShaderMaterial; overlay: THREE.ShaderMaterial } {
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1)
  white.needsUpdate = true
  const flatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 128]), 1, 1)
  flatNormal.needsUpdate = true

  const bones = { value: skinMatrices.length > 0 ? skinMatrices : [new THREE.Matrix4()] }
  const base = new THREE.ShaderMaterial({
    vertexShader: UNIT_VS,
    fragmentShader: BUILD_UEF_FS,
    defines: { MAX_BONES: Math.max(skinMatrices.length, 1) },
    uniforms: {
      boneMatrices: bones,
      albedoMap: { value: textures.albedo },
      normalsMap: { value: textures.normals ?? flatNormal },
      specTeamMap: { value: textures.specTeam ?? white },
      secondaryMap: { value: buildSpecular },
      teamColor: { value: teamColor },
      sunDirection: { value: lighting.sunDirection },
      sunDiffuse: { value: lighting.sunColor },
      sunAmbient: { value: lighting.sunAmbience },
      shadowFill: { value: lighting.shadowFillColor },
      lightMultiplier: { value: lighting.lightingMultiplier },
      glowMultiplier: { value: 2.0 }, // mesh.fx:56
      fraction: { value: 0 },
      unitAge: { value: 0 },
      time: { value: 0 },
    },
    transparent: true, // AlphaBlend_SrcAlpha_InvSrcAlpha (mesh.fx:5640/5669)
    // Write_RGB — the frame alpha (glow buffer) stays untouched.
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    side: THREE.DoubleSide,
  })
  const overlay = new THREE.ShaderMaterial({
    vertexShader: BUILD_OVERLAY_VS,
    fragmentShader: BUILD_OVERLAY_FS,
    defines: { MAX_BONES: Math.max(skinMatrices.length, 1) },
    uniforms: {
      boneMatrices: bones,
      secondaryMap: { value: buildSpecular },
      fraction: { value: 0 },
      unitAge: { value: 0 },
    },
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  return { base, overlay }
}

/**
 * The build-site materials of the other three factions (blueprints.lua:210
 * gives every build mesh the shader '<Faction>Build' and the secondary
 * texture '/textures/effects/<Faction>BuildSpecular.dds'):
 *
 *  - AeonBuild (mesh.fx:5349): opaque growing shell (AeonBuildPS :2713,
 *    mesh scaled by max(pc, 0.75) in AeonBuildVS :1307) + a blended
 *    scanline overlay (AeonBuildOverlayPS :2748).
 *  - CybranBuild (:5491): blended hologram (CybranBuildPS :2837, insect
 *    aniso lookup) + red scanline overlay (CybranBuildOverlayPS :2883,
 *    EffectVertexNormalLoFiVS(14,4,0,0,-0.008,0.008)).
 *  - SeraphimBuild (:5580): single blended pass (SeraphimBuildPS :2895,
 *    mesh scaled by 0.25 + pc*0.75, UV distortion from the secondary,
 *    falloff ramp per blueprints.lua:229).
 *
 * `fraction`/`unitAge` update per frame via the returned uniform refs,
 * like the UEF pair above.
 */
export function createFactionBuildMaterials(
  faction: 'Aeon' | 'Cybran' | 'Seraphim',
  textures: UnitTextures,
  /** /textures/effects/<Faction>BuildSpecular.dds */
  buildSpecular: THREE.Texture,
  /** Cybran only: /textures/engine/insectlookup.dds (Cfile:1194790). */
  insectLookup: THREE.Texture | null,
  /** Seraphim only: /textures/environment/Falloff_seraphim_lookup.dds. */
  falloffLookup: THREE.Texture | null,
  teamColor: THREE.Color,
  skinMatrices: THREE.Matrix4[],
  lighting: MapLighting = VIEWER_LIGHT,
  envCube: THREE.Texture | null = null,
): { base: THREE.ShaderMaterial; overlay: THREE.ShaderMaterial | null } {
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1)
  white.needsUpdate = true
  const flatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 128]), 1, 1)
  flatNormal.needsUpdate = true

  const bones = { value: skinMatrices.length > 0 ? skinMatrices : [new THREE.Matrix4()] }
  const shared = {
    boneMatrices: bones,
    albedoMap: { value: textures.albedo },
    normalsMap: { value: textures.normals ?? flatNormal },
    specTeamMap: { value: textures.specTeam ?? white },
    secondaryMap: { value: buildSpecular },
    teamColor: { value: teamColor },
    sunDirection: { value: lighting.sunDirection },
    sunDiffuse: { value: lighting.sunColor },
    sunAmbient: { value: lighting.sunAmbience },
    shadowFill: { value: lighting.shadowFillColor },
    lightMultiplier: { value: lighting.lightingMultiplier },
    glowMultiplier: { value: 2.0 }, // mesh.fx:56
    fraction: { value: 0 },
    unitAge: { value: 0 },
    environmentMap: { value: envCube },
  }
  const defines: Record<string, number | boolean> = {
    MAX_BONES: Math.max(skinMatrices.length, 1),
  }
  if (envCube) defines.ENVCUBE = true

  if (faction === 'Aeon') {
    const base = new THREE.ShaderMaterial({
      vertexShader: BUILD_FACTION_VS,
      fragmentShader: BUILD_AEON_FS,
      defines: { ...defines, AEON_SCALE: true },
      uniforms: { ...shared },
      // pass P0 is opaque, Write_RGB (mesh.fx:5362) — keep frame alpha
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      side: THREE.DoubleSide,
    })
    const overlay = new THREE.ShaderMaterial({
      vertexShader: BUILD_FACTION_VS,
      fragmentShader: BUILD_AEON_OVERLAY_FS,
      defines: { ...defines, AEON_SCALE: true },
      uniforms: { ...shared },
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    return { base, overlay }
  }

  if (faction === 'Cybran') {
    const base = new THREE.ShaderMaterial({
      vertexShader: BUILD_FACTION_VS,
      fragmentShader: BUILD_CYBRAN_FS,
      defines: { ...defines },
      uniforms: { ...shared, insectMap: { value: insectLookup ?? white } },
      transparent: true, // AlphaBlend_SrcAlpha Write_RGB (mesh.fx:5502)
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      side: THREE.DoubleSide,
    })
    const overlay = new THREE.ShaderMaterial({
      vertexShader: BUILD_CYBRAN_OVERLAY_VS,
      fragmentShader: BUILD_CYBRAN_OVERLAY_FS,
      defines: { ...defines },
      uniforms: { ...shared },
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    return { base, overlay }
  }

  const base = new THREE.ShaderMaterial({
    vertexShader: BUILD_FACTION_VS,
    fragmentShader: BUILD_SERAPHIM_FS,
    defines: { ...defines, SERAPHIM_SCALE: true },
    uniforms: { ...shared, lookupMap: { value: falloffLookup ?? white } },
    transparent: true, // AlphaBlend_SrcAlpha Write_RGB (mesh.fx:5592)
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    side: THREE.DoubleSide,
  })
  return { base, overlay: null }
}

/**
 * Das WRACK-Material (mesh.fx technique Wreckage, PS:2334 + VS:1153): das
 * Unit-Mesh, im Vertex-Shader verbeult, Albedo der Unit mit dem Wrack-Noise
 * aus `/env/common/props/wreckage_noise.dds` (der SpecularName, den
 * ExtractWreckageBlueprint in lua/system/blueprints.lua:201 setzt).
 * Keine Team-Farbe, kein Phong, keine Schatten — so das Original.
 */
export function createWreckageMaterial(
  textures: UnitTextures,
  noise: THREE.Texture,
  skinMatrices: THREE.Matrix4[],
  /** Erstellungszeit in Sekunden (Sim-Tick / 10) — variiert das Noise. */
  creationTime: number,
  lighting: MapLighting = VIEWER_LIGHT,
): THREE.ShaderMaterial {
  const flatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 128]), 1, 1)
  flatNormal.needsUpdate = true

  return new THREE.ShaderMaterial({
    vertexShader: WRECKAGE_VS,
    fragmentShader: WRECKAGE_FS,
    defines: { MAX_BONES: Math.max(skinMatrices.length, 1) },
    uniforms: {
      boneMatrices: { value: skinMatrices.length > 0 ? skinMatrices : [new THREE.Matrix4()] },
      albedoMap: { value: textures.albedo },
      normalsMap: { value: textures.normals ?? flatNormal },
      specularMap: { value: noise },
      sunDirection: { value: lighting.sunDirection },
      sunDiffuse: { value: lighting.sunColor },
      sunAmbient: { value: lighting.sunAmbience },
      shadowFill: { value: lighting.shadowFillColor },
      lightMultiplier: { value: lighting.lightingMultiplier },
      creationTime: { value: creationTime },
    },
    side: THREE.DoubleSide,
  })
}
