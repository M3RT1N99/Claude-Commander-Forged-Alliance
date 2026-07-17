// frame.fx CopyGlowingPS (:332-342): the frame buffer's ALPHA channel is
// the glow amount every mesh.fx shader wrote; copy color * scaled alpha
// into the (half-size) glow buffer. MinimumGlow = 0.02 (:327) reserves the
// bottom of the alpha range for the water mask.
precision highp float;

uniform sampler2D frameTex;
uniform float glowCopyScale; // ren_BloomGlowCopyScale = 2.0
uniform float glowCopyAdd;   // DoBloom amt parameter, 0 by default

varying vec2 vUv;

void main() {
  vec4 c = texture2D(frameTex, vUv);
  c.a = clamp((c.a - 0.02) * glowCopyScale + glowCopyAdd, 0.0, 1.0);
  gl_FragColor = c * c.a;
}
