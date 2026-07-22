// AeonPS (mesh.fx:2567-2597) — the Aeon unit shader: team color mask,
// AeonPhongCoeff (0.8, 0.85, 1.10, mesh.fx:96) * phong^3 * spec.g,
// environment * spec.r (no 2x), and the 0.6-dimmed light term. Frame
// alpha = spec.b + glowMinimum (the glow buffer input).
precision highp float;

uniform sampler2D albedoMap;
uniform sampler2D normalsMap;
uniform sampler2D specTeamMap;
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

  albedo.rgb = mix(teamColor, albedo.rgb, 1.0 - specular.a);

  // :2581-2585
  float phongAmount = clamp(dot(reflect(-sunDirection, normal), viewDir), 0.0, 1.0);
  vec3 phongAdditive = vec3(0.8, 0.85, 1.10) * pow(phongAmount, 3.0) * specular.g;
#ifdef ENVCUBE
  vec3 phongMultiplicative =
    specular.r * textureCube(environmentMap, reflect(-viewDir, normal)).rgb;
#else
  vec3 phongMultiplicative = vec3(0.0);
#endif

  // :2587-2589 — the Aeon light is dimmed to 0.6
  vec3 light =
    sunDiffuse * clamp(dot(sunDirection, normal), 0.0, 1.0) * cfaComputeShadow(vWorldPos) + sunAmbient;
  light = 0.6 * lightMultiplier * light + (vec3(1.0) - light) * shadowFill;

  float emissive = glowMultiplier * specular.b;
  vec3 color = albedo.rgb * (emissive + light + phongMultiplicative) + phongAdditive;

  gl_FragColor = vec4(color, specular.b + 0.01);
}
