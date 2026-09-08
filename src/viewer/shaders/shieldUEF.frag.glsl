// mesh.fx ShieldPS (:3076-3115) -- technique ShieldUEF_MedFidelity (:5965-
// 5984): the colour mask and the albedo from the albedo texture at two UV
// scales, a normal from the secondary texture (.gaa, z rebuilt), three
// noise layers from the specular texture picking the alpha, the health tint
// (material.y = PARAM_FRACTIONHEALTH) and the mask's alpha against the UV
// pinch at the top of the sphere. `time` is the global shader clock, not
// the age. The mirrored/depth clip of the water reflection is not drawn.
precision highp float;

uniform sampler2D albedoMap;
uniform sampler2D secondaryMap;
uniform sampler2D specularMap;
uniform float time;
uniform float fractionHealth;

varying vec4 vTex0;
varying vec4 vTex1;
varying vec3 vNormal;
varying float vAge;

void main() {
  vec4 colorMask = texture2D(albedoMap, vTex0.xy);
  vec4 albedo = texture2D(albedoMap, vTex0.zw);
  vec3 normal = texture2D(secondaryMap, vTex1.xy).gaa * 2.0 - 1.0;
  // The HLSL takes sqrt(1 - x^2 - y^2) unguarded. Under ps_2_0 sqrt() is
  // rsq + rcp, and rsq "takes the absolute value before processing"
  // (D3D9 shader reference, rsq - ps) -- so a map outside the unit disc
  // (Shield01_Secondary's alpha is 255 everywhere: y = 1) yields
  // sqrt(|1 - x^2 - y^2|), not NaN and not 0. GLSL's sqrt of a negative is
  // undefined, hence the explicit abs.
  normal.z = sqrt(abs(1.0 - normal.x * normal.x - normal.y * normal.y));
  vec3 specular = texture2D(specularMap, vTex1.zw).rgb;

  // mul(albedo.rgr, normal.rgb) is the dot product of the two vectors.
  float d = dot(albedo.rgr, normal.rgb);
  vec4 color = vec4(vec3(d) + vec3(0.0, 0.0, 0.25), 1.0);

  float pulse = sin(fract(0.01 * time) * 3.14);
  if (specular.g <= albedo.r) {
    if (specular.b >= albedo.g) {
      color.a = (color.b >= normal.b) ? 0.12 : mix(0.05, 0.0, pulse);
    } else {
      color.a = (normal.b >= albedo.r) ? 0.2 : mix(0.01, 0.1, pulse);
    }
  } else {
    if (specular.r >= albedo.r) {
      color.a = (specular.b >= albedo.r) ? 0.025 : 0.1;
    } else {
      color.a = (specular.g >= albedo.g) ? 0.02 : mix(0.37, 0.46, pulse);
    }
  }

  color.rgb += vec3(0.0, 0.0, 0.15);

  vec4 colorMod1 = mix(vec4(0.5, 0.0, 0.0, 0.05), color, 0.5);
  colorMod1 = mix(color, colorMod1 + color, sin(fract(0.06 * time) * 3.14));
  color = mix(colorMod1, color, fractionHealth);
  color += colorMask.b * 0.95;

  color.a *= colorMask.a;
  gl_FragColor = color;
}
