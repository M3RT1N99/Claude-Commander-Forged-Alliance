import * as THREE from 'three'

/**
 * Port des Original-Unit-Shaders (effects/mesh.fx, NormalMappedPS) aus den
 * Spieldaten:
 *   - Normal-Map: tangent-space, x/y aus den G/A-Kanälen der DXT5-Textur
 *     (`2 * tex.gaa - 1`, z rekonstruiert), gesampelt mit UV1
 *   - SpecTeam:  R = Environment-Reflexion, G = Phong-Spekular,
 *                B = Glow/Emissive, A = Team-Color-Maske
 *   - Team-Color: albedo.rgb = lerp(teamColor, albedo.rgb, 1 - specular.a)
 *   - Farbe: albedo * (emissive + licht + envReflexion) + phongAdditive
 * Environment-Cubemap ist (noch) durch eine Konstante angenähert.
 */

const vertexShader = /* glsl */ `
  attribute vec3 scmTangent;
  attribute vec3 scmBinormal;
  attribute vec2 scmUv1;
  attribute float scmBoneIndex;

  uniform mat4 boneMatrices[MAX_BONES];

  varying vec2 vUv0;
  varying vec2 vUv1;
  varying vec3 vNormal;
  varying vec3 vTangent;
  varying vec3 vBinormal;
  varying vec3 vWorldPos;

  void main() {
    vUv0 = uv;
    vUv1 = scmUv1;

    // FA-Skinning ist rigid: genau ein Bone pro Vertex
    mat4 skin = boneMatrices[int(scmBoneIndex + 0.5)];
    vec4 skinned = skin * vec4(position, 1.0);
    mat3 skinRot = mat3(skin);

    mat3 nm = mat3(modelMatrix) * skinRot;
    vNormal = nm * normal;
    vTangent = nm * scmTangent;
    vBinormal = nm * scmBinormal;
    vec4 worldPos = modelMatrix * skinned;
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`

const fragmentShader = /* glsl */ `
  precision highp float;

  uniform sampler2D albedoMap;
  uniform sampler2D normalsMap;
  uniform sampler2D specTeamMap;
  uniform vec3 teamColor;
  uniform vec3 sunDirection;   // Richtung ZUR Sonne, Weltkoordinaten
  uniform vec3 sunColor;
  uniform vec3 ambientColor;
  uniform float glowMultiplier;

  varying vec2 vUv0;
  varying vec2 vUv1;
  varying vec3 vNormal;
  varying vec3 vTangent;
  varying vec3 vBinormal;
  varying vec3 vWorldPos;

  void main() {
    // mesh.fx ComputeNormal: normal.xy aus G/A, z rekonstruiert,
    // rotiert mit float3x3(binormal, tangent, normal)
    vec2 nmga = texture2D(normalsMap, vUv1).ga;
    vec3 tsn;
    tsn.xy = nmga * 2.0 - 1.0;
    tsn.z = sqrt(max(0.0, 1.0 - dot(tsn.xy, tsn.xy)));
    vec3 normal = normalize(
      tsn.x * normalize(vBinormal) +
      tsn.y * normalize(vTangent) +
      tsn.z * normalize(vNormal)
    );

    vec4 albedo = texture2D(albedoMap, vUv0);
    vec4 specular = texture2D(specTeamMap, vUv0);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);

    // Team-Color (mesh.fx): lerp(teamColor, albedo, 1 - specular.a)
    albedo.rgb = mix(teamColor, albedo.rgb, 1.0 - specular.a);

    float dotLightNormal = max(dot(sunDirection, normal), 0.0);
    vec3 light = ambientColor + sunColor * dotLightNormal;

    float phongAmount = clamp(dot(reflect(-sunDirection, normal), viewDir), 0.0, 1.0);
    vec3 phongAdditive = sunColor * 0.5 * pow(phongAmount, 9.0) * specular.g;

    // Environment-Reflexion angenähert (Original: texCUBE * 2 * specular.r)
    float fresnel = pow(1.0 - max(dot(normal, viewDir), 0.0), 2.0);
    vec3 environment = mix(vec3(0.15, 0.17, 0.20), vec3(0.5, 0.55, 0.6), fresnel);
    vec3 phongMultiplicative = 2.0 * environment * specular.r;

    float emissive = glowMultiplier * specular.b;

    vec3 color = albedo.rgb * (emissive + light + phongMultiplicative) + phongAdditive;
    gl_FragColor = vec4(color, 1.0);
  }
`

export interface UnitTextures {
  albedo: THREE.Texture
  normals: THREE.Texture | null
  specTeam: THREE.Texture | null
}

export function createUnitMaterial(
  textures: UnitTextures,
  teamColor: THREE.Color,
  skinMatrices: THREE.Matrix4[],
): THREE.ShaderMaterial {
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 0]), 1, 1)
  white.needsUpdate = true
  const flatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 128]), 1, 1)
  flatNormal.needsUpdate = true

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    defines: { MAX_BONES: Math.max(skinMatrices.length, 1) },
    uniforms: {
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
