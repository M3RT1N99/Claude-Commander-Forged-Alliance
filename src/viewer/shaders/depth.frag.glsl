// Depth-only pass: the hardware writes the depth, the color is unused.
precision highp float;
void main() {
  gl_FragColor = vec4(1.0);
}
