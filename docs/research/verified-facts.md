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

- **Die Brain-Ökonomie-Getter liefern PER-TICK-Werte** — rohe Feld-Reads aus
  `CEconomy.mTotals` ohne Skalierung (GetEconomyIncome Cfile:739923, Usage =
  mLastUseActual Cfile:739997, Requested = mLastUseRequested Cfile:740071;
  Befüllung pro Tick ×0.1 in HandleResourceManagement Cfile:954011-954028).
  Die Original-Lua rechnet selbst hoch: defaultweapons.lua:970
  `GetEconomyIncome('ENERGY') * 10 # per tick to per seconds`; economy.lua:277
  multipliziert die GetEconomyTotals-Felder mit GetSimTicksPerSecond().
  Der einzige ×10-Faktor im Binary sitzt bei den Armee-STATS
  (Economy_Trend_*, Cfile:1107170) — nie bei den Brain-Gettern.
- **OFFEN (belegt, noch nicht umgesetzt):** Produktion skaliert mit der
  LimitingRate des eigenen Verbrauchs, wenn das Blueprint NICHT
  `Economy.NaturalProducer` hat (HandleResourceManagement Cfile:953938-953944 +
  954011-954012; NaturalProducer haben nur ACUs/sACUs + uea0001/uea0003) —
  der bekannte „Mex-Stall". Unsere ArmyEconomy.tick hat die Kopplung nicht;
  economy-binary.md:117-129 behauptet fälschlich das Gegenteil.

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

- **Die Speed-Cap-Kaskade der Bewegung** (sub_699760 @0x699760,
  Cfile:942291-942328, gerufen aus CAiPathSpline::Generate 766232ff):
  RotateOnSpot gilt NUR unter der Speed-Schwelle
  (`RotateOnSpotThreshold > |v|·10/MaxSpeed`, Default 0.5; Cfile:942301) —
  dann stehen bis `dot(fwd, ziel) ≥ 0.98`, danach voller MaxSpeed. Sonst
  Bogen-Geometrie: `r = dist²·0.5 / (dz·fwdX − fwdZ·dx)`; nur Kurven ENGER
  als der TurnRadius drosseln: `v = turnRate·|r|·0.5` (Cfile:942316-942321).
  Effektive Drehrate = `max(turnRate, v/turnRadius)`, auf π geklemmt
  (Cfile:766161-766163). Anhalten: `dist ≤ brake ? dist : sqrt(2·brake·dist)`
  (Cfile:766249-766262). Struct-Default TurnRadius = 5.0 (Cfile:656160).

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
- **Feldnamen im `.bp` sind die des PARSERS, nicht die internen Member.**
  `AddField_*` registriert sie (Projektil-Physics Cfile:653990-654175, Waffe
  Cfile:658290-658520). Zwei Fallen, an denen der `.bp`-Wert sonst nie gelesen
  wird: `CollideEntity` (nicht `CollisionEntity` — der Member heißt
  `mCollisionEntity`) und `BounceVelDamp` (nicht `BounceVelocityDamping`). Ein
  Projektil mit `CollideEntity = false` (Nukes, Strat-Raketen) flog sonst in die
  erste überflogene Einheit. Die Waffen-Struct-Defaults (23 float=0, 26
  bool=false, 7 string="") sind Pflicht: `weapon.lua:287` rechnet ungeprüft
  `bp.DamageRadius + …`, und die ACU-Waffe setzt kein `DamageRadius`.

## Schaden, Tod, Gesundheit (Details: [combat-projectiles.md](combat-projectiles.md), [damage-binary.md](damage-binary.md))

- **`SetHealth` quantisiert mit FLOOR, nicht kaufmännisch.** Die Engine rechnet
  `frndint(ratio*4)` mit der Korrektur `if (x < round(x)) −1` (Cfile:916030-916037)
  — das ist für positive x genau `floor(x)`. `OnHealthChanged(neu, alt)` feuert
  nur, wenn sich der **25%-quantisierte** Anteil ändert; daran hängen die
  Schadensraucher (unit.lua:820-823). Mit `+0.5` (round-half-up) feuert es an den
  12.5/37.5/…-Grenzen einen Tick zu früh.
- **Kill-Reihenfolge: `OnKilled` ZUERST, KILLS DANACH.** `cfunc_EntityKillL` ruft
  erst `Unit::Kill` (das OnKilled intern feuert, Cfile:936149), dann den
  KILLS-Zähler auf dem Instigator (Cfile:936183). `CheckVeteranLevel` liest
  `GetStat('KILLS',0).Value + 1` (unit.lua:3139) — das `+1` gilt genau, **weil**
  der aktuelle Kill noch nicht gezählt ist. Zählt man vorher, steigt die Unit
  einen Kill zu früh auf. **BENIGN**-Ziele (Wracks) zählen nicht (Cfile:936164).
