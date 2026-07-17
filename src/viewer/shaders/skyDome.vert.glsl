// Sky dome vertex shader — port of sky.fx DomeVS (:156-173). The dome
// vertices carry world position + theta (SkyDome::CreateDomeVertexBuffer
// @0x818170: 20-byte layout pos.xyz + theta + pad). The cirrus UVs are
// computed per vertex exactly like computeCirrusCoord (:146-154).
// gl_Position.z is pinned to w so the huge dome (R = scale/cos(subHeight),
// ~7500 m) never hits the far plane; the original just uses a large far.
attribute float theta;

uniform float time; // ticks (tick + interpolant), sky.fx:160
uniform vec2 cirrusFrequency[4];
uniform float cirrusSpeed[4];
uniform vec2 cirrusDirection[4];

varying float vElevation;
varying float vTheta;
varying vec4 vCirrus01; // xy = layer0, zw = layer1
varying vec4 vCirrus23;

vec2 cirrusCoord(vec2 pos, int i) {
  vec2 dir = normalize(cirrusDirection[i]);
  // sky.fx:150-151 (row-vector mul(position, R)):
  // R = [[dx,dy],[dy,-dx]] -> pos' = (p.x*dx + p.y*dy, p.x*dy - p.y*dx)
  vec2 p = vec2(pos.x * dir.x + pos.y * dir.y, pos.x * dir.y - pos.y * dir.x);
  return cirrusFrequency[i] * (p - time * cirrusSpeed[i] * dir);
}

void main() {
  vCirrus01.xy = cirrusCoord(position.xz, 0);
  vCirrus01.zw = cirrusCoord(position.xz, 1);
  vCirrus23.xy = cirrusCoord(position.xz, 2);
  vCirrus23.zw = cirrusCoord(position.xz, 3);
  vElevation = position.y;
  vTheta = theta;
  vec4 clip = projectionMatrix * viewMatrix * vec4(position, 1.0);
  clip.z = clip.w * 0.99999;
  gl_Position = clip;
}
