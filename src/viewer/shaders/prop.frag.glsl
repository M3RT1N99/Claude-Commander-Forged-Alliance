// Port of the prop pixel shaders from effects/mesh.fx. Features render with
// vertex.color = white and material.g = 1 (no team color, fully built), so
// those terms drop out. Variants via defines:
//
//   NORMALMAPPED + PHONG  — NormalMappedPS(false,false,…) (mesh.fx:2170-2209):
//     albedo * (emissive + light + envReflection) + phongAdditive; used by
//     technique NormalMappedAlpha (:4012) and the opaque NormalMapped family.
//   NORMALMAPPED only     — NormalMappedTerrainPS (:2371-2387): normal map,
//     ComputeLight with shadow 1, NO phong/env/emissive (rocks/cliffs).
//   neither               — VertexNormalPS_HighFidelity (:2086-2107):
//     albedo * light with the interpolated vertex normal.
//   ALPHATEST             — AlphaFunc Greater with per-technique alphaRef:
//     0x80 for NormalMappedAlpha (:4031-4033, no blending), 0x23 for
//     VertexNormal (:3941-3943, WITH SrcAlpha/InvSrcAlpha blending — the
//     distant tree-group LODs need both).
//
// LOD: Mesh::ComputeLOD (Mesh.cpp:4688-4724) draws nothing beyond LODCutoff;
// discarding per fragment applies that per INSTANCE at its own distance.
// Environment reflection (texCUBE, mesh.fx:2186) is 0 until DDS cubemap
// support lands — no invented substitute.
precision highp float;

uniform sampler2D albedoMap;
#ifdef NORMALMAPPED
uniform sampler2D normalsMap;
#endif
#ifdef PHONG
uniform sampler2D specTeamMap;
uniform float glowMultiplier; // mesh.fx:56 = 2.0
#ifdef ENVCUBE
uniform samplerCube environmentMap; // map '<default>' env cube (Cfile:1189598)
#endif
#endif
uniform vec3 sunDirection;
uniform vec3 sunDiffuse;      // scmap SunColor
uniform vec3 sunAmbient;      // scmap SunAmbience
uniform vec3 shadowFill;      // scmap ShadowFillColor
uniform float lightMultiplier;
uniform float lodCutoff;      // this LOD's cutoff; 0 = no far limit
uniform float lodNear;        // previous LOD's cutoff; this LOD draws beyond it
#ifdef ALPHATEST
uniform float alphaRef;       // AlphaFunc Greater reference (0-1)
#endif

varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBinormal;
varying vec3 vWorldPos;

void main() {
  // Mesh::ComputeLOD picks the FIRST lod with distance <= cutoff — so this
  // LOD owns the band (lodNear, lodCutoff].
  float lodDist = distance(cameraPosition, vWorldPos);
  if (lodNear > 0.0 && lodDist <= lodNear) discard;
  if (lodCutoff > 0.0 && lodDist > lodCutoff) discard;

  vec4 albedo = texture2D(albedoMap, vUv0);
#ifdef ALPHATEST
  if (albedo.a <= alphaRef) discard;
#endif

#ifdef NORMALMAPPED
  // mesh.fx ComputeNormal: normal.xy from G/A, z reconstructed, rotated
  // with float3x3(binormal, tangent, normal).
  vec2 nmga = texture2D(normalsMap, vUv1).ga;
  vec3 tsn;
  tsn.xy = nmga * 2.0 - 1.0;
  tsn.z = sqrt(max(0.0, 1.0 - dot(tsn.xy, tsn.xy)));
  vec3 normal = normalize(
    tsn.x * normalize(vBinormal) +
    tsn.y * normalize(vTangent) +
    tsn.z * normalize(vNormal)
  );
#else
  vec3 normal = normalize(vNormal);
#endif

  // ComputeLight (mesh.fx:552-560), shadow attenuation 1 until the
  // shadow-map pass exists.
  float dotLightNormal = dot(sunDirection, normal);
  vec3 light = sunDiffuse * clamp(dotLightNormal, 0.0, 1.0) + sunAmbient;
  light = lightMultiplier * light + (vec3(1.0) - light) * shadowFill;

#ifdef PHONG
  vec4 specular = texture2D(specTeamMap, vUv0);
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  // mesh.fx:2193-2194 — NormalMappedPhongCoeff(0.6,0.8,0.9) * phong^2 * spec.g
  float phongAmount = clamp(dot(reflect(-sunDirection, normal), viewDir), 0.0, 1.0);
  vec3 phongAdditive = vec3(0.6, 0.8, 0.9) * pow(phongAmount, 2.0) * specular.g;
  float emissive = glowMultiplier * specular.b;
  // mesh.fx:2186/2195 — 2 * texCUBE(environmentSampler, reflect) * spec.r
#ifdef ENVCUBE
  vec3 phongMultiplicative =
    2.0 * textureCube(environmentMap, reflect(-viewDir, normal)).rgb * specular.r;
#else
  vec3 phongMultiplicative = vec3(0.0);
#endif
  vec3 color = albedo.rgb * (emissive + light + phongMultiplicative) + phongAdditive;
#else
  vec3 color = albedo.rgb * light;
#endif

  // Alpha reaches the blend stage only when the material blends
  // (VertexNormal technique); opaque techniques ignore it.
  gl_FragColor = vec4(color, albedo.a);
}
