// sky.fx DecalAlbedoPS (:238-241): plain atlas sample, SrcAlpha blend.
// The glow pass P1 (DecalGlowPS, Write_A only) feeds the bloom pass and
// stays open until H2 exists.
precision highp float;

uniform sampler2D planetAtlas;

varying vec2 vUv;

void main() {
  gl_FragColor = texture2D(planetAtlas, vUv);
}
