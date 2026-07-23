# agent10

## Summary
All 9 render features are resolved from faf-re + effects.scd shaders + game data and partially verified numerically. Key finding: The SCMAP parser crashes today after the WaterMap - behind it are Foam/Flatness/DepthBias masks, TerrainType, the v60 skybox block and the props list. I decoded the entire tail structure and verified it across all 60 original maps (parser lands 60/60 exactly on EOF); the Skybox block was independently confirmed by sky.fx + SkyDome.cpp. Additionally: TerrainScale/Tiling semantics exactly documented (our tiling is correct), the original terrain lighting runs via a deferred normal buffer (TTerrainBasis + TTerrainNormals → frame.fx BasisPS), and 39 of 60 maps use TTerrain (4 Strata), not the TTerrainXP we implemented.

## Key Facts
- SCMAP tail fully decoded and verified over 60/60 original maps up to exactly EOF: WaterMap is followed by 3× (w/2 h/2) byte masks (foam, flatness, depth bias), terrain type (w h bytes), at v60 a skybox block, then the props list.
- Prop record = cstr(blueprintPath) + position(vec3) + rotX(vec3) + rotY(vec3) + rotZ(vec3) + scale(vec3); the 3 rotation vectors are the basis of a 3×3 rotation matrix. Up to 46,971 props per card (SCMP_005) → Instancing mandatory.
- TerrainScale = (1/mapWidth, 1/mapHeight, 0, 1) and StratumTile = (mapSize/albedoScale, ·, 0, 1) — both multiplied gives uv = worldXZ/albedoScale. Our current tiling is therefore already exactly correct (proven in HighFidelityTerrain.cpp + StratumMaterial.cpp).
- The original terrain normal comes from a deferred screen buffer: TTerrainBasis writes BA (geometry normal from the scmap NormalMap), TTerrainNormals(XP) writes RG (blinded stratum normal maps), frame.fx BasisPS builds a TBN from it and rotates the tangent normal in world coordinates.
- 39 out of 60 maps use 'TTerrain' (only 4 Strata, different light/specular formula), 20 'TTerrainXP', 1 'TTerrainGlow' — we currently only implement TerrainAlbedoXP for all.
- Skycube DDS are real DDS cubemaps: DXT1, 512×512, NO Mips, caps2=0xFE00, 6 faces of 131,072 bytes each in the order +X,−X,+Y,−Y,+Z,−Z (file length exactly 128 + 6·131072 = 786,560).
- Water Fresnel is a procedurally generated 128×128 lookup texture: fresnel = d bias + (1 − d bias) (1 − NdotV)^fresnelPower, where d = water depth; Our parser already reads fresnelBias/fresnelPower but discards them.
- WaterMap channels (UtilityTextureC) exactly: R = flatness (wave strength), G = depth, B = water alpha mask, A = 1 − foam.
- Decal types are an enum (1=Albedo, 2=Normals, 3=WaterMask, 4=WaterAlbedo, 6=Glow, 8=GlowMask, 9=AlbedoXp); Type 2 (75,683) and Type 1 (47,874) dominate in the original maps.
- DecalMatrix = translate(−pos) · Ry · Rx · Rz · scale(1/scale), UV = (x,z) of the result; the Lua API CreateDecal converts center→corner (pos = center − 0.5·(right·sizeX + forward·sizeZ)), i.e. h. SDecalInfo.mPos is the CORNER of the local [0,1]² square.
- LOD selection (Mesh::ComputeLOD): first LOD in order with cutoff<=0 (always) OR distance<=cutoff; with useDissolve distance<=cutoff+ren_MeshDissolve applies, otherwise nothing is drawn.
- Legacy ShaderName alias table found (Mesh.cpp ShaderDictionary): TMeshAlpha→NormalMappedAlpha, TMeshGlow→NormalMappedGlow, TMeshNoLighting→Flat, TMeshNoNormals→VertexNormal, Simple/Team→Unit, empty→Unit — Prop blueprints use exactly these old names.
- FoW and range rings are stencil shadow volumes: vision.fx/range.fx only render cylinders/ellipses in the stencil (ColorWrite=0), then frame.fx fills them using a fullscreen quad (Vision: black with alpha 0.33; RangeFill: white 0.125; RangeBurn: rangeColor).
- Water needs 2 screen render targets: RefractionMap (scene in front of the water; alpha = water mask) and ReflectionMap (scene mirrored, mesh.fx uniform 'mirrored' clips fragments under water); where the ReflectionMap is empty, the Sky Cubemap is used.
- Terrain-Skirt is trivial: TTerrainSkirt renders a skirt around the map, TerrainSkirtPS returns constant float4(0.1,0.1,0.1,0) (dark gray area).

## Details
## 0. Ausgangslage im Nachbau

`src/formats/scmap.ts` **aborts after the WaterMap** (comment lines 309-310). This means that the following data sources are missing: props, decals (are parsed but discarded), stratum normal paths, terrain type, foam/flatness/depth bias masks, the skybox block, as well as almost all water fields (fresnelBias/Power, unitReflection, skyReflection, sunShininess/Strength, water-sun, sunGlow, texPathCubemap, the 4 Wave normal maps + repeat rates) and the EnvCube list.

`src/viewer/terrainMaterial.ts` only implements `TerrainAlbedoXP` (+ own `stratumEnable` hack), `src/viewer/waterMaterial.ts` only implements an approximation without waves/cubemap/refraction.

---

## 1. SCMAP tail — fully decoded, 60/60 maps exact to EOF

Verification script: `…/scratchpad/verifyTail.ts` (Result: `EXAKT BIS EOF: 60/60`).

Order **after** the already parsed `waterMap`-DDS:

