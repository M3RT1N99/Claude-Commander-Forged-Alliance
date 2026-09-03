  attribute vec3 scmTangent;
  attribute vec3 scmBinormal;
  attribute vec2 scmUv1;
  attribute float scmBoneIndex;

  uniform mat4 boneMatrices[MAX_BONES];
  // The texture scroll of the entity (mVarDat.mScroll1 -> mScroll2,
  // interpolated per frame) and the LOD's Scrolling flag (mesh.fx anim.w).
  uniform vec2 scroll;
  uniform float scrolling;

  varying vec2 vUv0;
  varying vec2 vUv1;
  varying vec3 vNormal;
  varying vec3 vTangent;
  varying vec3 vBinormal;
  varying vec3 vWorldPos;

  // mesh.fx:438-452 ComputeScrolledTexcoord: the tread bands of the UV
  // layout scroll in U -- texcoord.y > 0.95 by material.z (scroll.x),
  // 0.90 < y <= 0.95 by material.w (scroll.y), on both UV sets (texcoord.x
  // and .z). The band is read from texcoord.y, i.e. the first UV set's V;
  // whether the second set is keyed off its own V is UNVERIFIED (the shader
  // packs both sets into one float4 and tests .y only).
  float scrolledU(float y) {
    if (y > 0.95) return scroll.x;
    if (y > 0.90) return scroll.y;
    return 0.0;
  }

  void main() {
    vUv0 = uv;
    vUv1 = scmUv1;
    if (scrolling > 0.5) {
      float du = scrolledU(uv.y);
      vUv0.x += du;
      vUv1.x += du;
    }

    // FA-Skinning ist rigid: genau ein Bone pro Vertex
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
