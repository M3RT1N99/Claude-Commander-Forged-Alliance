// Port of water2.fx HighFidelityPS (:329-496) with every uniform from the
// SCMAP water block. Differences to the original, by name:
//
//  - The original composes over a REFRACTION render target (the scene
//    masked by water) with a screen-space distortion (refractionScale) and
//    writes opaquely. We express the exact same lerp chain as premultiplied
//    alpha over the already-rendered terrain — equal except for the
//    missing distortion offset and the unit-reflection RT (an empty RT has
//    reflectedPixels.w = 0, which collapses that lerp to the sky cube —
//    the same thing we do).
//  - waterDepth: the original reads the baked watermap G channel; we use
//    the per-map height fit (regression against that channel, R^2 > 0.99)
//    to avoid its DXT compression holes — same quantity, cleaner shores.
//  - Shallow water (< 0.02 m) discards — it stands in for the shoreline
//    alpha punch-out (TShoreline) until that geometry exists.
//
// Everything else is the original math: 4 wave normal layers, flatness
// from the watermap R channel, foam from A (:339-388), the EXACT fresnel
// formula from HighFidelityWater.cpp:100-146 (BuildFresnelLookupTexture)
// inlined instead of the lookup texture, sky cube reflection, sun glint
// with the water block's own sun, wave crest color/threshold defaults
// (1,1,1) / 1 (water2.fx:21-22).
precision highp float;

uniform sampler2D waterMap;   // UtilitySamplerC: R flatness, G depth, B mask, A 1-foam
uniform sampler2D wave0;
uniform sampler2D wave1;
uniform sampler2D wave2;
uniform sampler2D wave3;
uniform samplerCube skyCube;

uniform float elevation;
uniform float depthToG;
uniform float colorLerpMin;
uniform float colorLerpMax;
uniform vec3 surfaceColor;
uniform float fresnelBias;
uniform float fresnelPower;
uniform float skyReflectionAmount;
uniform float sunShininess;
uniform vec3 sunDirection;    // the water block's own sun
uniform vec3 sunColor;

uniform sampler2D heightTex;
uniform float heightScale;
uniform vec2 hmUvScale;
uniform vec2 hmUvOffset;

varying vec2 vUvMap;
varying vec2 vLayer0;
varying vec2 vLayer1;
varying vec2 vLayer2;
varying vec2 vLayer3;
varying vec3 vViewVec;
varying vec3 vWorldPos;

void main() {
  vec4 waterTexture = texture2D(waterMap, vUvMap);

  // Depth from the height fit (see header) — the same quantity as the
  // watermap G channel the original samples (:339-340).
  float ground = texture2D(heightTex, vUvMap * hmUvScale + hmUvOffset).r * heightScale;
  float depth = elevation - ground;
  if (depth <= 0.02) discard;
  float waterDepth = clamp(depth * depthToG, 0.0, 1.0);

  vec3 viewVector = normalize(vViewVec);

  // Wave layers (:374-388)
  vec4 sum = texture2D(wave0, vLayer0) + texture2D(wave1, vLayer1)
           + texture2D(wave2, vLayer2) + texture2D(wave3, vLayer3);
  float waveCrest = clamp(sum.a - 1.0, 0.0, 1.0); // waveCrestThreshold = 1
  vec3 N = 2.0 * sum.xyz - 4.0;
  N = normalize(N.xzy);
  N = mix(vec3(0.0, 1.0, 0.0), N, waterTexture.r);

  vec3 R = reflect(viewVector, N);
  vec4 skyReflection = textureCube(skyCube, R);

  // Fresnel, exact (HighFidelityWater.cpp:100-146): column = depth, row =
  // incidence angle; R = blend + (1 - blend) * (1 - i)^power
  float NDotL = clamp(dot(-viewVector, N), 0.0, 1.0);
  float reflectionBlend = waterDepth * fresnelBias;
  float fresnel =
    clamp(reflectionBlend + (1.0 - reflectionBlend) * pow(1.0 - NDotL, fresnelPower), 0.0, 1.0);

  // Sun glint (:436, :467) with the water sun
  vec3 sunReflection = pow(clamp(dot(-R, sunDirection), 0.0, 1.0), sunShininess) * sunColor;
  sunReflection *= fresnel;

  // Composition chain (:448-472) rewritten as premultiplied alpha over the
  // terrain (dst = backGroundPixels):
  //   c1 = mix(dst, waterColor, wl)
  //   c2 = mix(c1, reflection, k),  k = sat(skyAmount * sat(depth*10) * fresnel)
  //   c3 = c2 + sun
  //   c4 = mix(c3, crestColor, f),  f = (1 - waterTexture.a) * waveCrest
  float wl = clamp(waterDepth, colorLerpMin, colorLerpMax);
  float k = clamp(skyReflectionAmount * clamp(waterDepth * 10.0, 0.0, 1.0) * fresnel, 0.0, 1.0);
  float f = clamp((1.0 - waterTexture.a) * waveCrest, 0.0, 1.0);

  float dstWeight = (1.0 - wl) * (1.0 - k) * (1.0 - f);
  vec3 premul = surfaceColor * (wl * (1.0 - k) * (1.0 - f))
              + skyReflection.rgb * (k * (1.0 - f))
              + sunReflection * (1.0 - f)
              + vec3(1.0) * f; // waveCrestColor = (1,1,1), water2.fx:22

  gl_FragColor = vec4(premul, 1.0 - dstWeight);
}
