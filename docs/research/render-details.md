# agent10

## Summary
Alle 9 Render-Features sind aus faf-re + effects.scd-Shadern + Spieldaten aufgeklärt und teilweise numerisch verifiziert. Kernbefund: Der SCMAP-Parser bricht heute nach der WaterMap ab — dahinter liegen Foam/Flatness/DepthBias-Masken, TerrainType, der v60-Skybox-Block und die Props-Liste. Ich habe die komplette Schwanz-Struktur dekodiert und über alle 60 Original-Karten verifiziert (Parser landet 60/60 exakt auf EOF); der Skybox-Block wurde unabhängig durch sky.fx + SkyDome.cpp bestätigt. Zusätzlich: TerrainScale/Tiling-Semantik exakt belegt (unser Tiling ist korrekt), die Original-Terrain-Beleuchtung läuft über einen Deferred-Normal-Buffer (TTerrainBasis + TTerrainNormals → frame.fx BasisPS), und 39 von 60 Karten benutzen TTerrain (4 Strata), nicht das von uns implementierte TTerrainXP.

## Key Facts
- SCMAP-Schwanz vollständig dekodiert und über 60/60 Original-Karten bis exakt EOF verifiziert: nach WaterMap folgen 3× (w/2·h/2)-Byte-Masken (Foam, Flatness, DepthBias), TerrainType (w·h Bytes), bei v60 ein Skybox-Block, dann die Props-Liste.
- Prop-Record = cstr(blueprintPfad) + position(vec3) + rotX(vec3) + rotY(vec3) + rotZ(vec3) + scale(vec3); die 3 Rotationsvektoren sind die Basis einer 3×3-Rotationsmatrix. Bis zu 46.971 Props pro Karte (SCMP_005) → Instancing zwingend.
- TerrainScale = (1/mapWidth, 1/mapHeight, 0, 1) und StratumTile = (mapSize/albedoScale, ·, 0, 1) — beides multipliziert ergibt uv = worldXZ/albedoScale. Unser aktuelles Tiling ist damit bereits exakt richtig (belegt in HighFidelityTerrain.cpp + StratumMaterial.cpp).
- Die Original-Terrain-Normale kommt aus einem Deferred-Screen-Buffer: TTerrainBasis schreibt BA (Geometrie-Normale aus der scmap-NormalMap), TTerrainNormals(XP) schreibt RG (geblendete Stratum-Normalmaps), frame.fx BasisPS baut daraus eine TBN und rotiert die Tangent-Normale in Weltkoordinaten.
- 39 von 60 Karten benutzen 'TTerrain' (nur 4 Strata, andere Licht-/Specular-Formel), 20 'TTerrainXP', 1 'TTerrainGlow' — wir implementieren aktuell nur TerrainAlbedoXP für alle.
- Skycube-DDS sind echte DDS-Cubemaps: DXT1, 512×512, KEINE Mips, caps2=0xFE00, 6 Faces à 131.072 Bytes in Reihenfolge +X,−X,+Y,−Y,+Z,−Z (Dateilänge exakt 128 + 6·131072 = 786.560).
- Wasser-Fresnel ist eine prozedural erzeugte 128×128-Lookup-Textur: fresnel = d·bias + (1 − d·bias)·(1 − NdotV)^fresnelPower, mit d = Wassertiefe; fresnelBias/fresnelPower liest unser Parser bereits, verwirft sie aber.
- WaterMap-Kanäle (UtilityTextureC) exakt: R = Flatness (Wellenstärke), G = Tiefe, B = Wasser-Alphamaske, A = 1 − Foam.
- Decal-Typen sind ein Enum (1=Albedo, 2=Normals, 3=WaterMask, 4=WaterAlbedo, 6=Glow, 8=GlowMask, 9=AlbedoXp); in den Originalkarten dominieren Typ 2 (75.683) und Typ 1 (47.874).
- DecalMatrix = translate(−pos) · Ry · Rx · Rz · scale(1/scale), UV = (x,z) des Ergebnisses; die Lua-API CreateDecal rechnet Mitte→Ecke um (pos = center − 0.5·(right·sizeX + forward·sizeZ)), d. h. SDecalInfo.mPos ist die ECKE des lokalen [0,1]²-Quadrats.
- LOD-Auswahl (Mesh::ComputeLOD): erste LOD in Reihenfolge mit cutoff<=0 (immer) ODER distance<=cutoff; bei useDissolve gilt distance<=cutoff+ren_MeshDissolve, sonst wird gar nichts gezeichnet.
- Legacy-ShaderName-Alias-Tabelle gefunden (Mesh.cpp ShaderDictionary): TMeshAlpha→NormalMappedAlpha, TMeshGlow→NormalMappedGlow, TMeshNoLighting→Flat, TMeshNoNormals→VertexNormal, Simple/Team→Unit, leer→Unit — Prop-Blueprints nutzen genau diese alten Namen.
- FoW und Range-Ringe sind Stencil-Shadow-Volumes: vision.fx/range.fx rendern Zylinder/Ellipsen nur in den Stencil (ColorWrite=0), danach füllt frame.fx per Fullscreen-Quad (Vision: schwarz mit Alpha 0.33; RangeFill: weiß 0.125; RangeBurn: rangeColor).
- Wasser braucht 2 Screen-Rendertargets: RefractionMap (Szene vor dem Wasser; Alpha = Wassermaske) und ReflectionMap (Szene gespiegelt, mesh.fx-Uniform 'mirrored' clippt Fragmente unter Wasser); wo die ReflectionMap leer ist, wird die Sky-Cubemap benutzt.
- Terrain-Skirt ist trivial: TTerrainSkirt rendert eine Schürze um die Karte, TerrainSkirtPS gibt konstant float4(0.1,0.1,0.1,0) zurück (dunkelgraue Fläche).

## Details
## 0. Ausgangslage im Nachbau

