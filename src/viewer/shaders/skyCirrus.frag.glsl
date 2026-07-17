// sky.fx CirrusPS (:264-272): four layers from ONE texture, one channel
// each; alpha = cirrusMultiplier * c0.r * c1.g * c2.b * c3.a.
precision highp float;

uniform sampler2D cirrusMap;
uniform float cirrusMultiplier;
uniform vec3 cirrusColor;

varying float vElevation;
varying float vTheta;
varying vec4 vCirrus01;
varying vec4 vCirrus23;

void main() {
  float c0 = texture2D(cirrusMap, vCirrus01.xy).r;
  float c1 = texture2D(cirrusMap, vCirrus01.zw).g;
  float c2 = texture2D(cirrusMap, vCirrus23.xy).b;
  float c3 = texture2D(cirrusMap, vCirrus23.zw).a;
  gl_FragColor = vec4(cirrusColor, cirrusMultiplier * c0 * c1 * c2 * c3);
}
