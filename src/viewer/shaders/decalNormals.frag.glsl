// Normals decal (type 2) — terrain.fx DecalsNormalsPS (:1108-1129) with the
// TDecalsNormals states (:1335-1345): SrcAlpha/InvSrcAlpha blend masked to
// RG, depth LessEqual without write, decal rasterizer bias. The pass writes
// into the screen-space normal buffer, NOT the frame.
//
// DXT5nm layout: x in ALPHA, z in GREEN; y (up) is rebuilt. The tangent
// normal is rotated into world space by the decal's Y rotation only
// (TangentMatrix = RotationY(rot.y), CWldTerrainDecal.cpp:797-835) and the
// world x/z components land in the buffer's RG — the same two channels the
// terrain normals pass writes (frame.fx BasisPS rebuilds up on read).
// Alpha (blend factor) = decalRaw.r * decalMask.w * DecalAlpha.
precision highp float;

uniform sampler2D decalNormalTex;
#ifdef HAS_MASK
uniform sampler2D decalMaskTex;
#endif
uniform float cutOffLOD;

varying vec2 vUv;
varying vec3 vWorldPos;
varying vec2 vRotSC; // (cos, sin) of the decal's Y rotation (per instance)
#ifdef INSTANCED_FADE
varying float vInstAlpha;
varying float vInstCutoff;
#endif

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
  float d = distance(cameraPosition, vWorldPos);
#ifdef INSTANCED_FADE
  float decalAlpha = cfaLodAlpha(d, vInstCutoff) * vInstAlpha;
#else
  float decalAlpha = cfaLodAlpha(d, cutOffLOD);
#endif
  if (decalAlpha <= 0.0) discard;

  vec4 raw = texture2D(decalNormalTex, vUv);
  float mask = 1.0;
#ifdef HAS_MASK
  mask = texture2D(decalMaskTex, vUv).a;
#endif

  vec3 n;
  n.xz = raw.ag * 2.0 - 1.0;
  n.y = sqrt(max(0.0, 1.0 - dot(n.xz, n.xz)));

  // RotationY with the same sign convention as the instance matrix
  // (mapDecals builds decal->world as RY(-rot.y); vRotSC carries that
  // angle): x' = c*x + s*z, z' = -s*x + c*z.
  vec2 rot = vec2(
    vRotSC.x * n.x + vRotSC.y * n.z,
    -vRotSC.y * n.x + vRotSC.x * n.z
  );

  // Buffer RG = world X / world Z (the .xzy swizzle of the original with
  // Write_RG masking the rest).
  gl_FragColor = vec4(rot * 0.5 + 0.5, 0.0, raw.r * mask * decalAlpha);
}
