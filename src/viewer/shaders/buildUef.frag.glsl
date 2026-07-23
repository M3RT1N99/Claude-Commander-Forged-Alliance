// Port von UEFBuildHiFiPS (effects/mesh.fx:2928-2961), Pass P0 der Technique
// UEFBuild (mesh.fx:5656: AlphaBlend SrcAlpha/InvSrcAlpha, Cull CW,
// PARAM_FRACTIONCOMPLETE — material.y ist der Baufortschritt 0..1,
// material.x das Alter der Unit in Sekunden). Die Baustelle ist blau
// durchscheinend und blendet mit dem Fortschritt zur normalen Farbe.

  precision highp float;

  uniform sampler2D albedoMap;
  uniform sampler2D normalsMap;
  uniform sampler2D specTeamMap;
  uniform sampler2D secondaryMap;  // UEFBuildSpecular.dds (scrollend)
  uniform vec3 teamColor;
  uniform vec3 sunDirection;
  uniform vec3 sunDiffuse;
  uniform vec3 sunAmbient;
  uniform vec3 shadowFill;
  uniform float lightMultiplier;
  uniform float glowMultiplier;   // mesh.fx:56 = 2.0
  uniform float fraction;         // material.y = FractionComplete
  uniform float unitAge;          // material.x = time - creationTime (Sekunden)
  uniform float time;             // Weltzeit in Sekunden (mesh.fx `time`)

  varying vec2 vUv0;
  varying vec2 vUv1;
  varying vec3 vNormal;
  varying vec3 vTangent;
  varying vec3 vBinormal;
  varying vec3 vWorldPos;

  void main() {
    // texcoord2 = texcoord * 5; texcoord2.y += material.x * 0.062 (mesh.fx:2935)
    vec2 texcoord2 = vUv0 * 5.0;
    texcoord2.y += unitAge * 0.062;

    vec4 albedo = texture2D(albedoMap, vUv0);
    vec2 nmga = texture2D(normalsMap, vUv1).ga;
    vec3 tsn;
    tsn.xy = nmga * 2.0 - 1.0;
    tsn.z = sqrt(max(0.0, 1.0 - dot(tsn.xy, tsn.xy)));
    vec3 normal = normalize(
      tsn.x * normalize(vBinormal) +
      tsn.y * normalize(vTangent) +
      tsn.z * normalize(vNormal)
    );
    vec4 specular = texture2D(specTeamMap, vUv0);
    // environment = texCUBE(...) — bis Cubemap-Support ehrlich 0.
    vec3 environment = vec3(0.0);
    vec4 secondary = texture2D(secondaryMap, texcoord2 * 10.0);

    // Teamfarbe blendet erst in den letzten 10 % ein (mesh.fx:2944-2946).
    vec3 team = teamColor * ((fraction >= 0.9) ? (fraction - 0.9) * 10.0 : 0.0);
    vec3 albedoRgb = mix(team, albedo.rgb, 1.0 - specular.a);

    vec3 viewDir = normalize(cameraPosition - vWorldPos);
    // mesh.fx:2947-2949: phong = sat(dot(reflect(sun, n), -view))^8 * spec.g
    float phongAmount = clamp(dot(reflect(-sunDirection, normal), viewDir), 0.0, 1.0);
    vec3 phongAdditive = vec3(pow(phongAmount, 8.0)) * specular.g;
    vec3 phongMultiplicative = 2.0 * environment * specular.r;

    // ComputeLight mit Schatten-Attenuation 1 (bis zum Shadow-Pass).
    vec3 light = sunDiffuse * clamp(dot(sunDirection, normal), 0.0, 1.0) + sunAmbient;
    light = lightMultiplier * light + (vec3(1.0) - light) * shadowFill;

    float emissive = glowMultiplier * specular.b;
    vec3 color = albedoRgb * (emissive + light + phongMultiplicative) + phongAdditive;

    // Der BLAU-PULS (mesh.fx:2956-2958): t pendelt mit frac(0.02*time) in
    // [0.35, 0.7]; die unfertige Farbe ist Richtung Blau verschoben und
    // blendet mit dem Fortschritt zur fertigen.
    float t = min(max(fract(0.02 * time), 0.35), 0.7);
    vec3 current = mix(color + secondary.rgb, vec3(0.0, 0.0, 1.0), t);
    vec3 outColor = mix(current, color, fraction);

    gl_FragColor = vec4(outColor, max(fraction, 0.5));
  }