- **`Kill`:** Baustelle mit `FractionComplete < 0.5` → `excessDamageRatio = 10.0`
  (Cfile:952122) ⇒ in der Lua **kein Wrack** (unit.lua:1079: `overkill > 1`).
- **`TargetCheckInterval` wird mit CEIL in Ticks umgerechnet** (`round(x·10) +
  (x·10 > round)`, min 1; Cfile:792904-792908), `fireClock = (int)(10/RoF)`
  (Trunkierung, Cfile:983956). Suchradius = `max(MaxRadius, TrackingRadius·MaxRadius)`
  — ein Maximum, kein Produkt (Cfile:793125).

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
- **Der Weltstart läuft über den WldUIProvider** (`InternalCreateWldUIProvider`
  → `WLD_SetUIProvider`, Cfile:29710): `func_DoPreload` (Cfile:1320735) ruft
  `StartGameUI` + `provider:StartLoadingDialog()`; `DoInitializing`
  (Cfile:1321030-1321090) ruft `StartGameUI` ERNEUT (SetNewLuaState räumt die
  Root-Frames — so verschwindet der Lade-Dialog), dann `StopLoadingDialog()`
  (Fraktionsbild, 1,5-s-Fade, `ForkThread(InitialAnimations)` —
  gamemain.lua:253-263 blendet Score/Economy/Avatare/Reiter ein) und ERST
  DANACH `CreateGameInterface` (= gamemain.CreateUI). Fehler in OnFrame
  werfen in der Engine nicht: RunScript fängt sie und loggt
  (`gpg::Warnf 'Error running %s script in %s: %s'`, Cfile:590672).
- **`currentScores` hat im Vanilla-3599-Datenbestand KEINEN Produzenten:**
  `CollectCurrentScores`/`SyncCurrentScores` (aibrain.lua:59/334) forkt
  niemand — weder eine Lua-Datei (grep über lua.scd/mohodata.scd: nur die
  Definitionen) noch die Engine (einziger aibrain-Import ist
  `func_LoadAiBrain`, Cfile:724474, nur für die Klasse; `GetArmyScore`
  liefert 0 Werte, Cfile:1267147). Die Punktespalte des Score-Panels bleibt
  1:1 LEER; lebende Zahlen wären eine Zusatzentscheidung (FAF-Verhalten).
- **Die Fabrik-Queue-Anzeige treibt die Engine, nicht die Lua:**
  `CUIManager::DoBeat` ruft pro Sim-Beat ERST
  `UI_FactoryCommandQueueHandlerBeat` (Cfile:1256904-1256990: struktureller
  Vergleich gegen `sCurrentBuildQueue`, bei Änderung
  `gamemain.OnQueueChanged(neu)`; Fabrik weg → einmal `OnQueueChanged(nil)`),
  DANN `UI_LuaBeat` (Cfile:1273907-1273911).
  `SetCurrentFactoryForQueueDisplay` kopiert die Queue sofort (Cfile:1257076).
- **Avatare/Idle:** Avatar = `bp.General.QuickSelectPriority > 0`
  (UserUnit-Ctor Cfile:1362979; Struct-Default 0, Cfile:656079), aufsteigend
  einsortiert (Cfile:1352238). `mIsEngineer` = ENGINEER **ohne**
  COMMAND/SCOUT/UNTARGETABLE (Cfile:1362995-1363014). Die Listen liefern bei
  leer **nil**, keine leere Tabelle (Cfile:1360921) — avatars.lua:666 prüft
  `if avatars then`. Die UEF-ACU trägt PODSTAGINGPLATFORM
  (uel0001_unit.bp:125) — orders.lua:923-932 läuft bei jeder ACU-Auswahl und
  braucht `GetAssistingUnitsList` (Cfile:1360671).

## Gelenkte Munition (Projectile-Tracking — Decomp + faf-re, alles belegt)

- **Move-Tick** (Cfile:944100-944260): OHNE Tracking `v += BallisticAcc·0.1`,
  dann `v += Forward(orient)·(Acceleration·0.1)`; VelocityAlign dreht die
  Orientierung per `QuatFromVecRot(orient, v, TurnRateDeg·0.0017453292)`
  (= TurnRate·0.1 Grad/Tick in rad). MIT Tracking (`bp.Physics.TrackTarget`,
  Struct-Default 0, Cfile:653698): `UpdateTracking` dreht die NASE, dann
  `v += Forward·Accel·0.1` (kein BallisticAcc). `MaxSpeed≠0` clampt |v|.
  Position += (v_alt + v_neu)·0.05 (Trapez!).
