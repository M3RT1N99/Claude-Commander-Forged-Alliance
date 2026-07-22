// sky.fx DecalGlowPS (:243-247), pass P1 of the Decal technique
// (AlphaBlend_Disable_Write_A, :310): writes decalGlowMultiplier * glow.a
// into the frame ALPHA — the glow buffer input that makes suns and moons
// bloom. RGB is left untouched via the blend factors (Write_A).
precision highp float;

uniform sampler2D planetGlowAtlas;
uniform float decalGlowMultiplier;

varying vec2 vUv;

void main() {
  float glow = texture2D(planetGlowAtlas, vUv).a;
  gl_FragColor = vec4(0.0, 0.0, 0.0, decalGlowMultiplier * glow);
}
