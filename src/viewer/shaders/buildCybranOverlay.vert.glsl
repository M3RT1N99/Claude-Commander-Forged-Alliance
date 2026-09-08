// EffectVertexNormalLoFiVS (mesh.fx:1562-1609) with the CybranBuild
// overlay parameters (:5515): texScale0 = 14, texScale1 = 4, shift0 = 0,
// shift1 = (-0.008, 0.008) * age — the second UV set scrolls.
attribute vec2 scmUv1;
attribute float scmBoneIndex;

uniform mat4 boneMatrices[MAX_BONES];
uniform float unitAge; // material.x = time - creation tick (game ticks)

varying vec2 vUvA; // texcoord0 * 14
varying vec2 vUvB; // texcoord0 * 4 + age * (-0.008, 0.008)

void main() {
  mat4 skin = boneMatrices[int(scmBoneIndex + 0.5)];
  vec4 worldPos = modelMatrix * (skin * vec4(position, 1.0));
  gl_Position = projectionMatrix * viewMatrix * worldPos;

  vUvA = uv * 14.0;
  vUvB = uv * 4.0 + unitAge * vec2(-0.008, 0.008);
}
