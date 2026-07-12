# Claude Commander: Forged Alliance

Eine Neuimplementierung von **Supreme Commander: Forged Alliance** für den
Browser (später Mobile, Linux und Windows) — als offene Engine nach dem
**Bring-your-own-assets**-Prinzip.

> Dieses Projekt liefert **keinerlei Spieldaten** aus. Es liest Modelle,
> Texturen, Blueprints und Karten direkt aus der **eigenen, gekauften
> Installation** des Spiels (Steam/GOG). Ohne Original-Spiel keine Assets.

## Status: Meilenstein 1 — Unit-Viewer ✅

Die App mountet die komplette Spielinstallation als virtuelles Dateisystem im
Browser und rendert Original-Einheiten mit Original-Texturen in WebGL:

- **SCD-Archive** (Zip) mit wahlfreiem Zugriff — auch die 1,3-GB-Archive
  werden nie komplett in den Speicher geladen
- **SCM-Meshes** (Format `MODL` v5): Vertices, Normals, Tangents, UV0/UV1,
  Bones, Skinning-Indizes
- **Blueprints** (.bp, deklaratives Lua): eigener Parser, verifiziert gegen
  alle 568 Unit-Blueprints des Spiels
- **DDS-Texturen** (DXT1/3/5): nativer GPU-Upload, Software-Dekoder als
  Fallback für Mobile
- **Original-Shader-Look**: Port des FA-Unit-Shaders (`mesh.fx`,
  NormalMappedPS) inkl. Team-Color-Maske, tangent-space Normal-Mapping aus
  den G/A-Kanälen, Spec/Glow

## Schnellstart (Entwicklung)

```bash
npm install
npm run dev
```

Dann <http://localhost:5173> öffnen und das FA-Installationsverzeichnis
wählen — oder mit lokal laufendem Dev-Server direkt
<http://localhost:5173/?http=1> (serviert die Installation aus
`CFA_GAME_DIR`, Standard: Steam-Pfad).

Parser-Tests gegen die echte Installation:

```bash
npx tsx scripts/verify.ts
```

## Rechtliches

- Der Quellcode dieses Repos ist eine Eigenentwicklung (TypeScript); er
  enthält keinen Original-Code, keine Original-Assets und keine aus der
  Binary kopierten Daten.
- Assets werden ausschließlich lokal aus der Installation des Users gelesen,
  niemals hochgeladen, gebündelt oder verteilt (`.gitignore` blockiert
  Asset-Formate).
- Als Besitznachweis dient die vorhandene lokale Installation; eine optionale
  Steam-/GOG-Verifikation ist geplant (siehe `docs/LEGAL.md`).

Gleiches Prinzip wie bei OpenRA, OpenMW, openage oder OpenSAGE.

## Roadmap

Siehe [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Kurzfassung:

1. ✅ **Unit-Viewer** — Formate, VFS, Rendering-Grundlage
2. **Karten-Renderer** — SCMAP-Terrain, Wasser, Props
3. **Sim-Kern** — deterministische Simulation (Einheiten, Bewegung, Waffen,
   Wirtschaft) auf Basis der Blueprints; Referenz: rekonstruierte
   Moho-Engine-Quellen (faf-re)
4. **Spielbarkeit** — Steuerung, UI, Fog of War, KI-Skirmish
5. **Plattformen** — Mobile (Touch-UI), Desktop-Builds (Tauri), Multiplayer
