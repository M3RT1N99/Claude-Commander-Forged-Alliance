// Port des Original-Terrain-Shaders (effects/terrain.fx, TerrainAlbedoXP):
//   - Höhe: Vertex-Displacement aus der Heightmap-Textur (R32F)
//   - Normale: zentrale Differenzen der Heightmap im Fragment-Shader
//   - Splatting: albedo = lower; lerp über Stratum 0-7 mit Masken aus
//     UtilityA/B (saturate(tex*2-1)); Upper über eigenen Alpha
//   - Licht: light = LightingMultiplier*(SunColor*NdotL + SunAmbience)
//            + ShadowFillColor*(1-light); Spekular über albedo.a
//   - Wasser-Tint: WaterRamp-Textur, indiziert über Wassertiefe
//     (UtilityC.g, Original-Formel: albedo = lerp(albedo, ramp.rgb, ramp.a))
// Stratum-Normal-Maps folgen in einem späteren Schritt (die geometrische
// Normale dominiert die Fernansicht).

  uniform sampler2D heightTex;
  uniform float heightScale;
  uniform vec2 hmUvScale;
  uniform vec2 hmUvOffset;

  varying vec2 vUvMap;   // 0..1 über die ganze Karte
  varying vec3 vWorldPos;

  void main() {
    vUvMap = uv;
    float h = texture2D(heightTex, uv * hmUvScale + hmUvOffset).r * heightScale;
    vec3 displaced = vec3(position.x, h, position.z);
    vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
