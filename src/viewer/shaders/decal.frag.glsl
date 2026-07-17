// Albedo decal (type 1) — terrain.fx DecalsPS (:1131-1143, TTerrain maps)
// and DecalAlbedoXP (:1145-1167, XP maps; XP define). Blend state per
// technique TDecals/TDecalsXP (:1245-1269): SrcAlpha/InvSrcAlpha, no depth
// write, decal rasterizer bias.
//
// The original lights decals with the deferred normal buffer (stratum
// normals + normals decals included); forward-rendering we rebuild the
// GEOMETRY normal from the heightmap — a named approximation until a
// normal render target exists. Without a spec texture (HAS_SPEC unset) the
// spec amount is 0 and the mask 1, like the engine's unbound samplers.
precision highp float;

uniform sampler2D decalAlbedo;
#ifdef HAS_SPEC
uniform sampler2D decalSpec;
#endif
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
uniform float cutOffLOD; // distance beyond which the decal is not drawn

varying vec2 vUv;
varying vec2 vUvMap;
varying vec3 vWorldPos;

float height(vec2 uvMap) {
  return texture2D(heightTex, uvMap * hmUvScale + hmUvOffset).r * heightScale;
}

void main() {
  // The decal sampler is CLAMP (render-details.md par. 3); the instance
  // quad is exactly the decal footprint, so just guard the border.
  if (vUv.x < 0.0 || vUv.x > 1.0 || vUv.y < 0.0 || vUv.y > 1.0) discard;
  if (cutOffLOD > 0.0 && distance(cameraPosition, vWorldPos) > cutOffLOD) discard;

  vec4 albedo = texture2D(decalAlbedo, vUv);

  // Geometry normal from the heightmap (central differences), same as the
  // terrain shader.
  float hl = height(vUvMap - vec2(hmTexel.x, 0.0));
  float hr = height(vUvMap + vec2(hmTexel.x, 0.0));
  float hd = height(vUvMap - vec2(0.0, hmTexel.y));
  float hu = height(vUvMap + vec2(0.0, hmTexel.y));
  vec3 normal = normalize(vec3(hl - hr, 2.0, hd - hu));

  vec3 viewDir = normalize(vWorldPos - cameraPosition);
#ifdef XP
  // DecalAlbedoXP (:1148-1160): specularAmount = decalSpec.a
  float specAmount = 0.0;
#ifdef HAS_SPEC
  specAmount = texture2D(decalSpec, vUv).a;
#endif
  vec3 r = reflect(viewDir, normal);
  vec3 spec = pow(clamp(dot(r, sunDirection), 0.0, 1.0), 80.0)
    * specAmount * specularColor.a * specularColor.rgb;
  float dotSunNormal = max(dot(sunDirection, normal), 0.0);
  vec3 light = sunColor * dotSunNormal + sunAmbience;
  light = lightingMultiplier * light + shadowFillColor * (1.0 - light);
  albedo.rgb = light * (albedo.rgb + spec);
#else
  // DecalsPS -> CalculateLighting (:370-394): specAmount = decalSpec.r,
  // the scalar specular joins the LIGHT term.
  float specAmount = 0.0;
#ifdef HAS_SPEC
  specAmount = texture2D(decalSpec, vUv).r;
#endif
  float sunDotNormal = dot(sunDirection, normal);
  vec3 refl = sunDirection - 2.0 * sunDotNormal * normal;
  float spec = pow(clamp(dot(refl, viewDir), 0.0, 1.0), 80.0)
    * specularColor.x * specAmount;
  vec3 light = sunColor * clamp(sunDotNormal, 0.0, 1.0) + sunAmbience + spec;
  light = lightingMultiplier * light + shadowFillColor * (1.0 - light);
  albedo.rgb = light * albedo.rgb;
#endif

  // Water tint like the terrain (ApplyWaterColor / WaterRampSampler).
  if (hasWater > 0.5 && vWorldPos.y < waterElevation) {
    float waterDepth = clamp((waterElevation - vWorldPos.y) * depthToG, 0.0, 1.0);
    vec4 water = texture2D(waterRamp, vec2(waterDepth, 0.5));
    albedo.rgb = mix(albedo.rgb, water.rgb, water.a);
  }

  // alpha = decalAlbedo.a * decalMask.a * DecalAlpha (mask 1; the LOD fade
  // is the cutOffLOD discard above)
  gl_FragColor = vec4(albedo.rgb, albedo.a);
}
