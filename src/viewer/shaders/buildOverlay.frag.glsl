// Port of UEFBuildOverlayHiFiPS (effects/mesh.fx:2977-2988), pass P1 the
// UEFBuild technique: two counter-scrolling samples of the
// Construction grid (secondary sampler), alpha drops with progress and
// fades out in the last 5%.

  precision highp float;

  uniform sampler2D secondaryMap; // UEFBuildSpecular.dds
  uniform float fraction;         // material.y = FractionComplete

  varying vec4 vUvs;

  void main() {
    vec4 xshift = texture2D(secondaryMap, vUvs.xy);
    vec4 yshift = texture2D(secondaryMap, vUvs.zw);

    float alpha = max((xshift.a + yshift.a) * (1.0 - fraction), 0.25);
    alpha *= (fraction >= 0.95) ? 1.0 - ((fraction - 0.95) * 20.0) : 1.0;

    gl_FragColor = vec4(xshift.rgb + yshift.rgb, alpha);
  }
