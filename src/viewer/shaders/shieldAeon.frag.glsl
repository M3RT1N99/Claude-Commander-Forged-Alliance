// mesh.fx ShieldAeonPS (:3210-3243) -- technique ShieldAeon_MedFidelity
// (:6063-6082, ShieldNormalVS): a tangent-space normal from the normals
// texture (ComputeNormal :565-570, UV1.zw * 4), a phong term and the map's
// environment cube along the reflected view direction, two specular noise
// layers pulsing with the global clock, the health tint (material.y), and
// an alpha from the environment's brightness plus the albedo's blue band.
// The dotLightNormal and colorMod2 of the HLSL are computed and unused
// there; they are left out. Without an environment cube the reflection is
// black, as a missing cube map would be.
precision highp float;

uniform sampler2D albedoMap;
uniform sampler2D specularMap;
uniform sampler2D normalsMap;
uniform samplerCube environmentMap;
uniform float time;
uniform float fractionHealth;

varying vec4 vTex0;
varying vec4 vTex1;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBinormal;
varying vec3 vViewDir;
varying float vAge;

void main() {
  // float3x3(binormal, tangent, normal) with mul(vector, matrix): the
  // vector's components weight the three rows.
  mat3 rotationMatrix = mat3(vBinormal, vTangent, vNormal);

  vec4 albedo = texture2D(albedoMap, vTex0.xy);
  vec3 specular = texture2D(specularMap, vTex0.zw).rgb;
  vec3 specular2 = texture2D(specularMap, vTex1.xy).rgb;
  vec3 nt = 2.0 * texture2D(normalsMap, vTex1.zw * 4.0).gaa - 1.0;
  // sqrt() is rsq + rcp under ps_2_0 and rsq takes the absolute value of
  // its source (D3D9 shader reference, rsq - ps): sqrt(|...|), see shieldUEF.
  nt.z = sqrt(abs(1.0 - nt.x * nt.x - nt.y * nt.y));
  vec3 normal = normalize(rotationMatrix * nt);

  float phongAmount = clamp(dot(reflect(-vViewDir, normal), vViewDir), 0.0, 1.0) * 0.6;
  vec3 environment = textureCube(environmentMap, reflect(-vViewDir, normal)).rgb;

  vec3 terrainBand = vec3(albedo.b * 0.5);
  vec3 color1 = phongAmount + environment - albedo.ggg;
  vec3 color2 = specular.rrr * mix(0.6, 1.3, sin(fract(0.015 * time) * 3.14));
  vec3 color3 = specular2.rrr * mix(2.0, 2.2, sin(fract(0.0045 * time) * 3.14));

  vec3 finalColor = (color1 * color2) * color3;
  vec3 color4 = (finalColor * normal.rgb) * 0.65 + finalColor;
  finalColor = color4 * environment * albedo.a;

  vec3 colorMod1 = mix(vec3(0.7, 0.3, 0.3), finalColor, 0.9);
  finalColor = mix(colorMod1, finalColor, fractionHealth);

  float alpha = 0.707 * ((environment.r + environment.g + environment.b) * 0.25) + terrainBand.r;
  gl_FragColor = vec4(mix(colorMod1, finalColor, fractionHealth), alpha);
}