- **UpdateTracking** (@944367): Ziel = GetTargetPosGun; Ziel verloren →
  RunScript `OnLostTarget` + TrackTarget=0 (fliegt auf letzte Zielposition
  weiter, Flag v207). LeadTarget (mLeadTarget & MaxSpeed>0, Entity-Ziel):
  ZWEISCHRITTIGE Vorhaltung — t1=|ziel−pos|/(MaxSpeed·0.1)… (iteriert 2×
  über die Zielgeschwindigkeit). ZigZag (MaxZigZag>0 & Frequency>0): alle
  f(Frequency) Ticks neue FRand(−max,+max)-Offsets je Achse, skaliert mit
  min(dist/MaxZigZag, 1), Terrain-Klemme GetElevation+0.5. Am Ende
  `QuatFromVecRot(orient, richtungZumZiel, TurnRateDeg·0.0017453292)`;
  VelocityAlign setzt v = Forward·|v| (func_VecSetLength).
- **QuatFromVecRot** (@0x69AA50, faf-re QuaternionMath.cpp:531): forward =
  Z-Spalte des Quats; `delta = QuatCrossAdd(forward, ziel)`;
  `RotateQuatByAngle(delta, rads)`; `quat = delta·quat` (PRE-multiply).
- **QuatCrossAdd(v1,v2)** (@0x44F880, faf-re Sim.cpp:8759): half =
  normalize(norm(v1)+norm(v2)); w = dot(half,v1), xyz = cross(v1, half)
  — die Rotation v1→v2. Antiparallel (|half|=0): (0, v1).
- **RotateQuatByAngle(q, rads)** (@0x4EB740, faf-re QuaternionMath.cpp:481):
  begrenzt das DELTA auf rads: wenn sin²(θ/2)=|q.xyz|² ≤ sin²(rads/2) →
  UNVERÄNDERT (Ziel näher als Limit → volle Drehung); sonst q =
  (cos(rads/2), axis·±sin(rads/2)) (Vorzeichen folgt w<0). rads/2 ≥ π/2 →
  unverändert.

## Effekte/Partikel (Quelle: effects/particle.fx aus effects.scd, 1332 Zeilen — der ECHTE Shader)

- **Partikel-Vertexshader (WorldVS):** `t = time - birth`; `alpha = t/lifetime`
  (= Ramp-U!); Position ohne Drag `P0 + V·t + 0.5·A·t²`, mit Drag
  `(dz·A − dy·V)·(e^(−dx·t) − 1) + dy·A·t + P0`; Rotation
  `rot = Pos.w + Vel.w·t` dreht das ±1-Quad; Billboard über
  `InverseViewMatrix[0/1]` (Flat: Welt-X/Z); Größe `Size.x + Size.y·t`.
  Frame-Animation: `frame = floor(framerate·t)`, U um `framesize·frame`
  verschoben; TexOffset.z/x wählen die Textur-Zeile, TexOffset.y die
  Ramp-Zeile (mTex1 = {alpha, rampOffset}).
- **Pixelshader:** `Partikeltextur(mTex0) × Ramptextur(mTex1)`; REFRACT
  versetzt den Hintergrund um `0.005·(2·texel.rg − 1)`.
- **Blend-States (AlphaState je Technique-Suffix):**
  MODULATEINVERSE = Zero/InvSrcColor · MODULATE2XINVERSE =
  InvDestColor/InvSrcColor · ADD = SrcAlpha/One · ALPHABLEND =
  SrcAlpha/InvSrcAlpha (nur RGB) · PREMODALPHA = One/InvSrcAlpha (nur RGB).
  Depth: Test Less AN, **Write AUS**; Cull None. Technique-Familien:
  TRamp[Animate][Align|AlignToBone|Flat]_<BLEND>, TLight, TBeam_One/TwoTexture,
  TTrail (TrailVS: Ribbon quer zur Blickrichtung, `cross((0,0,1), dirView)`,
  V aus `(startTime − originTime)/lifetime · repeatRate`).
- **Emitter-Transport bei uns:** die Sim meldet lebende Emitter pro Beat mit
  Weltposition (`__readAllEmittersJson`, globals.lua; Owner+Knochen über
  `__boneWorld`) → Worker → `LuaSimClient.allEmitters()`.

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
