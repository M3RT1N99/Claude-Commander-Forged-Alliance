// SeraphimBuildPS (mesh.fx:2895-2923), technique SeraphimBuild (SrcAlpha
// blend, single pass): UV distortion from the build specular
// (SeraphimBuildSpecular.dds * 0.03) that fades out via (pc-0.9)*10, the
// falloff ramp lookup of the Seraphim unit shader
// (Falloff_seraphim_lookup.dds, blueprints.lua:229), environment * spec.r
// * fallOff.a, alpha = max(fraction, 0.25).
precision highp float;

uniform sampler2D albedoMap;
uniform sampler2D normalsMap;
uniform sampler2D specTeamMap;
uniform sampler2D secondaryMap;
uniform sampler2D lookupMap; // falloff ramp
#ifdef ENVCUBE
uniform samplerCube environmentMap; // the '<seraphim>' env cube
#endif
uniform vec3 sunDirection;
uniform vec3 sunAmbient;
uniform vec3 shadowFill;
uniform float fraction; // material.y
uniform float unitAge;  // material.x = time - creation tick (game ticks)

varying vec2 vUv0;
varying vec2 vUv1;
varying vec3 vNormal;
varying vec3 vTangent;
varying vec3 vBinormal;
varying vec3 vWorldPos;

void main() {
  // :2899-2904 — scrolling distortion source, fading with build progress
  vec2 tc = vUv0;
  tc.y += unitAge * 0.005;
  float buildFractionMul = (fraction - 0.9) * 10.0;
  vec2 uvaddress = texture2D(secondaryMap, tc * 0.5).rb * 0.03;
  vec2 offset = mix(uvaddress, vec2(0.0), buildFractionMul);
  vec2 texcoord2 = vUv0 + offset;

  vec2 nmga = texture2D(normalsMap, vUv1 + offset).ga;
  vec3 tsn;
  tsn.xy = nmga * 2.0 - 1.0;
  tsn.z = sqrt(max(0.0, 1.0 - dot(tsn.xy, tsn.xy)));
  vec3 normal = normalize(
    tsn.x * normalize(vBinormal) + tsn.y * normalize(vTangent) + tsn.z * normalize(vNormal));

  vec3 viewDir = normalize(cameraPosition - vWorldPos);

  // :2911-2912 — falloff ramp like the Seraphim unit shader
  float ndotv = pow(1.0 - clamp(dot(viewDir, normal), 0.0, 1.0), 0.6);
  vec4 fallOff = texture2D(lookupMap, vec2(ndotv, 1.0));

  vec4 diffuse = texture2D(albedoMap, texcoord2);
  vec4 specular = texture2D(specTeamMap, texcoord2);
#ifdef ENVCUBE
  vec3 environment =
    textureCube(environmentMap, reflect(-viewDir, normal)).rgb * specular.r * fallOff.a;
#else
  vec3 environment = vec3(0.0);
#endif

  // :2919-2920
  vec3 color = diffuse.rgb * (sunAmbient + (vec3(1.0) - sunAmbient) * shadowFill);
  color += environment + fallOff.rgb * diffuse.a;

  gl_FragColor = vec4(color, max(fraction, 0.25));
}
