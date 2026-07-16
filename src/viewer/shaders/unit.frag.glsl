// Port des Original-Unit-Shaders (effects/mesh.fx, NormalMappedPS) aus den
// Spieldaten:
//   - Normal-Map: tangent-space, x/y aus den G/A-Kanälen der DXT5-Textur
//     (`2 * tex.gaa - 1`, z rekonstruiert), gesampelt mit UV1
//   - SpecTeam:  R = Environment-Reflexion, G = Phong-Spekular,
//                B = Glow/Emissive, A = Team-Color-Maske
//   - Team-Color: albedo.rgb = lerp(teamColor, albedo.rgb, 1 - specular.a)
//   - Licht: ComputeLight (mesh.fx:552-560) mit den KARTEN-Werten aus der
//     scmap (SunColor/SunAmbience/LightingMultiplier/ShadowFillColor) —
//     dieselben, mit denen das Terrain rechnet; vorher waren hier erfundene
//     Konstanten, und die Einheiten passten nicht in die Szene ("dunkel/flach").
//   - Phong: NormalMappedPhongCoeff(0.6,0.8,0.9) * pow(phong,2) * spec.g
//     (mesh.fx:97 + 2194) — exakt, nicht "huebsch".
//   - Farbe: albedo * (emissive + licht + envReflexion) + phongAdditive
// Environment-Reflexion (texCUBE, mesh.fx:2186) braucht DDS-Cubemap-Support
// und ist bis dahin 0 — KEIN erfundener Ersatz.

  precision highp float;

  uniform sampler2D albedoMap;
  uniform sampler2D normalsMap;
  uniform sampler2D specTeamMap;
  uniform vec3 teamColor;
  uniform vec3 sunDirection;   // Richtung ZUR Sonne, Weltkoordinaten
  uniform vec3 sunDiffuse;     // scmap SunColor
  uniform vec3 sunAmbient;     // scmap SunAmbience
  uniform vec3 shadowFill;     // scmap ShadowFillColor
  uniform float lightMultiplier; // scmap LightingMultiplier
  uniform float glowMultiplier;  // mesh.fx:56 = 2.0

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

    // ComputeLight (mesh.fx:552-560), Schatten-Attenuation = 1 bis zum
    // Shadow-Map-Pass: dunkle Bereiche werden proportional mit ShadowFill
    // aufgefuellt — so passen Einheiten und Terrain zusammen.
    float dotLightNormal = dot(sunDirection, normal);
    vec3 light = sunDiffuse * clamp(dotLightNormal, 0.0, 1.0) + sunAmbient;
    light = lightMultiplier * light + (vec3(1.0) - light) * shadowFill;

    // mesh.fx:2193-2194: phong = sat(dot(reflect(sun, n), -view)); Additiv =
    // (0.6, 0.8, 0.9) * phong^2 * spec.g. (GLSL-reflect(-sun) * +view ist
    // dieselbe Groesse, nur beidseitig negiert.)
    float phongAmount = clamp(dot(reflect(-sunDirection, normal), viewDir), 0.0, 1.0);
    vec3 phongAdditive = vec3(0.6, 0.80, 0.90) * pow(phongAmount, 2.0) * specular.g;

    // Environment-Reflexion: texCUBE(environmentSampler, reflect(-view, n)) —
    // bis zum Cubemap-Support ehrlich 0 (mesh.fx:2186/2196).
    vec3 phongMultiplicative = vec3(0.0);

    float emissive = glowMultiplier * specular.b;

    vec3 color = albedo.rgb * (emissive + light + phongMultiplicative) + phongAdditive;
    gl_FragColor = vec4(color, 1.0);
  }