```
waterFoamMask       (w/2)·(h/2) Bytes
waterFlatnessMask   (w/2)·(h/2) Bytes
waterDepthBiasMask  (w/2)·(h/2) Bytes
terrainTypeData     w·h Bytes
[wenn versionMinor >= 60] Skybox-Block  (s. Abschnitt 9)
propCount : u32
Prop[propCount]
```

**Prop-Record** (numerically verified, parser lands exactly on `data.length`):
```
cstr   blueprintPath   z. B. "/env/evergreen/props/trees/groups/pine06_groupa_prop.bp"
vec3   position        Welt-XYZ
vec3   rotationX       Basisvektor 1  (bei reiner Y-Drehung: (cos,0,sin))
vec3   rotationY       Basisvektor 2  (praktisch immer (0,1,0))
vec3   rotationZ       Basisvektor 3  (bei reiner Y-Drehung: (-sin,0,cos))
vec3   scale           praktisch immer (1,1,1)
```
= 3×3 rotation base, orthonormal (checked numerically: rotX*rotZ = 0).

Magnitude: SCMP_005 = **46,971 props**, SCMP_004/006 ≈ 27,000, typical 5,000-11,000. **207 distinct prop blueprints** across all maps. → GPU Instancing pro (Blueprint,LOD) is mandatory, not optional.

---

## 2. Props (trees/stones)

**Datenquelle:** SCMAP-Props-Liste (oben) → Blueprint in `env.scd` (335 `*_prop.bp`).

**Prop Blueprint Structure** (identical to Unit BPs, example `env/Evergreen/Props/Bush/eg_bush01_prop.bp`):
```
Display.Mesh.LODs = { { LODCutoff = 400, ShaderName = 'TMeshAlpha' } }
Display.UniformScale = 0.2
Display.Mesh.IconFadeInZoom = 4
Economy.ReclaimMassMax / ReclaimEnergyMax / ReclaimTime
Defense.Health / MaxHealth
Categories = { 'RECLAIMABLE' }
Physics.BlockPath = true
SizeX/SizeY/SizeZ
```
No explicit mesh path → **the existing resolution logic in `src/formats/unitPaths.ts` applies 1:1** (prefix from the BP directory: `eg_bush01` → `eg_bush01_lod0.scm`, `_albedo.dds`, `_normalsTS.dds`).

**Shader:** `ShaderName` is an *old* name and must be resolved via the alias table (see Section 8) — `TMeshAlpha` → **`NormalMappedAlpha`** (alpha-tested foliage!), `NormalMappedAlpha` remains. The technique says `PixelShader = NormalMappedPS(false,false,true, true, d3d_Greater, 0x80)` - i.e. h. **Alpha test with Ref 0x80**, no alpha blending.

**Don't confuse:** `moho/render/Clutter.{h,cpp}` is a *different* system — procedural ground scrub (grass), spread according to TerrainType density (`ClutterSurfaceEntry.density`, `ClutterSurfaceElement{selectionWeight, uniformScale, meshBlueprint}`), proprietary techniques `Clutter`/`UnderwaterClutter`. Optional, later.

**What the replica needs:** Parse the props list → load Mesh+Material once per blueprint → InstancedMesh with (position, 3×3 rotation, scale·UniformScale) → LOD/Cutoff from `LODCutoff` → Alpha test material. Props are also Sim objects (RECLAIMABLE, BlockPath) - but the render data is enough for the optics.

---

## 3. Decals

**Data source:** SCMAP decal list (we parse it, but we discard it) — per decal: `id, type(u32), texturen[], scale(vec3), position(vec3), rotation(vec3), cutOffLOD, nearCutOffLOD, ownerArmy`.

**Typ-Enum** (`CWldTerrainDecalTYPETypeInfo.h:12-25`):
`0 Undefined · 1 Albedo · 2 Normals · 3 WaterMask · 4 WaterAlbedo · 5 WaterNormals · 6 Glow · 7 NormalsAlpha · 8 GlowMask · 9 AlbedoXp`

Occurrences in the 60 original maps: **Type 2 (Normals) 75,683 · Type 1 (Albedo) 47,874** · Type 8 176 · Type 4 137 · Type 0 25 · Type 6 20. → Albedo+Normals are the essentials; Decals come as pairs with the same transform.

**Rendering (Original):** Decals are **not quads**, but the **terrain grid within the XZ-AABB of the decal is re-rasterized** (`CWldSplat::SplatVertex{position, texcoord}`) and projected into decal UV via `DecalMatrix`, alpha-blended over the terrain.

**DecalMatrix** (`CWldTerrainDecal.cpp:797-835`, Zeilenvektor-Konvention `mul(position, M)`):
```
M = translate(-position) · RotationY(rot.y) · RotationX(rot.x) · RotationZ(rot.z)
M = M mit Spalten x,y,z geteilt durch scale.x, scale.y, scale.z
TangentMatrix = RotationY(rot.y)          // dreht die Decal-Normale in Weltraum
```
In the shader: `mTexDecal = mul(position, DecalMatrix).xzyw` → `tex2Dproj` → **UV = (local.x, local.z)**, sampler on **CLAMP**.

**UV origin = CORNER, not center.** Evidence: `ProjectDecalBoundsXZ` (CWldTerrainDecal.cpp:155-183) spans the AABB from `position` to `position + R·scale` (offsets 0, xAxis, zAxis, xAxis+zAxis), and the Lua API explicitly converts center→corner:
`EffectLuaStartupRegistrations.cpp:219-222`:
```
position = center − 0.5·(rightXZ·size.x) − 0.5·(forwardXZ·size.z)
```
→ **For SCMAP decals, use `position` directly as the corner.** If the decals in the image appear offset by half a decal, the format stores midpoints and the same formula must be applied — *this is the one point to visually cross-check on a map.*

