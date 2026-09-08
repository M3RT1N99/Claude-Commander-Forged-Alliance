// Port of the original terrain shaders (effects/terrain.fx), variant chosen
// by the scmap terrainShader string (across the 60 retail maps: TTerrain 39,
// TTerrainXP 20, TTerrainGlow 1):
//   - height: vertex displacement from the heightmap texture (R32F)
//   - base normal: central differences of the heightmap (the original bakes
//     the same geometry normal into the embedded map normal texture and
//     reads it back in TerrainBasisPS)
//   - stratum normals: TerrainNormalsPS (:591, strata 0-3) / TerrainNormalsXP
//     (:613, strata 0-7) — RAW masks (no *2-1), lerp chain over tex*2-1,
//     channels R=world X, G=world Z; then rotated into the terrain frame
//     with the exact BasisPS math (frame.fx:279-320)
//   - TTerrain light: CalculateLighting (terrain.fx:370-394) — specular is
//     added INTO the light term, color = light * albedo
//   - TTerrainXP light (XP define): TerrainAlbedoXP (:724-769) — spec from
//     albedo.a, color = light * (albedo + spec)
//   - GLOW define (TTerrainGlow, :772): stratum1 albedo scrolls with
//     offset = sincos(Time*0.125)*0.01 (:510-514); the glow ALPHA output
//     has no consumer until the bloom pass (H2) exists
//   - water tint: WaterRamp indexed by water depth (per-map depth fit
//     against the baked watermap G channel, R^2 > 0.99)

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
#ifdef XP
  uniform sampler2D stratum4Albedo;
  uniform sampler2D stratum5Albedo;
  uniform sampler2D stratum6Albedo;
  uniform sampler2D stratum7Albedo;
#endif
  uniform sampler2D upperAlbedo;
  // Tile factor per layer: worldXZ / scale
  uniform float lowerTile;
  uniform float stratumTile[8];
  uniform float upperTile;
  // 1 = stratum has a texture; 0 = ignore the mask (empty path in the
  // scmap — otherwise the mask would blend in a dummy texture).
  uniform vec4 stratumEnable0;
  uniform vec4 stratumEnable1;

  // Stratum normal maps (terrain.fx TerrainNormalsPS/XP): lower + strata,
  // same masks as the albedos but sampled RAW.
  uniform sampler2D lowerNormalMap;
  uniform sampler2D stratum0Normal;
  uniform sampler2D stratum1Normal;
  uniform sampler2D stratum2Normal;
  uniform sampler2D stratum3Normal;
#ifdef XP
  uniform sampler2D stratum4Normal;
  uniform sampler2D stratum5Normal;
  uniform sampler2D stratum6Normal;
  uniform sampler2D stratum7Normal;
#endif
  uniform float lowerNormalTile;
  uniform float stratumNormalTile[8];
  uniform vec4 normalEnable0;
  uniform vec4 normalEnable1;

  uniform sampler2D waterRamp;
  uniform float hasWater;
  uniform float waterElevation;
  uniform float depthToG; // fitted scale world depth -> watermap G

  uniform vec3 sunDirection;
  uniform vec3 sunColor;
  uniform vec3 sunAmbience;
  uniform vec3 shadowFillColor;
  uniform vec4 specularColor;
  uniform float lightingMultiplier;
#ifdef GLOW
  uniform float time; // terrain.fx Time: game ticks + beat fraction — drives the stratum1 UV scroll
#endif

#include <cfaShadow>

  varying vec2 vUvMap;
  varying vec3 vWorldPos;

  float height(vec2 uvMap) {
    return texture2D(heightTex, uvMap * hmUvScale + hmUvOffset).r * heightScale;
  }

#ifndef NORMALS_PASS
// The deferred normal chain of the original: this pass READS the
// screen-space buffer the NORMALS_PASS variant (+ normals decals) wrote.
#include <cfaNormalBuffer>
#endif

  void main() {
    vec2 world = vWorldPos.xz;

#ifdef NORMALS_PASS
    // --- TerrainNormalsPS/XP (:591/:613): blend the stratum normal maps with
    // the SAME masks as the albedos (render-details.md:148) and write the two
    // tangent components into RG — the screen-space normal buffer the normals
    // decals then blend into (TDecalsNormals, Write_RG). The UtilityTexture
    // masks are always decoded saturate(tex*2-1) (FORMATS.md:86); using the raw
    // texel blended stratum normals in at ~50% everywhere (neutral level 0.5).
    vec4 mn0 = clamp(texture2D(maskA, vUvMap) * 2.0 - 1.0, 0.0, 1.0) * normalEnable0;
    vec4 n = texture2D(lowerNormalMap, world / lowerNormalTile) * 2.0 - 1.0;
    n = mix(n, texture2D(stratum0Normal, world / stratumNormalTile[0]) * 2.0 - 1.0, mn0.x);
    n = mix(n, texture2D(stratum1Normal, world / stratumNormalTile[1]) * 2.0 - 1.0, mn0.y);
    n = mix(n, texture2D(stratum2Normal, world / stratumNormalTile[2]) * 2.0 - 1.0, mn0.z);
    n = mix(n, texture2D(stratum3Normal, world / stratumNormalTile[3]) * 2.0 - 1.0, mn0.w);
#ifdef XP
    vec4 mn1 = clamp(texture2D(maskB, vUvMap) * 2.0 - 1.0, 0.0, 1.0) * normalEnable1;
    n = mix(n, texture2D(stratum4Normal, world / stratumNormalTile[4]) * 2.0 - 1.0, mn1.x);
    n = mix(n, texture2D(stratum5Normal, world / stratumNormalTile[5]) * 2.0 - 1.0, mn1.y);
    n = mix(n, texture2D(stratum6Normal, world / stratumNormalTile[6]) * 2.0 - 1.0, mn1.z);
    n = mix(n, texture2D(stratum7Normal, world / stratumNormalTile[7]) * 2.0 - 1.0, mn1.w);
#endif
    n.xyz = normalize(n.xyz);
    gl_FragColor = vec4(n.xy * 0.5 + 0.5, 0.0, 1.0);
  }
