# Stand & bekannte Löcher

*Dieses Dokument trägt den wechselnden Zustand, damit [CLAUDE.md](../CLAUDE.md)
ihn nicht tragen muss. Bei jedem größeren Meilenstein aktualisieren.*

## Stand (Juli 2026): Techdemo mit Kampf, Effekten, Audio und lebender UI

ACU auswählen → Bau-Menü aus dem Blueprint → Gebäude aufs Raster setzen →
echte Ökonomie zahlt → die Fabrik produziert Panzer → Gauss-Duell mit
Projektilen, Schaden, Tod und **Wrack** (Wreckage-Shader aus mesh.fx). Dazu:
Partikel/Trails/Beams (particle.fx-Port, CEfxEmitter-Tick), CollisionBeams,
gelenkte Munition, XACT-Audio als PCM im Lautsprecher, Einheiten im
Karten-Licht (mesh.fx ComputeLight). Die Session-UI (economy, multifunction,
orders, construction, unitview, tabs, avatars, minimap-Fenster …) rendert
komplett aus der Original-Lua über die echte Provider-Kette
(DoPreload → erster Sync-Beat → DoInitializing); die **Tastatur lebt**
(Keymap aus keymapper.lua, 135 Hotkeys, CUIKeyHandler-Executor, UI_Lua).
Verifiziert in 29 Suiten (`npm test`) und im Browser über
`?sandbox=<karte>&selftest=<blueprint>`.

## Bekannte Löcher

Der Weg zur echten UI: [PLAN-UI.md](PLAN-UI.md); der 1:1-Gesamtfahrplan:
[PLAN-1ZU1.md](PLAN-1ZU1.md).

- **Kein echtes Hauptmenü als Standard-Weg.** Das Front-End bootet
  (verify-frontend), aber die Sandbox startet über den Web-Launcher;
  `LaunchSinglePlayerSession`/Lobby fehlen.
- **Render-Inventur offen (H/M-Liste):** Baustellen sehen aus wie fertige
  Gebäude (H3 — BuildMeshBlueprint existiert schon), Terrain ohne
  Stratum-Normals/Decals (H4), Karten-Props (H5), Wasser statisch (H6),
  Schatten (H7), Glow/Bloom-Pass (H2), Beat-Interpolation (M6),
  Icon-Tint/Fade (M1), Cybran/Aeon-Spezialshader (M5). Blocker dafür:
  scmap-Parser-Schwanz + DDS-Cubemap.
- **Sound-Settings stellen nichts ein** (Nutzer-Fund): SetVolume/GetVolume
  fehlen; GameAudio hat keine xgs-Kategorie-Gains (Forschung läuft).
- **Tastatur-Folgefunde:** `InternalCreateEdit` fehlt (Chat-/Konsolen-EINGABE),
  `StartCommandMode`-Konsolenbefehl fehlt (Hotkeys wie Shift-P/Patrol laufen
  in die WARN-Liste), `IsAlly` in der UI-VM fehlt ('allies'-Chat).
- **Sim-Funde:** Einheiten stapeln sich am Roll-off (keine Separation),
  Mex-Stall (Produktion × LimitingRate, Cfile:953938), Türme drehen nicht
  (Turret-Aiming), Audio-Loops/Variationen.
- **`src/ui/hud.ts`** ist der letzte TS-Rest (Minimap-Bild, strategische
  Icons). Dort nichts Neues anbauen; er verschwindet mit worldview/minimap.
- **Die Karte wird in TS geparst** (`main.ts` liest `Scenario…Markers` selbst)
  statt über `ScenarioUtilities.lua` (keine Armee-Gruppen, keine Props).
- **Das Blueprint wird zweimal gelesen** — TS-Parser (Modelle/Knochen) und
  echte `LoadBlueprints()`-Pipeline. Zwei Wahrheiten.
- **Nur ein Bauer pro Baustelle** — Assist fehlt.
- **Ökonomie-Lua-API teils No-Op:** `SetProductionPerSecond*`,
  `SetConsumptionPerSecond*`, `SetBuildRate` schreiben noch nichts in die
  Engine-Ökonomie (Werte kommen nur aus dem Blueprint).
- **`research/economy-binary.md` beschreibt mehr, als `economy.ts` kann**
  (Handicap, Overflow-Sharing, kumulierter `granted`-Akku).
- **DDS-Parser:** 16-Bit-unkomprimierte DDS werden abgelehnt (Fund vom
  Selbsttest-Lauf, betrifft mindestens eine UI-Textur).
- **Score-Zahlen bleiben leer** (1:1: Vanilla-3599 hat keinen
  currentScores-Produzenten) — Nutzer-Entscheidung Vanilla vs. FAF offen.