**Shader (terrain.fx):**
- `DecalsPS` (TDecals, line 1131): Albedo Mask DecalAlpha, light via the deferred normal buffer, water tint.
- `DecalAlbedoXP` (TDecalsXP, Zeile 1145): XP-Variante, `specularAmount = DecalSpec.a`, `mask = DecalMask.a`.
- `DecalsNormalsPS` (TDecalsNormals, line 1108): `decalNormal.xz = decalRaw.ag*2-1; decalNormal.y = sqrt(1-dot(xz,xz)); decalNormal = mul(TangentMatrix, decalNormal)` → is **blended into the normal buffer** (blend factor = `decalRaw.r`). i.e. Normals decals only work if the Deferred Normal pass exists.
- `DecalsPSWaterAlbedo` (1077): Vertex-Y is clamped to `WaterElevation+0.01`.
- `decalHeightOffset` (987) — Z-Fight-Offset.

`cutOffLOD` / `nearCutOffLOD` = Distance fade in/out (Dissolve).

---

## 4. Stratum-Normalmaps, TerrainScale, Skirts

### TerrainScale (exactly proven)
`HighFidelityTerrain.cpp:437-444`:
```
TerrainScale = ( 1/(heightField.width-1), 1/(heightField.height-1), 0, 1 )
             = ( 1/mapWidth, 1/mapHeight, 0, 1 )
```
`StratumMaterial.cpp:85-104` (`CStratumMaterial::SetSize`) + `:226-245` (`SetSizeTo`, maxSize = (width-1, height-1)):
```
Tile = ( mapWidth/albedoScale, mapHeight/albedoScale, 0, 1 )
```
`mTexWT = position.xzyw` applies in the shader, so
```
uv_maske  = mTexWT · TerrainScale            = worldXZ / mapSize     (0..1)
uv_stratum= mTexWT · TerrainScale · Tile     = worldXZ / albedoScale
```
→ **Our current `world / albedoScale` or `vUvMap` is exactly correct.** (Important: `.z=0, .w=1` ensure that `tex2Dproj` divides by 1.)

### Deferred-Normal-Buffer (the missing core)
The original **doesn't** calculate the terrain normal in the composite shader, but rather in two pre-passes into a **screen-sized RGBA buffer** (`NormalTexture`), which is then read via `SampleScreen(NormalSampler, mTexSS)`:

1. **TTerrainBasis** (`AlphaBlend_Disable_Write_BA`, ColorWrite 0x0C): `TerrainBasisPS` (terrain.fx:643) samples the **NormalMap** embedded in the scmap (via `NormalMapScale`/`NormalMapOffset`) and writes `.xxwy` → **B,A = geometry normal (x,z)**. (`TTerrainBasisBiCubic` variant with Bicubic filter via `BiCubicLookup`.)
2. **TTerrainNormals / TTerrainNormalsXP** (`AlphaBlend_Disable_Write_RG`, ColorWrite 0x03): `TerrainNormalsPS` (591) or `TerrainNormalsXP` (613) blind the **stratum normal maps** with the same masks as the albedos (`lerp(normal, stratumN, maskN)`, TTerrain only 0-3, XP 0-7) and write `.xy*0.5+0.5` → **R,G = Tangent Normal (x,y)**.
3. **frame.fx `TCreateBasis` / `BasisPS`** (frame.fx:279-320) kombiniert beides:
```
raw = tex2D(buffer) * 2 - 1;                      // x,y = Tangent-Normale, z,w = Basis
screenNormal = raw.xyy; screenNormal.z = sqrt(1 - x² - y²); screenNormal.xzy = screenNormal.xyz;
baseNormal.xz = raw.zw; baseNormal.y = sqrt(1 - x² - z²);
h = normalize(baseNormal + (0,1,0));              // TBN aus der Geometrie-Normale
xaxis = h.xxx*h.xyz * (-2,2,-2) + (1,0,0);
yaxis = baseNormal;
zaxis = h.zzz*h.xyz * (-2,2,-2) + (0,0,1);        // aterm.zyx
normal = (dot(screenNormal,xaxis), dot(screenNormal,yaxis), dot(screenNormal,zaxis)) * 0.5 + 0.5;
```
`NormalSampler` benutzt **POINT**-Filter + CLAMP.

**Reproduction recommendation:** Since we render forward, the same code can run **inline in the terrain fragment shader** (sample stratum normal maps + scmap normal map, build TBN, rotate) — mathematically identical, without extra RT. Only the normal **decals** need special treatment (or a real normal RT).

The stratum normal paths + scales are already in the SCMAP (9 entries, lines 261-264 discarded in our parser). In the original maps, **5 of them are occupied** (Lower + Stratum0-3) — matching TTerrain.

### Terrain shader variants (important!)
Over 60 maps: **TTerrain 39 · TTerrainXP 20 · TTerrainGlow 1.** We only implement XP.
- `TerrainPS` (694, TTerrain): only **4 Strata** + Upper; Light:
  `spec = pow(saturate(dot(R,viewDir)),80) · SpecularColor.x · (1-albedo.w)`, `R = SunDirection - 2·(Sun·N)·N`;
  `light = SunColor·saturate(Sun·N)·shadow + SunAmbience + spec`; `light = LightingMultiplier·light + ShadowFillColor·(1-light)`; **`color = light · albedo`** (Specular steckt *im* light).
- `TerrainAlbedoXP` (724): 8 Strata; `spec = pow(saturate(dot(reflect(viewDir,N),Sun)),80) · albedo.aaa · SpecularColor.a · SpecularColor.rgb`; **`albedo = light · (albedo + spec)`**.
- `TerrainGlowPS` (772): like TTerrain, but Stratum1 albedo with animated UV offset (`sincos(Time*0.125)*0.01`), whose alpha goes into the alpha channel as glow.
→ The `terrainShader` string from the scmap must select the shader variant (instead of our `stratumEnable` hack).

