// sky.fx AtmospherePS (:229-236): th = theta/2pi, tv = (elevation -
// horizonBegin)/(horizonEnd - horizonBegin); t = horizonLookup(th,.25).a *
// horizonLookup(tv,.75).a; color = lerp(horizonColor, skyColor, 1-t).
// Sampler is POINT/CLAMP (:34-42).
precision highp float;

uniform sampler2D horizonLookup;
uniform float horizonBegin;
uniform float horizonEnd;
uniform vec3 horizonColor;
uniform vec3 skyColor;

varying float vElevation;
varying float vTheta;
varying vec4 vCirrus01;
varying vec4 vCirrus23;

void main() {
  float th = clamp(vTheta, 0.0, 6.283185) * 0.159155;
  float tv = clamp((vElevation - horizonBegin) / (horizonEnd - horizonBegin), 0.0, 1.0);
  float t = texture2D(horizonLookup, vec2(th, 0.25)).a
          * texture2D(horizonLookup, vec2(tv, 0.75)).a;
  gl_FragColor = vec4(mix(horizonColor, skyColor, 1.0 - t), 1.0);
}
