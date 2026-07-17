// Terrain skirt (terrain.fx TerrainSkirtVS/PS :534/:584): plain transform,
// the pixel shader is a constant.
void main() {
  gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