### Skirts
`HighFidelityTerrain::DrawTerrainSkirt` (:489) selects Technique `TTerrainSkirt`. `TerrainSkirtVS` (534) takes terrain grid points, `TerrainSkirtPS` (584) returns **constant `float4(0.1,0.1,0.1,0)`** — i.e. a simple **dark gray apron** around the map (`RasterizerState(Rasterizer_Cull_None)`). `SkirtTexture` = `/textures/engine/gridtest.dds` is bound but not used by the PS (legacy). Trivially reproducible.

Addition: `TerrainErrorScale = 1.0005` — the terrain in `calculateHomogenousCoordinate` is slightly scaled in view space (`viewSpace.xyz *= 1.0005`) so that it does not z-fight with the water plane in the distance.

---

## 5. Wasser (water2.fx, HighFidelityPS)

**All uniforms come 1:1 from the SCMAP water block** (which we already read but discard): `WaterElevation`, `waterColor(surfaceColor)`, `waterLerp(colorLerpMin/Max)`, `refractionScale`, `fresnelBias/fresnelPower`, `unitreflectionAmount`, `skyreflectionAmount`, `SunShininess/SunDirection/SunColor/sunReflectionAmount/SunGlow`, `normalRepeatRate(vec4)`, `normal1..4Movement(vec2)`, `SkyMap(texPathCubemap)`, `WaterRamp(texPathWaterRamp)`, the 4 wave normalmap paths.

**Wellen-Normalmaps (4 Layer):**
```
mLayerN = (worldXZ + normalNMovement · Time) · normalRepeatRate[N]      // VS, Zeile 315-318
W0..W3  = tex2D(NormalSamplerN, mLayerN)
sum     = W0+W1+W2+W3
waveCrest = saturate(sum.a - waveCrestThreshold)                        // waveCrestThreshold = 1
N       = 2.0*sum.xyz - 4.0                                             // = Σ (2·rgb − 1)
N       = normalize(N.xzy)                                              // .xzy → Y ist oben
N       = lerp(float3(0,1,0), N, waterTexture.r)                        // Flatness-Kanal
```
Texturen: `/textures/engine/waves.dds`, `waves000.dds`, `waves001.dds` — je **256×256, DXT3, 9 Mips**. RGB = Normale, **A = Wellenkamm**.

**WaterMap channels (UtilityTextureC) — exact:**
`R = Flatness` (0 = smooth, 1 = full waves) · `G = Tiefe` (index in WaterRamp + Fresnel) · `B = Wasser-Alphamaske` (→ `TWaterLayAlphaMask` gives `float4(0,0,0,mask.b)`) · `A = 1 − Foam` (comb blend: `lerp(color, waveCrestColor, (1 - waterTexture.a) · waveCrest)`).
The three semi-resolution 8-bit masks in SCMAP (Foam/Flatness/DepthBias) are the editor sources from which this DDS is baked.

**Sky-Cubemap:** `texCUBE(SkySampler, reflect(viewVector, N))`.
**Format (verified):** `SkyCube_*.dds` = **DXT1, 512×512, mips=0, caps2=0xFE00** (= CUBEMAP + all 6 faces). File length exactly `128 + 6·131072 = 786.560` → 6 faces in a row in the order **+X, −X, +Y, −Y, +Z, −Z**. (Also applies to `EnvCube_*` and `DefaultSkyCube.dds`.) So our DDS parser must support cubemap faces (`THREE.CubeTexture`).

**Refraktion:**
```
screenPos      = (mScreenPos.xy / w) · ViewportScaleOffset.xy + ViewportScaleOffset.zw
backGroundPixels = tex2D(RefractionSampler, screenPos)
mask           = saturate(backGroundPixels.a * 255)          // Alpha = Wassermaske
refractionPos  = screenPos − refractionScale · N.xz · (1/w)
refractedPixels= tex2D(RefractionSampler, refractionPos)
refractedPixels.xyz = lerp(refractedPixels, backGroundPixels, saturate(refractedPixels.w*255)).xyz  // Bleed-Schutz
```
→ **RefractionMap = the scene (terrain+units) in front of the water, into a screen RT.** Its **alpha is the water mask**.

**Reflexion:**
```
reflectedPixels = tex2D(ReflectionSampler, refractionPos)
reflectedPixels = lerp(skyReflection, reflectedPixels, saturate(unitreflectionAmount · reflectedPixels.w))
```
→ **ReflectionMap = the scene is rendered mirrored.** In mesh.fx the uniform **`mirrored`** controls this pass: `if (1 == mirrored) clip(vertex.depth.x)` (cuts away everything underwater) and `alpha = mirrored ? 0.5 : …`. Where the ReflectionMap has Alpha 0 → Sky Cubemap.

**Fresnel — exact formula** (`HighFidelityWater.cpp:100-146`, `BuildFresnelLookupTexture`, 128×128, 2 float channels):
```
// Spalte = Wassertiefe d, Zeile = Einfallswinkel i (= NdotV)
reflectionBlend = d · fresnelBias
R = clamp( reflectionBlend + (1 - reflectionBlend) · pow(1 - i, fresnelPower), 0, 1 )   // → .r, das ist "fresnel"
G = R · pow(i, sunShininess) · sunReflectionAmount
```
Im Shader: `fresnel = tex2D(FresnelSampler, float2(waterDepth, NDotL)).r` mit `NDotL = saturate(dot(-viewVector, N))`.
→ **Can be calculated directly inline, no lookup texture required** — replaces our silt approximation in `waterMaterial.ts:62-63`.

**Endkomposition:**
```
waterLerp = clamp(waterDepth, colorLerpMin, colorLerpMax)
refracted.xyz = lerp(refracted.xyz, waterColor, waterLerp)
skyreflectionAmount *= saturate(waterDepth · 10)
refracted = lerp(refracted, reflectedPixels, saturate(skyreflectionAmount · fresnel))
sunReflection = pow(saturate(dot(-R, SunDirection)), SunShininess) · SunColor · fresnel
refracted.xyz += sunReflection
refracted.xyz = lerp(refracted.xyz, waveCrestColor, (1 - waterTexture.a) · waveCrest)   // Foam
return float4(refracted.xyz, 1 - mask)
```

