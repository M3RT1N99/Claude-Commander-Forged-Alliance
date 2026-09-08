// PhaseShieldPS (mesh.fx:3348-3369) and SeraphimPhaseShieldPS (:3371-3392):
// the same arithmetic, the Seraphim one reading secondarySampler where the
// other reads lookupSampler -- one shader, the caller binds the texture
// (the mesh blueprint's LookupName resp. SecondaryName). Three samples of
// that one lookup at three scales, each scrolled by the age (material.x =
// time - creation tick, in game ticks), make the electricity and the
// pulse; no albedo, no light, no team colour.
precision highp float;

uniform sampler2D lookupMap;
uniform float unitAge;

varying vec2 vUv0;

void main() {
  vec2 tc1 = vUv0 * 0.5;
  tc1.x += 0.005 * unitAge;
  tc1.y += 0.02 * unitAge;
  vec4 lookup = texture2D(lookupMap, tc1);

  vec2 tc2 = vUv0 * 4.0;
  tc2.y += 0.008 * unitAge;
  tc2.x -= 0.008 * unitAge;
  vec4 lookup2 = texture2D(lookupMap, tc2);

  vec2 tc3 = vUv0 * 0.01;
  tc3.x -= 0.0018 * unitAge;
  vec4 lookup3 = texture2D(lookupMap, tc3);

  float electricity = lookup.r * lookup2.b;
  vec4 baseshellcolor = vec4(0.5, 0.5, 1.0, 1.0);
  vec4 glowpulse = vec4(lookup3.ggg, min(lookup3.g, 0.65) + electricity);

  gl_FragColor = (baseshellcolor + electricity) * glowpulse;
}