`src/formats/scmap.ts` **bricht nach der WaterMap ab** (Kommentar Zeile 309-310). Damit fehlen als Datenquelle: Props, Decals (werden geparst, aber verworfen), Stratum-Normal-Pfade, TerrainType, Foam/Flatness/DepthBias-Masken, der Skybox-Block, sowie fast alle Wasser-Felder (fresnelBias/Power, unitReflection, skyReflection, sunShininess/Strength, Wasser-Sonne, sunGlow, texPathCubemap, die 4 Wellen-Normalmaps + Repeat-Raten) und die EnvCube-Liste.

`src/viewer/terrainMaterial.ts` implementiert nur `TerrainAlbedoXP` (+ eigener `stratumEnable`-Hack), `src/viewer/waterMaterial.ts` nur eine Näherung ohne Wellen/Cubemap/Refraktion.

---

## 1. SCMAP-Schwanz — vollständig dekodiert, 60/60 Karten exakt bis EOF

Verifikationsskript: `…/scratchpad/verifyTail.ts` (Ergebnis: `EXAKT BIS EOF: 60/60`).

Reihenfolge **nach** dem bereits geparsten `waterMap`-DDS:

```
waterFoamMask       (w/2)·(h/2) Bytes
waterFlatnessMask   (w/2)·(h/2) Bytes
waterDepthBiasMask  (w/2)·(h/2) Bytes
terrainTypeData     w·h Bytes
[wenn versionMinor >= 60] Skybox-Block  (s. Abschnitt 9)
propCount : u32
Prop[propCount]
```

**Prop-Record** (numerisch verifiziert, Parser landet exakt auf `data.length`):
```
cstr   blueprintPath   z. B. "/env/evergreen/props/trees/groups/pine06_groupa_prop.bp"
vec3   position        Welt-XYZ
vec3   rotationX       Basisvektor 1  (bei reiner Y-Drehung: (cos,0,sin))
vec3   rotationY       Basisvektor 2  (praktisch immer (0,1,0))
vec3   rotationZ       Basisvektor 3  (bei reiner Y-Drehung: (-sin,0,cos))
vec3   scale           praktisch immer (1,1,1)
```
= 3×3-Rotationsbasis, orthonormal (numerisch geprüft: rotX·rotZ = 0).

Größenordnung: SCMP_005 = **46.971 Props**, SCMP_004/006 ≈ 27.000, typisch 5.000–11.000. **207 distinkte Prop-Blueprints** über alle Karten. → GPU-Instancing pro (Blueprint,LOD) ist Pflicht, nicht Kür.

---

## 2. Props (Bäume/Steine)

**Datenquelle:** SCMAP-Props-Liste (oben) → Blueprint in `env.scd` (335 `*_prop.bp`).

**Prop-Blueprint-Struktur** (identisch zu Unit-BPs, Beispiel `env/Evergreen/Props/Bush/eg_bush01_prop.bp`):
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
Kein expliziter Mesh-Pfad → **die vorhandene Auflösungslogik in `src/formats/unitPaths.ts` greift 1:1** (Präfix aus dem BP-Verzeichnis: `eg_bush01` → `eg_bush01_lod0.scm`, `_albedo.dds`, `_normalsTS.dds`).

**Shader:** `ShaderName` ist ein *alter* Name und muss über die Alias-Tabelle aufgelöst werden (s. Abschnitt 8) — `TMeshAlpha` → **`NormalMappedAlpha`** (alpha-getestetes Laub!), `NormalMappedAlpha` bleibt. In der Technique steht `PixelShader = NormalMappedPS(false,false,true, true, d3d_Greater, 0x80)` — d. h. **Alpha-Test mit Ref 0x80**, kein Alpha-Blending.

**Nicht verwechseln:** `moho/render/Clutter.{h,cpp}` ist ein *anderes* System — prozedurales Bodengestrüpp (Gras), gestreut nach TerrainType-Dichte (`ClutterSurfaceEntry.density`, `ClutterSurfaceElement{selectionWeight, uniformScale, meshBlueprint}`), eigene Techniques `Clutter`/`UnderwaterClutter`. Optional, später.

**Was der Nachbau braucht:** Props-Liste parsen → pro Blueprint einmal Mesh+Material laden → InstancedMesh mit (position, 3×3-Rotation, scale·UniformScale) → LOD/Cutoff aus `LODCutoff` → Alpha-Test-Material. Props sind gleichzeitig Sim-Objekte (RECLAIMABLE, BlockPath) — die Renderdaten reichen aber für die Optik.

---

## 3. Decals

**Datenquelle:** SCMAP-Decal-Liste (parsen wir schon, verwerfen wir aber) — pro Decal: `id, type(u32), texturen[], scale(vec3), position(vec3), rotation(vec3), cutOffLOD, nearCutOffLOD, ownerArmy`.

**Typ-Enum** (`CWldTerrainDecalTYPETypeInfo.h:12-25`):
`0 Undefined · 1 Albedo · 2 Normals · 3 WaterMask · 4 WaterAlbedo · 5 WaterNormals · 6 Glow · 7 NormalsAlpha · 8 GlowMask · 9 AlbedoXp`

Vorkommen in den 60 Originalkarten: **Typ 2 (Normals) 75.683 · Typ 1 (Albedo) 47.874** · Typ 8 176 · Typ 4 137 · Typ 0 25 · Typ 6 20. → Albedo+Normals sind das Wesentliche; Decals kommen als Paare mit gleicher Transform.

**Rendering (Original):** Decals sind **keine Quads**, sondern es wird das **Terrain-Gitter innerhalb der XZ-AABB des Decals neu rasterisiert** (`CWldSplat::SplatVertex{position, texcoord}`) und per `DecalMatrix` in Decal-UV projiziert, alpha-geblendet über das Terrain.