**Shorelines:** `TShoreline` (water2.fx:612) renders a **generated shore geometry** (`moho/terrain/water/Shoreline.{h,cpp}`, `ShoreCell.h`, `ren_ShorelineCutoff`) and writes **only alpha = 0** (`AlphaBlend_Disable_Write_A`, `Rasterizer_Cull_CCW`, `Depth_Enable_Less`) — so it "punches" the Remove the water mask from the shore so that the water doesn't run over the beach. Together with `TWaterLayAlphaMask` (from `UtilityC.b`) and `TDecalsWaterMask` (terrain.fx:1207) this builds the alpha mask of the RefractionMap.

**LowFidelity Water** (water2.fx:220-275) is a cheap 2-pass fallback (color from `UtilityC.g` + wave crest) — useful as an intermediate step.

---

## 6. Construction shader + wreck look (mesh.fx)

Common Varyings: **`vertex.material.y` = percentComplete (buildProgress 0→1)**, **`vertex.material.x` = Time/Animation Driver**. Textures: `albedoSampler`, `normalsSampler`, `specularSampler`, `secondarySampler` (construction overlay pattern), `falloffSampler` (seraphim ramp), `environmentSampler` (**Cubemap from scmap's EnvCube list!**).

| Technique | PS (Zeile) | Kern |
|---|---|---|
| `UEFBuild_*` | `UEFBuildHiFiPS` (2928) | Normal-mapped base; Team color only appears at 90%: `teamColor *= (pc>=0.9) ? (pc-0.9)*10 : 0`; `t = min(max(frac(0.02·time),0.35),0.7)`; `current = lerp(color+secondary, float3(0,0,1), t)`; `out = lerp(current, color, pc)`; `alpha = max(pc, 0.5)` → blue pulsation that disappears as you progress. Second pass: `UEFBuildOverlayHiFiPS` (2976), Alpha faded out in the last 5%. |
| `UEFBuildCube_*` | `UEFBuildCubePS` (3003) | The “scaffolding cube” mesh; Albedo 0.025, secondary 50, same blue Lerp logic. |
| `AeonBuild_*` | `AeonBuildPS` (2713) | Phong + Env cubemap; `light = 0.6·lightMultiplier·light + (1-light)·shadowFill`; `alpha = specular.b + glowMinimum`. Overlay pass `AeonBuildOverlayPS` (2748): two counter-scrolling masks (`mask1.r - mask2.g + mask1.g·mask2.r`). |
| `AeonBuildPuddle_*` | `AeonBuildPuddlePS` (2789) | scrollende UVs (`x -= mat.x·0.002`, `y += mat.x·0.0042`). |
| `CybranBuild_*` | `CybranBuildPS` (2837) + `CybranBuildOverlayPS` | Overlay-VS `EffectVertexNormalLoFiVS(14,4,0,0,-0.008,0.008)`. |
| `SeraphimBuild_*` | `SeraphimBuildPS` (2895) | UV distortion from `secondarySampler` (`uvaddress·0.03`), which fades out with `buildFractionMul = (pc-0.9)*10`; Falloff ramp like our already ported `UnitFalloffPS`; `alpha = max(pc, 0.25)`. Own depth technique `SeraphimBuildDepth`. |
| `Wreckage_*` | `WreckagePS` (2334) | **No shadow** (conscious); Spec-UV drifts with `frac(0.01·vertex.depth.y)`; `color = albedo · ComputeLight(dot(Sun,N),1)`; then `if (specular.g < 0.22) color *= (albedo+spec.r+spec.a)·spec.b·2.5; else color *= spec.b·2;` → the typical charred, crusty look. `alpha = glowMinimum`. |

---

## 7. Schild-Kuppeln (mesh.fx)

| Technique | VS-Parameter (4 UV-Sets: Skalen + Shift-Geschwindigkeiten) | PS |
|---|---|---|
| `ShieldUEF_*` | `FourUVTexShiftScaleVS(1,3,32,6, 0,0, 0.0003,0.005, -0.001,-0.005, -0.0003,-0.0008)` | `ShieldPS` (3076) |
| `ShieldCybran_*` | `FourUVTexShiftScaleVS(1,1,2,1, -0.01,0, -0.002,0, 0,0.0012, 0.001,-0.0015)` + 2. Pass `ShieldPositionNormalOffsetVS(0.01, …)` | `ShieldCybranPS(0.17)` (3145) |
| `ShieldAeon_*` | `ShieldNormalVS(1,12,8,3, 0,0, 0,0.032, 0.012,-0.032, 0,0.0012)` | `ShieldAeonPS` (3210) |
| `ShieldSeraphim_*` | `ShieldNormalVS(5,1,1,11, -0.00153,-0.0159, 0,0, 0.003,-0.0045, -0.005,-0.045)`, `environment = "<seraphim>"` | `ShieldSeraphimPS` (3260) |
| `SeraphimPersonalShield_*`, `PhaseShield_*`, `ShieldFill`, `ShieldImpact`, `CybranShieldImpact` | | |

`ShieldSeraphimPS` in detail (3260-3304): UV distortion from `normalsSampler` (`uvaddress.rb*0.1`); `dp = abs(cos(dot((0,1,0), normal)))`; `channel_color = 0.453 - clamp(1-dp, 0, 0.453)`; Above `t = 0.753` (near the top of the dome) `m = 1 - 0.7·(t-0.753)/(1-0.753)` is used to prevent transparency; `alpha = m·(dp2·0.3 + channel_color)·1.75`; Color `(0.425, 0.76274, 1.0) · dp² · specular.rgb` (blue tint).
All shields have `cartographicTechnique = "CartographicShield"`.

---

## 8. Fog of War / Range-Ringe / Selection / LOD / Silhouetten

### FoW + Ranges = Stencil-Shadow-Volumes (2-stufig)
**Stage 1 — Fill Stencil (ColorWrite = 0):**
- `vision.fx` `CastVision`: `visionVertexShader` scales a unit volume: `vertex.xz = radius·vertex.xz + position.xy`. FrontFace (Cull CCW): `StencilZFail = incr`; BackFace (Cull CW): `StencilZFail = decr`, `StencilFunc = always`, masks 0xFF.
- `vision.fx` `CastBoundaryCCW/CW`: Card boundary box (`boxCenter`, `boxExtent`), with DepthBias ±0.00001.
- `range.fx` `Cast`: **ellipse** instead of circle — `vertex.xz = (coeff.xx·radius.xx + coeff.yy·radius.yy)·vertex.xz + position.xy`; StencilWriteMask 0x7F, StencilMask 0x80, StencilRef 0xFF, `StencilFunc = notequal`, `StencilFail = zero`, ZFail incr/decr.

**Stufe 2 — Fullscreen-Quad in frame.fx:**
- `Vision` (598): `StencilFunc = equal`, Ref 0x00 → `VisionPS(0.33)` = `float4(0,0,0,0.33)`, SrcAlpha/InvSrcAlpha → **unexplored area is darkened by 33%**.
- `Boundary` (626): `StencilFunc = notequal`, `VisionPS(1.0)` → everything outside the map is completely black.
- `RangeMask` (518) → `RangeFill` (542, `RangePS(float4(1,1,1,0.125))`, StencilMask 0x80/Ref 0xFF/equal) → `RangeBurn` (570, `RangePS(rangeColor)`, StencilMask 0x7F/Ref 0x00/notequal, SrcBlend one/DestBlend zero) — 3 passes for fill + border.

### Strategic/Cartographic-Overlay
`frame.fx` `TStrategic` / `StrategicPS` (246): `color = tex(FrameSampler1)`, `overlay = tex(FrameSampler2)`, `fog = 1 - tex(FrameSampler3).r`; if `useStrategicOverlay`: `color = overlay.a·overlay.rgb + (1-overlay.a)·fog·color`; Alpha from a dissolve texture (`8·texcoord`) + `DissolveOffset`. mesh.fx has `CartographicUnit/Feature/Place/Build/Shield/Feedback` and `cartographic.fx`.

### Selection-Reticles
`moho/render/SelectionBracketParams.h`: `ren_SelectionSizeFudge`, `ren_SelectionHeightFudge`, `ren_UnitSelectionScale`, `ren_SelectBracketMinPixelSize`, `ren_SelectBracketSize` — the brackets have a **minimum pixel size** (so do not scale linearly with zoom).

### LOD system (`Mesh::ComputeLOD`, Mesh.cpp:4688-4724) — exact
```
for each LOD in order:
    cutoff = lod.cutoff                       // = LODCutoff aus dem Blueprint
    if (cutoff <= 0)               return lod   // 0/fehlend = immer sichtbar
    if (lod.useDissolve) {
        if (distance <= cutoff + ren_MeshDissolve) return lod
        return nullptr                          // sonst GAR NICHT zeichnen
    }
    if (distance <= cutoff)        return lod
return nullptr                                  // jenseits der letzten LOD: unsichtbar
```
`MeshLOD` (Mesh.h:388-403) also has `scrolling`, `occlude`, **`silhouette`** flags. `GetMaxCutoff() = lastLod.cutoff + ren_MeshDissolve`. Camera has a `LODScale` (`cam_SetLOD`).

### Silhouetten
mesh.fx `Silhouette` (Technique 3715) renders hidden units into the stencil; frame.fx `TSilhouette` (658) then fills **wherever the stencil is 0x03**, the constant `silhouetteColor` (default `float4(0,0,1,1)`) - units behind terrain shine through as a colored silhouette. Can be activated per LOD via the `silhouette` flag.

### Legacy ShaderName Resolution (Mesh.cpp:2534-2583) — **missing**
```
TMeshNoLighting→Flat · TMeshNoNormals→VertexNormal · TMeshAlpha→NormalMappedAlpha
TMeshGlow→NormalMappedGlow · TMeshTerrain→NormalMappedTerrain · Simple→Unit · Team→Unit
TMeshAlphaGlowFade→UnitBuild · TMeshMetalBuild→AeonBuild · TMeshShield→Shield · TMeshZFill→ShieldFill
TMeshAdd→Effect · TMeshExplosion→Explosion · TMeshCloud→Cloud · TMeshOuterCloud→OuterCloud
TMeshEMPNuke→NukeEMP · TMeshQuantumNuke→NukeQuantum · TMeshTemporalBubble→TemporalBubble
leerer Name → "Unit"
```
Then: Technique = `<resolved>_<HighFidelity|MedFidelity|LowFidelity>`.

---

## 9. Sky / Background of the map

### SCMAP v60 Skybox block (decoded by me; **independently confirmed** by `sky.fx` and `SkyDome.cpp`)
```
vec3   position              (z. B. 512, 0, 512 = Kartenmitte)
float  horizonHeight         (-42.5)
float  scale                 (2343.16)
float  subHeight             (1.2566371)
int32  subDivAx              (16)
int32  subDivHeight          (6)
float  zenithHeight          (293.5)
vec3   horizonColor          (0.649, 0.820, 0.840)
vec3   zenithColor           (0.220, 0.410, 0.720)
float  decalGlowMultiplier   (0.1)
cstr   albedo                "/textures/environment/Decal_test_Albedo003.dds"
cstr   glow                  "/textures/environment/Decal_test_Glow003.dds"
int32  planetCount           (9)
Planet[planetCount] = { vec3 position; float rotation; vec2 scale; vec4 uv }   // 10 floats = 40 B
uint8  midRgbColor[3]
float  cirrusMultiplier      (1.8)
vec3   cirrusColor           (1.16, 1.16, 1.23)
cstr   cirrusTexture         "/textures/environment/cirrus000.dds"
int32  cirrusLayerCount      (4)
CirrusLayer[count] = { vec2 frequency; float speed; vec2 direction }           // 5 floats = 20 B
float  clouds7               (0.0)
```
**Counterproof:** `SkyDome.cpp:56-75` sets `mDomeShapeParams.z = 1.2566371f; mWidth = 16; mHeight = 6;` — identical to subHeight/subDivAx/subDivHeight. `sky.fx:99-107` declares `struct Cirrus { float2 frequency; float1 speed; float2 direction; }` + `Cirrus aCirrus[4]` + `cirrusMultiplier` + `cirrusColor` — exactly my decoded structure. `SkyDome.cpp:158` calls `/textures/environment/horizonLookup.dds`.

### sky.fx passes
- **`Atmosphere`** (`DomeVS`/`AtmospherePS`, 229): Hemispherical dome (16×6 segments); `th = theta/2π`, `tv = (elevation - horizonBegin)/(horizonEnd - horizonBegin)`; `t = horizonLookup(th,0.25).a · horizonLookup(tv,0.75).a`; `color = lerp(horizonColor, skyColor, 1-t)`. No Z-Test/Write, Cull CW.
- **`Decal`** (`DecalVS`/`DecalAlbedoPS`, 175/238): the **9 “Planets”** as billboards — `texcoord = uv.xy + 0.5·uv.zw·(corner+1)` (i.e. `uv` = sub-rectangle in the atlas), rotation around `position.w`, spanned with `viewRight`/`viewUp`. Pass P1 adds the glow (`decalGlowMultiplier · glow.a`).
- **`Cirrus`** (`CirrusPS`, 264): 4 layers of **one** texture, one channel each: `alpha = cirrusMultiplier · c0.r · c1.g · c2.b · c3.a`; UV per layer: `computeCirrusCoord` = rotation by `direction`, then `frequency · (position - time·speed·direction)`.
- **`Cumulus`** (249): 3D cloud particles with light/dispersion ramps (not from the scmap; optional).

### Background
SCMAP header field `background` → only two values ​​in the original maps: `/textures/environment/defaultbackground.dds` (**1024×1024, DXT5, no mips, no cubemap**) and `/textures/environment/blackbackground.dds` (16×16 DXT5). Rendered via `frame.fx` `TBackground`/`BackgroundPS` (168): Fullscreen, `dissolve = tex(FrameSamplerWrap2, 8·Tex1).a`, `alpha = saturate(dissolve + DissolveOffset)` → is displayed when zooming out into the strategic view.

Header field `skyCubemap` → 24 different `SkyCube_*.dds`/`EnvCube_*.dds` (DXT1 cubemaps, see above). Additionally, the **EnvCube list** (`envCubeCount` × (name, path)) — it feeds `environmentSampler` into mesh.fx (unit/build/shield shader), e.g. B. Name `<seraphim>`.

---

## Priorisierter Umsetzungsvorschlag

1. **Complete SCMAP parser** (props, skybox, keep decals, stratum normals, all water fields, EnvCubes, TerrainType) — pure data work, everything verified, blocks 1/2/3/4/9.
2. **DDS Cubemap Support** (6 Faces, DXT1) — blocks water reflection + unit env maps + shields.
3. **Terrain: Select shader variant according to `terrainShader`** (TTerrain/TTerrainXP/TTerrainGlow) + **Stratum normal maps inline** (Basic PS-TBN mathematics) — biggest optical leap, replaces the `stratumEnable` hack.
4. **Props** (Instancing, LOD, ShaderName Alias ​​Table, Alpha Test).
5. **Decals** (Albedo + Normals) — needs terrain re-rasterization in the decal AABB.
6. **Water full** (4 wave layers, exact Fresnel, sky cube map; refraction/reflection as 2 screen RTs).
7. **Skybox** (Dome 16×6, Planets, Cirrus) + Background.
8. **Skirt** (trivial), **LOD rule** (accept exactly), **Legacy ShaderName table**.
9. **FoW/Range/Silhouette** (Stencil Volumes) — usefully comes with the Intel system.

## Refs
- faf-re: src/sdk/moho/terrain/HighFidelityTerrain.cpp:375-470 (LoadShaderVars; TerrainScale = 1/(w-1), 1/(h-1), 0, 1; UtilityTextureA/B/C-Bindung)
- faf-re: src/sdk/moho/terrain/HighFidelityTerrain.cpp:489-520 (DrawTerrainSkirt → Technique "TTerrainSkirt")
- faf-re: src/sdk/moho/terrain/StratumMaterial.cpp:85-104 (CStratumMaterial::SetSize → mScaleX = maxSize.x / mSize)
- faf-re: src/sdk/moho/terrain/StratumMaterial.cpp:226-245 (SetSizeTo → maxSize = (heightField.width-1, height-1))
- faf-re: src/sdk/moho/terrain/StratumMaterial.h:23-33 (CStratumMaterial: mScaleX, mScaleY, v3=0, v4=1 → the float4 'Tile')
- faf-re: src/sdk/moho/terrain/water/HighFidelityWater.cpp:100-146 (BuildFresnelLookupTexture — exakte Fresnel-Formel, 128x128)
- faf-re: src/sdk/moho/terrain/water/HighFidelityWater.cpp:290-365 (LoadShaderVars, refractionTexture + reflectionTexture)
- faf-re: src/sdk/moho/terrain/water/Shoreline.h (Shoreline, ShoreCell, ren_Shoreline, ren_ShorelineCutoff)
- faf-re: src/sdk/moho/terrain/water/WaterShaderVars.h:7-53 (all water2.fx uniforms 1:1 to SCMAP water block)
- faf-re: src/sdk/moho/render/CWldTerrainDecalTYPETypeInfo.h:12-25 (Decal-Typ-Enum 0..9)
- faf-re: src/sdk/moho/render/CWldTerrainDecal.cpp:117-183 (RotationAxisX/Y/Z, ProjectDecalBoundsXZ, ApplyInverseScaleToTextureMatrix)
- faf-re: src/sdk/moho/render/CWldTerrainDecal.cpp:797-835 (Update → DecalMatrix + TangentMatrix)
- faf-re: src/sdk/moho/render/CDecalTypes.h:89-101 (SDecalInfo: mPos, mSize, mRot, mTexName1/2, mIsSplat, mLODParam, mType, mArmy, mFidelity)
- faf-re: src/sdk/moho/effects/rendering/EffectLuaStartupRegistrations.cpp:196-247 (CreateDecalFromTransform — Mitte→Ecke-Umrechnung)
- faf-re: src/sdk/moho/terrain/splat/CWldSplat.h:61-137 (CWldSplat : CWldTerrainDecal, SplatVertex{position, texcoord})
- faf-re: src/sdk/moho/render/SkyDome.cpp:56-75 and :157-159 (Dome 16x6, subHeight 1.2566371, horizonLookup.dds, cirrus000.dds)
- faf-re: src/sdk/moho/mesh/Mesh.cpp:4688-4724 (Mesh::ComputeLOD — exakte LOD-Regel)
- faf-re: src/sdk/moho/mesh/Mesh.cpp:2534-2583 (ShaderDictionaryRuntime — legacy ShaderName alias table + ResolveShaderAnnotationName)
- faf-re: src/sdk/moho/mesh/Mesh.h:388-403 (MeshLOD: useDissolve, cutoff, scrolling, occlude, silhouette)
- faf-re: src/sdk/moho/render/Clutter.h:39-93 (ClutterSurfaceElement/Entry — procedural ground scrub, NOT the map props)
- faf-re: src/sdk/moho/render/SelectionBracketParams.h:10-35 (ren_SelectBracketSize, ren_SelectBracketMinPixelSize, ren_UnitSelectionScale)
- effects.scd: effects/terrain.fx:111 (TerrainScale), :534-587 (TerrainSkirtVS/PS), :591-640 (TerrainNormalsPS / TerrainNormalsXP), :643-691 (TerrainBasisPS / BiCubic), :694-722 (TerrainPS = TTerrain), :724-770 (TerrainAlbedoXP), :772-807 (TerrainGlowPS), :852-975 (Techniques), :989-1225 (DecalsVS, DecalsPS, DecalAlbedoXP, DecalsNormalsPS, DecalsPSWaterAlbedo/WaterMask), :1231-1360 (Decal-Techniques)
- effects.scd: effects/frame.fx:168-186 (BackgroundPS), :246-263 (StrategicPS), :279-320 (BasisPS — TBN-Rekonstruktion), :518-596 (RangeMask/RangeFill/RangeBurn), :598-652 (Vision/Boundary), :658-673 (TSilhouette), :733 (TCreateBasis)
- effects.scd: effects/water2.fx:294-327 (WaterVS — 4 Wellen-Layer), :329-496 (HighFidelityPS — Refraktion/Reflexion/Fresnel/Foam), :563-580 (TWaterLayAlphaMask), :612-629 (TShoreline)
- effects.scd: effects/sky.fx:99-107 (struct Cirrus), :146-197 (DomeVS/DecalVS), :229-272 (AtmospherePS, DecalAlbedoPS/GlowPS, CumulusPS, CirrusPS), :274-353 (Techniques)
- effects.scd: effects/range.fx:18-79 (Ellipsen-Stencil-Volumes), effects/vision.fx:25-202 (CastVision, CastBoundaryCCW/CW)
- effects.scd: effects/mesh.fx:2145 (ClutterPS), :2170 (NormalMappedPS), :2334-2366 (WreckagePS), :2713-2836 (AeonBuildPS/OverlayPS/PuddlePS), :2837 (CybranBuildPS), :2895-2923 (SeraphimBuildPS), :2928-3036 (UEFBuildHiFiPS/Overlay/Cube), :3076-3304 (ShieldPS, ShieldCybranPS, ShieldAeonPS, ShieldSeraphimPS), :3568-6505 (all techniques)
- effects.scd: effects/d3d9states.compat (AlphaBlend_Disable_Write_RG = ColorWriteEnable 0x03; _Write_BA = 0x0C)
- env.scd: env/Evergreen/Props/Bush/eg_bush01_prop.bp, env/Evergreen/Props/Rocks/Rock01_prop.bp (PropBlueprint structure; 335 *_prop.bp total)
- textures.scd: textures/environment/SkyCube_*.dds (DXT1 512x512, mips=0, caps2=0xFE00 → real cubemap, 6x131072 B), DefaultBackground.dds (DXT5 1024x1024), textures/engine/waves{,000,001}.dds (DXT3 256x256, 9 Mips)
- Maps: C:\Program Files (x86)\Steam\steamapps\common\Supreme Commander Forged Alliance\maps\SCMP_0XX\SCMP_0XX.scmap (60 maps, all v60; TTerrain 39 / TTerrainXP 20 / TTerrainGlow 1)
- Verification scripts (Scratchpad): scratchpad/verifyTail.ts (60/60 exact up to EOF), scratchpad/findProps.ts (props record confirmed numerically), scratchpad/scmapTail.ts, scratchpad/hexTail.ts
- Replica (to be adapted): src/formats/scmap.ts:309-310 (parser stops here), src/viewer/terrainMaterial.ts (only TerrainAlbedoXP, no stratum normals), src/viewer/waterMaterial.ts:62-63 (approximate Fresnel), src/formats/unitPaths.ts (also applies to Props), src/viewer/unitMaterial.ts (ShaderName selection — Alias table missing)
