// Depth pass with alpha clip (depthTechnique 'DepthClip', foliage): the
// same Greater-0x80 test as the color pass so leaves punch holes into
// their shadows.
precision highp float;

uniform sampler2D albedoMap;

varying vec2 vUv0;

void main() {
  if (texture2D(albedoMap, vUv0).a <= 128.0 / 255.0) discard;
  gl_FragColor = vec4(1.0);
}
