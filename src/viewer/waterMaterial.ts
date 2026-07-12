import * as THREE from 'three'

/**
 * Wasseroberfläche nach der Original-Kompositionsformel (water2.fx,
 * HighFidelityPS), angepasst an Alpha-Blending statt Refraction-Buffer:
 *
 *   waterLerp = clamp(depth, colorLerpMin, colorLerpMax)
 *   c = lerp(refraktiertesTerrain, surfaceColor, waterLerp)
 *   skyAmt = skyReflection * fresnel(depth, NdotV) * saturate(depth*10)
 *   c = lerp(c, sky, skyAmt) + sunGlint * fresnel
 *
 * Das "refraktierte Terrain" liefert bei uns das Alpha-Blending über dem
 * bereits gerenderten (wassergetönten) Terrain. Wellen-Normalmaps und
 * Sky-Cubemap folgen später — Fresnel ist Schlick + Tiefen-Sockel, wie es
 * die Fresnel-Lookup-Textur des Originals näherungsweise tut.
 */

const vertexShader = /* glsl */ `
  varying vec3 vWorldPos;

  void main() {
    vec4 worldPos = modelMatrix * vec4(position, 1.0);
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
  uniform float elevation;
  uniform float depthToG;      // gefittete Skalierung Welttiefe -> Watermap-G
  uniform float colorLerpMin;
  uniform float colorLerpMax;
  uniform vec3 surfaceColor;
  uniform vec3 skyColor;
  uniform vec3 sunDirection;
  uniform vec3 sunColor;
  uniform float skyReflectionAmount;
  uniform float sunShininess;

  varying vec3 vWorldPos;

  void main() {
    vec2 uvMap = vWorldPos.xz / mapSize;
    float h = texture2D(heightTex, uvMap * hmUvScale + hmUvOffset).r * heightScale;
    float depth = elevation - h;
    if (depth <= 0.02) discard;

    float waterDepth = clamp(depth * depthToG, 0.0, 1.0);

    vec3 N = vec3(0.0, 1.0, 0.0);
    vec3 V = normalize(cameraPosition - vWorldPos);
    float ndotv = clamp(dot(N, V), 0.0, 1.0);

    // Schlick-Fresnel + Tiefen-Sockel (Original: Lookup über (depth, NdotV))
    float fresnel = 0.06 + 0.94 * pow(1.0 - ndotv, 5.0);
    fresnel = max(fresnel, 0.28 * clamp(waterDepth * 2.0, 0.0, 1.0));

    float waterLerp = clamp(waterDepth, colorLerpMin, colorLerpMax);
    float skyAmt = clamp(
      skyReflectionAmount * fresnel * clamp(waterDepth * 10.0, 0.0, 1.0), 0.0, 1.0);

    float glint = pow(clamp(dot(reflect(-sunDirection, N), V), 0.0, 1.0), sunShininess);

    // Gesamtkomposition als Alpha-Blend: result = terrain*(1-A) + C*A
    float alpha = waterLerp + skyAmt - waterLerp * skyAmt;
    vec3 color =
      surfaceColor * waterLerp * (1.0 - skyAmt) +
      skyColor * skyAmt +
      sunColor * glint * fresnel;
    color /= max(alpha, 0.001);

    gl_FragColor = vec4(color, alpha);
  }
`

export interface WaterMaterialOptions {
  heightTex: THREE.Texture
  heightScale: number
  hmWidth: number
  hmHeight: number
  mapWidth: number
  mapHeight: number
  elevation: number
  depthToG: number
  colorLerpMin: number
  colorLerpMax: number
  surfaceColor: THREE.Color
  sunDirection: THREE.Vector3
  sunColor: THREE.Color
}

export function createWaterMaterial(o: WaterMaterialOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    uniforms: {
      heightTex: { value: o.heightTex },
      heightScale: { value: o.heightScale },
      hmUvScale: {
        value: new THREE.Vector2((o.hmWidth - 1) / o.hmWidth, (o.hmHeight - 1) / o.hmHeight),
      },
      hmUvOffset: { value: new THREE.Vector2(0.5 / o.hmWidth, 0.5 / o.hmHeight) },
      mapSize: { value: new THREE.Vector2(o.mapWidth, o.mapHeight) },
      elevation: { value: o.elevation },
      depthToG: { value: o.depthToG },
      colorLerpMin: { value: o.colorLerpMin },
      colorLerpMax: { value: o.colorLerpMax },
      surfaceColor: { value: o.surfaceColor },
      skyColor: { value: new THREE.Color(0.42, 0.5, 0.58) },
      sunDirection: { value: o.sunDirection },
      sunColor: { value: o.sunColor },
      skyReflectionAmount: { value: 0.65 },
      sunShininess: { value: 60 },
    },
  })
}
