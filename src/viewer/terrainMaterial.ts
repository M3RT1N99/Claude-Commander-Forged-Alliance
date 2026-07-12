import * as THREE from 'three'

/**
 * Port des Original-Terrain-Shaders (effects/terrain.fx, TerrainAlbedoXP):
 *   - Höhe: Vertex-Displacement aus der Heightmap-Textur (R32F)
 *   - Normale: zentrale Differenzen der Heightmap im Fragment-Shader
 *   - Splatting: albedo = lower; lerp über Stratum 0-7 mit Masken aus
 *     UtilityA/B (saturate(tex*2-1)); Upper über eigenen Alpha
 *   - Licht: light = LightingMultiplier*(SunColor*NdotL + SunAmbience)
 *            + ShadowFillColor*(1-light); Spekular über albedo.a
 *   - Wasser-Tint: WaterRamp-Textur, indiziert über Wassertiefe
 *     (UtilityC.g, Original-Formel: albedo = lerp(albedo, ramp.rgb, ramp.a))
 * Stratum-Normal-Maps folgen in einem späteren Schritt (die geometrische
 * Normale dominiert die Fernansicht).
 */

const vertexShader = /* glsl */ `
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
`

const fragmentShader = /* glsl */ `
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
  uniform sampler2D utilityC;
  uniform float hasWater;
  uniform float waterElevation;

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

    // Wassertiefen-Tint wie im Original (terrain.fx): Tiefe aus dem
    // G-Kanal der vom Map-Compiler gebackenen Watermap. Das Höhen-Gate
    // verhindert, dass DXT-Kompressionsartefakte der Watermap über die
    // Uferlinie hinaus tinten (Treppen-/Fleck-Artefakte).
    if (hasWater > 0.5 && vWorldPos.y < waterElevation) {
      float waterDepth = texture2D(utilityC, vUvMap).g;
      vec4 water = texture2D(waterRamp, vec2(waterDepth, 0.5));
      albedo.rgb = mix(albedo.rgb, water.rgb, water.a);
    }

    gl_FragColor = vec4(albedo.rgb, 1.0);
  }
`

export interface TerrainLayerTextures {
  lower: THREE.Texture
  strata: THREE.Texture[] // 8 Einträge (fehlende: 1x1-Dummy)
  upper: THREE.Texture
  lowerScale: number
  strataScales: number[] // 8 Einträge
  upperScale: number
  /** 1 = Stratum vorhanden, 0 = Maske ignorieren — 8 Einträge */
  strataEnabled: number[]
}

export interface TerrainMaterialOptions {
  heightTex: THREE.Texture
  heightScale: number
  hmWidth: number // Heightmap-Samples in x (mapWidth + 1)
  hmHeight: number
  mapWidth: number
  mapHeight: number
  maskA: THREE.Texture
  maskB: THREE.Texture
  layers: TerrainLayerTextures
  waterRamp: THREE.Texture | null
  utilityC: THREE.Texture | null
  waterElevation: number
  lighting: {
    sunDirection: THREE.Vector3
    sunColor: THREE.Color
    sunAmbience: THREE.Color
    shadowFillColor: THREE.Color
    specularColor: THREE.Vector4
    lightingMultiplier: number
  }
}

export function createTerrainMaterial(o: TerrainMaterialOptions): THREE.ShaderMaterial {
  const dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
  dummy.needsUpdate = true

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      heightTex: { value: o.heightTex },
      heightScale: { value: o.heightScale },
      // Texel-Zentren statt Kanten sampeln
      hmUvScale: {
        value: new THREE.Vector2((o.hmWidth - 1) / o.hmWidth, (o.hmHeight - 1) / o.hmHeight),
      },
      hmUvOffset: { value: new THREE.Vector2(0.5 / o.hmWidth, 0.5 / o.hmHeight) },
      hmTexel: { value: new THREE.Vector2(1 / o.hmWidth, 1 / o.hmHeight) },
      mapSize: { value: new THREE.Vector2(o.mapWidth, o.mapHeight) },
      maskA: { value: o.maskA },
      maskB: { value: o.maskB },
      lowerAlbedo: { value: o.layers.lower },
      stratum0Albedo: { value: o.layers.strata[0] ?? dummy },
      stratum1Albedo: { value: o.layers.strata[1] ?? dummy },
      stratum2Albedo: { value: o.layers.strata[2] ?? dummy },
      stratum3Albedo: { value: o.layers.strata[3] ?? dummy },
      stratum4Albedo: { value: o.layers.strata[4] ?? dummy },
      stratum5Albedo: { value: o.layers.strata[5] ?? dummy },
      stratum6Albedo: { value: o.layers.strata[6] ?? dummy },
      stratum7Albedo: { value: o.layers.strata[7] ?? dummy },
      upperAlbedo: { value: o.layers.upper },
      lowerTile: { value: o.layers.lowerScale },
      stratumTile: { value: o.layers.strataScales },
      upperTile: { value: o.layers.upperScale },
      stratumEnable0: { value: new THREE.Vector4(...o.layers.strataEnabled.slice(0, 4)) },
      stratumEnable1: { value: new THREE.Vector4(...o.layers.strataEnabled.slice(4, 8)) },
      waterRamp: { value: o.waterRamp ?? dummy },
      utilityC: { value: o.utilityC ?? dummy },
      hasWater: { value: o.waterRamp && o.utilityC ? 1 : 0 },
      waterElevation: { value: o.waterElevation },
      sunDirection: { value: o.lighting.sunDirection },
      sunColor: { value: o.lighting.sunColor },
      sunAmbience: { value: o.lighting.sunAmbience },
      shadowFillColor: { value: o.lighting.shadowFillColor },
      specularColor: { value: o.lighting.specularColor },
      lightingMultiplier: { value: o.lighting.lightingMultiplier },
    },
  })
}
