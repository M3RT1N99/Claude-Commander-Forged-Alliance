// mesh.fx ShieldCybranPS(alpha) (:3145-3189) -- technique ShieldCybran_
// MedFidelity (:6010-6038): two albedo and two specular reads at four UV
// scales, "color wackiness", the health tint (material.y) pulsing with the
// dome's AGE (material.x), a dark floor, and the alpha argument of the pass
// (0.17 for both Med passes) raised by the albedo reds.
precision highp float;

uniform sampler2D albedoMap;
uniform sampler2D specularMap;
uniform float fractionHealth;
uniform float alphaBase;

varying vec4 vTex0;
varying vec4 vTex1;
varying vec3 vNormal;
varying float vAge;

void main() {
  vec4 albedo = texture2D(albedoMap, vTex0.xy);
  vec4 albedo2 = texture2D(albedoMap, vTex0.zw);
  vec3 specular = texture2D(specularMap, vTex1.xy).rgb;
  vec3 specular2 = texture2D(specularMap, vTex1.zw).rgb;

  vec3 color2 = vec3(albedo2.b * specular2.g * 3.0);
  vec3 color3 = vec3(specular2.g * albedo.a);
  vec3 color4 = vec3(((albedo2.g - specular2.b) * specular.b) * albedo.a);
  vec3 finalColor = vec3(0.05, 0.0, 0.3) + color4 - color2 * color3;

  vec3 colorMod1 = mix(vec3(0.2, 0.0, 0.0), finalColor, 0.5);
  colorMod1 = mix(finalColor, (colorMod1 - finalColor) + (color4 + colorMod1), sin(fract(0.06 * vAge) * 3.14));
  finalColor = mix(colorMod1, finalColor, fractionHealth);

  finalColor += (albedo.r + albedo2.r) * 0.1;
  finalColor -= (1.0 - albedo.a);

  float clradd = finalColor.r + finalColor.g + finalColor.b;
  if (clradd < 0.1) {
    finalColor = vec3(0.15, 0.15, 0.3);
  } else if (clradd > 0.1 && clradd < 0.2) {
    finalColor = vec3(specular.b);
  }

  finalColor += (albedo.r + albedo2.r) * vec3(0.0, 0.0, 0.3);

  float alpha = alphaBase + (albedo.r + albedo2.r) * 0.2;
  gl_FragColor = vec4(finalColor, alpha);
}
