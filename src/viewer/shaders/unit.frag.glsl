// Port of the original unit shader (effects/mesh.fx, NormalMappedPS) from the
// Spieldaten:
//   - Normal map: tangent-space, x/y from the G/A channels of the DXT5 texture
//     (`2 * tex.gaa - 1`, z rekonstruiert), gesampelt mit UV1
//   - SpecTeam:  R = Environment-Reflexion, G = Phong-Spekular,
//                B = Glow/Emissive, A = Team-Color-Maske
//   - Team-Color: albedo.rgb = lerp(teamColor, albedo.rgb, 1 - specular.a)
//   - Light: ComputeLight (mesh.fx:552-560) with the MAP values ​​from the
//     scmap (SunColor/SunAmbience/LightingMultiplier/ShadowFillColor) —
//     the same ones that the terrain expects; previously there were invented ones here
//     Constants, and the units didn't fit the scene ("dark/flat").
//   - Phong: NormalMappedPhongCoeff(0.6,0.8,0.9) * pow(phong,2) * spec.g
//     (mesh.fx:97 + 2194) — exact, not “pretty”.
//   - Farbe: albedo * (emissive + licht + envReflexion) + phongAdditive
//   - Environment-Reflexion (texCUBE, mesh.fx:2186/2195): 2 * env * spec.r
//     from the map EnvCube ('<default>' entry; engine default
//     /textures/environment/defaultenvcube.dds, Cfile:1189598). Without
//     loaded cubemap (ENVCUBE define is missing), the term remains 0.

  precision highp float;

  uniform sampler2D albedoMap;
  uniform sampler2D normalsMap;
  uniform sampler2D specTeamMap;
#ifdef ENVCUBE
  uniform samplerCube environmentMap;
#endif
  uniform vec3 teamColor;
  uniform vec3 sunDirection;   // Direction TO the sun, world coordinates
  uniform vec3 sunDiffuse;     // scmap SunColor
  uniform vec3 sunAmbient;     // scmap SunAmbience
  uniform vec3 shadowFill;     // scmap ShadowFillColor
  uniform float lightMultiplier; // scmap LightingMultiplier
  uniform float glowMultiplier;  // mesh.fx:56 = 2.0

#include <cfaShadow>

  varying vec2 vUv0;
  varying vec2 vUv1;
  varying vec3 vNormal;
  varying vec3 vTangent;
  varying vec3 vBinormal;
  varying vec3 vWorldPos;

  void main() {
    // mesh.fx ComputeNormal: normal.xy reconstructed from G/A, z,
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

    // ComputeLight (mesh.fx:552-560), Shadow Attenuation = 1 to
    // Shadow Map Pass: dark areas become proportional with ShadowFill
    // replenished — this is how units and terrain fit together.
    float dotLightNormal = dot(sunDirection, normal);
    vec3 light = sunDiffuse * clamp(dotLightNormal, 0.0, 1.0) * cfaComputeShadow(vWorldPos) + sunAmbient;
    light = lightMultiplier * light + (vec3(1.0) - light) * shadowFill;

    // mesh.fx:2193-2194: phong = sat(dot(reflect(sun, n), -view)); Additiv =
    // (0.6, 0.8, 0.9) * phong^2 * spec.g. (GLSL-reflect(-sun) * +view is
    // same size, just negated on both sides.)
    float phongAmount = clamp(dot(reflect(-sunDirection, normal), viewDir), 0.0, 1.0);
    vec3 phongAdditive = vec3(0.6, 0.80, 0.90) * pow(phongAmount, 2.0) * specular.g;

    // mesh.fx:2186/2195: environment = texCUBE(environmentSampler,
    // reflect(-viewDirection, n)); phongMultiplicative = 2 * env * spec.r.
#ifdef ENVCUBE
    vec3 phongMultiplicative =
      2.0 * textureCube(environmentMap, reflect(-viewDir, normal)).rgb * specular.r;
#else
    vec3 phongMultiplicative = vec3(0.0);
#endif

    float emissive = glowMultiplier * specular.b;

    vec3 color = albedo.rgb * (emissive + light + phongMultiplicative) + phongAdditive;
    // Frame alpha = glow amount (mesh.fx:2202: spec.b + glowMinimum)
    gl_FragColor = vec4(color, specular.b + 0.01);
  }
