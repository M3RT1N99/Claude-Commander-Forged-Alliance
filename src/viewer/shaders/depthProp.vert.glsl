// Depth pass for instanced map props (depthTechnique 'DepthClip'): the
// alpha-tested foliage needs the albedo UV for the clip in the fragment
// shader. Tree sway is omitted in the shadow pass (the moving shadow of a
// swaying pine is invisible at game zoom).
varying vec2 vUv0;

void main() {
  vUv0 = uv;
  mat4 world = modelMatrix;
#ifdef USE_INSTANCING
  world = modelMatrix * instanceMatrix;
#endif
  gl_Position = projectionMatrix * viewMatrix * world * vec4(position, 1.0);
}
