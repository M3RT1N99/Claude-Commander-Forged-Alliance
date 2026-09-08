// PositionNormalOffsetVS (mesh.fx:1473-1511) for the personal shield shell:
// pass P1 of PhaseShield (:5805-5832) and SeraphimPersonalShield
// (:5837-5867), normalOffset 0.05. Rigid FA skinning like unit.vert.glsl;
// the vertex is pushed out along its normal BEFORE the bone transform --
// `position += normal * 1 / transPalette[bone].w * normalOffset` (:1495),
// transPalette.w being the bone's uniform scale, so the shell sits
// normalOffset world units outside the body whatever the unit's draw
// scale (Display.UniformScale stands in for it here).
attribute float scmBoneIndex;

uniform mat4 boneMatrices[MAX_BONES];
uniform float normalOffset;
uniform float drawScale;

varying vec2 vUv0;

void main() {
  vUv0 = uv;
  vec3 pos = position + normal * (normalOffset / drawScale);
  mat4 skin = boneMatrices[int(scmBoneIndex + 0.5)];
  gl_Position = projectionMatrix * modelViewMatrix * (skin * vec4(pos, 1.0));
}
