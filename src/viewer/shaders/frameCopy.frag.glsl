// frame.fx FixedPS (:159-166): plain blit of the scene render target onto
// the back buffer (technique TFrame); the glow buffer follows additively
// (technique TFrameAdd, One/One).
precision highp float;

uniform sampler2D frameTex;

varying vec2 vUv;

void main() {
  gl_FragColor = vec4(texture2D(frameTex, vUv).rgb, 1.0);
}
