// AeonBuildOverlayPS (mesh.fx:2748-2784), pass P1 of technique AeonBuild
// (SrcAlpha blend): two counter-scrolling masks from the build specular
// (AeonBuildSpecular.dds, blueprints.lua:221), a hand-built normal from
// mask + secondary + unit normal map, phong^8 highlight, alpha fading out
// in the last 5%.
precision highp float;

uniform sampler2D normalsMap;
uniform sampler2D secondaryMap;
uniform vec3 sunDirection;
uniform float fraction; // material.y
uniform float unitAge;  // material.x = time - creation tick (game ticks)

varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBinormal;
varying vec3 vWorldPos;

void main() {
  // :2751-2758 — two scrolled samples of the secondary mask
  vec2 tc1 = vUv0;
  tc1.y += unitAge * 0.00162;
  tc1.x -= unitAge * 0.001;
  vec4 mask1 = texture2D(secondaryMap, tc1 * 2.0);

  vec2 tc2 = vUv0;
  tc2.y -= unitAge * 0.00162;
  vec4 mask2 = texture2D(secondaryMap, tc2 * 2.0);

  vec3 diffuse = mask1.rrr - mask2.ggg + mask1.ggg * mask2.rrr;
  diffuse = mix(diffuse, vec3(0.5), 0.75);

  // :2764-2770 — custom normal from unit normals (.ga), secondary (.ba)
  // and the animated mask, rotated into the tangent frame
  vec3 n = texture2D(normalsMap, vUv1).gaa;
  n = mix(n, texture2D(secondaryMap, vUv0 * 7.0).baa, 0.5);
  n = mix(n, diffuse, 0.5);
  n = 2.0 * n - 1.0;
  n.z = sqrt(max(0.0, 1.0 - n.x * n.x - n.y * n.y));
  vec3 normal = normalize(
    n.x * normalize(vBinormal) + n.y * normalize(vTangent) + n.z * normalize(vNormal));

  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float dotLightNormal = clamp(dot(sunDirection, normal), 0.0, 1.0);
  vec3 reflection = normalize(2.0 * dotLightNormal * normal - normalize(sunDirection));
  // :2775 — NOTE the original dots with +viewDirection (camera->fragment)
  float specular = pow(clamp(dot(reflection, -viewDir), 0.0, 1.0), 8.0);

  vec3 color = diffuse * dotLightNormal + specular;

  // :2780-2781 — fade out at 95%
  float alpha = (fraction >= 0.95)
    ? (1.0 - (fraction - 0.95) * 20.0) * (color.r * 2.0)
    : color.r * 2.0;

  gl_FragColor = vec4(color, alpha);
}
