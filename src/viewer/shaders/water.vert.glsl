// water2.fx WaterVS (:294-327): the water plane sits at WaterElevation and
// carries four scrolling wave-layer UVs (world XZ + movement * Time, times
// the per-layer repeat rate) plus the view vector and the 0..1 map UV for
// the baked water texture (UtilitySamplerC).
uniform vec2 mapSize;
uniform float time;
uniform vec2 waveMovement[4];
uniform vec4 waveRepeat;

varying vec2 vUvMap;
varying vec2 vLayer0;
varying vec2 vLayer1;
varying vec2 vLayer2;
varying vec2 vLayer3;
varying vec3 vViewVec;
varying vec3 vWorldPos;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vUvMap = world.xz / mapSize;

  vLayer0 = (world.xz + waveMovement[0] * time) * waveRepeat.x;
  vLayer1 = (world.xz + waveMovement[1] * time) * waveRepeat.y;
  vLayer2 = (world.xz + waveMovement[2] * time) * waveRepeat.z;
  vLayer3 = (world.xz + waveMovement[3] * time) * waveRepeat.w;

  vViewVec = world.xyz - cameraPosition;

  gl_Position = projectionMatrix * viewMatrix * world;
}
