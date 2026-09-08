// The shield dome vertex shaders of mesh.fx, one source with three shapes:
//   FourUVTexShiftScaleVS      (:1614-1671)  ShieldUEF, ShieldCybran pass 0
//   ShieldNormalVS             (:1673-1737)  ShieldAeon, ShieldSeraphim (NORMALMAPPED)
//   ShieldPositionNormalOffsetVS (:1739-1801) ShieldCybran pass 1 (NORMAL_OFFSET)
// All three take ONE texcoord and make four UV sets of it: texcoord0.xy/.zw
// and texcoord1.xy/.zw, each scaled by texScaleN and shifted by
// (time - material.x) * texXshiftN / texYshiftN -- material.x is the mesh
// instance's creation tick, so the shift grows with the dome's age. `time`
// is game ticks + the frame's beat fraction (MeshRenderer::Batch,
// Cfile:1212805-1212810), not seconds.
// A shield mesh has no bones: ComputeWorldMatrix is the model matrix.

uniform float time;
uniform float creationTime;
uniform vec4 texScale;
uniform vec4 texShiftA;
uniform vec4 texShiftB;
#ifdef NORMAL_OFFSET
// position += normal * 1 / transPalette[bone].w * normalOffset (:1765):
// transPalette.w is the bone's scale, here the uniform draw scale -- the
// shell sits normalOffset world units outside the dome whatever its size.
uniform float normalOffset;
uniform float drawScale;
#endif

varying vec4 vTex0;
varying vec4 vTex1;
varying vec3 vNormal;
varying float vAge;
#ifdef NORMALMAPPED
attribute vec3 scmTangent;
attribute vec3 scmBinormal;
varying vec3 vTangent;
varying vec3 vBinormal;
varying vec3 vViewDir;
#endif

void main() {
  vec3 pos = position;
#ifdef NORMAL_OFFSET
  pos += normal * (1.0 / drawScale) * normalOffset;
#endif
  vec4 world = modelMatrix * vec4(pos, 1.0);
  // The clip position through three.js's CPU-side modelViewMatrix, the same
  // expression for the depth shell (ShieldFill) and the dome: the dome's
  // Depth_Enable_LessEqual test only passes against the shell's depth when
  // both rasterise bit-identical z -- a different matrix order would z-fight.
  vec4 clip = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  gl_Position = clip;
  vNormal = normalize(mat3(modelMatrix) * normal);
  float age = time - creationTime;
  vAge = age;
  vTex0 = vec4(uv, uv);
  vTex1 = vec4(uv, uv);
  vTex0.xy *= texScale.x;
  vTex0.zw *= texScale.y;
  vTex1.xy *= texScale.z;
  vTex1.zw *= texScale.w;
  vTex0.x += age * texShiftA.x;
  vTex0.y += age * texShiftA.y;
  vTex0.z += age * texShiftA.z;
  vTex0.w += age * texShiftA.w;
  vTex1.x += age * texShiftB.x;
  vTex1.y += age * texShiftB.y;
  vTex1.z += age * texShiftB.z;
  vTex1.w += age * texShiftB.w;
#ifdef NORMALMAPPED
  vTangent = normalize(mat3(modelMatrix) * scmTangent);
  vBinormal = normalize(mat3(modelMatrix) * scmBinormal);
  // ShieldNormalVS:1700-1701: viewDirection = normalize(position.xyz / w)
  // of the CLIP position, then mul(viewMatrix, viewDirection) -- the view
  // matrix's 3x3 applied to that clip-space direction, reproduced as is.
  vec3 vd = normalize(clip.xyz / clip.w);
  vViewDir = mat3(viewMatrix) * vd;
#endif
}
