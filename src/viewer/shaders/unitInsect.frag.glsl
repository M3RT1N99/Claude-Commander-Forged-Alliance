// NormalMappedInsectPS (mesh.fx, technique Insect :5080) — the Cybran unit
// shader: anisotropic highlight from the insect lookup texture
// (/textures/engine/insectlookup.dds, Cfile:1194790) indexed by
// (reflection angle, N.L), phong masked by (1 - spec.a), and a DOUBLED sun
// term. Frame alpha = spec.b + glowMinimum (the glow buffer input).
precision highp float;

uniform sampler2D albedoMap;
uniform sampler2D normalsMap;
uniform sampler2D specTeamMap;
uniform sampler2D insectMap;
#ifdef ENVCUBE
uniform samplerCube environmentMap;
#endif
uniform vec3 teamColor;
uniform vec3 sunDirection;
uniform vec3 sunDiffuse;
uniform vec3 sunAmbient;
uniform vec3 shadowFill;
uniform float lightMultiplier;
uniform float glowMultiplier; // mesh.fx:56 = 2.0

#include <cfaShadow>

varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBinormal;
varying vec3 vWorldPos;

void main() {
  vec2 nmga = texture2D(normalsMap, vUv1).ga;
  vec3 tsn;
  tsn.xy = nmga * 2.0 - 1.0;
  tsn.z = sqrt(max(0.0, 1.0 - dot(tsn.xy, tsn.xy)));
  vec3 normal = normalize(
    tsn.x * normalize(vBinormal) + tsn.y * normalize(vTangent) + tsn.z * normalize(vNormal));

  vec4 albedo = texture2D(albedoMap, vUv0);
  vec4 specular = texture2D(specTeamMap, vUv0);
  vec3 viewDir = normalize(cameraPosition - vWorldPos);

  float dotLightNormal = dot(sunDirection, normal);
  vec2 anisoLookup = vec2(dot(reflect(-sunDirection, normal), viewDir), dotLightNormal);
  vec4 anisoAmount = texture2D(insectMap, anisoLookup);

  albedo.rgb = mix(teamColor, albedo.rgb, 1.0 - specular.a);

#ifdef ENVCUBE
  vec3 env = textureCube(environmentMap, reflect(-viewDir, normal)).rgb;
#else
  vec3 env = vec3(0.0);
#endif
  vec3 phongAdditive =
    (anisoAmount.rgb * specular.g + 0.5 * specular.r * env) * (1.0 - specular.a);

  // doubled sun term
  vec3 light =
    2.0 * sunDiffuse * clamp(dotLightNormal, 0.0, 1.0) * cfaComputeShadow(vWorldPos) + sunAmbient;
  light = lightMultiplier * light + (vec3(1.0) - light) * shadowFill;

  float emissive = glowMultiplier * specular.b;
  vec3 color = albedo.rgb * (emissive + light) + phongAdditive;

  gl_FragColor = vec4(color, specular.b + 0.01);
}