**DecalMatrix** (`CWldTerrainDecal.cpp:797-835`, Zeilenvektor-Konvention `mul(position, M)`):
```
M = translate(-position) · RotationY(rot.y) · RotationX(rot.x) · RotationZ(rot.z)
M = M mit Spalten x,y,z geteilt durch scale.x, scale.y, scale.z
TangentMatrix = RotationY(rot.y)          // dreht die Decal-Normale in Weltraum
```
Im Shader: `mTexDecal = mul(position, DecalMatrix).xzyw` → `tex2Dproj` → **UV = (lokal.x, lokal.z)**, Sampler auf **CLAMP**.

**UV-Ursprung = ECKE, nicht Mitte.** Beleg: `ProjectDecalBoundsXZ` (CWldTerrainDecal.cpp:155-183) spannt die AABB von `position` bis `position + R·scale` (Offsets 0, xAxis, zAxis, xAxis+zAxis), und die Lua-API rechnet explizit Mitte→Ecke um:
`EffectLuaStartupRegistrations.cpp:219-222`:
```
position = center − 0.5·(rightXZ·size.x) − 0.5·(forwardXZ·size.z)
```
→ **Für SCMAP-Decals `position` direkt als Ecke verwenden.** Falls die Decals im Bild um ein halbes Decal versetzt wirken, speichert das Format Mittelpunkte und dieselbe Formel muss angewandt werden — *das ist der eine Punkt, der visuell an einer Karte gegenzuprüfen ist.*

**Shader (terrain.fx):**
- `DecalsPS` (TDecals, Zeile 1131): Albedo·Mask·DecalAlpha, Licht über den Deferred-Normal-Buffer, Wasser-Tint.
- `DecalAlbedoXP` (TDecalsXP, Zeile 1145): XP-Variante, `specularAmount = DecalSpec.a`, `mask = DecalMask.a`.
- `DecalsNormalsPS` (TDecalsNormals, Zeile 1108): `decalNormal.xz = decalRaw.ag*2-1; decalNormal.y = sqrt(1-dot(xz,xz)); decalNormal = mul(TangentMatrix, decalNormal)` → wird **in den Normal-Buffer geblendet** (Blend-Faktor = `decalRaw.r`). D. h. Normals-Decals wirken nur, wenn der Deferred-Normal-Pass existiert.
- `DecalsPSWaterAlbedo` (1077): Vertex-Y wird auf `WaterElevation+0.01` geklemmt.
- `decalHeightOffset` (987) — Z-Fight-Offset.

`cutOffLOD` / `nearCutOffLOD` = Entfernungs-Ein-/Ausblendung (Dissolve).

---

## 4. Stratum-Normalmaps, TerrainScale, Skirts

### TerrainScale (exakt belegt)
`HighFidelityTerrain.cpp:437-444`:
```
TerrainScale = ( 1/(heightField.width-1), 1/(heightField.height-1), 0, 1 )
             = ( 1/mapWidth, 1/mapHeight, 0, 1 )
```
`StratumMaterial.cpp:85-104` (`CStratumMaterial::SetSize`) + `:226-245` (`SetSizeTo`, maxSize = (width-1, height-1)):
```
Tile = ( mapWidth/albedoScale, mapHeight/albedoScale, 0, 1 )
```
Im Shader gilt `mTexWT = position.xzyw`, also
```
uv_maske  = mTexWT · TerrainScale            = worldXZ / mapSize     (0..1)
uv_stratum= mTexWT · TerrainScale · Tile     = worldXZ / albedoScale
```
→ **Unser aktuelles `world / albedoScale` bzw. `vUvMap` ist exakt richtig.** (Wichtig: `.z=0, .w=1` sorgen dafür, dass `tex2Dproj` durch 1 teilt.)

### Deferred-Normal-Buffer (das fehlende Kernstück)
Das Original berechnet die Terrain-Normale **nicht** im Composite-Shader, sondern in zwei Vorpässen in einen **screengroßen RGBA-Buffer** (`NormalTexture`), der dann per `SampleScreen(NormalSampler, mTexSS)` gelesen wird:

1. **TTerrainBasis** (`AlphaBlend_Disable_Write_BA`, ColorWrite 0x0C): `TerrainBasisPS` (terrain.fx:643) sampelt die **in der scmap eingebettete NormalMap** (via `NormalMapScale`/`NormalMapOffset`) und schreibt `.xxwy` → **B,A = Geometrie-Normale (x,z)**. (Variante `TTerrainBasisBiCubic` mit Bicubic-Filter via `BiCubicLookup`.)
2. **TTerrainNormals / TTerrainNormalsXP** (`AlphaBlend_Disable_Write_RG`, ColorWrite 0x03): `TerrainNormalsPS` (591) bzw. `TerrainNormalsXP` (613) blenden die **Stratum-Normalmaps** mit denselben Masken wie die Albedos (`lerp(normal, stratumN, maskN)`, TTerrain nur 0-3, XP 0-7) und schreiben `.xy*0.5+0.5` → **R,G = Tangent-Normale (x,y)**.
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

**Nachbau-Empfehlung:** Da wir forward rendern, kann derselbe Code **inline im Terrain-Fragmentshader** laufen (Stratum-Normalmaps + scmap-NormalMap sampeln, TBN bauen, rotieren) — mathematisch identisch, ohne Extra-RT. Nur die Normals-**Decals** brauchen dann eine Sonderbehandlung (oder doch einen echten Normal-RT).

Die Stratum-Normal-Pfade + Skalen stehen bereits im SCMAP (9 Einträge, in unserem Parser Zeile 261-264 verworfen). In den Originalkarten sind **5 davon belegt** (Lower + Stratum0-3) — passend zu TTerrain.

### Terrain-Shader-Varianten (wichtig!)
Über 60 Karten: **TTerrain 39 · TTerrainXP 20 · TTerrainGlow 1.** Wir implementieren nur XP.
- `TerrainPS` (694, TTerrain): nur **4 Strata** + Upper; Licht:
  `spec = pow(saturate(dot(R,viewDir)),80) · SpecularColor.x · (1-albedo.w)`, `R = SunDirection - 2·(Sun·N)·N`;
  `light = SunColor·saturate(Sun·N)·shadow + SunAmbience + spec`; `light = LightingMultiplier·light + ShadowFillColor·(1-light)`; **`color = light · albedo`** (Specular steckt *im* light).
