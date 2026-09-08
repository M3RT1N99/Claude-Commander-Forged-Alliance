// SplatsVS (terrain.fx:1372-1411) for the runtime splats (CreateSplat,
// CreateSplatOnBone): the quad's four corners come from the CPU
// (CWldSplat::UpdateVertices, Cfile:1335570-1335625 -- each corner's Y
// read from the heightfield), the UV is the texture rect (the atlas rect
// in the engine, 0..1 here, CWldSplat::UpdateBatchTexture 1335626-1335661),
// the alpha per vertex (mAlpha = a.x: the LOD fade times mCurAlpha in the
// engine's batch loop; here mCurAlpha, the LOD fade is done per pixel).
// mTexWT = the world position (the water depth), mTexSS = the clip
// position (the screen-space normal buffer).
attribute float alpha;
attribute float cutoff;

uniform vec2 mapSize;

varying vec2 vUv;
varying vec2 vUvMap;
varying vec3 vWorldPos;
varying float vAlpha;
varying float vCutoff;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorldPos = world.xyz;
  vUvMap = world.xz / mapSize;
  vUv = uv;
  vAlpha = alpha;
  vCutoff = cutoff;
  gl_Position = projectionMatrix * viewMatrix * world;
}
