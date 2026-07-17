// Fullscreen quad for the frame.fx post passes (FIXED_FUNC_VS equivalent).
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
