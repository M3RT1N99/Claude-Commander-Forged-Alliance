// TerrainSkirtPS (terrain.fx:584-587): constant dark grey apron around the
// map — the bound SkirtTexture is legacy and never sampled.
void main() {
  gl_FragColor = vec4(0.1, 0.1, 0.1, 0.0);
}
