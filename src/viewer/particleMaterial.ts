import * as THREE from 'three'

/**
 * Der Partikel-Shader der Engine, portiert aus `effects/particle.fx`
 * (effects.scd, 1332 Zeilen — die ECHTE Quelle; Auszug + Blend-States in
 * docs/research/verified-facts.md, Abschnitt „Effekte/Partikel").
 *
 * Die komplette Partikel-Simulation läuft im VERTEX-SHADER (WorldVS):
 * jede Instanz trägt ihre Spawn-Werte als Attribute, die Position wird
 * analytisch aus t = time − birth integriert. CPU-seitig wird nur gespawnt.
 *
 * Zeiteinheit ist der SIM-TICK (10/s): `time = tick + frameDelta`
 * (effects-audio.md; die Kurven und Lifetimes zählen in Ticks).
 */

/** BlendMode aus dem Emitter-Blueprint (0..5) → Technique-Suffix der Engine. */
export const BLEND_SUFFIX = [
  'ALPHABLEND',
  'MODULATEINVERSE',
  'MODULATE2XINVERSE',
  'ADD',
  'PREMODALPHA',
  'REFRACT',
] as const

const VERTEX = /* glsl */ `
  // Pro Instanz — die Spawn-Werte, wie WorldVS sie erwartet (particle.fx:75-86):
  attribute vec4 pPos;       // xyz = Spawn-Position (Welt), w = Startwinkel
  attribute vec2 pSize;      // x = Startgröße, y = Größen-Rate (per Tick)
  attribute vec4 pVelocity;  // xyz = Geschwindigkeit, w = Rotationsrate
  attribute vec3 pAccel;
  attribute vec4 pTime;      // x = Spawn-Tick, y = Lifetime, z = Framerate, w = Framesize
  attribute vec3 pTexOffset; // x = Texturzeilen-Offset, y = Ramp-V, z = Zeilenhöhe
  attribute vec3 pDrag;      // dragCoeff (dx, dy, dz) — nur bei uDrag == 1

  uniform float uTime;      // Sim-Tick + Frame-Anteil
  uniform vec3 uCamRight;   // InverseViewMatrix[0] (particle.fx:130)
  uniform vec3 uCamUp;      // InverseViewMatrix[1]
  uniform int uDrag;        // DragEnabled (ParticleResistance im Blueprint)
  uniform int uAnim;        // TextureFramecount > 1
  uniform int uFlat;        // Flat: Quad in der XZ-Ebene statt Billboard

  varying vec2 vUv0;
  varying vec2 vUv1;

  void main() {
    float t = uTime - pTime.x;
    float lifetime = pTime.y;
    float alphaT = t / lifetime;

    // particle.fx:104-107 — analytische Integration, mit oder ohne Drag.
    vec3 pos;
    if (uDrag == 1) {
      pos = (pDrag.z * pAccel - pDrag.y * pVelocity.xyz) * (exp(-pDrag.x * t) - 1.0)
        + pDrag.y * pAccel * t + pPos.xyz;
    } else {
      pos = pPos.xyz + pVelocity.xyz * t + 0.5 * pAccel * t * t;
    }

    // particle.fx:110-119 — das ±1-Quad um den Startwinkel + Rotationsrate drehen.
    float rot = pPos.w + pVelocity.w * t;
    float rs = sin(rot);
    float rc = cos(rot);
    vec2 quad = vec2(position.x * rc - position.y * rs, position.x * rs + position.y * rc);
    float size = pSize.x + pSize.y * t;

    // particle.fx:122-131 — Flat liegt in der Welt-XZ-Ebene, sonst Billboard
    // über die Spalten der inversen View-Matrix.
    if (uFlat == 1) {
      pos += (quad.x * vec3(1.0, 0.0, 0.0) + quad.y * vec3(0.0, 0.0, 1.0)) * size;
    } else {
      pos += (quad.x * uCamRight + quad.y * uCamUp) * size;
    }

    gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);

    // particle.fx:134-147 — UVs: Frame-Animation im Textur-Strip; die Ramp
    // wird mit U = t/lifetime („alpha") und V = Ramp-Auswahl gesampelt.
    vec2 uv = (position.xy + 1.0) * 0.5;
    if (uAnim == 1) {
      float frame = floor(pTime.z * t);
      uv.x = uv.x * pTime.w + pTime.w * frame;
      uv.y = uv.y * pTexOffset.z + pTexOffset.x;
    }
    vUv0 = uv;
    vUv1 = vec2(alphaT, pTexOffset.y);

    // particle.fx:100 — WorldVS gibt für tote Partikel Out=0 zurück (das Quad
    // degeneriert). Hier dasselbe: w=0 macht das Dreieck unsichtbar.
    if (t < 0.0 || alphaT >= 1.0) {
      gl_Position = vec4(0.0, 0.0, 2.0, 0.0);
    }
  }
`

