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

Magic `ANIM`, Version 5. Header (verifiziert an UEL0001_A001.sca):
numFrames u32 · duration f32 · numBones u32 · namesOffset u32 ·
linksOffset u32 · animDataOffset u32 · frameSize u32. Pro Frame und Bone:
Position ³f + Rotation ⁴f. **Parser noch nicht implementiert (M3).**

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

Magic `Map\x1a`. Heightmap (u16), Terrain-Textur-Lagen, Wasser-Parameter,
Props, Decals. **Parser noch nicht implementiert (M2)** — Referenzen:
FAForever-Map-Tools (Neroxis-Generator, hazard-x scmap-Doku), Original-Code
in faf-re.
