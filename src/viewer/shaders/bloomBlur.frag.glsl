// frame.fx BlurHorizontalPS / BlurVerticalPS (:349-378): 7-tap blur with
// the kernel/weights declared in frame.fx:17-18, scaled by BlurScale
// (ren_BloomBlurKernelScale = 1.5). HORIZONTAL define picks the axis.
precision highp float;

uniform sampler2D frameTex;
uniform vec2 texelSize; // 1 / buffer size

varying vec2 vUv;

void main() {
  float kernel[7];
  kernel[0] = -3.0; kernel[1] = -2.0; kernel[2] = -1.0; kernel[3] = 0.0;
  kernel[4] = 1.0; kernel[5] = 2.0; kernel[6] = 3.0;
  float weight[7];
  weight[0] = 0.102734; weight[1] = 0.120985; weight[2] = 0.176033;
  weight[3] = 0.199471; weight[4] = 0.176033; weight[5] = 0.120985;
  weight[6] = 0.102734;

  vec4 color = vec4(0.0);
  for (int i = 0; i < 7; i++) {
#ifdef HORIZONTAL
    color += weight[i] * texture2D(frameTex, vUv + vec2(kernel[i] * texelSize.x, 0.0));
#else
    color += weight[i] * texture2D(frameTex, vUv + vec2(0.0, kernel[i] * texelSize.y));
#endif
  }
  gl_FragColor = color * 1.5; // BlurScale (ren_BloomBlurKernelScale)
}
