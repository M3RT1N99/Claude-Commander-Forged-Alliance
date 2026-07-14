# Stand & bekannte Löcher

*Dieses Dokument trägt den wechselnden Zustand, damit [CLAUDE.md](../CLAUDE.md)
ihn nicht tragen muss. Bei jedem größeren Meilenstein aktualisieren.*

## Stand (Juli 2026): die Techdemo läuft

ACU auswählen → Bau-Menü aus dem Blueprint → Gebäude aufs Raster setzen → es wird
aus der echten Ökonomie bezahlt → die fertige Fabrik produziert Panzer, die vom
Hof rollen. Alles über die Original-Lua; verifiziert in
[scripts/verify-command-chain.ts](../scripts/verify-command-chain.ts) und
[scripts/verify-factory.ts](../scripts/verify-factory.ts), im Browser über
`?selftest=<blueprint>`.

Die Session-UI (economy, multifunction, orders, construction, unitview,
unitviewDetail) rendert komplett aus der Original-Lua (113 maui-Controls);
der Web-Rahmen ist nur noch Launcher (Menü: Start/Sandbox/Einheiten/Karten).

## Bekannte Löcher

Der Weg zur echten UI: [PLAN-UI.md](PLAN-UI.md); der 1:1-Gesamtfahrplan:
[PLAN-1ZU1.md](PLAN-1ZU1.md).

- **Kein echtes Hauptmenü.** Das Ziel-Erlebnis ist das Original-Front-End
  (`lua/ui/menus/main.lua`); heute startet die Sandbox über einen Web-Button.
- **Kein Kampf:** Waffen bauen sich auf und zielen, aber es gibt keine
  Projektile, keinen Schaden, keine Beam-Waffen (`defaultweapons.lua:909`).
- **`src/ui/hud.ts`** ist der letzte TS-Rest (Minimap, strategische Icons).
  Dort nichts Neues anbauen; er verschwindet mit `minimap.lua`/worldview.
- **Keine Weltansicht als maui-Control.** `worldview.lua`, `borders`-Rahmen,
  Minimap, Tabs, Chat fehlen; der Klick in die Welt läuft über
  [src/ui/worldCommands.ts](../src/ui/worldCommands.ts).
- **Die Karte wird in TS geparst** (`main.ts` liest `Scenario…Markers` selbst)
  statt über `ScenarioUtilities.lua` (keine Armee-Gruppen, keine Props).
- **Das Blueprint wird zweimal gelesen** — TS-Parser (Modelle/Knochen) und
  echte `LoadBlueprints()`-Pipeline. Zwei Wahrheiten.
- **Nur ein Bauer pro Baustelle** — Assist fehlt.
- **Kein Audio.** `PlaySound` protokolliert nur (`__uiSoundsRequested`);
  FMOD/XACT-Bänke ungelesen (siehe [research/sound-fmod.md](research/sound-fmod.md)).
- **Ökonomie-Lua-API teils No-Op:** `SetProductionPerSecond*`,
  `SetConsumptionPerSecond*`, `SetBuildRate` schreiben noch nichts in die
  Engine-Ökonomie (Werte kommen nur aus dem Blueprint).
- **`research/economy-binary.md` beschreibt mehr, als `economy.ts` kann**
  (Handicap, Overflow-Sharing, kumulierter `granted`-Akku).
- **DDS-Parser:** 16-Bit-unkomprimierte DDS werden abgelehnt (Fund vom
  Selbsttest-Lauf, betrifft mindestens eine UI-Textur).
