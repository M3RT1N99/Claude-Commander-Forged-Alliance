  attribute vec3 scmTangent;
  attribute vec3 scmBinormal;
  attribute vec2 scmUv1;
  attribute float scmBoneIndex;

  uniform mat4 boneMatrices[MAX_BONES];

  varying vec2 vUv0;
  varying vec2 vUv1;
  varying vec3 vNormal;
  varying vec3 vTangent;
  varying vec3 vBinormal;
  varying vec3 vWorldPos;

  void main() {
    vUv0 = uv;
    vUv1 = scmUv1;

    // FA skinning is rigid: exactly one bone per vertex
    mat4 skin = boneMatrices[int(scmBoneIndex + 0.5)];
    vec4 skinned = skin * vec4(position, 1.0);
    mat3 skinRot = mat3(skin);

    mat3 nm = mat3(modelMatrix) * skinRot;
    vNormal = nm * normal;
    vTangent = nm * scmTangent;
    vBinormal = nm * scmBinormal;
    vec4 worldPos = modelMatrix * skinned;
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
