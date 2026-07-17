// CybranBuildPS (mesh.fx:2837-2868), pass P0 of technique CybranBuild
// (:5491-5518, SrcAlpha blend): the hologram-like Cybran site — 40%
// visible until 70% complete, then fading solid. Anisotropic highlight
// via the insect lookup (/textures/engine/insectlookup.dds,
// Cfile:1194790), light doubled (2 * sunDiffuse), team color at 90%.
precision highp float;

uniform sampler2D albedoMap;
uniform sampler2D normalsMap;
uniform sampler2D specTeamMap;
uniform sampler2D insectMap; // anisotropic lookup, CLAMP
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

  float dotLightNormal = dot(sunDirection, normal);
  // :2848-2851 — anisotropic lookup indexed by (reflection angle, N.L)
  vec2 anisoLookup =
    vec2(dot(reflect(-sunDirection, normal), viewDir), dotLightNormal);
  vec4 anisoAmount = texture2D(insectMap, anisoLookup);
#ifdef ENVCUBE
  vec3 env = textureCube(environmentMap, reflect(-viewDir, normal)).rgb;
#else
  vec3 env = vec3(0.0);
#endif
  vec3 phongAdditive =
    (anisoAmount.rgb * specular.g + 0.5 * specular.r * env) * (1.0 - specular.a);

  // :2854-2855 — doubled sun term
  vec3 light = 2.0 * sunDiffuse * clamp(dotLightNormal, 0.0, 1.0) + sunAmbient;
  light = lightMultiplier * light + (vec3(1.0) - light) * shadowFill;

  float emissive = glowMultiplier * specular.b;
  vec3 team = teamColor * ((fraction >= 0.9) ? (fraction - 0.9) * 10.0 : 0.0);
  vec3 albedoRgb = mix(team, albedo.rgb, 1.0 - specular.a);

  vec3 color = albedoRgb * (emissive + light) + phongAdditive;

  // :2865 — 40% visible until 70%, then ramp to solid
  float alpha = (fraction >= 0.7) ? 0.4 + 0.6 * ((fraction - 0.7) * 3.33) : 0.4;

  gl_FragColor = vec4(color, alpha);
}