const FRAGMENT = /* glsl */ `
  precision mediump float;
  uniform sampler2D uTex;   // ParticleTexture0 (Partikeltextur)
  uniform sampler2D uRamp;  // ParticleTexture1 (Farb-/Alpha-Rampe)
  varying vec2 vUv0;
  varying vec2 vUv1;

  void main() {
    // WorldPS (particle.fx:250-255): Partikeltextur × Ramptextur — die Ramp
    // kodiert Farbe UND Alpha über die Lebenszeit.
    gl_FragColor = texture2D(uTex, vUv0) * texture2D(uRamp, vUv1);
  }
`

/**
 * Blend-Zustand je BlendMode — 1:1 die AlphaStates der Techniques
 * (particle.fx:407-483; REFRACT rendert dort mit eigenem Pixelshader gegen
 * den Backbuffer — bis der Refraktions-Pass existiert, fällt Mode 5 ehrlich
 * auf ALPHABLEND zurück, denselben Blend-Zustand, den TRamp_REFRACT nutzt).
 *
 * ALPHABLEND/PREMODALPHA schreiben im Original nur RGB (Write_RGB) — WebGL
 * kann colorMask nicht pro Material; der Alpha-Kanal des Framebuffers wird
 * bei uns nicht weiterverwendet, der Unterschied ist nicht sichtbar.
 */
function applyBlend(mat: THREE.ShaderMaterial, blendMode: number): void {
  mat.blending = THREE.CustomBlending
  mat.blendEquation = THREE.AddEquation
  switch (blendMode) {
    case 1: // MODULATEINVERSE: Zero / InvSrcColor
      mat.blendSrc = THREE.ZeroFactor
      mat.blendDst = THREE.OneMinusSrcColorFactor
      break
    case 2: // MODULATE2XINVERSE: InvDestColor / InvSrcColor
      mat.blendSrc = THREE.OneMinusDstColorFactor
      mat.blendDst = THREE.OneMinusSrcColorFactor
      break
    case 3: // ADD: SrcAlpha / One
      mat.blendSrc = THREE.SrcAlphaFactor
      mat.blendDst = THREE.OneFactor
      break
    case 4: // PREMODALPHA: One / InvSrcAlpha
      mat.blendSrc = THREE.OneFactor
      mat.blendDst = THREE.OneMinusSrcAlphaFactor
      break
    default: // 0 ALPHABLEND (und 5 REFRACT, s. o.): SrcAlpha / InvSrcAlpha
      mat.blendSrc = THREE.SrcAlphaFactor
      mat.blendDst = THREE.OneMinusSrcAlphaFactor
      break
  }
}

export interface ParticleMaterialOptions {
  texture: THREE.Texture
  ramp: THREE.Texture
  blendMode: number
  /** TextureFramecount > 1 ⇒ Frame-Animation (Technique-Familie …Animate…). */
  animated: boolean
  /** Flat ⇒ Quad in der XZ-Ebene (TRampFlat_*). */
  flat: boolean
  /** ParticleResistance ⇒ Drag-Modell im Shader (DragEnabled). */
  drag: boolean
}

/** Ein Material je Emitter-Batch — Uniforms uTime/uCamRight/uCamUp pro Frame. */
export function createParticleMaterial(o: ParticleMaterialOptions): THREE.ShaderMaterial {
  const mat = new THREE.ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uCamRight: { value: new THREE.Vector3(1, 0, 0) },
      uCamUp: { value: new THREE.Vector3(0, 1, 0) },
      uDrag: { value: o.drag ? 1 : 0 },
      uAnim: { value: o.animated ? 1 : 0 },
      uFlat: { value: o.flat ? 1 : 0 },
      uTex: { value: o.texture },
      uRamp: { value: o.ramp },
    },
    // Alle Techniques: Depth-Test Less AN, Depth-Write AUS, Cull None
    // (particle.fx: Depth_Enable_Less_Write_None, Rasterizer_Cull_None).
    depthTest: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    transparent: true,
  })
  applyBlend(mat, o.blendMode)
  return mat
}
