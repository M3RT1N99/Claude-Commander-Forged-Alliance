# Verifizierte Fakten — nicht neu erfinden

*Aus [CLAUDE.md](../../CLAUDE.md) ausgelagert: hier steht das teuer erkaufte
Detailwissen mit Belegen. Die querschneidenden Invarianten (Blueprint-Defaults,
class.lua-Semantik, getrennte Ökonomie-Schalter, wasmoon-null) stehen weiterhin
in CLAUDE.md. Vor Arbeit an einem der Themen: den passenden Abschnitt lesen.*

## Ökonomie (Details: [economy-binary.md](economy-binary.md))

- **Ökonomie ist gleitend** (wie SCFA, nicht wie SC2): zwei Ratios in
  `func_ArmyProcessEconomy` (@0x771B50). Produktion ist bedingungsloses Einkommen
  und wird **nie** an die Gewährungs-Ratio gekoppelt.
- **Produktion und Verbrauch sind getrennte Schalter** (`SetProductionActive` /
  `SetConsumptionActive`) — niemals einer. Original-`OnStopBeingBuilt` ruft
  `SetConsumptionActive(false)`; auf einem gemeinsamen Flag stirbt lautlos die
  Produktion **jedes fertigen Gebäudes**.
- **Unfertige Units (`complete = false`) sind in der Ökonomie unsichtbar** —
  kein Lager, keine Produktion, kein Unterhalt. Eine Baustelle entsteht über
  `__spawnBuildSite`, nicht über `__spawnUnit`.
- **Startressourcen** kommen NICHT aus einer Konstante. Jede ACU forkt in
  `OnStopBeingBuilt` ihr `GiveInitialResources` (`uel0001_script.lua:159`) und
  schenkt der Armee nach `WaitTicks(5)` ihr eigenes Lager
  (`StorageEnergy = 4000`, `StorageMass = 650`).
