// Port von EffectVertexNormalHiFiVS (effects/mesh.fx:1513-1560) mit den
// Parametern des UEFBuild-Overlay-Passes (mesh.fx:5651):
//   texScale0=16, texScale1=8, shift0=(0.0192, 0.0176), shift1=(-0.0122,-0.0122)
// — zwei skalierte, gegenlaeufig scrollende UV-Saetze fuer das Bau-Gitter.
  attribute vec2 scmUv1;
  attribute float scmBoneIndex;

  uniform mat4 boneMatrices[MAX_BONES];
  uniform float unitAge; // material.x = time - creationTime (Sekunden)

  varying vec4 vUvs; // xy = texcoord0*16 + Scroll, zw = texcoord1*8 + Scroll

  void main() {
    mat4 skin = boneMatrices[int(scmBoneIndex + 0.5)];
    vec4 worldPos = modelMatrix * (skin * vec4(position, 1.0));
    gl_Position = projectionMatrix * viewMatrix * worldPos;

    vUvs.xy = uv * 16.0 + unitAge * vec2(0.0192, 0.0176);
    // HLSL: texcoord0.zw += age*xshift1; texcoord0.zw += age*yshift1 —
    // beide Skalare addieren auf BEIDE Komponenten: zusammen -0.0244.
    vUvs.zw = scmUv1 * 8.0 + unitAge * vec2(-0.0244);
  }
