// Glow decal (type 6) -- terrain.fx DecalsPSGlow (:1097-1105) with the
// TDecalsGlow states (:1286-1298): glow = decalAlbedo.a, mask = the second
// texture's .x * 0.25, out = glow * mask * DecalAlpha in every channel,
// AlphaBlend_One_One_Write_A -- added into the frame's ALPHA only, the glow
// buffer the bloom chain reads (bloom.ts); depth LessEqual without write,
// decal bias. An unbound mask sampler reads (0,0,0,1): a glow decal without
// a second texture adds nothing (the tarmacs' Glow entries pass '').
precision highp float;

uniform sampler2D decalAlbedo;
uniform sampler2D decalMask;

varying vec2 vUv;
varying vec3 vWorldPos;
varying float vInstAlpha;
varying float vInstCutoff;

// GetLODAlpha (CWldTerrainDecal, Cfile:1335082-1335114; the batch loops
// 1218082-1218099): with mNearCutoff 0 the alpha fades linearly from 1 at
// cutoff * ren_DecalFadeFraction (0.5, :421725) to 0 at cutoff.
float cfaLodAlpha(float d, float cutoff) {
  if (cutoff <= 0.0) return 1.0;
  float fadeFloor = cutoff * 0.5;
  return clamp(1.0 - (max(d, fadeFloor) - fadeFloor) / (cutoff - fadeFloor), 0.0, 1.0);
}

void main() {
  if (vUv.x < 0.0 || vUv.x > 1.0 || vUv.y < 0.0 || vUv.y > 1.0) discard;
  float decalAlpha = cfaLodAlpha(distance(cameraPosition, vWorldPos), vInstCutoff) * vInstAlpha;
  if (decalAlpha <= 0.0) discard;
  float glow = texture2D(decalAlbedo, vUv).a;
  float mask = texture2D(decalMask, vUv).x * 0.25;
  float a = glow * mask * decalAlpha;
  gl_FragColor = vec4(a, a, a, a);
}
