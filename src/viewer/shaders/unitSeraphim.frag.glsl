// Port des Seraphim-Unit-Shaders (mesh.fx, UnitFalloffPS):
// Falloff-Ramp-Lookup über pow(1−N·V, 0.6) (v = fractionComplete = 1),
// Rim-Glow = fallOff.rgb · diffuse.a, Sonnenanteil 0 (shadow=0 im
// Original), Phong (0.5,0.6,0.7)·spec.g⁹, environment = the map's cube map
// reflected off the normal (mesh.fx:2659 texCUBE(environmentSampler,
// reflect(-viewDirection, normal))), scaled by spec.r · fallOff.a
// (mesh.fx:2670). Without a cube map (the unit viewer tool) the term is
// zero, as in unit.frag.glsl -- no invented constant.

  precision highp float;

  uniform sampler2D albedoMap;
  uniform sampler2D normalsMap;
  uniform sampler2D specTeamMap;
  uniform sampler2D lookupMap;
  uniform vec3 sunDirection;
  uniform vec3 sunAmbience;
  uniform vec3 shadowFillColor;
#ifdef ENVCUBE
  uniform samplerCube environmentMap;
#endif

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

    vec4 diffuse = texture2D(albedoMap, vUv0);
    vec4 specular = texture2D(specTeamMap, vUv0);
    vec3 viewDir = normalize(cameraPosition - vWorldPos);

    float ndotv = pow(1.0 - clamp(dot(viewDir, normal), 0.0, 1.0), 0.6);
    vec4 fallOff = texture2D(lookupMap, vec2(ndotv, 1.0));

    float specularAmount = clamp(dot(reflect(-sunDirection, normal), viewDir), 0.0, 1.0);
    vec3 phongAdditive = vec3(0.5, 0.6, 0.7) * pow(specularAmount, 9.0) * specular.g;

    // mesh.fx:2659: environment = texCUBE(environmentSampler,
    // reflect(-viewDirection, normal)); :2670 environment *= spec.r * fallOff.a.
#ifdef ENVCUBE
    vec3 environment = textureCube(environmentMap, reflect(-viewDir, normal)).rgb
      * specular.r * fallOff.a;
#else
    vec3 environment = vec3(0.0);
#endif

    // Original: shadow = 0 -> Sonnenanteil entfällt
    vec3 light = sunAmbience;
    light = light + (1.0 - light) * shadowFillColor;

    vec3 color = diffuse.rgb * light + environment + phongAdditive + fallOff.rgb * diffuse.a;
    // Frame alpha = glow amount (spec.b + glowMinimum)
    gl_FragColor = vec4(color, specular.b + 0.01);
  }