#else
    // Normal from the buffer (stratum normals + normals decals), rotated
    // into the terrain frame — frame.fx BasisPS via the shared chunk.
    vec3 normal = cfaWorldNormal(vUvMap, hmTexel);

    // --- albedo splat (masks saturate(tex*2-1) here, unlike the normal pass)
    vec4 m0 = clamp(texture2D(maskA, vUvMap) * 2.0 - 1.0, 0.0, 1.0) * stratumEnable0;

    vec4 albedo = texture2D(lowerAlbedo, world / lowerTile);
    albedo = mix(albedo, texture2D(stratum0Albedo, world / stratumTile[0]), m0.x);
#ifdef GLOW
    // TerrainGlowPS (:779-783): stratum1 scrolls with sincos(Time*0.125)*0.01;
    // its alpha is zeroed (no specular from the lava layer).
    vec2 glowOffset = vec2(sin(time * 0.125), cos(time * 0.125)) * 0.01;
    vec4 s1 = texture2D(stratum1Albedo, world / stratumTile[1] + glowOffset);
    s1.a = 0.0;
    albedo = mix(albedo, s1, m0.y);
#else
    albedo = mix(albedo, texture2D(stratum1Albedo, world / stratumTile[1]), m0.y);
#endif
    albedo = mix(albedo, texture2D(stratum2Albedo, world / stratumTile[2]), m0.z);
    albedo = mix(albedo, texture2D(stratum3Albedo, world / stratumTile[3]), m0.w);
#ifdef XP
    vec4 m1 = clamp(texture2D(maskB, vUvMap) * 2.0 - 1.0, 0.0, 1.0) * stratumEnable1;
    albedo = mix(albedo, texture2D(stratum4Albedo, world / stratumTile[4]), m1.x);
    albedo = mix(albedo, texture2D(stratum5Albedo, world / stratumTile[5]), m1.y);
    albedo = mix(albedo, texture2D(stratum6Albedo, world / stratumTile[6]), m1.z);
    albedo = mix(albedo, texture2D(stratum7Albedo, world / stratumTile[7]), m1.w);
#endif
    vec4 upper = texture2D(upperAlbedo, world / upperTile);
    albedo.rgb = mix(albedo.rgb, upper.rgb, upper.a);

    vec3 viewDir = normalize(vWorldPos - cameraPosition);
    // ComputeShadowPCF term (TerrainAlbedoXP :760 / CalculateLighting :373)
    float shadowTerm = cfaComputeShadow(vWorldPos);
#ifdef XP
    // TerrainAlbedoXP (:753-763): spec = pow(sat(dot(reflect(view,N),Sun)),80)
    // * albedo.a * SpecularColor.a * SpecularColor.rgb; color = light*(a+spec)
    vec3 r = reflect(viewDir, normal);
    vec3 specular = pow(clamp(dot(r, sunDirection), 0.0, 1.0), 80.0)
      * albedo.aaa * specularColor.a * specularColor.rgb;
    float dotSunNormal = max(dot(sunDirection, normal), 0.0);
    vec3 light = sunColor * dotSunNormal * shadowTerm + sunAmbience;
    light = lightingMultiplier * light + shadowFillColor * (1.0 - light);
    albedo.rgb = light * (albedo.rgb + specular);
#else
    // CalculateLighting (terrain.fx:370-394): R = Sun - 2*(Sun.N)*N; the
    // scalar specular joins the LIGHT term; color = light * albedo.
    float sunDotNormal = dot(sunDirection, normal);
    vec3 r = sunDirection - 2.0 * sunDotNormal * normal;
    float specular = pow(clamp(dot(r, viewDir), 0.0, 1.0), 80.0)
      * specularColor.x * (1.0 - albedo.w);
    vec3 light = sunColor * clamp(sunDotNormal, 0.0, 1.0) * shadowTerm + sunAmbience + specular;
    light = lightingMultiplier * light + shadowFillColor * (1.0 - light);
    albedo.rgb = light * albedo.rgb;
#endif

    // Water depth tint as in the original (terrain.fx). Instead of the
    // watermap G channel we use the per-map fitted height-based depth
    // (regression against the baked watermap, R^2 > 0.99) — identical
    // gradient, but without DXT compression holes and shore artifacts.
    if (hasWater > 0.5 && vWorldPos.y < waterElevation) {
      float waterDepth = clamp((waterElevation - vWorldPos.y) * depthToG, 0.0, 1.0);
      vec4 water = texture2D(waterRamp, vec2(waterDepth, 0.5));
      albedo.rgb = mix(albedo.rgb, water.rgb, water.a);
    }

#ifdef XP
    gl_FragColor = vec4(albedo.rgb, 0.0); // TerrainAlbedoXP returns alpha 0
#else
#ifdef GLOW
    // TerrainGlowPS (:804): the scrolled stratum1 alpha is the glow
    float glowOut = texture2D(stratum1Albedo, world / stratumTile[1] + glowOffset).a;
    gl_FragColor = vec4(albedo.rgb, glowOut * m0.y + 0.01);
#else
    gl_FragColor = vec4(albedo.rgb, 0.01 + specular * specularColor.w);
#endif
#endif
  }
#endif // NORMALS_PASS
