// Port von UEFBuildOverlayHiFiPS (effects/mesh.fx:2977-2988), Pass P1 der
// UEFBuild-Technique: zwei gegeneinander scrollende Abtastungen des
// Bau-Gitters (secondarySampler), Alpha faellt mit dem Fortschritt und
// blendet in den letzten 5 % aus.

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
