// AeonBuildPS (mesh.fx:2713-2746), pass P0 of technique AeonBuild
// (:5349-5366, blending DISABLED — the growing shell is opaque):
// normal-mapped lighting with light = 0.6 * lightMultiplier * light +
// (1-light) * shadowFill, phong^8 * spec.g, environment * spec.r, team
// color fading in at 90%. Alpha = spec.b + glowMinimum feeds the bloom
// pass (H2) and is ignored until then.
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
uniform float fraction;       // material.y = FractionComplete

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

  // Team color fades in at 90% complete (:2727-2729)
  vec3 team = teamColor * ((fraction >= 0.9) ? (fraction - 0.9) * 10.0 : 0.0);
  vec3 albedoRgb = mix(team, albedo.rgb, 1.0 - specular.a);

  // :2731-2734 — phong^8 * spec.g, environment * spec.r (no 2x here)
  float phongAmount = clamp(dot(reflect(-sunDirection, normal), viewDir), 0.0, 1.0);
  vec3 phongAdditive = vec3(pow(phongAmount, 8.0)) * specular.g;
#ifdef ENVCUBE
  vec3 phongMultiplicative =
    specular.r * textureCube(environmentMap, reflect(-viewDir, normal)).rgb;
#else
  vec3 phongMultiplicative = vec3(0.0);
#endif

  // :2737-2738 — the Aeon build light is dimmed to 0.6
  vec3 light = sunDiffuse * clamp(dot(sunDirection, normal), 0.0, 1.0) + sunAmbient;
  light = 0.6 * lightMultiplier * light + (vec3(1.0) - light) * shadowFill;
  float emissive = glowMultiplier * specular.b;

  vec3 color = albedoRgb * (emissive + light + phongMultiplicative) + phongAdditive;
  gl_FragColor = vec4(color, 1.0);
}
