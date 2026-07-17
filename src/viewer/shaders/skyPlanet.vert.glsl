// sky.fx DecalVS (:175-197): the "planets" are camera-facing billboards.
// Per instance: world position + rotation + size + atlas sub-rect (uv.xy
// offset, uv.zw extent); corner runs -1..1. viewRight/viewUp come from the
// view matrix rows (camera basis in world space).
attribute vec2 corner;
attribute vec4 planetPos;  // xyz world, w rotation
attribute vec2 planetSize;
attribute vec4 planetUv;

varying vec2 vUv;

void main() {
  float s = sin(planetPos.w);
  float c = cos(planetPos.w);

  vUv = planetUv.xy + 0.5 * planetUv.zw * (corner + vec2(1.0, 1.0));
  vUv.y = 1.0 - vUv.y;

  vec2 sc = planetSize * corner;
  vec2 r = vec2(sc.x * c - sc.y * s, sc.x * s + sc.y * c);

  vec3 viewRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 viewUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 world = planetPos.xyz + r.x * viewRight + r.y * viewUp;

  vec4 clip = projectionMatrix * viewMatrix * vec4(world, 1.0);
  clip.z = clip.w * 0.99999;
  gl_Position = clip;
}
