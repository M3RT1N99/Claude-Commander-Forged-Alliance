// Depth pass for skinned unit meshes (depthTechnique 'Depth'): position
// only, rigid FA skinning like unit.vert.glsl.
attribute float scmBoneIndex;

uniform mat4 boneMatrices[MAX_BONES];

void main() {
  mat4 skin = boneMatrices[int(scmBoneIndex + 0.5)];
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * (skin * vec4(position, 1.0));
}
