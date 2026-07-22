// Shared shadow term, registered as the three.js shader chunk <cfaShadow>
// (see shadow.ts). Port of mesh.fx ComputeShadowPCF (:477-529): five taps
// at (-t/2,0), (0,-t/2), (-t,0), (+t,0), (0,+t) with t = 1/shadowSize,
// each comparing depth + shadowBias > z - 0.001, averaged. Constants from
// the binary: ren_ShadowBias = 0.005, ren_ShadowSize = 1024
// (Cfile:421804/421811). The original maps mShadow with the D3D half-texel
// convention (x+w)*0.5 / (-y+w)*0.5 (NormalMappedVS :951); in GL clip
// space that is xy/w * 0.5 + 0.5 without the y flip.
uniform sampler2D cfaShadowMap;
uniform mat4 cfaShadowMatrix;
uniform float cfaShadowsEnabled;
uniform float cfaShadowSize;

float cfaComputeShadow(vec3 worldPos) {
  if (cfaShadowsEnabled < 0.5) return 1.0;
  vec4 sc = cfaShadowMatrix * vec4(worldPos, 1.0);
  vec2 uv = sc.xy / sc.w * 0.5 + 0.5;
  float z = sc.z / sc.w * 0.5 + 0.5;
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
  float texel = 1.0 / cfaShadowSize;
  float bias = 0.005; // ren_ShadowBias
  float B = z - 0.001;
  float shadow = 0.0;
  shadow += (texture2D(cfaShadowMap, uv + vec2(-texel * 0.5, 0.0)).r + bias > B) ? 1.0 : 0.0;
  shadow += (texture2D(cfaShadowMap, uv + vec2(0.0, -texel * 0.5)).r + bias > B) ? 1.0 : 0.0;
  shadow += (texture2D(cfaShadowMap, uv + vec2(-texel, 0.0)).r + bias > B) ? 1.0 : 0.0;
  shadow += (texture2D(cfaShadowMap, uv + vec2(texel, 0.0)).r + bias > B) ? 1.0 : 0.0;
  shadow += (texture2D(cfaShadowMap, uv + vec2(0.0, texel)).r + bias > B) ? 1.0 : 0.0;
  return shadow * 0.2;
}