- `TerrainAlbedoXP` (724): 8 Strata; `spec = pow(saturate(dot(reflect(viewDir,N),Sun)),80) · albedo.aaa · SpecularColor.a · SpecularColor.rgb`; **`albedo = light · (albedo + spec)`**.
- `TerrainGlowPS` (772): wie TTerrain, aber Stratum1-Albedo mit animiertem UV-Offset (`sincos(Time*0.125)*0.01`), dessen Alpha als Glow in den Alpha-Kanal geht.
→ Der `terrainShader`-String aus der scmap muss die Shader-Variante wählen (statt unseres `stratumEnable`-Hacks).

### Skirts
`HighFidelityTerrain::DrawTerrainSkirt` (:489) wählt Technique `TTerrainSkirt`. `TerrainSkirtVS` (534) nimmt Terrain-Gitterpunkte, `TerrainSkirtPS` (584) gibt **konstant `float4(0.1,0.1,0.1,0)`** zurück — also eine schlichte **dunkelgraue Schürze** um die Karte (`RasterizerState(Rasterizer_Cull_None)`). `SkirtTexture` = `/textures/engine/gridtest.dds` wird zwar gebunden, vom PS aber nicht benutzt (Legacy). Trivial nachbaubar.

Zusatz: `TerrainErrorScale = 1.0005` — das Terrain wird in `calculateHomogenousCoordinate` in View-Space leicht skaliert (`viewSpace.xyz *= 1.0005`), damit es in der Ferne nicht mit der Wasserebene z-fightet.

---

## 5. Wasser (water2.fx, HighFidelityPS)

**Alle Uniforms kommen 1:1 aus dem SCMAP-Wasser-Block** (den wir bereits lesen, aber verwerfen): `WaterElevation`, `waterColor(surfaceColor)`, `waterLerp(colorLerpMin/Max)`, `refractionScale`, `fresnelBias/fresnelPower`, `unitreflectionAmount`, `skyreflectionAmount`, `SunShininess/SunDirection/SunColor/sunReflectionAmount/SunGlow`, `normalRepeatRate(vec4)`, `normal1..4Movement(vec2)`, `SkyMap(texPathCubemap)`, `WaterRamp(texPathWaterRamp)`, die 4 Wellen-Normalmap-Pfade.

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

**WaterMap-Kanäle (UtilityTextureC) — exakt:**
`R = Flatness` (0 = glatt, 1 = volle Wellen) · `G = Tiefe` (Index in WaterRamp + Fresnel) · `B = Wasser-Alphamaske` (→ `TWaterLayAlphaMask` gibt `float4(0,0,0,mask.b)`) · `A = 1 − Foam` (Kamm-Blend: `lerp(color, waveCrestColor, (1 - waterTexture.a) · waveCrest)`).
Die drei halbauflösenden 8-Bit-Masken im SCMAP (Foam/Flatness/DepthBias) sind die Editor-Quellen, aus denen diese DDS gebacken wird.

**Sky-Cubemap:** `texCUBE(SkySampler, reflect(viewVector, N))`.
**Format (verifiziert):** `SkyCube_*.dds` = **DXT1, 512×512, mips=0, caps2=0xFE00** (= CUBEMAP + alle 6 Faces). Dateilänge exakt `128 + 6·131072 = 786.560` → 6 Faces hintereinander in Reihenfolge **+X, −X, +Y, −Y, +Z, −Z**. (Gilt auch für `EnvCube_*` und `DefaultSkyCube.dds`.) Unser DDS-Parser muss also Cubemap-Faces unterstützen (`THREE.CubeTexture`).

**Refraktion:**
```
screenPos      = (mScreenPos.xy / w) · ViewportScaleOffset.xy + ViewportScaleOffset.zw
backGroundPixels = tex2D(RefractionSampler, screenPos)
mask           = saturate(backGroundPixels.a * 255)          // Alpha = Wassermaske
refractionPos  = screenPos − refractionScale · N.xz · (1/w)
refractedPixels= tex2D(RefractionSampler, refractionPos)
refractedPixels.xyz = lerp(refractedPixels, backGroundPixels, saturate(refractedPixels.w*255)).xyz  // Bleed-Schutz
```
→ **RefractionMap = die Szene (Terrain+Units) vor dem Wasser, in ein Screen-RT.** Deren **Alpha ist die Wassermaske**.

**Reflexion:**
```
reflectedPixels = tex2D(ReflectionSampler, refractionPos)
reflectedPixels = lerp(skyReflection, reflectedPixels, saturate(unitreflectionAmount · reflectedPixels.w))
```
→ **ReflectionMap = die Szene gespiegelt gerendert.** In mesh.fx steuert das Uniform **`mirrored`** diesen Pass: `if (1 == mirrored) clip(vertex.depth.x)` (schneidet alles unter Wasser weg) und `alpha = mirrored ? 0.5 : …`. Wo die ReflectionMap Alpha 0 hat → Sky-Cubemap.

**Fresnel — exakte Formel** (`HighFidelityWater.cpp:100-146`, `BuildFresnelLookupTexture`, 128×128, 2 Float-Kanäle):
```
// Spalte = Wassertiefe d, Zeile = Einfallswinkel i (= NdotV)
reflectionBlend = d · fresnelBias
R = clamp( reflectionBlend + (1 - reflectionBlend) · pow(1 - i, fresnelPower), 0, 1 )   // → .r, das ist "fresnel"
G = R · pow(i, sunShininess) · sunReflectionAmount
```
Im Shader: `fresnel = tex2D(FresnelSampler, float2(waterDepth, NDotL)).r` mit `NDotL = saturate(dot(-viewVector, N))`.
→ **Direkt inline berechenbar, keine Lookup-Textur nötig** — ersetzt unsere Schlick-Näherung in `waterMaterial.ts:62-63`.

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

