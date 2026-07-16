// Port von WreckageVS_HighFidelity (effects/mesh.fx:1153-1203): das Wrack ist
// das Unit-Mesh, im Vertex-Shader VERBEULT — sin/cos-Deformation der
// Weltposition, Phase aus der Objekt-Weltposition (HLSL: row3 der
// Bone-Weltmatrix; hier modelMatrix[3], dieselbe Groesse).
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

    // FA-Skinning ist rigid: genau ein Bone pro Vertex
    mat4 skin = boneMatrices[int(scmBoneIndex + 0.5)];
    vec4 skinned = skin * vec4(position, 1.0);
    mat3 skinRot = mat3(skin);

    mat3 nm = mat3(modelMatrix) * skinRot;
    vNormal = nm * normal;
    vTangent = nm * scmTangent;
    vBinormal = nm * scmBinormal;

    vec4 worldPos = modelMatrix * skinned;

    // mesh.fx:1175-1182 — woertlich. HLSL `float s = nvert * 0.15` trunkiert
    // den Vektor auf die x-Komponente; `r` ist der Abstand vom WELT-Ursprung,
    // `phi` die Phase aus der Objektposition (length(row3)).
    vec3 nvert = normalize(worldPos.xyz);
    float s = nvert.x * 0.15;
    float r = length(worldPos.xyz);
    float phi = fract(0.01 * length(modelMatrix[3].xyz));
    worldPos.x += sin(14.5 * r * nvert.z + phi) * s;
    worldPos.y += cos(10.8 * r * nvert.x + phi) * s;
    worldPos.z += sin(20.5 * r * nvert.y + phi) * s;

    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
