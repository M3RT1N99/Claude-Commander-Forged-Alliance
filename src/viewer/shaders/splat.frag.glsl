// SplatsPS (terrain.fx:1413-1434) with the TSplats states (:1436-1447):
// the albedo lit like a decal (CalculateLighting on the screen-space
// normal buffer, the water depth), alpha = decalAlbedo.w * mAlpha;
// AlphaBlend_SrcAlpha_InvSrcAlpha_Write_RGB, depth LessEqual without
// write, Rasterizer_Cull_None_Bias_Neg001. The lighting is the DecalsPS
// one (decal.frag.glsl) without the spec and mask samplers.
precision highp float;

uniform sampler2D decalAlbedo;
uniform sampler2D heightTex;
uniform float heightScale;
uniform vec2 hmUvScale;
uniform vec2 hmUvOffset;
uniform vec2 hmTexel;

uniform sampler2D waterRamp;
uniform float hasWater;
uniform float waterElevation;
uniform float depthToG;

uniform vec3 sunDirection;
uniform vec3 sunColor;
uniform vec3 sunAmbience;
uniform vec3 shadowFillColor;
uniform vec4 specularColor;
uniform float lightingMultiplier;

#include <cfaShadow>

varying vec2 vUv;
varying vec2 vUvMap;
varying vec3 vWorldPos;
varying float vAlpha;
varying float vCutoff;

float height(vec2 uvMap) {
  return texture2D(heightTex, uvMap * hmUvScale + hmUvOffset).r * heightScale;
}

#include <cfaNormalBuffer>

// GetLODAlpha (CWldTerrainDecal, Cfile:1335082-1335114; the batch loops
// 1218082-1218099): with mNearCutoff 0 the alpha fades linearly from 1 at
// cutoff * ren_DecalFadeFraction (0.5, :421725) to 0 at cutoff.
float cfaLodAlpha(float d, float cutoff) {
  if (cutoff <= 0.0) return 1.0;
  float fadeFloor = cutoff * 0.5;
  return clamp(1.0 - (max(d, fadeFloor) - fadeFloor) / (cutoff - fadeFloor), 0.0, 1.0);
}

void main() {
  float lodAlpha = cfaLodAlpha(distance(cameraPosition, vWorldPos), vCutoff);
  float splatAlpha = lodAlpha * vAlpha;
  if (splatAlpha <= 0.0) discard;

  vec4 albedo = texture2D(decalAlbedo, vUv);
  vec3 normal = cfaWorldNormal(vUvMap, hmTexel);
  vec3 viewDir = normalize(vWorldPos - cameraPosition);

  // CalculateLighting (:370-394) with specular amount 0 (SplatsPS passes 0).
  float sunDotNormal = dot(sunDirection, normal);
  vec3 light =
    sunColor * clamp(sunDotNormal, 0.0, 1.0) * cfaComputeShadow(vWorldPos) + sunAmbience;
  light = lightingMultiplier * light + shadowFillColor * (1.0 - light);
  albedo.rgb = light * albedo.rgb;

  if (hasWater > 0.5 && vWorldPos.y < waterElevation) {
    float waterDepth = clamp((waterElevation - vWorldPos.y) * depthToG, 0.0, 1.0);
    vec4 water = texture2D(waterRamp, vec2(waterDepth, 0.5));
    albedo.rgb = mix(albedo.rgb, water.rgb, water.a);
  }

  gl_FragColor = vec4(albedo.rgb, albedo.a * splatAlpha);
}