**Shorelines:** `TShoreline` (water2.fx:612) rendert eine **generierte Ufer-Geometrie** (`moho/terrain/water/Shoreline.{h,cpp}`, `ShoreCell.h`, `ren_ShorelineCutoff`) und schreibt **nur Alpha = 0** (`AlphaBlend_Disable_Write_A`, `Rasterizer_Cull_CCW`, `Depth_Enable_Less`) — sie „stanzt" also die Wassermaske am Ufer weg, damit das Wasser nicht über den Strand läuft. Zusammen mit `TWaterLayAlphaMask` (aus `UtilityC.b`) und `TDecalsWaterMask` (terrain.fx:1207) baut das die Alpha-Maske der RefractionMap auf.

**LowFidelity-Wasser** (water2.fx:220-275) ist ein billiger 2-Pass-Fallback (Farbe aus `UtilityC.g` + Wellenkamm) — nützlich als Zwischenschritt.

---

## 6. Bau-Shader + Wrack-Look (mesh.fx)

Gemeinsame Varyings: **`vertex.material.y` = percentComplete (buildProgress 0→1)**, **`vertex.material.x` = Zeit-/Animationstreiber**. Texturen: `albedoSampler`, `normalsSampler`, `specularSampler`, `secondarySampler` (Bau-Overlay-Muster), `falloffSampler` (Seraphim-Ramp), `environmentSampler` (**Cubemap aus der EnvCube-Liste der scmap!**).

| Technique | PS (Zeile) | Kern |
|---|---|---|
| `UEFBuild_*` | `UEFBuildHiFiPS` (2928) | Normal-Mapped-Basis; Teamfarbe blendet erst ab 90 % ein: `teamColor *= (pc>=0.9) ? (pc-0.9)*10 : 0`; `t = min(max(frac(0.02·time),0.35),0.7)`; `current = lerp(color+secondary, float3(0,0,1), t)`; `out = lerp(current, color, pc)`; `alpha = max(pc, 0.5)` → blaues Pulsieren, das mit dem Fortschritt verschwindet. Zweiter Pass: `UEFBuildOverlayHiFiPS` (2976), Alpha faded in den letzten 5 % aus. |
| `UEFBuildCube_*` | `UEFBuildCubePS` (3003) | Das „Baugerüst-Würfel"-Mesh; Albedo·0.025, secondary·50, gleiche blaue Lerp-Logik. |
| `AeonBuild_*` | `AeonBuildPS` (2713) | Phong + Env-Cubemap; `light = 0.6·lightMultiplier·light + (1-light)·shadowFill`; `alpha = specular.b + glowMinimum`. Overlay-Pass `AeonBuildOverlayPS` (2748): zwei gegenläufig scrollende Masken (`mask1.r - mask2.g + mask1.g·mask2.r`). |
| `AeonBuildPuddle_*` | `AeonBuildPuddlePS` (2789) | scrollende UVs (`x -= mat.x·0.002`, `y += mat.x·0.0042`). |
| `CybranBuild_*` | `CybranBuildPS` (2837) + `CybranBuildOverlayPS` | Overlay-VS `EffectVertexNormalLoFiVS(14,4,0,0,-0.008,0.008)`. |
| `SeraphimBuild_*` | `SeraphimBuildPS` (2895) | UV-Verzerrung aus `secondarySampler` (`uvaddress·0.03`), die mit `buildFractionMul = (pc-0.9)*10` ausblendet; Falloff-Ramp wie unser bereits portierter `UnitFalloffPS`; `alpha = max(pc, 0.25)`. Eigene Depth-Technique `SeraphimBuildDepth`. |
| `Wreckage_*` | `WreckagePS` (2334) | **Kein Schatten** (bewusst); Spec-UV driftet mit `frac(0.01·vertex.depth.y)`; `color = albedo · ComputeLight(dot(Sun,N),1)`; dann `if (specular.g < 0.22) color *= (albedo+spec.r+spec.a)·spec.b·2.5; else color *= spec.b·2;` → der typische verkohlt-krustige Look. `alpha = glowMinimum`. |

---

## 7. Schild-Kuppeln (mesh.fx)

| Technique | VS-Parameter (4 UV-Sets: Skalen + Shift-Geschwindigkeiten) | PS |
|---|---|---|
| `ShieldUEF_*` | `FourUVTexShiftScaleVS(1,3,32,6, 0,0, 0.0003,0.005, -0.001,-0.005, -0.0003,-0.0008)` | `ShieldPS` (3076) |
| `ShieldCybran_*` | `FourUVTexShiftScaleVS(1,1,2,1, -0.01,0, -0.002,0, 0,0.0012, 0.001,-0.0015)` + 2. Pass `ShieldPositionNormalOffsetVS(0.01, …)` | `ShieldCybranPS(0.17)` (3145) |
| `ShieldAeon_*` | `ShieldNormalVS(1,12,8,3, 0,0, 0,0.032, 0.012,-0.032, 0,0.0012)` | `ShieldAeonPS` (3210) |
| `ShieldSeraphim_*` | `ShieldNormalVS(5,1,1,11, -0.00153,-0.0159, 0,0, 0.003,-0.0045, -0.005,-0.045)`, `environment = "<seraphim>"` | `ShieldSeraphimPS` (3260) |
| `SeraphimPersonalShield_*`, `PhaseShield_*`, `ShieldFill`, `ShieldImpact`, `CybranShieldImpact` | | |

`ShieldSeraphimPS` im Detail (3260-3304): UV-Verzerrung aus `normalsSampler` (`uvaddress.rb*0.1`); `dp = abs(cos(dot((0,1,0), normal)))`; `channel_color = 0.453 - clamp(1-dp, 0, 0.453)`; oberhalb `t = 0.753` (Nähe zur Kuppelspitze) wird per `m = 1 - 0.7·(t-0.753)/(1-0.753)` gegen Transparenz geblendet; `alpha = m·(dp2·0.3 + channel_color)·1.75`; Farbe `(0.425, 0.76274, 1.0) · dp² · specular.rgb` (Blaustich).
Alle Schilde haben `cartographicTechnique = "CartographicShield"`.

