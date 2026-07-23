// Reading side of the screen-space normal buffer — the deferred normal
// chain of the original: TerrainNormalsPS (terrain.fx:591) writes the
// blended stratum normal, TDecalsNormals (:1335, Write_RG) blends decal
// normals in, and frame.fx BasisPS (:279-320) rotates the two stored
// tangent components into the terrain frame. TerrainPS/DecalsPS then read
// it via SampleScreen(NormalSampler, mTexSS) (:706/1178).
//
// Callers must define height(vec2 uvMap) BEFORE including this chunk.
uniform sampler2D cfaNormalBuffer;
uniform vec2 cfaNormalBufferSize;

vec3 cfaWorldNormal(vec2 uvMap, vec2 texel) {
  // Base normal from central differences — the TerrainBasisPS source.
  float nbHl = height(uvMap - vec2(texel.x, 0.0));
  float nbHr = height(uvMap + vec2(texel.x, 0.0));
  float nbHd = height(uvMap - vec2(0.0, texel.y));
  float nbHu = height(uvMap + vec2(0.0, texel.y));
  vec3 baseNormal = normalize(vec3(nbHl - nbHr, 2.0, nbHd - nbHu));

  // The buffer carries only n.xy (channels = world X / world Z); the up
  // component is rebuilt — frame.fx BasisPS, bit for bit.
  vec2 nxy = texture2D(cfaNormalBuffer, gl_FragCoord.xy / cfaNormalBufferSize).xy * 2.0 - 1.0;
  vec3 screenNormal;
  screenNormal.x = nxy.x;
  screenNormal.z = nxy.y;
  screenNormal.y = sqrt(max(0.0, 1.0 - dot(nxy, nxy)));
  vec3 h = normalize(baseNormal + vec3(0.0, 1.0, 0.0));
  vec3 xaxis = h.x * h.xyz * vec3(-2.0, 2.0, -2.0) + vec3(1.0, 0.0, 0.0);
  vec3 yaxis = baseNormal;
  vec3 zaxis = h.z * h.xyz * vec3(-2.0, 2.0, -2.0) + vec3(0.0, 0.0, 1.0);
  return normalize(vec3(
    dot(screenNormal, xaxis),
    dot(screenNormal, yaxis),
    dot(screenNormal, zaxis)
  ));
}
