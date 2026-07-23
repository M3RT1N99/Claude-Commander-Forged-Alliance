// Port von WreckagePS (effects/mesh.fx:2334-2356): Albedo der Unit, darueber
// das Wrack-Noise (/env/common/props/wreckage_noise.dds als Specular-Sampler,
// UV * 5.15, verschoben um frac(0.01 * Erstellungszeit) — depth.y ist im
// WreckageVS material.x, die creation time). Wracks empfangen KEINE Schatten
// (Kommentar im Original: "the crunchiness makes for bad artifacts"), keine
// Team-Farbe, kein Phong. Alpha = glowMinimum (mesh.fx:57 = 0.010).

  precision highp float;

  uniform sampler2D albedoMap;
  uniform sampler2D normalsMap;
  uniform sampler2D specularMap;  // wreckage_noise.dds
  uniform vec3 sunDirection;
  uniform vec3 sunDiffuse;        // scmap SunColor
  uniform vec3 sunAmbient;        // scmap SunAmbience
  uniform vec3 shadowFill;        // scmap ShadowFillColor
  uniform float lightMultiplier;  // scmap LightingMultiplier
  uniform float creationTime;     // Sekunden — mesh.fx: material.x

  varying vec2 vUv0;
  varying vec2 vUv1;
  varying vec3 vNormal;
  varying vec3 vTangent;
  varying vec3 vBinormal;
  varying vec3 vWorldPos;

  void main() {
    // ComputeNormal (mesh.fx): normal.xy aus G/A, z rekonstruiert
    vec2 nmga = texture2D(normalsMap, vUv1).ga;
    vec3 tsn;
    tsn.xy = nmga * 2.0 - 1.0;
    tsn.z = sqrt(max(0.0, 1.0 - dot(tsn.xy, tsn.xy)));
    vec3 normal = normalize(
      tsn.x * normalize(vBinormal) +
      tsn.y * normalize(vTangent) +
      tsn.z * normalize(vNormal)
    );
    float dotLightNormal = dot(sunDirection, normal);

    vec4 albedo = texture2D(albedoMap, vUv0);
    vec2 texcoord = vUv0;
    texcoord.y -= fract(0.01 * creationTime);
    texcoord.x += fract(0.01 * creationTime);
    vec4 specular = texture2D(specularMap, texcoord * 5.15);

    // ComputeLight (mesh.fx:552-560) mit Attenuation 1 — Wracks ohne Schatten.
    vec3 light = sunDiffuse * clamp(dotLightNormal, 0.0, 1.0) + sunAmbient;
    light = lightMultiplier * light + (vec3(1.0) - light) * shadowFill;
    vec3 color = albedo.rgb * light;

    // mesh.fx:2349-2352 — woertlich (HLSL float4-Arithmetik: albedo + skalar).
    if (specular.g < 0.22) {
      color *= (albedo.rgb + vec3(specular.r + specular.a)) * specular.b * 2.5;
    } else {
      color *= specular.b * 2.0;
    }

    gl_FragColor = vec4(color, 0.01); // glowMinimum
  }