---

## 8. Fog of War / Range-Ringe / Selection / LOD / Silhouetten

### FoW + Ranges = Stencil-Shadow-Volumes (2-stufig)
**Stufe 1 — Stencil füllen (ColorWrite = 0):**
- `vision.fx` `CastVision`: `visionVertexShader` skaliert ein Einheits-Volumen: `vertex.xz = radius·vertex.xz + position.xy`. FrontFace (Cull CCW): `StencilZFail = incr`; BackFace (Cull CW): `StencilZFail = decr`, `StencilFunc = always`, Masken 0xFF.
- `vision.fx` `CastBoundaryCCW/CW`: Karten-Boundary-Box (`boxCenter`, `boxExtent`), mit DepthBias ±0.00001.
- `range.fx` `Cast`: **Ellipse** statt Kreis — `vertex.xz = (coeff.xx·radius.xx + coeff.yy·radius.yy)·vertex.xz + position.xy`; StencilWriteMask 0x7F, StencilMask 0x80, StencilRef 0xFF, `StencilFunc = notequal`, `StencilFail = zero`, ZFail incr/decr.

**Stufe 2 — Fullscreen-Quad in frame.fx:**
- `Vision` (598): `StencilFunc = equal`, Ref 0x00 → `VisionPS(0.33)` = `float4(0,0,0,0.33)`, SrcAlpha/InvSrcAlpha → **unerkundetes Gebiet wird um 33 % abgedunkelt**.
- `Boundary` (626): `StencilFunc = notequal`, `VisionPS(1.0)` → alles außerhalb der Karte komplett schwarz.
- `RangeMask` (518) → `RangeFill` (542, `RangePS(float4(1,1,1,0.125))`, StencilMask 0x80/Ref 0xFF/equal) → `RangeBurn` (570, `RangePS(rangeColor)`, StencilMask 0x7F/Ref 0x00/notequal, SrcBlend one/DestBlend zero) — 3 Pässe für Füllung + Rand.

### Strategic/Cartographic-Overlay
`frame.fx` `TStrategic` / `StrategicPS` (246): `color = tex(FrameSampler1)`, `overlay = tex(FrameSampler2)`, `fog = 1 - tex(FrameSampler3).r`; wenn `useStrategicOverlay`: `color = overlay.a·overlay.rgb + (1-overlay.a)·fog·color`; Alpha aus einer Dissolve-Textur (`8·texcoord`) + `DissolveOffset`. mesh.fx hat dazu `CartographicUnit/Feature/Place/Build/Shield/Feedback` und `cartographic.fx`.

### Selection-Reticles
`moho/render/SelectionBracketParams.h`: `ren_SelectionSizeFudge`, `ren_SelectionHeightFudge`, `ren_UnitSelectionScale`, `ren_SelectBracketMinPixelSize`, `ren_SelectBracketSize` — die Klammern haben eine **Mindest-Pixelgröße** (skalieren also nicht linear mit dem Zoom).

### LOD-System (`Mesh::ComputeLOD`, Mesh.cpp:4688-4724) — exakt
```
für jede LOD in Reihenfolge:
    cutoff = lod.cutoff                       // = LODCutoff aus dem Blueprint
    if (cutoff <= 0)               return lod   // 0/fehlend = immer sichtbar
    if (lod.useDissolve) {
        if (distance <= cutoff + ren_MeshDissolve) return lod
        return nullptr                          // sonst GAR NICHT zeichnen
    }
    if (distance <= cutoff)        return lod
return nullptr                                  // jenseits der letzten LOD: unsichtbar
```
`MeshLOD` (Mesh.h:388-403) hat außerdem `scrolling`, `occlude`, **`silhouette`** Flags. `GetMaxCutoff() = lastLod.cutoff + ren_MeshDissolve`. Kamera hat einen `LODScale` (`cam_SetLOD`).

### Silhouetten
mesh.fx `Silhouette` (Technique 3715) rendert verdeckte Units in den Stencil; frame.fx `TSilhouette` (658) füllt danach **überall dort, wo der Stencil 0x03 ist**, die Konstante `silhouetteColor` (Default `float4(0,0,1,1)`) — Units hinter Terrain scheinen als farbige Silhouette durch. Pro LOD über das `silhouette`-Flag aktivierbar.

### Legacy-ShaderName-Auflösung (Mesh.cpp:2534-2583) — **fehlt uns**
```
TMeshNoLighting→Flat · TMeshNoNormals→VertexNormal · TMeshAlpha→NormalMappedAlpha
TMeshGlow→NormalMappedGlow · TMeshTerrain→NormalMappedTerrain · Simple→Unit · Team→Unit
TMeshAlphaGlowFade→UnitBuild · TMeshMetalBuild→AeonBuild · TMeshShield→Shield · TMeshZFill→ShieldFill
TMeshAdd→Effect · TMeshExplosion→Explosion · TMeshCloud→Cloud · TMeshOuterCloud→OuterCloud
TMeshEMPNuke→NukeEMP · TMeshQuantumNuke→NukeQuantum · TMeshTemporalBubble→TemporalBubble
leerer Name → "Unit"
```
Danach: Technique = `<aufgelöst>_<HighFidelity|MedFidelity|LowFidelity>`.

---

## 9. Sky / Background der Karte

