// Port of mesh.fx NormalMappedVS (:927-967) for map props: the per-entity
// world matrix comes from the InstancedMesh attribute instead of the bone
// palette (props are static features — one bone, bindpose, so the raw SCM
// positions ARE the model space the original skins from).
attribute vec3 scmTangent;
attribute vec3 scmBinormal;
attribute vec2 scmUv1;

varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBinormal;
varying vec3 vWorldPos;

void main() {
  vUv0 = uv;
  vUv1 = scmUv1;

  mat4 world = modelMatrix;
#ifdef USE_INSTANCING
  world = modelMatrix * instanceMatrix;
#endif

  // mesh.fx:961-964 — rotate the tangent frame with the world matrix.
  // Prop scale is uniform (scale * UniformScale), so no inverse-transpose
  // is needed; the fragment shader normalizes.
  mat3 nm = mat3(world);
  vNormal = nm * normal;
  vTangent = nm * scmTangent;
  vBinormal = nm * scmBinormal;

  vec4 worldPos = world * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
