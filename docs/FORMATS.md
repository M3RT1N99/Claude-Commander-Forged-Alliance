# Dateiformate (verifiziert gegen die Installation)

Alle Angaben wurden gegen die echte Steam-Installation geprüft
(`scripts/verify.ts`); Byte-Layouts wurden zusätzlich mit Hex-Proben der
Original-Dateien abgeglichen. Quellen: GPG-Mod-SDK-Dokumentation,
FAF-Community-Tools, eigene Verifikation.

## SCD — Archive (`gamedata/*.scd`)

Normale **Zip-Archive** (Magic `PK\x03\x04`). Einträge überwiegend
*Stored* (unkomprimiert), teils *Deflate*. Kein Zip64 (alle < 4 GB).
→ [src/vfs/zipArchive.ts](../src/vfs/zipArchive.ts) liest nur das Central
Directory und lädt Einträge einzeln (Random-Access über Blob/HTTP-Range).
Pfade sind case-insensitiv zu behandeln (`UEL0001_NormalsTS.DDS` vs.
`uel0001_lod1_normalsts.dds`).

## SCM — Modelle (`*_lod0.scm`)

Little-endian, Magic `MODL`, Version 5. Sektionen mit `0xC5` gepolstert,
je ein 4-Byte-Marker (`NAME`, `SKEL`, `VTXL`, `TRIS`, `INFO`) direkt vor dem
Offset-Ziel. Vollständiges Layout im Header-Kommentar von
[src/formats/scm.ts](../src/formats/scm.ts).

Referenz UEL0001_LOD0.scm: 5807 Vertices, 10458 Indizes (3486 Tris),
29 Bones (19 gewichtet).

- Vertex (68 B): pos ³f · tangent ³f · normal ³f · binormal ³f · uv0 ²f ·
  uv1 ²f · boneIdx ⁴u8
- Bone (108 B): restPoseInverse 4×4f · pos ³f · rot (Quaternion) ⁴f ·
  nameOffset u32 · parentIndex i32 · 8 B reserviert
- UVs sind DirectX-Konvention (Ursprung oben links) — passt ohne Flip zu
  nicht geflippten (compressed) WebGL-Texturen.

## SCA — Animationen (`*_A*.sca`)

Magic `ANIM`, Version 5. Header (verifiziert an UEL0001_A001.sca und dem
rekonstruierten Loader `RScaResource::LoadScaFile` in faf-re):
numFrames u32 · duration f32 · numBones u32 · namesOffset u32 ·
linksOffset u32 · animDataOffset u32 · frameSize u32.

- Ab animDataOffset: ein 28-Byte-**Root-Delta**-Record, dann pro Frame:
  8-Byte-Header (f32 time, u32 flags) + numBones × 28-Byte-Keys
  {pos ³f, quat ⁴f (w,x,y,z)}
- Version < 5: Quaternion-Komponenten [a,b,c,d]→[d,a,b,c] rotieren
- Playback (Original): 10-Hz-Sim-Ticks, `framePos = (frames-1)/duration * t`,
  Position-LERP + Quaternion-LERP zwischen Nachbarframes
- Skelett kommt aus der SCM-Datei (Bones + Parents + Bindpose)

**Parser noch nicht implementiert (M3).**

## Blueprints (`*_unit.bp`, Lua)

Deklaratives Lua: `UnitBlueprint { ... }` mit verschachtelten Konstruktoren
(`Sound { ... }`), Strings, Zahlen, Booleans, einfacher Arithmetik und
`--`/`#`-Kommentaren. → [src/formats/blueprint.ts](../src/formats/blueprint.ts)
(kein vollständiges Lua nötig; 568/568 Unit-BPs parsen).

## DDS — Texturen

Unit-Texturen: DXT5, 1024², volle Mip-Kette. Bedeutung der Kanäle (aus dem
Original-Shader `effects/mesh.fx` in effects.scd):

| Textur | Inhalt |
| ------ | ------ |
| `_Albedo.dds` | RGB Farbe, A ungenutzt/Transparenz (je nach Shader) |
| `_NormalsTS.dds` | Tangent-Space-Normale: **x = G-Kanal, y = A-Kanal**, z rekonstruiert (`2*tex.gaa-1`), gesampelt mit **UV1** |
| `_SpecTeam.dds` | R = Environment-Reflexion · G = Phong-Spekular · B = Glow/Emissive · **A = Team-Color-Maske** |

Team-Color (mesh.fx): `albedo.rgb = lerp(teamColor, albedo.rgb, 1 - specular.a)`

## SCMAP — Karten (`maps/*/*.scmap`)

Magic `Map\x1a`, Version major 2, minor 56 (FA) / 60 (FAF-Editor;
Original-Steam-Karten sind teils ebenfalls 60). Vollständiges Layout in
[src/formats/scmap.ts](../src/formats/scmap.ts); Parser verifiziert gegen
alle 60 Karten der Installation. Quellen: Neroxis `SCMapImporter.java`,
ozonex FAF Map Editor (HazardX-Loader), faf-re (`CWldMap::MapLoad`).

Kernfakten:

- Heightmap: u16-Grid mit (w+1)×(h+1) Samples, Welthöhe = wert × 1/128,
  1 Sample pro Weltmeter
- 10 Albedo-Strata (Lower, Stratum0–7, Upper) + 9 Normal-Strata, je
  Pfad (case-insensitiv in env.scd!) + Kachelgröße in Weltmetern
- Splat-Masken: 2 eingebettete unkomprimierte BGRA-DDS (Stratum 0-3 in
  RGBA von UtilityA, 4-7 in UtilityB), Dekodierung `saturate(tex*2-1)`
- Watermap (UtilityC, DXT5, halbe Auflösung): R = über Wasser,
  **G = Wassertiefe**, B = Flatness, A = Foam
- Wasser-Settings: elevation/deep/abyss, SurfaceColor, WaterRamp-Textur
- Lighting: Sonnenrichtung/-farbe, Ambience, ShadowFill, Specular,
  LightingMultiplier, Fog — 1:1 an den Terrain-Shader durchgereicht
- Danach: WaveGenerators, Decals, TerrainType-Bytes, (v60: Skybox), Props
  (Blueprint-Pfad + Position + 3×3-Rotationsmatrix)