### SCMAP-v60-Skybox-Block (von mir dekodiert; **unabhängig bestätigt** durch `sky.fx` und `SkyDome.cpp`)
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
**Gegenbeweise:** `SkyDome.cpp:56-75` setzt `mDomeShapeParams.z = 1.2566371f; mWidth = 16; mHeight = 6;` — identisch zu subHeight/subDivAx/subDivHeight. `sky.fx:99-107` deklariert `struct Cirrus { float2 frequency; float1 speed; float2 direction; }` + `Cirrus aCirrus[4]` + `cirrusMultiplier` + `cirrusColor` — exakt meine dekodierte Struktur. `SkyDome.cpp:158` nennt `/textures/environment/horizonLookup.dds`.

### sky.fx-Pässe
- **`Atmosphere`** (`DomeVS`/`AtmospherePS`, 229): Halbkugel-Dome (16×6 Segmente); `th = theta/2π`, `tv = (elevation - horizonBegin)/(horizonEnd - horizonBegin)`; `t = horizonLookup(th,0.25).a · horizonLookup(tv,0.75).a`; `color = lerp(horizonColor, skyColor, 1-t)`. Kein Z-Test/Write, Cull CW.
- **`Decal`** (`DecalVS`/`DecalAlbedoPS`, 175/238): die **9 „Planets"** als Billboards — `texcoord = uv.xy + 0.5·uv.zw·(corner+1)` (also `uv` = Sub-Rechteck im Atlas), Drehung um `position.w`, aufgespannt mit `viewRight`/`viewUp`. Pass P1 addiert den Glow (`decalGlowMultiplier · glow.a`).
- **`Cirrus`** (`CirrusPS`, 264): 4 Layer aus **einer** Textur, je ein Kanal: `alpha = cirrusMultiplier · c0.r · c1.g · c2.b · c3.a`; UV pro Layer: `computeCirrusCoord` = Rotation um `direction`, dann `frequency · (position - time·speed·direction)`.
- **`Cumulus`** (249): 3D-Wolkenpartikel mit Light-/Dispersion-Ramps (nicht aus der scmap; optional).

### Background
SCMAP-Header-Feld `background` → nur zwei Werte in den Originalkarten: `/textures/environment/defaultbackground.dds` (**1024×1024, DXT5, keine Mips, keine Cubemap**) und `/textures/environment/blackbackground.dds` (16×16 DXT5). Gerendert per `frame.fx` `TBackground`/`BackgroundPS` (168): Fullscreen, `dissolve = tex(FrameSamplerWrap2, 8·Tex1).a`, `alpha = saturate(dissolve + DissolveOffset)` → wird beim Zoom-Out in die Strategic-View eingeblendet.

Header-Feld `skyCubemap` → 24 verschiedene `SkyCube_*.dds`/`EnvCube_*.dds` (DXT1-Cubemaps, s. o.). Zusätzlich die **EnvCube-Liste** (`envCubeCount` × (Name, Pfad)) — sie speist `environmentSampler` in mesh.fx (Unit-/Build-/Schild-Shader), z. B. Name `<seraphim>`.

---

## Priorisierter Umsetzungsvorschlag

1. **SCMAP-Parser vervollständigen** (Props, Skybox, Decals behalten, Stratum-Normals, alle Wasser-Felder, EnvCubes, TerrainType) — reine Datenarbeit, alles verifiziert, blockiert 1/2/3/4/9.
2. **DDS-Cubemap-Support** (6 Faces, DXT1) — blockiert Wasser-Reflexion + Unit-Env-Maps + Schilde.
3. **Terrain: Shader-Variante nach `terrainShader` wählen** (TTerrain/TTerrainXP/TTerrainGlow) + **Stratum-Normalmaps inline** (BasisPS-TBN-Mathematik) — größter Optik-Sprung, ersetzt den `stratumEnable`-Hack.
4. **Props** (Instancing, LOD, Alias-Tabelle für ShaderName, Alpha-Test).
5. **Decals** (Albedo + Normals) — braucht Terrain-Re-Rasterisierung in der Decal-AABB.
6. **Wasser voll** (4 Wellen-Layer, exakter Fresnel, Sky-Cubemap; Refraktion/Reflexion als 2 Screen-RTs).
7. **Skybox** (Dome 16×6, Planets, Cirrus) + Background.
8. **Skirt** (trivial), **LOD-Regel** (exakt übernehmen), **Legacy-ShaderName-Tabelle**.
9. **FoW/Range/Silhouette** (Stencil-Volumes) — kommt sinnvollerweise mit dem Intel-System.

