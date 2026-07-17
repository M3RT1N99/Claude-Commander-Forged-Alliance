// CybranBuildOverlayPS (mesh.fx:2883-2890), pass P1 of CybranBuild
// (SrcAlpha blend): the red scanline overlay from CybranBuildSpecular.dds,
// alpha-masked by a second scrolled sample, fading out in the last 5%.
precision highp float;

uniform sampler2D secondaryMap;
uniform float fraction; // material.y

varying vec2 vUvA;
varying vec2 vUvB;

void main() {
  vec4 secondary = texture2D(secondaryMap, vUvA);
  vec4 alphamask1 = texture2D(secondaryMap, vUvB);
  vec4 color = vec4(secondary.a * 0.75, 0.0, 0.0, alphamask1.r * secondary.a);
  color.a *= (fraction >= 0.95) ? 1.0 - (fraction - 0.95) * 20.0 : 1.0;
  gl_FragColor = color;
}
