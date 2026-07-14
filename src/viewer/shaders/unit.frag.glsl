// Port des Original-Unit-Shaders (effects/mesh.fx, NormalMappedPS) aus den
// Spieldaten:
//   - Normal-Map: tangent-space, x/y aus den G/A-Kanälen der DXT5-Textur
//     (`2 * tex.gaa - 1`, z rekonstruiert), gesampelt mit UV1
//   - SpecTeam:  R = Environment-Reflexion, G = Phong-Spekular,
//                B = Glow/Emissive, A = Team-Color-Maske
//   - Team-Color: albedo.rgb = lerp(teamColor, albedo.rgb, 1 - specular.a)
//   - Farbe: albedo * (emissive + licht + envReflexion) + phongAdditive
// Environment-Cubemap ist (noch) durch eine Konstante angenähert.

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