## Refs
- faf-re: src/sdk/moho/terrain/HighFidelityTerrain.cpp:375-470 (LoadShaderVars; TerrainScale = 1/(w-1), 1/(h-1), 0, 1; UtilityTextureA/B/C-Bindung)
- faf-re: src/sdk/moho/terrain/HighFidelityTerrain.cpp:489-520 (DrawTerrainSkirt → Technique "TTerrainSkirt")
- faf-re: src/sdk/moho/terrain/StratumMaterial.cpp:85-104 (CStratumMaterial::SetSize → mScaleX = maxSize.x / mSize)
- faf-re: src/sdk/moho/terrain/StratumMaterial.cpp:226-245 (SetSizeTo → maxSize = (heightField.width-1, height-1))
- faf-re: src/sdk/moho/terrain/StratumMaterial.h:23-33 (CStratumMaterial: mScaleX, mScaleY, v3=0, v4=1 → das float4 'Tile')
- faf-re: src/sdk/moho/terrain/water/HighFidelityWater.cpp:100-146 (BuildFresnelLookupTexture — exakte Fresnel-Formel, 128x128)
- faf-re: src/sdk/moho/terrain/water/HighFidelityWater.cpp:290-365 (LoadShaderVars, refractionTexture + reflectionTexture)
- faf-re: src/sdk/moho/terrain/water/Shoreline.h (Shoreline, ShoreCell, ren_Shoreline, ren_ShorelineCutoff)
- faf-re: src/sdk/moho/terrain/water/WaterShaderVars.h:7-53 (alle water2.fx-Uniforms 1:1 zum SCMAP-Wasserblock)
- faf-re: src/sdk/moho/render/CWldTerrainDecalTYPETypeInfo.h:12-25 (Decal-Typ-Enum 0..9)
- faf-re: src/sdk/moho/render/CWldTerrainDecal.cpp:117-183 (RotationAxisX/Y/Z, ProjectDecalBoundsXZ, ApplyInverseScaleToTextureMatrix)
- faf-re: src/sdk/moho/render/CWldTerrainDecal.cpp:797-835 (Update → DecalMatrix + TangentMatrix)
- faf-re: src/sdk/moho/render/CDecalTypes.h:89-101 (SDecalInfo: mPos, mSize, mRot, mTexName1/2, mIsSplat, mLODParam, mType, mArmy, mFidelity)
- faf-re: src/sdk/moho/effects/rendering/EffectLuaStartupRegistrations.cpp:196-247 (CreateDecalFromTransform — Mitte→Ecke-Umrechnung)
- faf-re: src/sdk/moho/terrain/splat/CWldSplat.h:61-137 (CWldSplat : CWldTerrainDecal, SplatVertex{position, texcoord})
- faf-re: src/sdk/moho/render/SkyDome.cpp:56-75 und :157-159 (Dome 16x6, subHeight 1.2566371, horizonLookup.dds, cirrus000.dds)
- faf-re: src/sdk/moho/mesh/Mesh.cpp:4688-4724 (Mesh::ComputeLOD — exakte LOD-Regel)
- faf-re: src/sdk/moho/mesh/Mesh.cpp:2534-2583 (ShaderDictionaryRuntime — Legacy-ShaderName-Alias-Tabelle + ResolveShaderAnnotationName)
- faf-re: src/sdk/moho/mesh/Mesh.h:388-403 (MeshLOD: useDissolve, cutoff, scrolling, occlude, silhouette)
- faf-re: src/sdk/moho/render/Clutter.h:39-93 (ClutterSurfaceElement/Entry — prozedurales Bodengestrüpp, NICHT die Map-Props)
- faf-re: src/sdk/moho/render/SelectionBracketParams.h:10-35 (ren_SelectBracketSize, ren_SelectBracketMinPixelSize, ren_UnitSelectionScale)
- effects.scd: effects/terrain.fx:111 (TerrainScale), :534-587 (TerrainSkirtVS/PS), :591-640 (TerrainNormalsPS / TerrainNormalsXP), :643-691 (TerrainBasisPS / BiCubic), :694-722 (TerrainPS = TTerrain), :724-770 (TerrainAlbedoXP), :772-807 (TerrainGlowPS), :852-975 (Techniques), :989-1225 (DecalsVS, DecalsPS, DecalAlbedoXP, DecalsNormalsPS, DecalsPSWaterAlbedo/WaterMask), :1231-1360 (Decal-Techniques)
- effects.scd: effects/frame.fx:168-186 (BackgroundPS), :246-263 (StrategicPS), :279-320 (BasisPS — TBN-Rekonstruktion), :518-596 (RangeMask/RangeFill/RangeBurn), :598-652 (Vision/Boundary), :658-673 (TSilhouette), :733 (TCreateBasis)
- effects.scd: effects/water2.fx:294-327 (WaterVS — 4 Wellen-Layer), :329-496 (HighFidelityPS — Refraktion/Reflexion/Fresnel/Foam), :563-580 (TWaterLayAlphaMask), :612-629 (TShoreline)
- effects.scd: effects/sky.fx:99-107 (struct Cirrus), :146-197 (DomeVS/DecalVS), :229-272 (AtmospherePS, DecalAlbedoPS/GlowPS, CumulusPS, CirrusPS), :274-353 (Techniques)
- effects.scd: effects/range.fx:18-79 (Ellipsen-Stencil-Volumes), effects/vision.fx:25-202 (CastVision, CastBoundaryCCW/CW)
- effects.scd: effects/mesh.fx:2145 (ClutterPS), :2170 (NormalMappedPS), :2334-2366 (WreckagePS), :2713-2836 (AeonBuildPS/OverlayPS/PuddlePS), :2837 (CybranBuildPS), :2895-2923 (SeraphimBuildPS), :2928-3036 (UEFBuildHiFiPS/Overlay/Cube), :3076-3304 (ShieldPS, ShieldCybranPS, ShieldAeonPS, ShieldSeraphimPS), :3568-6505 (alle Techniques)
- effects.scd: effects/d3d9states.compat (AlphaBlend_Disable_Write_RG = ColorWriteEnable 0x03; _Write_BA = 0x0C)
- env.scd: env/Evergreen/Props/Bush/eg_bush01_prop.bp, env/Evergreen/Props/Rocks/Rock01_prop.bp (PropBlueprint-Struktur; 335 *_prop.bp gesamt)
- textures.scd: textures/environment/SkyCube_*.dds (DXT1 512x512, mips=0, caps2=0xFE00 → echte Cubemap, 6x131072 B), DefaultBackground.dds (DXT5 1024x1024), textures/engine/waves{,000,001}.dds (DXT3 256x256, 9 Mips)
- Karten: C:\Program Files (x86)\Steam\steamapps\common\Supreme Commander Forged Alliance\maps\SCMP_0XX\SCMP_0XX.scmap (60 Karten, alle v60; TTerrain 39 / TTerrainXP 20 / TTerrainGlow 1)
- Verifikationsskripte (Scratchpad): scratchpad/verifyTail.ts (60/60 exakt bis EOF), scratchpad/findProps.ts (Props-Record numerisch bestätigt), scratchpad/scmapTail.ts, scratchpad/hexTail.ts
- Nachbau (anzupassen): src/formats/scmap.ts:309-310 (Parser bricht hier ab), src/viewer/terrainMaterial.ts (nur TerrainAlbedoXP, keine Stratum-Normals), src/viewer/waterMaterial.ts:62-63 (genäherter Fresnel), src/formats/unitPaths.ts (gilt auch für Props), src/viewer/unitMaterial.ts (ShaderName-Auswahl — Alias-Tabelle fehlt)
