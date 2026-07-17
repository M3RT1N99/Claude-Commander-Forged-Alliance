// Shared vertex shader for the faction build techniques (mesh.fx):
//  - AEON_SCALE:     AeonBuildVS (:1286-1327) grows the mesh with
//                    position *= max(fraction, 0.75)
//  - SERAPHIM_SCALE: SeraphimBuildVS grows with 0.25 + fraction * 0.75
//  - neither:        NormalMappedVS (CybranBuild pass P0)
// Rigid FA skinning (one bone per vertex) like unit.vert.glsl.
attribute vec3 scmTangent;
attribute vec3 scmBinormal;
attribute vec2 scmUv1;
attribute float scmBoneIndex;

uniform mat4 boneMatrices[MAX_BONES];
uniform float fraction; // material.y = FractionComplete

varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBinormal;
varying vec3 vWorldPos;

void main() {
  vUv0 = uv;
  vUv1 = scmUv1;

  vec3 pos = position;
#ifdef AEON_SCALE
  pos *= max(fraction, 0.75);
#endif
#ifdef SERAPHIM_SCALE
  pos *= 0.25 + fraction * 0.75;
#endif

  mat4 skin = boneMatrices[int(scmBoneIndex + 0.5)];
  vec4 skinned = skin * vec4(pos, 1.0);
  mat3 skinRot = mat3(skin);

  mat3 nm = mat3(modelMatrix) * skinRot;
  vNormal = nm * normal;
  vTangent = nm * scmTangent;
  vBinormal = nm * scmBinormal;
  vec4 worldPos = modelMatrix * skinned;
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
