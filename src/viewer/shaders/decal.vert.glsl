// Albedo decal patch (terrain.fx DecalsVS :989-1031). The original
// re-rasterizes the terrain grid inside the decal's XZ bounds and projects
// it through DecalMatrix; here each instance is a subdivided unit quad in
// decal space (origin = corner, ProjectDecalBoundsXZ, CWldTerrainDecal.cpp
// :155-183) whose instance matrix is the INVERSE DecalMatrix — the quad
// parameter IS the decal UV, and the height comes from the heightmap
// texture like the terrain itself.
uniform sampler2D heightTex;
uniform float heightScale;
uniform vec2 hmUvScale;
uniform vec2 hmUvOffset;
uniform vec2 mapSize;
uniform float decalHeightOffset; // terrain.fx:987, z-fight offset

varying vec2 vUv;      // decal-local 0..1 (mTexDecal.xz)
varying vec2 vUvMap;   // world / mapSize for the height lookup
varying vec3 vWorldPos;

void main() {
  vec4 world = modelMatrix * instanceMatrix * vec4(position, 1.0);
  vUv = position.xz;
  vUvMap = world.xz / mapSize;
  float h = texture2D(heightTex, vUvMap * hmUvScale + hmUvOffset).r * heightScale;
  world.y = h + decalHeightOffset;
  vWorldPos = world.xyz;
  gl_Position = projectionMatrix * viewMatrix * world;
}
