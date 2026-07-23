// Port of the original terrain shader (effects/terrain.fx, TerrainAlbedoXP):
//   - Height: Vertex displacement from the heightmap texture (R32F)
//   - Normals: central differences of the heightmap in the fragment shader
//   - Splatting: albedo = lower; lerp over stratum 0-7 with masks off
//     UtilityA/B (saturate(tex*2-1)); Upper über eigenen Alpha
//   - Licht: light = LightingMultiplier*(SunColor*NdotL + SunAmbience)
//            + ShadowFillColor*(1-light); Spekular über albedo.a
//   - Wasser-Tint: WaterRamp-Textur, indiziert über Wassertiefe
//     (UtilityC.g, original formula: albedo = lerp(albedo, ramp.rgb, ramp.a))
// Stratum normal maps follow in a later step (the geometric
// Normal dominates the distance view).

  uniform sampler2D heightTex;
  uniform float heightScale;
  uniform vec2 hmUvScale;
  uniform vec2 hmUvOffset;

  varying vec2 vUvMap;   // 0..1 across the whole map
  varying vec3 vWorldPos;

  void main() {
    vUvMap = uv;
    float h = texture2D(heightTex, uv * hmUvScale + hmUvOffset).r * heightScale;
    vec3 displaced = vec3(position.x, h, position.z);
    vec4 worldPos = modelMatrix * vec4(displaced, 1.0);
    vWorldPos = worldPos.xyz;
    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
