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

  precision highp float;

  uniform sampler2D heightTex;
  uniform float heightScale;
  uniform vec2 hmUvScale;
  uniform vec2 hmUvOffset;
  uniform vec2 mapSize;
  uniform vec2 hmTexel;

  uniform sampler2D maskA;
  uniform sampler2D maskB;
  uniform sampler2D lowerAlbedo;
  uniform sampler2D stratum0Albedo;
  uniform sampler2D stratum1Albedo;
  uniform sampler2D stratum2Albedo;
  uniform sampler2D stratum3Albedo;
  uniform sampler2D stratum4Albedo;
  uniform sampler2D stratum5Albedo;
  uniform sampler2D stratum6Albedo;
  uniform sampler2D stratum7Albedo;
  uniform sampler2D upperAlbedo;
  // Kachelfaktor je Lage: worldXZ / scale
  uniform float lowerTile;
  uniform float stratumTile[8];
  uniform float upperTile;
  // 1 = Stratum hat eine Textur; 0 = Maske ignorieren. Wichtig: Karten mit
  // dem alten 4-Lagen-Shader (TTerrain) tragen in der zweiten Maske Junk.
  uniform vec4 stratumEnable0;
  uniform vec4 stratumEnable1;

  uniform sampler2D waterRamp;
  uniform float hasWater;
  uniform float waterElevation;
  uniform float depthToG; // gefittete Skalierung Welttiefe -> Watermap-G

  uniform vec3 sunDirection;
  uniform vec3 sunColor;
  uniform vec3 sunAmbience;
  uniform vec3 shadowFillColor;
  uniform vec4 specularColor;
  uniform float lightingMultiplier;

  varying vec2 vUvMap;
  varying vec3 vWorldPos;

  float height(vec2 uvMap) {
    return texture2D(heightTex, uvMap * hmUvScale + hmUvOffset).r * heightScale;
  }

  void main() {
    // geometrische Normale aus zentralen Differenzen (1 Welt-Einheit je Texel)
    float hl = height(vUvMap - vec2(hmTexel.x, 0.0));
    float hr = height(vUvMap + vec2(hmTexel.x, 0.0));
    float hd = height(vUvMap - vec2(0.0, hmTexel.y));
    float hu = height(vUvMap + vec2(0.0, hmTexel.y));
    vec3 normal = normalize(vec3(hl - hr, 2.0, hd - hu));

    vec2 world = vWorldPos.xz;
    vec4 m0 = clamp(texture2D(maskA, vUvMap) * 2.0 - 1.0, 0.0, 1.0) * stratumEnable0;
    vec4 m1 = clamp(texture2D(maskB, vUvMap) * 2.0 - 1.0, 0.0, 1.0) * stratumEnable1;

    vec4 albedo = texture2D(lowerAlbedo, world / lowerTile);
    albedo = mix(albedo, texture2D(stratum0Albedo, world / stratumTile[0]), m0.x);
    albedo = mix(albedo, texture2D(stratum1Albedo, world / stratumTile[1]), m0.y);
    albedo = mix(albedo, texture2D(stratum2Albedo, world / stratumTile[2]), m0.z);
    albedo = mix(albedo, texture2D(stratum3Albedo, world / stratumTile[3]), m0.w);
    albedo = mix(albedo, texture2D(stratum4Albedo, world / stratumTile[4]), m1.x);
    albedo = mix(albedo, texture2D(stratum5Albedo, world / stratumTile[5]), m1.y);
    albedo = mix(albedo, texture2D(stratum6Albedo, world / stratumTile[6]), m1.z);
    albedo = mix(albedo, texture2D(stratum7Albedo, world / stratumTile[7]), m1.w);
    vec4 upper = texture2D(upperAlbedo, world / upperTile);
    albedo.rgb = mix(albedo.rgb, upper.rgb, upper.a);

    // Licht (terrain.fx TerrainAlbedoXP)
    vec3 viewDir = normalize(vWorldPos - cameraPosition);
    vec3 r = reflect(viewDir, normal);
    vec3 specular = pow(clamp(dot(r, sunDirection), 0.0, 1.0), 80.0)
      * albedo.aaa * specularColor.a * specularColor.rgb;
    float dotSunNormal = max(dot(sunDirection, normal), 0.0);
    vec3 light = sunColor * dotSunNormal + sunAmbience;
    light = lightingMultiplier * light + shadowFillColor * (1.0 - light);
    albedo.rgb = light * (albedo.rgb + specular);

    // Wassertiefen-Tint wie im Original (terrain.fx). Statt des Watermap-
    // G-Kanals nutzen wir die pro Karte gefittete höhenbasierte Tiefe
    // (Regression gegen die gebackene Watermap, R² > 0,99) — identischer
    // Verlauf, aber ohne DXT-Kompressionslöcher und Ufer-Artefakte.
    if (hasWater > 0.5 && vWorldPos.y < waterElevation) {
      float waterDepth = clamp((waterElevation - vWorldPos.y) * depthToG, 0.0, 1.0);
      vec4 water = texture2D(waterRamp, vec2(waterDepth, 0.5));
      albedo.rgb = mix(albedo.rgb, water.rgb, water.a);
    }

    gl_FragColor = vec4(albedo.rgb, 1.0);
  }