- **Lager** entsteht ausschließlich aus `Storage*` der Units. Der
  `SSTIArmyVariableData`-Ctor (@0x6FD390) startet mit `mStored = 0/0`,
  `mMaxStorage = 0/0`. (Ein zusätzlicher „Sockel 650/4000" wäre die ACU doppelt.)

## Bau (Details: [build-task-binary.md](build-task-binary.md))

- **Bau-Fortschritt:** `delta = buildRate/BuildTime · ResourceConsumed · 0.1`
  (`CBuildTaskHelper::UpdateWorkProgress` @0x5f5f2c).
- **Raster-Snap** (`COORDS_GridSnap` @0x50B1E0, Cfile:641666-641686):
  `cell = trunc(p − size/2)`, zurück `+ size/2`, **Höhe erst nach dem Snap**
  (Cfile:641588). `size` sind die ganzzahligen `Footprint.SizeX/SizeZ` — nicht
  SkirtSize, nicht SelectionSize. Ein 5×5-Gebäude sitzt immer auf `x.5`.
- **Beat-Reihenfolge ist messbar** (`Sim::AdvanceBeat` @Cfile:1076363):
  Fabrik-Warteschlangen → Bau-Bedarf → Ökonomie → Rate anwenden → Lua-Threads →
  Bewegung. Eine Unit wird in Phase 3 fertig; ihr **Lager** taucht erst im
  Ökonomie-Tick des **nächsten** Beats auf.

## Bewegung (Details: [movement-path.md](movement-path.md))

- **`MaxBrake == 0` / `MaxSteerForce == 0` heißen „nimm `MaxAcceleration`"**,
  nicht „kann nicht bremsen/lenken" (Cfile:942136-942147). Die ACU hat gar
  keinen `MaxBrake` — falsch gelesen pinnt das ihre Geschwindigkeit auf 0.
- Motion-Parameter sind **pro Tick** skaliert (`·0.1` Speed, `·0.01` Accel,
  `·0.0017453` deg/s → rad/Tick).

## Units, Waffen, Skelett (Details: [weapons.md](weapons.md))

- **Unit-Lifecycle:** `OnPreCreate` (@943748) → `OnCreate` (@944007) → bei
  fertigen Units `OnStopBeingBuilt`. Ohne `OnPreCreate` gibt es kein
  `self.Sync`, kein `self.Trash`, keine `EventCallbacks`.
- **Die Sim hat das SKELETT der Unit**, nicht nur der Renderer.
  `weapon.lua:67` prüft Turm-Knochen über `Unit:ValidateBone` (unit.lua:2751);
  Mündungen, Bau- und Effekt-Knochen hängen ebenfalls an Namen. Die Knochen
  kommen aus derselben `.scm` wie im Renderer (`__setBones`,
  [scripts/gameFiles.ts](../../scripts/gameFiles.ts)). Ohne Skelett bricht
  schon `Weapon:OnCreate` ab.
- **Die Engine ruft `OnCreate` auf JEDER Waffe.**
  `DefaultProjectileWeapon.OnCreate` endet mit
  `ChangeState(self, self.IdleState)` (defaultweapons.lua:87) — erst der
  IdleState startet die Zustandsmaschine. Ohne den Aufruf lud der Overcharge
  der ACU (IdleState.Main → `StartEconomyDrain`, defaultweapons.lua:404) seine
  5000 Energie irgendwann später bei leerer Kasse — Rate 0.004, nie fertig,
  und jede Fabrik verhungert nebenbei. **Reihenfolge ist Semantik.**
- **Feuerhaltung** (`GetFireState` @0x8BB500): Sentinel 3 → erste Unit **mit**
  `RULEUCC_RetaliateToggle` (Bit 5 der CommandCaps, Cfile:656671-656719) setzt
  den Zustand, Abweichung ⇒ −1 (gemischt). Werte: 0 = ReturnFire, 1 = HoldFire,
  2 = HoldGround; Ctor startet mit ReturnFire (Cfile:772277).

## Blueprints

- **Struct-Defaults:** die Engine liest ein `.bp` in ein getyptes Struct, dessen
  Ctor (`Moho::RUnitBlueprint` @0x51E480) **jedes Feld** vorbelegt
  (`Defense.Shield.ShieldSize = 0`, `Intel.VisionRadius = 10`,
  `Economy.BuildRate = 1` …). Die Lua sieht das reflektierte Struct — **jedes
  Feld existiert immer**. Darum greift `Unit.lua` ungeprüft auf
  `bp.Defense.Shield.ShieldSize` zu.
- **`Sound{}`** ist der einzige DSL-Konstruktor in den `.bp`-Dateien (3445×).
  Fehlt er, bricht die Blueprint-Auswertung mittendrin ab — und das bp landet
  halbfertig unter dem Schlüssel `'null'`.

## UI (Details: [ui-complete.md](ui-complete.md))

- **Schriften:** `lua/skins/skins.lua:22-26` verlangt „Arial" und
  „Zeroes Three" — beide als TTF in `<GameDir>/fonts`. Text-Controls bemessen
  sich nach `FontAscent + FontDescent` und `TextAdvance` (text.lua:39/47) →
  echte TTF-Metrik ([src/formats/ttf.ts](../../src/formats/ttf.ts)), dieselbe
  Datei per `FontFace` gerendert. Der **volle Name** (nameID 4) ist der
  Schlüssel: `ARIAL.TTF` und `ARIALBD.TTF` haben beide die Familie „Arial".
- **`/lua/usersync.lua` gehört in die UI-VM** (Gegenstück zu `/lua/simsync.lua`;
  keine Lua-Datei lädt es, die Engine tut es). Es bringt `Sync`, `UnitData`,
  `OnSync()` — ohne `UnitData` scheitert orders.lua:909 an der ersten Selektion.

- **Die Session in der UI-VM:** `GetArmiesTable()` (cfunc_GetArmiesTableL,
  Cfile:1267023-1267111) liefert `{ numArmies, focusArmy (1-basiert),
  armiesTable }`; je Armee genau: `name, nickname, faction, color, iconColor,
  showScore, civilian, human, outOfGame, authorizedCommandSources`.
  **`faction` ist 0-basiert** — die Lua rechnet überall `faction + 1`
  (gamemain.lua:109, orders.lua:675, avatars.lua:664). `SessionGetScenarioInfo()`
  gibt die Tabelle zurück, die beim Start an die Sim ging (`.Options` wird
  ungeprüft gelesen: tabs.lua:21, diplomacy.lua:34).
  `SessionGetLocalCommandSource()` ist der **Client**-Index (1-basiert; 0 = darf
  nicht befehligen, Cfile:1330618), **nicht** die Armee. Ohne Session werfen alle
  Session-Globals „…(): no active session." (Cfile:1330339).
- **`SessionRequestPause`/`SessionResume` halten die SIM an**
  (CWldSession::RequestPause) — die UI läuft weiter (eigene VM, eigener
  Frame-Takt).

## Lua-Host

- **FA-Lua knallt bei Vergleichen über Typgrenzen NICHT.** Die Engine hat
  `luaV_lessthan` (Cfile:1442257) und `luaV_lessequal` (Cfile:1442275) gepatcht:
  bei ungleichen Typen liefern sie den Vergleich der **Typ-Tags**
  (nil=0, boolean=1, number=3, string=4, table=5, function=6, userdata=7) statt
  „attempt to compare number with nil". Die Original-UI rechnet damit:
  diplomacy.lua:24 hängt `Items` an den Boolean `false`, Zeile 107 ersetzt
  `parent` durch ein Control (dort ist `Items` nil), und Zeile 123 fragt
  `table.getsize(parent.Items) > 0` — `nil > 0` ist in FA einfach `false`.
  Nachgebildet über `__lt`/`__le` auf den Typ-Metatables
  ([boot.lua](../../src/engine-lua/boot.lua)).
- **wasmoon: eine JS-Funktion darf NIE `null` zurückgeben** — wasmoon prüft
  `typeof target !== 'object'` und greift dann auf `target.then` zu
  (dist/index.js:1020-1026); für `null` ist `typeof` „object", die VM stirbt
  tief in fremder Lua. `LuaHost.setGlobal` wandelt deshalb `null → undefined`.
- **`class.lua` kopiert Basisklassen-Felder in die abgeleitete Klasse** (kein
  `__index`-Fallback). Ein Methodenname darf in **genau einer**
  moho-Namensliste stehen: `GetHealth` stand in ENTITY_NAMES *und* UNIT_NAMES —
  der No-Op auf der Unit überschattete die echte Implementierung, jede Unit
  meldete 0 HP.
