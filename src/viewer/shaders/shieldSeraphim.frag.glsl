// mesh.fx ShieldSeraphimPS (:3260-3300) -- technique ShieldSeraphim_
// MedFidelity (:6108-6130, ShieldNormalVS, SrcAlpha/One additive, RGB only):
// a tangent-space normal from the normals texture (UV1.zw), a UV address
// from the same texture (UV1.xy) that warps the specular read, a blue tint
// weighted by the square of the normal's up component, and an alpha that
// fades towards the top of the dome (past time_cutoff 0.753 of the
// geometric normal's up component) and with the view angle.
precision highp float;

uniform sampler2D specularMap;
uniform sampler2D normalsMap;

varying vec4 vTex0;
varying vec4 vTex1;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBinormal;
varying vec3 vViewDir;
varying float vAge;

void main() {
  vec4 normal_pixel = texture2D(normalsMap, vTex1.zw);
  mat3 rotationMatrix = mat3(vBinormal, vTangent, vNormal);
  vec3 nt = 2.0 * texture2D(normalsMap, vTex1.zw).gaa - 1.0;
  // sqrt() is rsq + rcp under ps_2_0 and rsq takes the absolute value of
  // its source (D3D9 shader reference, rsq - ps): sqrt(|...|), see shieldUEF.
  nt.z = sqrt(abs(1.0 - nt.x * nt.x - nt.y * nt.y));
  vec3 normal = normalize(rotationMatrix * nt);
  vec4 uvaddress = texture2D(normalsMap, vTex1.xy);
  vec2 texcoord = vTex0.xy + (uvaddress.rb * 0.1);
  vec4 specular = texture2D(specularMap, texcoord);

  float m = abs(normal_pixel.g - 0.5);
  const float max_brightness = 0.453;
  // dot(float4(0,1,0,0), normal) with a float3 normal is its up component.
  float dp = abs(cos(normal.y));
  float channel_color = max_brightness - clamp(1.0 - dp, 0.0, max_brightness);
  float t = abs(dot(vec3(0.0, 1.0, 0.0), normalize(vNormal)));
  const float time_cutoff = 0.753;
  float dp2 = abs(dot(vViewDir, normal));

  if (t < time_cutoff) {
    m = 1.0;
  } else {
    m = 1.0 - 0.7 * (t - time_cutoff) / (1.0 - time_cutoff);
  }

  float alpha = m * (dp2 * 0.3 + channel_color) * 1.75;
  gl_FragColor = vec4(0.425 * dp * dp * specular.r, 0.76274 * dp * dp * specular.g, 1.0 * dp * dp * specular.b, alpha);
}
