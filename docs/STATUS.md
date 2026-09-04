# Status & known gaps

*This document tracks the changing status so [CLAUDE.md](../CLAUDE.md) does not
have to. Update it at every major milestone.*

## Status (July 2026): tech demo with combat, effects, audio, and a live UI

Select an ACU → open the build menu from its blueprint → place a building on
the grid → the real economy pays → the factory produces tanks → a Gauss duel
with projectiles, damage, death, and **wreckage** (the wreckage shader from
mesh.fx). Also included: particles/trails/beams (particle.fx port,
CEfxEmitter tick), CollisionBeams, guided munitions, XACT audio as PCM through
the speakers, and units under map lighting (mesh.fx ComputeLight). The session
UI (economy, multifunction, orders, construction, unitview, tabs, avatars,
minimap window, ...) renders entirely from the original Lua through the real
provider chain (DoPreload → first sync beat → DoInitializing); **keyboard input
works** (keymap from keymapper.lua, 135 hotkeys, CUIKeyHandler executor,
UI_Lua). Verified in **53 suites** (`npm test`) and in the browser through
`?sandbox=<map>&selftest=<blueprint>`.

## Engine coverage (August 2026)

`npx tsx --import ./scripts/register-lua.mjs scripts/coverage-engine.ts` measures
every binding in [research/engine-api.md](research/engine-api.md) against what
our engine made of it: **1149 bindings, 698 real / 147 no-op / 304 missing =
61 %**.

Two earlier figures are void. "86 %" was measured while the class-line regex
(`$`-anchored, CRLF checkout) parsed **no class binding at all** and pinned the
NO-OP column to 0. The replacement "57 %" was **also wrong**: `methodenStand`
returned `FEHLT` for every class not in a 19-entry map, so **238 methods across
32 classes were scored blind**. The map now covers the manipulators (one shared
`ManipMeta` — a named reduction), `CollisionBeamEntity` and `CMauiLuaDragger`;
**38 methods moved from "missing" to "real"** on re-measurement.

Largest remaining gaps: `Unit` (54), `CPlatoon` (49) and `CAiBrain` (48) — the
two AI classes are a scheduled phase in [MASTERPLAN.md](MASTERPLAN.md), not a
defect — then Sim-Globals (47), `CAiPersonality` (35), `Entity` (27),
`CLobby` (18). Those four classes genuinely do not exist in `src/engine-lua/`
(checked); `FEHLT` is correct for them.

## Welche der stillen No-ops das Spiel wirklich aufruft

`src/engine-lua/moho.lua` filled **147** bindings with a silent no-op when
this was measured. Until then nobody knew which of them a running game even
reaches -- the priorities were guesswork. `scripts/verify-playthrough.ts`
switches on `__mohoNoopWarn` for that; every no-op reports its first call.

A full game (ACU -> build -> factory -> combat -> wreck) reaches **none of
them** any more (nine, until `AddBuildRestriction`, `HideBone`, `ShowBone`,
`GetFocusUnit`, the attach family `AttachTo`/`AttachBoneTo`/`DetachFrom`/
`DetachAll` and `ShakeCamera` became real; then the motion events made
unit.lua's movement effects run, which reached `AddThreadScroller` and
`RemoveScroller` until the texture scrollers became real -- see below). The
other no-ops are not reached this way -- not harmless, but not urgent either.
The **first** called no-op fails the run (the checked-in finding list).

## Golden Master: ein Orakel, das keine Frage stellt

Jede der 57 Suiten prüft eine Sache, die jemand vorher bedacht hat. Genau daran
sind zwei Regressionen dieser Woche vorbeigelaufen (beschildete Einheiten nahmen
null Flächenschaden; Schüsse an einer Küste meldeten `Water`), und die aus
`4a37b2f` überlebte so einen ganzen Monat.

`scripts/verify-goldenmaster.ts` fährt einen festen Ablauf — Ökonomie, Bau,
Fabrik, Bewegung, Kampf, Flächenschaden, Schildkuppel — und hasht den Endzustand.
Das Material ist nicht ausgedacht: es ist `__readAllUnitsJson()`
(`units.lua:846`), also exakt der Block, den die Sim zehnmal pro Sekunde an die
UI schickt, plus die acht Ökonomie-Summen je Armee. Der Hash liegt in
`scripts/fixtures/goldenmaster.json`.

Der Test weiß nicht, was RICHTIG ist — nur was ANDERS ist. Jede
Verhaltensänderung wird rot, auch eine, an die niemand gedacht hat. War sie
Absicht, wird der Hash mit `--update` in demselben Commit nachgezogen, der sie
erklärt; `--dump` schreibt das gehashte Material heraus, damit ein roter Lauf
zeigt **was** sich geändert hat statt nur **dass**.

Rot-Probe: die Schild-Regression wieder eingebaut (`damage.lua:223`
`if not fromArea` → `if true`) → Hash weicht ab, Exit 1; zurückgenommen → grün.

### Was die Rot-Probe nebenbei gefunden hat: `math.pow`

Der rote Lauf meldete `Error running lua script: /mod/lua/utilities.lua:50:
attempt to call a nil value (field 'pow')`. FAs Lua 5.0.1 hatte `math.pow`, Lua 5.4
(wasmoon) hat es nicht mehr, und `compat.lua` shimmte es nicht. Betroffen ist
`GetVectorLength` (`utilities.lua:50`) und `platoon.lua:983` — mehr Stellen gibt
es in der Original-Lua nicht (alle 1316 Dateien durchsucht; `math.log10`,
`frexp`, `ldexp`, `cosh/sinh/tanh`, `atan2`, `fmod` kommen nicht vor,
`math.mod` war bereits geshimmt).

Der Fehler war doppelt still: aus einem ForkThread wird er nur geloggt, der
Aufrufer bekommt einfach nie eine Länge. Behoben in `compat.lua`, geprüft in
`verify-lua.ts` über den Original-Ausdruck aus `utilities.lua:50` (3/4/12 → 13),
Rot-Probe: Shim entfernt → FAIL + Exit 1.

## Das Replay als Orakel: die Frage ist beantwortet

Ein Golden Master schützt vor Änderung, aber er sagt nicht, ob der Zustand
RICHTIG ist — er ist unser eigener Zustand. Die einzige Quelle, die das
beantworten kann, ist die Originalengine. Sie hat auf diesem Rechner neun
Partien aufgezeichnet.

Offen war, ob der aufgezeichnete Körper die `VerifyChecksum`-Nachrichten
wirklich Byte für Byte enthält. Die Architektur legte es nahe, bewiesen war es
nicht. **Jetzt ist es bewiesen.**

Der Weg dahin, vollständig aus dem Decompilat: `CDecoder::DecodeMessage`
(Cfile:996781-996800) rahmt jede Nachricht als `[u8 Opcode][u16 Gesamtlänge
LE][Nutzlast]`, `MSGOP_VerifyChecksum` ist Opcode 3 (`case 3u`), und
`DecodeVerifyChecksum` (Cfile:996938-996946) liest 16 Byte Digest plus den Beat
als `int` — ein Datensatz von genau 23 Byte. Das Kopfformat steht in
`VCR_SetupReplaySession` (Cfile:1303988-1304227).

`src/formats/scfareplay.ts` setzt das um, `scripts/verify-replay.ts` prüft es
gegen die echten Aufzeichnungen: **9 Replays aus drei Engine-Ständen
(v1.50.3599, v1.50.3608, v1.60.6), 258 107 Nachrichten, 4 884 Prüfsummen, kein
Fehler.** Die tragende Prüfung ist nicht „parst ohne Ausnahme", sondern dass der
Rahmenlauf in jeder Datei **exakt** auf dem Dateiende endet; ein unabhängiger
roher Byte-Scan findet dieselben Prüfsummen.

Rot-Proben: Körperbeginn um **ein** Byte verschoben → alle neun scheitern
sofort. Kein Replay im Ordner → Exit 1 (ein Fehlschlag, kein Übersprung).

Gemessen: die Prüfsummen liegen bei Beat 0, 50, 100, … ohne Lücke — die größte
Datei hat 2701 Datensätze bis Beat 135 000 (= 2700 × 50 + Beat 0, exakt). **Die
50 ist eine Messung, keine Cfile-Konstante:** die Sendestelle
(Cfile:1067922-1067937) verschickt den Beat, den die Sync-Anfrage nennt, aus dem
128er-Ring `mSimHashes[beat & 0x7F]`; welche Kadenz die Anfrage wählt, ist nicht
nachverfolgt.

Damit existiert alle 5 Sekunden Spielzeit ein Vergleichspunkt gegen die
Originalengine. **Noch nicht gebaut** ist der Vergleich selbst: dafür muss
`Sim::UpdateChecksum` (Cfile:1076701, faltet `SEconTotals` je Armee über 0x38
Byte) nachgebildet werden, und der eingespeiste Befehlsstrom muss bei uns
überhaupt laufen. Das nächste ehrliche Fortschrittsmaß ist deshalb keine
Prozentzahl, sondern: **bis zu welchem Beat kommen wir?**

### Der Befehlsstrom ist jetzt dekodiert — 6 263 Datensätze, kein Rest

`src/formats/scfareplay.ts` liest nicht mehr nur den Rahmen. Jedes Feld stammt
aus dem Decompilat, und zwar von BEIDEN Seiten, weil die sich gegenseitig
kontrollieren: `DecodeCommandData` (Cfile:997521-997590) gegen
`WriteCommandData` (Cfile:999299-999428), `WriteTarget` (Cfile:999433-999493),
`DecodeEntIdSet` (Cfile:997440-997444), `WriteCells` (Cfile:999496-999541),
`SCR_FromByteStream` (Cfile:598588-598636), `DecodeLuaSimCallback`
(Cfile:997312-997318).

Über alle neun Replays: **258 107 Nachrichten, 4 884 Prüfsummen, 6 263
Befehls-Datensätze — jeder auf das letzte Byte aufgegangen.** Dazu die drei
Kopf-Blöcke als vollständige Lua-Bäume.

Was dabei ans Licht kam:

| Befund | |
| --- | --- |
| **G2, ein Fehler von heute Vormittag.** `gameMods`, `scenarioInfo` und `armies[].info` wurden mit `TextDecoder('latin1')` gelesen. Node bildet `latin1` auf **windows-1252** ab (nachgemessen: `.encoding === 'windows-1252'`, `0x80` → U+20AC) — und `0x80` ist das dritte Byte des Floats 1.0, das in jedem dieser Blöcke steht. Es sind `SCR_ToByteStream`-Bäume, kein Text. Jetzt `Uint8Array`. | behoben |
| **Der `ori`-Block ist 24 Byte, nicht 20.** Die Engine schreibt Sentinel (4) + 16 + 4 (Cfile:999369-999393). Mit 20 verschob sich alles danach, und der Fehler tauchte drei Felder später auf: die Zellen-Anzahl las sich als 4 161 536, weil sie die halbe Bitfolge des Floats 1.0 war. | behoben |
| **`LuaSimCallback` hat DREI Teile**, nicht zwei: Name, Lua-Wert, EntIdSet (Cfile:997312-997318). | belegt |
| **Die Uhr ist keine Gleichheit.** Die Summe der Advance-Deltas ist NICHT immer der Beat der nächsten Prüfsumme. Gemessen: Versatz meist 0, aber bis 47. Das passt zum 128er-Ring `mSimHashes[beat & 0x7F]` (Cfile:1067934). Geprüft wird deshalb die Schranke `0 ≤ Versatz < 128` — verrutscht der Rahmen, sprengt der Versatz sie sofort. | korrigiert |
| **`ESTITargetType` hat im Decompilat keine Zahlen.** Die STRUKTUR ist bewiesen (`WriteTarget`: Typ-Byte, dann 4 Byte Id bei `AITARGET_Entity`, 12 Byte Position bei `AITARGET_Ground`, sonst nichts). Die Werte 0/1/2 sind aus dem Bestand erschlossen. Der Leser WIRFT bei allem anderen. | UNBEKANNT, markiert |
| **`unk1`, `unk3`, `unk4`, `index`** heißen so, weil ihre Bedeutung unbekannt ist. Ihre Bytes sind es nicht. | UNBEKANNT, markiert |

Rot-Probe: vier Byte aus dem `ori`-Block genommen → fünf Replays scheitern
sofort mit derselben unsinnigen Zellen-Anzahl.

### Der eigentliche Befund: es gibt kein einspeisbares Replay

Der Bestand nach Befehlstyp — 6 263 Befehle, angeführt von Move (3 519),
BuildMobile (950), BuildFactory (410), Guard (359), Attack (224). Und acht
verschiedene `LuaSimCallback`s, darunter **`GiveOrders` (109)**: das ist ein
echter Befehlskanal, kein Debug-Verkehr.

Aber: **keines der neun Replays ist einspeisbar.** Ein Replay taugt nur als
Vergleich gegen die Originalengine, wenn dieselbe Lua läuft. Sechs tragen
LOUD/BrewLAN/TotalMayhem/M28-AI, deren Lua unsere Sim-Skripte ersetzt — eine
Abweichung dagegen misst den Mod, nicht unsere Engine. Von den drei mod-freien
ist nur bei einem die Karte installiert, und das enthält 1 Beat und 0 Befehle.

**Was fehlt, ist keine Codeänderung: es ist eine Partie ohne Mods auf einer
installierten Karte.** `verify-replay.ts` führt die Zahl als Sperrklinke (heute
0, darf nur steigen) und nennt je Replay, woran es scheitert.

## Der Sitzungsstart läuft jetzt als Original-Lua

Drei Stellen bauten die Startbedingungen in TypeScript nach — genau das, was
CLAUDE.md verbietet:

* `src/sim/session.ts` kopierte die Bündnisregel aus
  `scenarioutilities.lua:488-500` nach TS. Der Kommentar zitierte sogar die
  Zeile 495 — und die Übersetzung hatte **beide Zivilisten-Zweige verloren**
  (`:491-493` `CivilianAlliance == 'neutral'`, `:497-498` `NEUTRAL_CIVILIAN`).
* `src/main.ts:1031-1062` parste die `_save.lua` der Karte mit dem
  TS-Blueprint-Parser, um zwei Werte herauszuziehen.
* `src/engine-lua/units.lua` **erfand** ein leeres `Scenario`-Global — mit einem
  Kommentar, der es zugab („minimal leer, damit `GetMarkers()` fehlerfrei
  läuft"). Ein **fünfter Auto-Vivifier**, den CLAUDE.md nicht kennt, und der
  schlimmste: `GetMarkers()` lieferte still `{}`, `InitializeArmies()` übersprang
  jede Armee an `scenarioutilities.lua:449` (`if tblData then`), und **nichts
  schlug fehl**.

Jetzt läuft die echte Kette, jede Zeile mit ihrer Fundstelle in
`src/engine-lua/session.lua`:

```
doscript('/lua/dataInit.lua')                              siminit.lua:92
ScenarioInfo.Env = import('/lua/scenarioEnvironment.lua')  siminit.lua:82
doscript(ScenarioInfo.save, ScenarioInfo.Env)              siminit.lua:93
Scenario = ScenarioInfo.Env.Scenario                       siminit.lua:95
doscript(ScenarioInfo.script, ScenarioInfo.Env)            siminit.lua:98
je Armee: InitializeStartLocation + SetPlans               schook/lua/simInit.lua:47-48
ScenarioInfo.Env.OnPopulate(ScenarioInfo)                  siminit.lua:145
```

Das Ergebnis auf SCMP_009, geprüft von `scripts/verify-session-start.ts`:
**341 Marker aus der echten Karte** (das erfundene Global hatte 0), und **zwei
Kommandeure auf 672.5/346.5 und 357.5/673.5 — den Markern `ARMY_1` und `ARMY_2`
der Karte, dorthin gestellt von `scenarioutilities.lua`**. Die Bündnislage
setzt `scenarioutilities.lua:495`, nicht mehr TypeScript.

`setupSession` und `beginSession` sind jetzt zwei Schritte, wie in der Engine
(`Sim::CreateArmies` Cfile:1072015, `Sim::BeginSession` Cfile:1072090):
dazwischen werden die Blueprints geladen, die `OnPopulate` braucht — die Engine
hat sie ebenfalls lange vorher (siminit.lua:8).

Neu gebaut, jedes mit Beleg: `__resolveArmy` (= `ARMY_FromLuaState`,
Cfile:1024163-1024225, Zahl ODER Name, drei Original-Fehlertexte),
`SetArmyStart` (Cfile:1024490-1024526), `ShouldCreateInitialArmyUnits`
(Cfile:1024319-1024333, **null** Argumente), `SetArmyPlans`, `InitializeArmyAI`
(Cfile:724516-724518), `CreateInitialArmyUnit` (Cfile:1025200-1025275) und ein
echter `GetArmyStartPos` — der stand bis jetzt in der stillen No-op-Liste
(`moho.lua`, AIBRAIN_NAMES) und lieferte `nil` an genau die zwei Stellen, die
ihn brauchen.

Zwei Unterscheidungen, die die Engine macht und wir jetzt auch:
`CreateUnitHPR` nimmt einen Armee-NAMEN (`ARMY_FromLuaState`, Cfile:980538),
`CreateUnit` nicht (`lua_type != LUA_TNUMBER` → `TypeError "integer"`,
Cfile:980336-980352). Und `SetArmyEconomy` warf einen unbekannten Namen
still auf Armee 1 (`?? 1`) — jetzt `Unknown army: %s` wie im Original.

Rot-Proben: `SetArmyStart` zum No-op gemacht → der Lauf scheitert laut an
`scenarioutilities.lua:338` mit der Ursache im Klartext. Die Karte nicht laden →
der Lauf scheitert sofort. **Ehrlich dazu:** das erfundene `Scenario` wieder
einzusetzen macht die Suite NICHT rot — `Scenario = Scenario or {…}` weist nur
zu, wenn nichts da ist, und der echte Lader überschreibt es danach. Die Suite
belegt also, dass die echte Karte geladen wird, nicht die Löschung als solche.

### Was die Löschung im vollen Lauf ausgelöst hat

Drei Suiten gingen rot, und alle drei waren Befunde:

* **`verify-multiunit` und `verify-upgrade`** starben beim Spawn von `ueb1103`
  (Massextraktor). Ursache: `MassCollectionUnit.OnCreate` ruft
  `ScenarioUtils.GetMarkers()` (defaultunits.lua:776), um zu sehen, ob der
  Extraktor auf einem Massepunkt steht — vorher las es still `{}`, jetzt gibt es
  ohne Karte gar kein `Scenario` und `pairs(nil)` wirft. Gelöst nicht durch
  Zurücknehmen, sondern durch Verschieben: `__harnessScenario()` setzt die leere
  Tabelle **nur im ausdrücklich kartenlosen Zweig** von `setupSession`. Der
  Unterschied ist nicht kosmetisch — im Produktionspfad gibt es sie nicht mehr,
  also fällt eine echte Sitzung, die das Laden vergisst, jetzt auf.
* **`verify-army-victory`** erwartete unsere alte Fehlermeldung. `GetArmyBrain`
  geht im Original durch `ARMY_FromLuaState` und meldet `"Invalid army %d"`
  (Cfile:1024184) — und druckt dabei `index - 1`, fragt man also nach 99, sagt
  es 98. Die andere Meldung („Invalid army index; must be >= …") gehört zu den
  Positions-/Threat-Bindungen (Cfile:980344-980352). Die Suite prüft jetzt den
  exakten Engine-Text statt eines Musters — eine schärfere Zusicherung als vorher.

### Was dabei über die KI herauskam

Mit `human: false` läuft `InitializeArmyAI` in `brain:OnCreateAI(plan)` — und
der Pfad stirbt an `aibrain.lua:1144`: `plat:ForkThread(...)` auf
`plat = self:GetPlatoonUniquelyNamed('ArmyPool')`, und
**`GetPlatoonUniquelyNamed` ist einer der 147 stillen No-ops**. Es gibt kein
Platoon-System, also gibt es keine KI-Armee. Das ist kein Testproblem, das ist
der Zustand — nachgemessen in genau diesem Lauf.

### Offen und benannt

`/lua/simInit.lua` selbst läuft weiterhin nicht — aber der Grund ist ein
anderer geworden, und der alte ist behoben.

**Behoben: `DiskFindFiles` in der Sim war eine stille falsche Antwort.** Die
Fassung in `blueprints.lua` durchsuchte nur `__bpFiles` und **ignorierte das
`pattern`-Argument vollständig**. `localization.lua:29` fragt nach
`DiskFindFiles('/loc', '*strings_db.lua')` und bekam Blueprint-Pfade oder
nichts — deshalb kam `/lua/globalinit.lua:14-24` nie durch. Die UI-VM hatte die
richtige Fassung die ganze Zeit (`src/vfs/glob.ts`).

Jetzt liefert `/loc '*strings_db.lua'` die Datei, `/maps '*_scenario.lua'` die
61 installierten Karten, und ein Muster, das nicht passen kann, liefert nichts.
`.bp` kommt weiterhin aus `__bpFiles` — eine **benannte** Abweichung: die Engine
hätte hier den ganzen Spielordner, wir laden Blueprints absichtlich selektiv,
sonst zöge jeder Testlauf alle 2437 durch die Original-Pipeline. Beide Hälften
sind in `verify-core-globals.ts` festgenagelt; Rot-Probe: das Muster wieder
ignorieren → genau die Zusicherung „das Muster wird wirklich angewandt" wird rot.

**Ebenfalls neu:** `HasLocalizedVO` und `AudioSetLanguage` gibt es jetzt auch in
der Sim. Sie stehen in **beiden** VM-Listen (`engine-api.md:45` und `:104`), und
die Sim-Fassungen tun nachweislich nichts: `cfunc_HasLocalizedVOSim`
(Cfile:1090520-1090533) und `cfunc_AudioSetLanguageSim` (Cfile:1090484-1090497)
prüfen nur die Argumentzahl und machen `return 0` — ohne Rückgabewert. Für
`localization.lua:43` heißt das: der `else`-Zweig greift. Das ist der
Unterschied zu einem stillen Stub — hier IST Nichtstun das Verhalten der Engine,
mit Fundstelle.

**Der neue Blocker liegt tiefer:** `doscript('/lua/simInit.lua')` kommt jetzt
durch die ganze Lokalisierung und scheitert erst an `class.lua:273`
(„Attempted to add field `__index` after class was defined"). Die volle
`simInit.lua` fährt den `ConvertCClassToLuaClass`-Lauf, den unser `installEngine`
bereits hinter sich hat — das ist eine Kollision der Boot-Reihenfolge, kein
fehlendes Global, und damit ein eigener Meilenstein. Bis dahin fährt
`session.lua` genau die Schritte nach, die `SetupSession`/`BeginSession` täten.

### Die Karte bringt jetzt ihre Lagerstätten und Props mit

`CreateResourceDeposit` fehlte als einzige der Bindungen, die
`ScenarioUtils.CreateResources()` (scenarioutilities.lua:371-431) braucht —
`CreatePropHPR`, `CreateSplat` und `Random` waren längst da. Belegt aus
`cfunc_CreateResourceDepositL` (Cfile:687704-687772): genau fünf Argumente
(sonst wirft die Engine), Argument 2/3/4 → `pos.x/y/z`, Argument 5 → ein
quadratisches `Vector2i{size,size}`, am Ende `AddDepositPoint`. Ein unbekannter
Typ wird nur **geloggt**, nicht abgelehnt (Cfile:687767).

**Die Enum-Werte sind UNBEKANNT** — IDA zeigt nur den Container
`resource_deposit_t` (Cfile:422326), nicht seine Zeichenketten. Deshalb wird der
STRING gespeichert und keine Zahl erfunden. Benutzt werden ohnehin nur zwei:
`Mass` und `Hydrocarbon` (markertemplates.lua:9-23).

Vor `OnPopulate` läuft, was der schook-Hook fährt: `CreateProps()` und
`CreateResources()` (schook/lua/simInit.lua:17-18) — inzwischen der Hook selbst,
nicht mehr unser Nachbau davon. Auf
SCMP_009 ergibt das **108 Masse- und 8 Hydrokohlenstoff-Lagerstätten**, und die
Suite prüft sie gegen die Marker der Karte — ohne diese Gegenprobe würde sie
auch für einen Lader gelten, der irgendetwas anlegt.

Dabei kam heraus, dass `loadProps` in `gameFiles.ts` zu eng filterte: nur
`/props/**`, während die Karte aus `/env/common/props/` baut
(`massDeposit01_prop.bp`, scenarioutilities.lua:389). Die Engine warf dort
richtig („Invalid blueprint"); jetzt werden 335 Prop-Blueprints geladen.

**Gesammelt, nicht benutzt:** was die Engine mit den Lagerstätten tut, haben wir
nicht. `CSimResources` speist im Original die Bauplatzprüfung, damit ein
Extraktor nur auf einem Massepunkt stehen darf. Hier liest sie bis auf Weiteres
nur die Prüfung. Das ist eine Lücke, keine Implementierung — und sie steht so im
Code.

### Und dann läuft sie: 100 Beats auf echten Kartendaten

Ein Sitzungsstart, den niemand tickt, beweist wenig. `verify-session-start.ts`
setzt jetzt das **echte Höhenfeld der `.scmap`** als Geländequelle (nicht flach
20) und lässt die Sim 100 Beats laufen. Ergebnis: **kein Lua-Fehler**, beide
Kommandeure stehen unverändert auf ihren Markern, beide Armeen haben ihren
Startvorrat (650 Masse / 4000 Energie, von der ACU selbst über
`GiveInitialResources`).

Der erste Lauf war rot, und der Grund war aufschlussreich:
`CreateProjectile: Invalid blueprint /effects/entities/UnitTeleport01/…` an
`uel0001_script.lua:193`. Das ist `PlayCommanderWarpInEffect` — geforkt von
`CommanderWarpDelay`, weil `Options.PrebuiltUnits == 'Off'` ist
(scenarioutilities.lua:340-343). Mit anderen Worten: **der Warp-In der ACU läuft
seit dieser Änderung wirklich mit**, und der Suite fehlten nur seine
Blueprints. Die Engine hat dort zu Recht geworfen.

### Armee-Namen: was schon ging, und was nicht

`SetAlliance` mit Namen stand hier als offener Punkt — **es ging bereits.** Die
gemeinsame Auflösung `__resolveArmy` hatte es miterledigt, samt der
Engine-Meldung `Unknown army: %s` für einen unbekannten Namen. Nachgemessen,
nicht angenommen.

Offen war etwas anderes, das niemand aufgeschrieben hatte: **sechs Bindungen
gehen über `__armyVar` und lehnten Namen ab** — `SetIgnoreArmyUnitCap`,
`ArmyIsOutOfGame`, `ArmyIsCivilian` (Cfile:1025687), `GetArmyUnitCap`
(Cfile:1024976), `SetArmyUnitCap` (Cfile:1025033), `SetArmyOutOfGame`
(Cfile:1026347). Alle sechs gehen im Original durch `ARMY_FromLuaState`,
nehmen also Namen; nachgesehen für jede einzelne. Behoben an der gemeinsamen
Stelle, wobei Zahlen unverändert durchgehen — eine zusätzliche Bereichsprüfung
dort hätte Aufrufer getroffen, die es heute richtig machen.

### `GetTerrainType` las die Typ-Ebene der Karte gar nicht (US16/T018)

Die Funktion lieferte für **jede** Position `TerrainTypes[1]`. Für den Randfall
war das zufällig richtig, für jede echte Zelle falsch — die Karte hat eine
Terrain-Typ-Ebene, und sie wurde nie gelesen.

`STIMap::GetTerrainType` (Cfile:1087694-1087707) macht dreierlei, und das
mittlere ist das überraschende:

1. außerhalb der Karte (`x >= width-1` oder `z >= height-1`) ist der Index fest
   **1**, nicht 0 (Cfile:1087702-1087703);
2. sonst das Byte der Typ-Ebene an dieser Zelle (Cfile:1087705);
3. nachgeschlagen wird nach **TYPCODE**, nicht nach Listenposition — der Vektor
   ist ein C++-Vektor über Codes bis 255. `terrainTypes.lua:8` sagt es selbst,
   und die Bereiche beginnen bei 002.

Damit stimmt der Randfall mit dem überein, was die Datei verspricht:
`TerrainTypes[1]` hat `TypeCode = 1` und heißt `'Default'`
(terrainTypes.lua:126-129) — „Position (-1, -1) will return the 'Default'
terrain type" (:15-16), worauf sich `unit.lua:2421` verlässt.

Gemessen: SCMP_009 hat **11 verschiedene Typcodes**, SCMP_001 neun, SCMP_015
fünf. Über ein Raster gelesen liefert die Karte jetzt **Water03, Water02,
Rocky02, Vegetation04, Water04, Vegetation03, Dirt02, Sand02, Dirt03** statt
neunmal `Default`.

Ein Code **ohne** Eintrag bleibt UNBEKANNT: die Engine indiziert dort ihren
Vektor, und ob der 256 Plätze hat, steht nicht im Decompilat. Statt zu raten
wird einmal je Code gewarnt und der Default geliefert — sichtbar, nicht still.
Auf den geprüften Karten feuert die Warnung nicht.

### US9: Script-Bits gingen an Einheiten, die sie gar nicht haben

`ToggleScriptBit` kippte den Bit ohne jede Prüfung. Die Engine prüft als
allererstes die **Laufzeit**-Toggle-Cap-Maske: `if ((1 << bit) &
GetAttributes1(this)->mToggleCaps)` (Cfile:951398) — ist das Bit nicht drin,
passiert gar nichts, kein Umschalten, kein Callback. `SetScriptBit` macht
nichts eigenes; es rechnet die Cap-Zeichenkette in einen Index um und delegiert
(Cfile:974910-974925).

Es muss die Laufzeit-Maske sein, nicht `TestToggleCaps`: das prüft ausdrücklich
das unveränderliche Blueprint-Feld (Cfile:975885-975932), während Erweiterungen
Caps zur Laufzeit **hinzufügen**. Gegen das Blueprint zu prüfen hieße, jede
Erweiterung wirkungslos zu machen.

Gemessen, wer überhaupt Caps hat: `ueb4202` (Schild) `RULEUTC_ShieldToggle`,
`ueb3101` (Radar) `RULEUTC_IntelToggle`, `url0101` `RULEUTC_CloakToggle` —
**`uel0001` (ACU) und `ueb0101` (Fabrik) haben keine.**

Das hat zwei Dinge aufgedeckt:

* **`verify-toggle-pause` prüfte Verhalten, das die Engine nicht hat.** Sie legte
  den Schild-Bit an der ACU um und bekam ihn auch. Jetzt läuft der Block am
  Schildgenerator, plus einer Gegenprobe an der ACU, bei der nichts passieren
  darf. Nebenbei kam heraus, dass der Schildgenerator seinen Bit beim Erzeugen
  **selbst** setzt — Original-Lua bei der Arbeit; die Messung bringt ihn jetzt
  erst auf einen bekannten Stand.
* **Der Golden Master schlug an**, und sein Diff war chirurgisch: ein Feld an
  einer Einheit. Die beschildete ACU hatte `scriptBits = 1`, jetzt `0`. Ökonomie
  identisch, alle zehn Einheiten identisch, sonst nichts. Der Hash ist mit
  diesem Commit nachgezogen.

Mirrored as well, since the attach family became real (see "The attach
family was four silent no-ops"): the engine refuses the toggle while the unit
is attached to something of the category TRANSPORTATION (Cfile:951400-951424)
-- `ToggleScriptBit` checks `IsUnitState('Attached')` and the parent's
category.

### Der schook-Blocker war ein Typfehler an der JS-Grenze — und er ist behoben

`Hook /schook/lua/simInit.lua: TypeError: self is not a function` sah nach einem
Lua-Problem aus. Es war keines.

`DiskFindFiles` endet in `__simDiskFindFiles`, einer **JS-Funktion**, die ein
`string[]` liefert. wasmoon legt das nicht als Lua-Tabelle ab, sondern als
**userdata**-Proxy. Selbst nachgemessen:

| | |
| --- | --- |
| `type(...)` | `userdata` |
| `#` und `ipairs` | funktionieren |
| `pairs` | **reisst die VM um** — `Cannot read properties of null (reading 'then')` |
| `for k,v in t do` (FA-Dialekt → `__foriter`) | **`TypeError: self is not a function`** |

`__foriter` (compat.lua:14-22) prüft im Tabellen-Zweig auf
`type(a) == 'table'`; userdata fällt durch, und der generische `for` ruft den
Proxy als Iterator auf. Genau daran starb der Hook.

Und es war **nicht auf die Sim beschränkt**: die UI-VM hat dieselbe Brücke
(`uiEngine.ts:130`) und damit denselben Fehler — er hätte die Kartenliste der
Lobby getroffen (`maputil.lua:106 for index, fileName in scenFiles do`,
`helptext.lua:26`). Beide VMs kopieren den Proxy jetzt in eine echte Tabelle.

Dieselbe Familie wie die `null`-Falle in `LuaHost.setGlobal`: ein
JS-Rückgabewert, den Lua anders sieht als gedacht. Die Prüfung in
`verify-core-globals.ts` nagelt deshalb ausdrücklich den **Dialekt-Weg** fest,
nicht nur die Länge — `#` allein hätte den Fehler nicht gesehen.

### `CreatePrefetchSet` — die nächste fehlende Zutat, gebaut

`Prefetcher = CreatePrefetchSet()` steht in `siminit.lua:232`; ohne diese
Bindung kommt die echte `/lua/simInit.lua` dort nicht vorbei. Registriert in
**`scr_CoreInits`** (Cfile:563845), also in beiden VMs — deshalb liegt sie in
`str.lua`, das `LuaHost` in beide lädt. Hilfetext wörtlich: „create an empty
prefetch set". Die Metatabelle trägt genau **zwei** Methoden:
`Update({d3d_textures=…, batch_textures=…, models=…, anims=…})`
(Cfile:563891-563897) und `Reset()` (Cfile:563950-563956).

Dass `Update` hier nichts tut, ist **keine Auslassung**: `DefaultPrefetchSet()`
(siminit.lua:234-250) baut `{ models = {}, anims = {}, d3d_textures = {} }` —
alle drei `DiskFindFiles`-Schleifen darin sind **auskommentiert** (:237-247) —
und `siminit.lua:252` übergibt genau das. Auf diese Eingabe ist Nichtstun das
Verhalten der Engine.

Käme je eine nicht leere Liste, wäre es etwas anderes: dann lädt die Engine
Assets vor, und das haben wir nicht. Dann warnt es — einmal — statt still zu
schlucken.

### Der Sim bootet jetzt die echte `/lua/simInit.lua`

`installEngine()` setzte die Boot-Kette bisher von Hand zusammen: `class.lua`
neu laden, `installMoho`, `utils.lua`, `repr.lua`, `buffblueprints.lua`, später
`doscript('/lua/SimSync.lua')` und `ResetSyncTable()`. Alles davon steht in
`globalInit.lua:14-24` bzw. `siminit.lua:45/100` — nachgebaut, wo es
auszuführen gereicht hätte. Jetzt macht der Sim-Boot, was
`Moho::Sim::Create` macht: `SCR_LuaDoScript(mLuaState, "/lua/simInit.lua", 0)`
(Cfile:1071613).

Voraussetzung dafür war die `moho`-Übergabeform. `globalInit.lua:27-29` sagt es
in Prosa: *„Classes exported from the engine are in the 'moho' table. But they
aren't full classes yet, just lists of exported methods and base classes."* Also
einfache Tabellen, Methoden unter String-Schlüsseln, Basisklassen im
**Array-Teil**, keine Metatabelle — genau das, was `ConvertCClassToLuaClass`
(class.lua:387-406) verbraucht: es rekursiert über `ipairs(cclass)` und wandelt
**an Ort und Stelle** um. `moho.lua` veröffentlichte stattdessen 20 fertige
`Class(base)(spec)`, und daran starb die Retail-Kette an `class.lua:273`: beim
erneuten Laden von `class.lua` ist `Class` eine **neue** Tabelle, der Kurzschluss
`getmetatable(cclass) == Class` (class.lua:389) greift nicht, und die Umwandlung
läuft ein zweites Mal über eine Tabelle, deren alte `Class`-Metatabelle den
`__newindex`-Wächter trägt.

Der UI-VM hatte dieselbe Handkette und dieselbe Begründung im Kommentar („den
`ConvertCClassToLuaClass`-Lauf brauchen wir nicht, unsere moho-Klassen SIND schon
Lua-Klassen"). Er lädt jetzt `doscript('/lua/globalInit.lua')` — das, was
`userInit.lua:11` tut.

**Was der Retail-Boot mitbringt** (gemessen, vorher/nachher):

| | vorher | jetzt |
| --- | --- | --- |
| `Buffs` | 0 | **108** |
| `Prefetcher`, `PlatoonTemplate` | nil | Tabelle |
| `InitialRegistration` | nil | `false` (schook setzt es um) |
| striktes `_G` im Sim-VM | nein | **ja** |
| `SetupSession` / `BeginSession` | unsere | **`/mod/schook/lua/siminit.lua:9/16`** |
| Meldungen beim Boot | — | 79 SPEW, **0 WARN**, 0 Hook-Fehler |

Die letzte Zeile widerlegt eine frühere Eintragung hier: *„Die schook-Hooks
installieren also gar nicht … Der Hook-Fehler ist der Blocker, nicht
`class.lua:273`."* Beides war falsch herum. Der Hook-Fehler kam von der
wasmoon-Containergrenze (JS-Array → userdata statt Tabelle), die inzwischen an
beiden `DiskFindFiles` behoben ist; `class.lua:273` **war** der Blocker.
`SetupSession` und `BeginSession` kommen jetzt nachweislich aus dem Hook.

**Was die Umstellung gekostet hat** — 31 von 63 Suiten rot, in drei Ursachen:

1. **Striktes `_G` erreicht den Sim.** `config.lua` lässt das Lesen eines nie
   zugewiesenen Globals werfen, und `x = nil` legt keinen Schlüssel an. Betroffen
   waren genau zwei: `__engineVersion` (globals.lua) und `__terrainFlatten`
   (globals.lua, ein Haken, den heute niemand setzt). Beide sind jetzt mit
   `false` deklariert. Eine Suche über alle `engine-lua/*.lua` nach echten
   Global-Lesungen ohne Zuweisung liefert sonst nur Kommentar-Treffer und die
   `__econ*`-Brücken, die TS **vor** `simInit` setzt.
2. **Der UI-VM wandelte `moho` nicht um** — siehe oben, `globalInit.lua`.
3. **Handverlesene Test-VFS.** Zwölf Suiten mounten nur `mohodata.scd` +
   `lua.scd`. Der Retail-Boot braucht mehr: `loc_*.scd`, sonst stirbt
   `localization.lua:30` an `string.gsub(nil, …)`; und `schook.scd`, weil
   `schook/lua/GlobalInit.lua` die Datei lädt, die `BuffBlueprint` **definiert**
   (`/lua/system/BuffBlueprints.lua`) — ohne sie fällt
   `/lua/sim/adjacencybuffs.lua:37`, mit ihr `/lua/defaultunits.lua` und damit
   jede Einheit. `scripts/gameFiles.ts` hat dafür `bootArchives()`;
   `GameFiles.open()` braucht es nicht, das mountet ohnehin alles.

Festgenagelt in `verify-moho-sim-contracts.ts`, und zwar an einem **nackten**
Host (nur `installMoho`, sonst nichts): keine Metatabelle, Basisklasse im
Array-Teil, `GetEntityId` noch nicht geerbt. Nach dem Boot dann das Gegenteil.
Der Rot-Test — `cclass` wieder `Class(base)(spec)` liefern lassen — bringt
`class.lua:273` zurück. Die vorherige Fassung dieses Blocks prüfte `__bases[1]`
auf dem gebooteten Host; das gilt für **beide** Formen und konnte nicht
scheitern.

### Und der Sitzungsstart ist jetzt auch der echte

`src/sim/session.ts` rief `__loadScenario()` / `__initArmyFromScenario(name)` /
`__beginSession()` aus `src/engine-lua/session.lua` — Nachbauten von
`SetupSession()` (siminit.lua:53-102), dem schook-`OnCreateArmyBrain`
(schook/lua/simInit.lua:45-51) und `BeginSession()` (siminit.lua:137-146). Die
Originale liegen seit dem Retail-Boot im VM, also rufen wir sie: Schritt 4a
`SetupSession()`, Schritt 5a je Armee `OnCreateArmyBrain(index, brain, name,
nickname)` wie `Sim::CreateArmies` (Cfile:1072015), Schritt 6a `BeginSession()`.
Die drei Nachbauten sind gelöscht.

Was sie ausgelassen hatten, und was jetzt steht (`verify-session-start.ts`
prüft jede Zeile einzeln): die sieben `ScenarioInfo`-Untertabellen
(`PlatoonHandles`, `UnitGroups`, `UnitNames`, `VarTable`, `OSPlatoonCounter`,
`BuilderTable`, `MapData`), `ScenarioInfo.Env`, `ScenarioInfo.TriggerManager`
(ein **Feld**, kein Global — eine frühere Eintragung hier suchte den falschen
Namen), `ArmyBrains[i].Name`/`.Nickname`, die drei Untertabellen je Armee, und
die Team-/TeamLock-Auswertung am Ende von `BeginSession`. Der Rot-Test — die
alten drei wieder einsetzen — bringt 12 FAIL-Zeilen.

Ein Wert kommt dabei nicht aus dem Spiel: der **Nickname**. Den liefert im
Original die Lobby über die Launch-Info, aus der die Engine auch `ArmySetup`
baut; ohne Lobby steht der Armeename dort. Er erreicht genau eine Stelle,
`LocGlobals.PlayerName` (siminit.lua:139-142), also `{g PlayerName}` in
Loc-Strings.

### Der Browser fährt denselben Sitzungsstart — und TypeScript liest die Karte nicht mehr

Der Sandbox-Pfad las die `_save.lua` selbst: ein TS-Parser holte den
`ARMY_1`-Marker heraus, setzte daraus den Spawn-Punkt, sammelte die Massepunkte
und `spawnViaLua('uel0001')` stellte die ACU dorthin. Dieselbe Datei, zweimal
gelesen, einmal nachgebaut.

Jetzt bekommt der Worker die Lua der Karte in seinen VFS, und `SetupSession()`
macht `doscript` darauf (siminit.lua:91-98). Die ACUs setzt `BeginSession()`
über das `OnPopulate` der Karte, die Massevorkommen `CreateResources()`. Im
Browser gemessen (headless, `?http&sandbox=SCMP_009`):

```
Sitzungsstart: uel0001 angefordert
BeginSession: 2 Einheiten aus OnPopulate
ARMY_1 steht bei 673, 347 (Marker der Karte)
```

und `__cfaSzene()` zeigt beide ACUs sichtbar auf 672,5/346,5 und 357,5/673,5.

**Eine benannte Abweichung:** die Engine hat vor `simInit.lua` JEDEN Blueprint
(siminit.lua:8). Der Worker kann das nicht — zu jeder Einheit gehört ihr
Skelett, und das steckt im Modell: **78 MB `_lod0.scm` für 580 Einheiten**
(gemessen). Deshalb fragt die Sim selbst, welche Blueprints *dieser*
Sitzungsstart benennen kann — `__sessionInitialUnits()` aus
`factions.lua Factions[i].InitialUnit` (scenarioutilities.lua:336-338) und den
Gruppen der Karte (scenarioutilities.lua:279/287) — und der Client liefert genau
die. Für SCMP_009 ist das eine einzige: `uel0001`. Alles darüber hinaus
scheitert weiterhin laut („Unknown unit kind"), nicht still.

**`scripts/verify-browser-session.ts`** prüft das in Node: es baut den VFS aus
denselben Funktionen, die der Client benutzt (`simBootPaths`, `mapSession` in
`src/sim/mapSession.ts`), bootet darin und fährt den Sitzungsstart. Fällt eine
Dateigruppe aus der Browser-Nutzlast, fällt sie hier aus — und hier ist sie eine
rote Zeile. Genau so kamen drei Befunde heraus, die vorher niemand sehen konnte:

1. **Die Nutzlast hatte kein `/loc`.** Der Worker wäre seit dem Retail-Boot an
   `localization.lua:30` gestorben (`string.gsub(nil, …)`), und keine Node-Suite
   hätte es gemerkt.
2. **Ein Fehler im Worker war ein stiller Tod.** `onmessage` war `async`, eine
   abgelehnte Zusage landete nirgends, der Hauptthread wartete ewig auf
   `booted`. Jetzt meldet der Worker, woran er gestorben ist — das hat den
   nächsten Fehler in einer Minute statt in einer Stunde gefunden.
3. **Die Spawn-Höhe fehlte in der Engine** (siehe unten).

### `CalcSpawnElevation` — die ACU stand auf y = 0

`SUnitConstructionParams::SUnitConstructionParams` setzt `mFixElevation = 1` und
in der nächsten Zeile `if (!layer) mFixElevation = 0` (Cfile:733280-733285).
`layer` ist das **optionale zehnte Argument** von `CreateUnit`: `cfunc_CreateUnitL`
initialisiert `layer = 0` und ruft `COORDS_StringToLayer` nur, wenn Argument 10
ein String ist (Cfile:980412-980423). Und `Moho::Unit::Unit` ersetzt dann `pos.y`
durch `Moho::IUnit::CalcSpawnElevation` mit der eben bestimmten **Startebene**
(Cfile:950181-950196).

Ohne Ebenen-Argument ist das übergebene y also gar kein Wunsch — es wird
verworfen. `CreateInitialArmyUnit` verlässt sich darauf und schickt immer y = 0
(Cfile:1025265). Bei uns kam es genau so an: **ACU auf y = 0, Boden auf 18,68.**
Unsichtbar, weil jede Suite bisher ein eigenes y übergab.

`CalcSpawnElevation` (Cfile:683091-683120) hat fünf Fälle, in dieser Reihenfolge:

| Ebene | Höhe |
| --- | --- |
| Land/Seabed (0x03) | `CHeightField::GetElevation(x, z)` — das reine Gelände |
| Water (0x08) | der Wasserspiegel, ohne Wasser −10000 |
| Sub (0x04) | `Physics.Elevation` + Wasserspiegel |
| Air (0x10) | `STIMap::GetSurface(x, z)` + `Physics.Elevation` |
| sonst | 0 |

Der Land/Seabed-Fall nimmt `GetElevation`, **nicht** `GetSurface` — ein Seabed
liegt unter Wasser, und `GetSurfaceHeight` würde ihn auf den Wasserspiegel
heben.

### Und die UI-VM bootet `/lua/userInit.lua`

Dasselbe noch einmal fuer den anderen VM. `userInit.lua` ist das Gegenstueck zu
`simInit.lua`: es setzt `__language` aus den Einstellungen (userinit.lua:8 —
*„for the Sim init, the engine sets `__language` for us"*), macht
`doscript '/lua/globalInit.lua'` (:11) und definiert danach `WaitFrames`,
`WaitSeconds` (:13-21), `FrontEndData` (:24) und `Prefetcher` (:27).

`WaitFrames` und `WaitSeconds` standen in `ui-globals.lua` nachgebaut — mit dem
Kommentar, dass `userinit.lua:13-21` sie definiert. Sie sind geloescht; jetzt
gilt `WaitFrames == coroutine.yield` woertlich, statt eines Wrappers, der
`n or 1` daraus machte. `verify-ui-boot.ts` prueft die Herkunft ueber
`debug.getinfo(...).short_src`; der Rot-Test (zurueck auf `globalInit.lua`)
zeigt sofort wieder `ui-globals.lua`.

### `CAiPersonality` — der erste von drei Blockern der KI-Armee

Eine KI-Armee (`human: false`) stirbt an drei Stellen. Gemessen auf SCMP_009 mit
`ARMY_2` als KI:

| Stelle | Fehler |
| --- | --- |
| `aibrain.lua:1144` | `plat:ForkThread` — `GetPlatoonUniquelyNamed('ArmyPool')` liefert nichts |
| `aibrain.lua:1373` | `personality:GetAirUnitsEmphasis()` |
| `aibrain.lua:878` | `personality:AdjustDelay(20, 4)` |

Die letzten beiden sind erledigt. `CAiBrain::CAiBrain` legt zu **jedem** Brain
eine Personality an (Cfile:724303-724309) und ruft sofort
`CAiPersonality::ReadData` (Cfile:724385). `ReadData` (Cfile:768303-769100)
importiert `/lua/aipersonality.lua`, holt `AIPersonalityTemplate` und sucht den
Eintrag mit **33 Feldern**, dessen Feld 1 case-insensitiv `"AverageJoe"` ist —
der Name steht fest im Binaercode (Cfile:768539-768541). Findet es keinen,
bleiben die Konstruktor-Werte: alle Bereiche 0/0, `mDifficulty = 0.5`
(Cfile:768162-768194). Nichts sonst im Spiel setzt die Schwierigkeit; nur die
Serialisierung liest und schreibt sie (Cfile:769840/770181).

Die 29 Bereichs-Getter sind alle dieselbe Interpolation:
`(1 - d) * min + max * d` (Cfile:770438-770439). `AdjustDelay(basis, faktor)`
ist `basis + (int)((1 - d) * (basis * faktor))` — beide Argumente muessen
Ganzzahlen sein, sonst `TypeError "integer"` (Cfile:770360-770392). Die beiden
Listen-Getter liefern je Aufruf eine **neue** Tabelle (`AssignNewTable`,
Cfile:771170).

Die Feld-Indizes sind nicht aus den Kommentaren der Lua-Datei abgelesen, sondern
mechanisch aus den `operator[](template, i)`-Aufrufen in `ReadData` extrahiert.
`verify-ai-personality.ts` vergleicht die Getter gegen die Vorlage aus der
Original-Datei, nicht gegen abgeschriebene Zahlen; der Rot-Test (Index 19 -> 18)
faellt sofort um.

### Und das Platoon-System — der dritte Blocker

Ein Platoon ist ein CScriptObject: `CPlatoon::CPlatoon` laedt
`import('/lua/platoon.lua').Platoon` (func_LoadPlatoon, Cfile:1048422-1048435),
setzt `mName = a4` und `mPlan = a5` und ruft
`CScriptObject::Call_Str(this, "OnCreate", &this->mPlan)` (Cfile:1048347-1048349).
Aus der Lua heisst das: `brain:MakePlatoon(name, plan)` → `OnCreate(plan)`, und
`platoon.lua:27-31` startet daraus den KI-Thread, wenn die Klasse eine Methode
dieses Namens hat.

Der Schluessel war, wo das `'ArmyPool'`-Platoon herkommt: **die
Armee-Erzeugung** macht `MakePlatoon(army, "Pool", "PoolAI")`, haengt ein
`CSquad` mit `SQUADCLASS_Unassigned` an und setzt `mUniqueName = "ArmyPool"`
(Cfile:1017576-1017578). Und jede neue Einheit landet darin, **bevor** ihr
`OnCreate` laeuft: `Sim::CreateUnit` macht erst
`mArmy->Func9(…, "ArmyPool")` (Cfile:950549) und dann
`RunScript("OnCreate")` (Cfile:950554).

Damit stehen `MakePlatoon`, `GetPlatoonUniquelyNamed`, `GetPlatoonsList`,
`PlatoonExists`, `DisbandPlatoon`, `DisbandPlatoonUniquelyNamed` und
`AssignUnitsToPlatoon` mit echten Ruempfen, dazu `moho.platoon_methods` mit
`GetBrain`, `GetPlatoonUnits`, `GetPlatoonUniqueName`, `UniquelyNamePlatoon`,
`GetAIPlan`, `GetFactionIndex`, `GetPersonality` und `Destroy`. Die restlichen
39 CPlatoon-Bindungen sind weiterhin No-ops — der Bestand steigt damit, und das
ist ehrlich als Schuld verbucht, nicht als Fortschritt.

Zwei Feinheiten, beide aus der Bindung und nicht geraten: `AssignUnitsToPlatoon`
nimmt als erstes Argument auch einen **Namen** (`aiutilities.lua:875` uebergibt
`'ArmyPool'`), und `PlatoonExists` liefert `false` statt eines Fehlers, wenn das
Objekt kein lebendes Platoon mehr ist.

**Gemessen:** eine Sitzung auf SCMP_009 mit `ARMY_2` als KI kommt jetzt durch
`installEngine` UND `BeginSession`, beide ACUs stehen, und jede liegt im Pool
ihrer Armee. Es bleibt **genau eine** Fehlermeldung pro Zyklus:
`aibrain.lua:3470` vergleicht nil, weil `GetHighestThreatPosition`
(aibrain.lua:3466) ein No-op ist. **Der naechste Blocker ist also die
Bedrohungskarte**, nicht mehr das Platoon-System. `mapSession()` laesst beide
Armeen bis dahin auf `human: true` — eine KI-Armee wuerde nur diese eine Warnung
im Takt wiederholen.

### Nur EIN Initialisierungspfad je Armee — und was danach sichtbar wurde

`__createBrain` rief unbedingt `b:OnCreateHuman(planName)`. Das war schon vorher
falsch und wurde durch den Retail-Sitzungsstart schaedlich: `OnCreateArmyBrain`
→ `InitializeArmyAI` waehlt selbst (Cfile:1024677-1024699, Entscheidung
`IsHuman` in Cfile:724516-724518), also bekam eine KI-Armee **beide** Pfade —
`CreateBrainShared` (aibrain.lua:406) lief zweimal, mit neuem TrashBag und dem
alten verwaist, dazu `InitializeVO` fuer eine KI.

`CAiBrain::CAiBrain` (Cfile:724270-724386) ruft im Konstruktor **keinen** der
beiden. Jetzt auch bei uns nicht; der kartenlose Harness-Pfad ruft dafuer
`InitializeArmyAI` selbst, an derselben Stelle im Ablauf. Nachweis in
`verify-ai-platoon.ts`: `VOTable` legt allein `InitializeVO` an, und das ruft
allein `OnCreateHuman` (aibrain.lua:352, 916-921) — die KI-Armee darf keine
haben.

Damit lief die KI-Armee der **Sandbox** zum ersten Mal wirklich los, und
`verify-playthrough.ts` meldete prompt einen neuen Fund: `IsOpponentAIRunning`
als No-op aufgerufen. Genau dafuer ist die Fund-Liste da. Zwei Konsequenzen:

1. **`IsOpponentAIRunning` ist jetzt echt** (cfunc_CAiBrainIsOpponentAIRunningL,
   Cfile:733465-733503): steht `/noai` auf der Kommandozeile → `false`, sonst
   der Sim-ConVar `AI_RunOpponentAI`, dessen Standardwert 1 ist
   (`register_AI_RunOpponentAI_SimConVarDef`, Cfile:1944553-1944556). Beide
   Werte sind in `globals.lua` deklariert, weil das strikte `_G` sonst beim
   Lesen wirft.
2. **`SANDBOX_SESSION` setzt ARMY_2 auf `human: true`** — mit derselben
   Begruendung, die schon in `mapSession()` und `verify-session-start.ts` steht.
   Die Sandbox ist nicht der Ort, an dem eine halbfertige KI ausprobiert wird;
   das ist `verify-ai-platoon.ts`.

Und noch ein Fund aus demselben Lauf: die Bindungsliste `PLATOON_NAMES` war
**unvollstaendig**. Sie stammte aus den `"CPlatoon:X()"`-Hilfetexten des Decomps
und liess drei Bindungen aus, die dort anders formatiert sind —
`PlatoonCategoryCount`, `PlatoonCategoryCountAroundPosition` und
`GetPlatoonUnits`. Die KI fiel an `platoon.lua:258` um. Die belastbare Quelle
sind die `luadef_CPlatoon*`-Symbole: **49 Bindungen**, nicht 46.

Beide Zaehler stehen jetzt echt da, und zwei Details daran waren nicht zu
erraten: `PlatoonCategoryCountAroundPosition` liest den Radius von Stack-Index 4
**zweimal** und multipliziert ihn mit sich selbst, und der Abstand ist
**zweidimensional** — `(pos.x - u.x)² + (pos.z - u.z)² <= r²`, die Hoehe geht
nicht ein.

**Der Stand der KI-Armee, gemessen:** sie kommt durch `installEngine` und
`BeginSession`, bildet aus ihrem Pool eigene Platoons und laeuft 60 Beats. Es
bleiben **zwei** benannte Haltepunkte, beide als Ratsche in
`verify-ai-platoon.ts`: `aibrain.lua:3470` (die Bedrohungskarte fehlt) und
`scenarioplatoonai.lua:66` (`platoon.BuilderHandle:SetPriority` — es gibt noch
keine BuilderManagers, aibrain.lua:1137). Ein dritter Fehler waere ein neuer
Fund und macht die Suite rot.

### Die Bedrohungskarte — der letzte gemessene Halt der KI

Sieben Recherchefragen, je eine Antwort und eine adversariale Gegenprüfung
(14 Agenten, 208 bestätigte Befunde, 13 widerlegte). Was daraus in den Code kam:

**Die Geometrie steht einmal fest, aus den Kartenmaßen** (Cfile:1017315-1017328):
`gridSize = max(32, max(sizeX, sizeZ) / 16)`, ganzzahlig, dann
`mWidth = sizeX / gridSize`. Für jede FA-Kartengröße ab 512 ergibt das ein
**16×16**-Gitter, für 256 ein 8×8 — die Karte ist grob, und die Original-KI
weiß das: sie übergibt `ring = 16` mit der Bedeutung „die ganze Karte"
(aibrain.lua:3660). Jede Armee hat ihre eigene Karte (Cfile:1017321-1017333).

**Drei Dinge daran waren nicht zu erraten:**

1. **Schreiben und Lesen benutzen nicht dasselbe Feld.** `AssignThreatAtPosition`
   teilt sich für `Overall` den `switch`-Fall mit `Unknown` und schreibt nach
   `unknownInfluence` (Cfile:1035574-1035581) — `GetThreat` liest für `Overall`
   aber `overallInfluence` (Cfile:1034567). `overallInfluence` wird von
   `AssignThreatAtPosition` also **nie** beschrieben.
   `OverallNotAssigned` hat gar keinen Schreibfall: der Aufruf tut nichts.

   **Korrektur (der erste Stand dieses Absatzes war falsch):** daraus folgt
   NICHT, dass der `Overall`-Kanal ohne Aufklärung tot ist. `DecayInfluence`
   zerfällt 13 Felder und setzt danach als **letzte Anweisung**
   `threat.overallInfluence` auf deren ungewichtete Summe
   (Cfile:1034420-1034429). Der Kanal ist also die Gesamtsicht auf alle anderen
   und entsteht bei jedem Update — ohne ReconDB. Wir hatten diese Herleitung
   nicht, und damit war genau der Kanal leer, aus dem die KI ihre Ziele holt:
   `aiattackutilities.lua:250` fragt `GetThreatsAroundPosition(pos, 16, true,
   'Overall', enemyIndex)` und gibt bei leerer Liste auf. Behoben; die
   Reihenfolge der 13 Summanden ist übernommen, weil Gleitkomma-Addition nicht
   assoziativ ist.
2. **Der `ring` zählt ZELLEN, nicht Welteinheiten** (Cfile:1035045-1035081), und
   die Summe ist ungewichtet über das einschließende Quadrat.
3. **`armyIndex` ist 1-basiert und `-1` ist ein Fehler.**
   `aiattackutilities.lua:245` übergibt `-1` in der Absicht „alle Armeen"; die
   Engine rechnet `-1 - 1 = -2` und wirft (Cfile:740435-740445). Der Pfad ist im
   Original tot — und muss bei uns genauso tot sein, sonst rechnet unsere KI mit
   Zahlen, die es im Spiel nicht gibt.

`GetHighestThreatPosition` gibt **zwei** Werte zurück: eine Vector-Tabelle
`{x, 0, z}` — die Y-Komponente ist immer exakt 0, die Engine fragt hier kein
Gelände ab — und die Bedrohung (Cfile:740710-740718). Der Zerfall läuft aus
`CArmyImpl::OnTick`, gestaffelt: jede Armee, wenn `mCurTick % 30 == armyIndex`
(Cfile:1018010-1018011).

**Zwei stille Zweigschalter kamen dabei ans Licht**, beide vom selben Typ wie
die, vor denen `__defaultScenarioOptions` seit jeher warnt:

* `ScenarioInfo.Options.TeamSpawn` fehlte. Ohne `'fixed'` tut
  `AddInitialEnemyThreat` **gar nichts** (aibrain.lua:3610) — jede KI-Armee
  startete also mit leerer Bedrohungskarte. Der Wert steht im Lobby-Satz
  (autolobby.lua:28), und ein Skirmish kommt im Original aus der Lobby.
* `ArmySetup` hatte kein `Team`-Feld. `aibrain.lua:3618` prüft
  `army.Team ~= myArmy.Team or army.Team == 1`, und mit `nil` ist beides falsch.
  Der Lobby-Standard ist `Team = 1` (lobbycomm.lua:29-31).

**Und eine Reihenfolge stimmte nicht.** Die Engine lädt die Karte, **bevor** sie
die Armeen erzeugt — die Bedrohungskarte entsteht *in* der Armee-Erzeugung und
liest dabei das Heightfield. Bei uns kam `setTerrainSource` erst nach
`installEngine`. `installEngine` nimmt das Gelände jetzt als vierten Parameter
entgegen; ohne ihn bleibt der bisherige Weg gültig, solange keine KI-Armee
mitfährt. Dazu hat das flache Testgelände jetzt benannte **Maße**
(`FLAT_TEST_MAP_SIZE`, 256×256 — die kleinste Größe, die das Spiel ausliefert):
eine Sim ohne Kartenmaß ist keine Sim, und `MobileUnit.OnKilled` schreibt bei
JEDEM Tod in die Bedrohungskarte (defaultunits.lua:1229-1235).

**Ein Fehler im Original, den man beim Nachbauen findet:**
`GetAllianceEnemy` (aibrain.lua:3423) weist beide Rückgabewerte von
`GetHighestThreatPosition` einer **einzigen** Variablen zu, `highStrength`
bekommt also die Positionstabelle — und Zeile 3432 vergleicht sie mit einer
Zahl. In unserem VM wirft das nicht, die Funktion findet nur nie einen
Verbündeten-Gegner (gemessen). Das ist ein Defekt der Spiel-Lua, keiner der
Engine, und er wird nicht „repariert".

**Was fehlt:** `CInfluenceMap::Update` summiert je Zelle auch die
Aufklärungs-Blips neu auf, gewichtet mit den vier Blueprint-Feldern
`Defense.{Air,Surface,Sub,Economy}ThreatLevel` (Cfile:1035318-1035375). Dafür
braucht es die ReconDB, die es bei uns nicht gibt. Die Karte enthält also genau
das, was die Lua hineinschreibt — nichts, was aus gesichteten Einheiten
entstünde.

**Stand der KI-Armee:** `aibrain.lua:3470` ist erledigt. Es bleiben zwei
Haltepunkte, beide dieselbe Lücke von zwei Seiten — es gibt noch keine
BuilderManagers (aibrain.lua:1137): `scenarioplatoonai.lua:66`
(`platoon.BuilderHandle:SetPriority`) und `aiarchetype-managerloader.lua:51`
(`aiBrain:HasBuilderList`). `verify-ai-platoon.ts` führt die Ratsche darüber:
ein bekannter Halt **darf** verschwinden, aber es darf keiner dazukommen.

### Die Trennung der beiden VMs war undicht — 51 Bindungen auf der falschen Seite

CLAUDE.md nennt es als Invariante: jede Engine-Bindung ist über `mPrevDef` in
genau EINER Init-Liste registriert, deshalb kennt die Sim `_c_CreateCursor`
nicht und die UI kein `CreateUnit`. Gemessen war es anders.

`installEngineGlobals` lädt `globals.lua`, und das ruft der **UI**-Boot auch —
die Datei enthält aber nicht nur `scr_CoreInits`, sondern zu einem guten Teil
`sim_SimInits`. Ergebnis: **51 Sim-Bindungen standen im UI-VM**
(`CreateEmitterAtBone`, `GetArmyBrain`, `SetAlliance`, `Warp`, `_c_CreateShield`
und so weiter). In der Gegenrichtung standen 5 UI-Bindungen in der Sim.

Vierzehn Namen stehen in BEIDEN Abschnitten von `engine-api.md` — die sind
wirklich zweimal registriert (`IsAlly`, `IsEnemy`, `GetBlueprint`, `Random`, …)
und dürfen überall stehen. Ohne diese Unterscheidung sähe die Zahl doppelt so
schlimm aus, wie sie ist.

Behoben: `engine-lua/ui-sim-globals.lua` nimmt die Sim-Liste aus
`engine-api.md` (generiert aus den `mPrevDef`-Ketten) und entfernt sie nach dem
Laden wieder aus dem UI-VM. Keine der sechs UI-Suiten hing daran. Auf der
anderen Seite sind `GameTick` und `GetSimTicksPerSecond` aus `threads.lua`
verschwunden und `SetFocusArmy` aus `globals.lua` — alle drei sind
`scr_UserInits` und in `ui-globals.lua` ohnehin echt implementiert.

**Dabei fiel eine Suite auf, die unseren Fehler festhielt:**
`verify-simthreads.ts` verlangte `GetSimTicksPerSecond()` in der Sim. Der
Decomp sagt das Gegenteil —
`luadef_GetSimTicksPerSecond.mPrevDef = Moho::scr_UserInits.mForms`
(Cfile:1264462), genau wie `GameTick` (Cfile:1361911). Die Zeile prüft jetzt,
dass beide in der Sim **fehlen**.

Es bleiben zwei UI-Namen im Sim-VM, und nur einer ist unserer:
`SyncPlayableRect` kommt aus der Original-Lua (`/lua/SimSync.lua` wird per
`doscript` geladen, seine obersten Funktionen sind damit global), und
`EntityCategoryFilterOut` steht noch in `globals.lua` statt in
`ui-globals.lua`. `scripts/check-vm-separation.ts` nagelt beide Richtungen fest;
die Schranke ist eine Ratsche und darf nur sinken.

### Eine Prüfung gegen still überschriebene Methoden

`scripts/check-shadowed-methods.ts`. Anlass war ein echter Fund: am Ende der
`aibrain`-Tabelle in `moho.lua` standen zwei alte Attrappen
(`GetThreatAtPosition` gab 0 zurück, `AssignThreatAtPosition` tat nichts) — und
weiter oben in DERSELBEN Tabelle die neuen, echten Rümpfe. Der spätere Eintrag
gewinnt, also blieb die Bedrohungskarte leer, und keine Suite konnte es sehen:
beide Aufrufe „funktionierten" ja, sie taten nur nichts. Aufgefallen ist es
erst, weil eine Zelle nach einem Schreibvorgang 0 blieb.

Die Prüfung liest die Tabellenblöcke von `local <name> = {` bis zur schließenden
Klammer und meldet jeden Schlüssel, der darin zweimal auf erster Ebene steht.
51 Blöcke, 523 Schlüssel, aktuell null Funde.

### Regeneration lief nie — und das Bogen-Cap tut es bis heute nicht

Zwei Funde aus derselben Ecke, einer behoben, einer offen.

**`Unit::OnTick` hat zwei Zweige, und wir hatten nur einen.** Der Kommentar in
`build.lua` zitierte den ganzen Bereich (Cfile:952808-952840), umgesetzt war nur
das `else`:

```
if (!mIsBeingBuilt) {
  if (maxHealth > health && GetAttributes1()->mRegenRate > 0.0)
    AdjustHealth(this, this, mRegenRate * 0.1);      // <- fehlte komplett
} else if (curTick - creationTick > 1) { … Zerfall … } // <- war da
```

`Defense.RegenRate` ist ein Wert **pro Sekunde**, verteilt auf zehn Ticks. Keine
Einheit im Spiel hat je Leben zurückbekommen — der ACU regeneriert 10/s, jedes
Gebäude und jede Veteranenstufe hängen daran. `SetRegenRate` und
`RevertRegenRate` waren dazu passend zwei stille No-ops. Alles drei ist jetzt
echt, und der Weg ist `AdjustHealth`, nicht ein roher Schreibzugriff — damit
gelten die 25-%-Quantisierung von `OnHealthChanged` und der Toten-Wächter.
`verify-unit-tick.ts` misst es.

**Offen: GATE 2, das Bogen-Geschwindigkeitslimit.** `verify-motion.ts` prüfte es
mit `v <= cap` nach zwei Beats **aus dem Stand** — da begrenzt die
Beschleunigung auf 2·accel, weit unter dem Cap. Die Zeile war wahr, ob das Gate
greift oder nicht.

Gemessen (uel0001, MaxSpeed 1,7, MaxBrake 0, TurnRate 90): ein 90°-Ziel auf 4 m,
ein 90°-Ziel auf 200 m und ein Ziel geradeaus ergeben Tick für Tick **dieselbe**
Kurve — 1,683 / 1,666 / 1,649 / … also −1 % je Tick, unabhängig vom Bogen.
`sub_699760` (Cfile:942313-942321) ist bei uns also **nicht wirksam**, und was
die Geschwindigkeit stattdessen abbaut, ist ungeklärt. Die falsche Zusicherung
ist entfernt; die Suite druckt die Zahlen und behauptet nichts. Eine Behauptung
kommt zurück, wenn das Bewegungsmodell geklärt ist.

### Die Boot-Nutzlast des Sim-Workers

Gemessen: die Boot-Nutzlast des Sim-Workers ist heute **4 281
Dateien / 15,5 MB** — davon allein `effects/**` 7,07 MB, was der Kommentar in
`luaSimClient.ts:287` gar nicht erwähnt. Die drei Lua-Dateien von SCMP_009 sind
**217 829 Byte, also 1,4 %** davon (gzip: 11 KB). Die Annahme „alle Karten zu
schicken ist keine Option" ist damit nicht haltbar — alle 228 Karten-Lua sind
24,4 MB roh, aber nur 1,14 MB gzip, und `gameFiles.ts` liest sie ohnehin aus dem
Spielordner des Nutzers. Der Browser-Pfad ist also billig; er ist nur nicht in
Node prüfbar, weshalb er hier noch offen steht.

### T019/US17 bleibt offen — und zwar bewusst

Die Aufgabe lautet, das SCMAP-Gate `>= 60` in die zwei der Engine zu zerlegen.
Beide sind im Decompilat bestätigt: `if (v108 >= 0x3A)` → `SkyDome::Load`
(Cfile:1339157-1339161) und danach `if (v53 >= 0x3B)` →
`Cartographic::ReadDecals` (Cfile:1339183-1339184), das eine `u32`-Anzahl und so
viele `CartographicDecalBatch` liest (Cfile:1182437-1182453).

**Trotzdem wird nichts geändert.** Gemessen: **alle 60 installierten Karten
haben versionMinor 60.** Es gibt hier keine 58er- oder 59er-Karte, also wäre
jede Änderung am Gate unbeobachtbar und unwiderlegbar — genau die Sorte
Vermutung, die dieses Projekt verbietet.

Und es gibt einen ungelösten Widerspruch, der zuerst geklärt gehört: die Engine
liest die kartografischen Dekale **nach** dem Skybox, unser Parser liest seinen
Dekal-Gruppenblock (`scmap.ts:380`) **davor** — und braucht dabei jede der 60
Karten bis aufs letzte Byte auf (`scmap.ts:465` wirft sonst). Entweder ist der
dekompilierte Kontrollfluss nicht die Dateireihenfolge, oder die beiden
„Dekal"-Blöcke sind verschiedene Dinge. **UNBEKANNT.**

Weiterhin offen: `ArmyInitializePrebuiltUnits` (nur bei
`Options.PrebuiltUnits == 'On'`, Cfile:1073515-1073533 — unbedingt gebaut würde
es in jedem Skirmish Basen hinstellen). Und der Browser-Pfad: `src/sim/luaSimClient.ts` schickt dem Worker weiterhin keine
Kartendateien, also profitieren bislang nur die Node-Suiten davon —
`src/main.ts:1031-1062` parst die `_save.lua` dort noch mit dem TS-Parser.

## Offener Befund: der Typecheck sieht die Skripte nicht

`npx tsc --noEmit` prüft `tsconfig.json`, und dessen `include` ist `["src"]`.
Die **58 Dateien in `scripts/`** — also jedes einzelne Verifikationsgate, der
Playthrough, der Coverage-Zähler, der Selftest-Treiber — laufen damit
**ungeprüft**. „Typecheck grün" hieß bisher: grün für 65 % des Codes, den
`npm test` ausführt.

Aufgefallen beim Bau des Replay-Lesers. Gemessen, nicht geschätzt:

* `@types/node` war **gar nicht installiert** (jetzt als devDependency da) —
  ohne Node-Typen kann `scripts/` gar nicht geprüft werden;
* `scripts/verify-selection.ts:73` war **syntaktisch ungültig für `tsc`**: nach
  dem semikolonlosen `const cand = … => ({…})` liest der Parser den folgenden
  alleinstehenden Block `{` als Fortsetzung. `tsx`/esbuild verzeiht das, `tsc`
  nicht. Behoben (`;{`);
* danach bleiben **155 Fehler in 18 Dateien**:

| Datei | Fehler |
| --- | --- |
| `verify-emitter-curves.ts` | 53 |
| `shot-click.ts` | 24 |
| `shot.ts` | 16 |
| `selftest-gate.ts` | 12 |
| `verify-factory.ts` | 7 |
| `verify-command-chain.ts` | 5 |
| `verify-build-effects.ts` | 4 |
| `src/main.ts`, `verify-user-unit-state.ts`, `verify-upgrade.ts`, `verify-combat.ts` | je 3 |
| `verify-shields.ts`, `verify-playthrough.ts`, `verify-coverage.ts`, `playthrough.ts` | je 2 |
| `verify-restrictions.ts`, `verify-core-globals.ts`, `verify-army-victory.ts` | je 1 |

### Erledigt: 155 → 0, und es ist jetzt ein Gate

Die 155 sind abgearbeitet, `npm run typecheck:scripts` ist grün und steht im
pre-push-Hook neben `npx tsc --noEmit`.

Zwei Drittel hatten eine gemeinsame, langweilige Ursache: Dateien ohne `import`
oder `export` sind für `tsc` keine Module, also war `await` auf oberster Ebene
ein Fehler (TS1375) und gleichnamige Konstanten verschiedener Skripte
kollidierten (TS2451). Ein `export {}` je Datei. Dazu `allowImportingTsExtensions`
(`verify-coverage.ts` importiert `./coverage-engine.ts`) und
`types: ["node", "vite/client"]` — ohne das zweite verlor `src/main.ts` sein
`import.meta.env`.

Der Rest war `noUncheckedIndexedAccess`. Die Auflage bei jeder einzelnen Datei
war, dass die AUSGABE der Suite vorher und nachher identisch sein muss — ein
Typfehler „behoben", indem eine Zusicherung weicher wird, wäre schlimmer als der
Typfehler. Zwei Suiten haben dabei etwas über sich verraten: `verify-combat` und
`verify-emitter-curves` sind von sich aus **nicht deterministisch** (Entity-Ids
bzw. `pairs()`-Reihenfolge in einer Stichprobe). Nachgewiesen, indem die
unveränderte Fassung aus HEAD zweimal lief und sich ebenso unterschied. Nach
Maskieren genau dieser Zeilen sind alle Läufe byteweise gleich.

Ein echter Fund nebenbei: **`LuaUnitState` deklarierte `fraction` nicht**, obwohl
`__readUnit` es seit jeher liefert (`units.lua:757`). Drei Suiten lasen das Feld
und hatten sich je eine eigene lokale Deklaration gebaut — dieselbe Aussage
dreimal, an der falschen Stelle. Jetzt steht sie einmal in
`src/lua/unitFactory.ts`.

## Die vier `check-*`-Skripte sind jetzt Gates (Runde-2 T023)

`scripts/run-tests.ts` globte nur `verify*`. Die vier `check-*`-Skripte liefen
deshalb **nie** — und das war zu Recht so: sie DRUCKTEN nur. Null
`check()`-Aufrufe, null `exit(1)`-Pfade. Sie damals in den Glob zu nehmen hätte
die Suite-Zahl von 53 auf 58 gehoben, ohne ein einziges Gate hinzuzufügen.

Der Grund für ihre Existenz war ein anderer: jedes hat einmal eine **Konvention
ermittelt**, auf der der Renderer seitdem stillschweigend steht. Ein Mensch hat
die Zahlen gelesen und entschieden; die Entscheidung wurde Code; geprüft wurde
sie nie wieder. Genau das sind sie jetzt — Wächter über ihre eigene Antwort:

| Skript | Die stillschweigende Annahme | Gemessen |
| --- | --- | --- |
| `check-convention` | `scm.ts:24-26`: `restPoseInverse` spaltenweise, Rotation `w,x,y,z`; `animator.ts:61` transponiert nicht | Über 5 Modelle: Einheitsmatrix-Fehler `1e-7`, die drei falschen Kombinationen `7e+0` bis `5e+2` |
| `check-orientation` | `fitDepthToG` bildet die Watermap-Zeile direkt auf die Heightmap-Zeile ab, ohne Spiegelung | 40 auswertbare Karten, `corr(normal) ≥ 0.9` überall, 29 davon trennen die Lesungen um ≥ 0.3 |
| `check-unit-assets` | `resolveUnitPaths` findet die Modelle | 555 von 568 lösen auf, 553 mit Albedo, 3 bewusst `<none>`, 10 ohne Fund |
| `check-watermap-holes` | `FALLBACK = 1/15` im Renderer, und die lineare Ersetzung ist zulässig | Median-Steigung **0.0665** gegen 1/15 = 0.0667; R² ≥ 0.9 ausser SCMP_016 (0.530); 36 DXT-Löcher gesamt |

Zwei Dinge daran sind mehr als Aufräumen:

* **`check-unit-assets` hatte eine eigene Kopie der Auflösungslogik** (`<id>_lod0.scm`,
  `<id>_albedo.dds` von Hand). Sie konnte grün melden, während der echte Lader
  danebenlag. Jetzt ruft es `resolveUnitPaths` selbst — die eine massgebliche
  Darstellung, wie CLAUDE.md es verlangt.
* **`check-watermap-holes` prüft eine Konstante, die sonst nur als Literal
  dasteht.** Die 41 Karten sagen 0.0665, der Renderer sagt 1/15 = 0.0667.

Rot-Proben, jede einzeln gesehen: Rotationsreihenfolge in `scm.ts` vertauscht →
alle 5 Modelle rot mit Nennung der Ursache · Zeilenlesung gespiegelt → alle 40
Karten rot, „0 Karten unterscheiden" · `resolveUnitPaths` lahmgelegt → 555 → 496,
Sperrklinke rot · Grünkanal im DXT-Decoder um 12 gedämpft → 36 → 219 Löcher.

Ein Detail, das die Prüfung selbst korrigiert hat: die erste Fassung von
`check-orientation` verlangte auf JEDER Karte eine niedrige Korrelation der
gespiegelten Lesung — und wurde auf 16 Karten rot. Der Grund war kein Fehler im
Code, sondern in meinem Kriterium: auf **vertikal symmetrischen** Karten
korreliert die gespiegelte Lesung genauso gut (SCMP_002: 1.000 gegen 0.984).
Unterscheidbarkeit ist eine Eigenschaft der Suite, nicht jeder Karte.

## Known gaps

The path to the real UI: [PLAN-UI.md](PLAN-UI.md); the complete 1:1 roadmap:
[PLAN-1ZU1.md](PLAN-1ZU1.md).

- **No real main menu as the default path.** The front end boots
  (verify-frontend), but the sandbox starts through the web launcher;
  `LaunchSinglePlayerSession`/Lobby are missing.
- **Rendering inventory (H/M list), still open:** the water's
  refraction/reflection RT (a named approximation), Bloating Props (2 BPs
  static), and construction-site depth
  (SeraphimBuildDepth). **COMPLETED since the inventory:** the planet glow
  pass (Write_A) — `skyPlanetGlow.frag.glsl`, wired at `skyDome.ts:10`, built
  in `4d42592` and listed as open here for 36 days; normals decals
  through the screen-space normal prepass (46c3e8b), shadows (H7) with
  ComputeShadowPCF + depth pass, Aeon/Insect unit shader (M5), undulating
  tree sway, SCMAP tail fully parsed (ad3c8e4), map props as instance LOD
  chains (H5), DDS cubemaps + environment reflection (5287a98), terrain
  shader variants + stratum normals + skirt (H4), albedo decals as
  instance patches, sky dome with planets + Cirrus (M9), water according
  to HighFidelityPS (H6, 95a36b0), build shaders for ALL four factions
  (c370942), glow/bloom pass after CBloomRenderer (H2, ef1f088),
  construction-site appearance (H3), beat interpolation (M6), icon
  tint (M1).
- **Sound settings work.** `SetVolume`/`GetVolume` are real
  (`ui-globals.lua:2378`/`:2383`), `SupCom.xgs` is parsed
  (`src/formats/xgs.ts`) and GameAudio builds one GainNode per category;
  covered by `scripts/verify-audio.ts`. (This entry claimed the opposite for
  41 days after `5ba81e5` fixed it — corrected 2026-08-27.)
  Still open in audio: loops/variations/instance limits.
- **Text input works** (CMauiEdit vtable-override port: typing, selection,
  MaxChars, OnTextChanged/OnEnterPressed/OnEscPressed/OnCharPressed,
  caret rendering); StartCommandMode console command and UI IsAlly exist.
  The chat WINDOW renders completely (panel, title buttons, scrollbar,
  localized "To all:" prompt, blinking caret) — the earlier
  "invisible window" reading was CDP screenshot latency racing the
  auto-fade toggle. Open: verify the fade duration matches the 15 s of
  chat.lua:1004-1009 in real play; clipboard is a VM-internal buffer
  (browser clipboard is async — platform deviation); drag-selection and
  the exact caret-blink math (CMauiEdit::DoRender undecoded) are named
  gaps.
- **Command dispatch:** Stop, Move-cancels-build, Attack (units and
  ground, AITARGET_Ground), Repair (including HP repair), shift queueing
  (CUnitCommandQueue), Guard/Assist (queue sharing, build assist, follow),
  Patrol (ring-rotated queue legs with engage-on-the-way), Reclaim
  (props/wrecks with the target-Lua cost formula; clickable in the
  browser — wreck raycast plus instanced map-prop picking resolved
  through the scmap index, RULEUCC_Reclaim command mode and the default
  right-click), SetFireState, and command-cap masks/build restrictions
  (Add/RemoveCommandCap, Add/RemoveBuildRestriction with dispatch
  validation) are 1:1 now (dispatch table @0x608EF0); a guard with unit
  category RECLAIM also joins the guarded unit's running reclaim
  (sub_612E80). Still open: Capture, point guard, capture-on-enemy,
  guard enemy chase (GetBestEnemy), ground-attack ring rotation in the
  queue, rectangle reclaim (GetReclaimablesInRect), and command markers
  (UICommandGraph — order lines exist). Click picking is ONE
  depth-sorted raycast across units, wrecks and instanced map props
  (the closest entity of any kind wins — engine semantics).
- **Sim findings:** occupancy at arrival works — two units sent to the same
  point stop 1.41 m apart instead of stacking (`verify-motion.ts`, since
  `7df07bf`). Still open is *predictive* avoidance **during** travel: units do
  not steer around each other on the way, only refuse an occupied arrival cell.
- **Fixed in the August 2026 fidelity round** (spec
  [001-engine-fidelity-fixes](../specs/001-engine-fidelity-fixes/spec.md), each
  with its decomp evidence and a suite): `AIBrain:TakeResource` drains storage
  and returns what it took instead of being a negative `GiveResource`; shields
  absorb once per damage event instead of once per covered unit; target
  acquisition honours `TargetPriorities` instead of picking the nearest;
  construction and decay *adjust* health by the delta instead of assigning it
  (damage to a site is no longer healed away every tick); `Stop` clears a
  factory's production queue; a dying factory stops producing;
  `Unit:GetResourceConsumed` reports the real granted rate instead of a flat 1;
  water impacts report `Water` instead of `Terrain`; the map's water elevation
  reaches the Sim at last, and unit height now branches by motion type (only
  Water/AmphibiousFloating/Hover float — an amphibious unit walks the seabed);
  `uimain.OnMouseButtonPress` is called again, so every `AddOnMouseClickedFunc`
  registration works; a click elsewhere no longer steals the keyboard focus.
- **`src/ui/hud.ts`** is the last TS remainder (minimap image, strategic
  icons). Do not add anything new there; it disappears with worldview/minimap.
- **The map is parsed in TS** (`main.ts` reads `Scenario…Markers` itself)
  instead of through `ScenarioUtilities.lua` (no army groups); map PROPS
  now reach the sim through the boot message (Sim::Setup step 7,
  5182/5182 on SCMP_009).
- **The blueprint is read twice** — by the TS parser (models/bones) and the
  real `LoadBlueprints()` pipeline. The TS side is a pure projection again:
  `blueprintPlacement()` had grown two invented defaults (`Footprint → 1`,
  `BuildOnLayerCaps → 0`) and disagreed with the pipeline on the 72 retail
  structures that ship no `Footprint` section, so the build ghost judged a 3×3
  building as 1×1. Both now derive from the engine rule, and
  `verify-ogrid.ts` compares all 374 structures against the pipeline — a future
  drift is a test failure, not a surprise.
- **Assist works** (multi-builder placement, Guard on a builder/factory, and
  a Guard with category RECLAIM joining a reclaiming builder — sub_612E80,
  asserted in `verify-combat.ts`). Still open: Capture, point guard,
  capture-on-enemy.
- ~~**Economy Lua API is partly a no-op**~~ — no longer true, and the entry was
  stale: `SetProductionPerSecond*` and `SetConsumptionPerSecond*` write through
  `__econUpdateRate` into the army economy (moho.lua:793-808), and
  `SetBuildRate` mutates the value the build task actually reads
  (`b:GetBuildRate()`, build.lua:476). `Unit:GetResourceConsumed` now reports
  the real granted rate too (the last placeholder in that corner).
- **`research/economy-binary.md` describes more than `economy.ts` supports**
  (Handicap, overflow sharing, cumulative `granted` accumulator).
- **DDS parser** handles DXT1/3/5, uncompressed 8/16/24/32-bit (incl. A1R5G5B5,
  the format of all 1,134 strategic icons), cubemaps and full mip chains.
  Sub-4-bit channels now expand uniformly (`round(v*255/(2^bits-1))`) — the
  1-bit alpha of the A1R5G5B5 icons no longer renders at half opacity. Open:
  ATI2/BC5, BC6H/BC7, DX10 headers and DDSD_PITCH — no retail asset uses them.
- **Score numbers remain blank** (1:1: Vanilla-3599 has no `currentScores`
  producers) — the user decision between Vanilla and FAF remains open.

## The thread scheduler ran forks one tick late

`src/engine-lua/threads.lua` mirrors `CTaskStage` / `CTaskThread` / `CLuaTask`.
Reading those against the file found five differences, all fixed and pinned by
`scripts/verify-simthreads.ts` (twelve checks red on the old file):

* **A thread forked during a frame runs in that frame.** `CTaskStage::DoFrame`
  (Cfile:439351-439395) pops threads off the head of `mThreads` until the list
  is EMPTY; the constructor appends a new thread to its tail with
  `mWaitTicks = 0` (Cfile:438783-438808), and the pre-decrement in `DoTaskTick`
  (Cfile:438898) makes it due at once. Our scheduler took a snapshot of the
  list and ran forks one tick later -- and `verify-simthreads.ts` ASSERTED that
  ("Kind läuft NICHT im selben Tick"). The original Lua knows the engine's
  order: `platoon.lua:210` has a branch for "Platoon disbanded same tick as
  created", reachable only when the platoon's forked AI thread runs in the
  tick the platoon was formed.
* **`WaitTicks(0)` does not wait.** `TASKSTATUS_0` stores `mWaitTicks = 0` and
  re-ticks an un-parked thread at once (Cfile:438938-438942). That is also
  how `WaitFor` gets its wait task executed immediately (it yields 0,
  Cfile:592990-592993).
* **The engine's own texts.** A Lua error in a thread is logged as
  `Error running lua script: %s` (Cfile:592246) -- the log line to search for
  now, instead of our own `ForkThread-Fehler:`. A yield that is not a number
  logs `Invalid args to yield(); expected tick count`, a negative one
  `Invalid args to yield(); tick count must be >=0` (Cfile:592211-592233), and
  both end the thread; a bare `WaitTicks()` ends it silently (LUA_TNONE ->
  -1, Cfile:592208). We used to treat all of those as `WaitTicks(1)`.
* **`ResumeThread` appends to the tail** (Cfile:593112-593124): a parked
  thread resumed during a frame runs in that frame, after everything queued.
* **`KillThread(false)` is a type error**, only nil is ignored
  (Cfile:592571-592577); the original always guards with `if x then`.

What it changed in the running game: the golden master moved by one unit --
the second engineer of the factory chain is born at tick 130 instead of 131
(its id 19 instead of 20), because every fork chain is one tick shorter.

And the AI: with forks one tick late, the engineer platoon formed at tick 10
was disbanded at tick 11 and re-formed EVERY tick (`TaskFinished`,
platoon.lua:219). With the engine's order it is disbanded in the tick it was
formed and re-tried once a second (`DelayAssign`, platoon.lua:213-217). The
suite now counts the forming (`__platoonsMade`) instead of expecting a platoon
to survive. Why none survives is the next AI stop, now named correctly:
`EngineerBuildAI` finds nothing to build because `FindPlaceToBuild`,
`CanBuildStructureAt`, `CanBuildPlatoon`, `GetUnitsAroundPoint` and
`GetNumUnitsAroundPoint` are still silent no-ops in `moho.lua` -- so
`ProcessBuildCommand` disbands the platoon (platoon.lua:2932), and `BuildOnce`
then runs on a platoon whose `BuilderHandle` is already nil.

## Three weapon-task facts the code contradicted

Read against `CAcquireTargetTask`, `CFireWeaponTask` and `CAimManipulator`;
each fix has a check in `scripts/verify-combat.ts` that was red before it.

* **The target check runs on the weapon's own rhythm.** The acquire task
  returns `interval + 1` (Cfile:792908-792912), `DoTaskTick` stores
  `interval` and pre-decrements it (Cfile:438947, 438898), and the task
  thread starts due (`mWaitTicks = 0`, Cfile:438797): first check on the
  weapon's first tick, then every `interval` ticks. Ours checked on
  `__gameTick % interval == 0` -- a tank finished at tick 17 waited until
  tick 30 for its first look around. Now a per-weapon countdown
  (`__acquireWait`).
* **Fire control is a label on the weapon.** `UnitWeapon::mLabel` starts as
  "Default" (Cfile:984161); `SetFireControl` replaces it (Cfile:987460),
  `IsFireControl` is `stricmp` against it (Cfile:987526), and an aim
  manipulator writes the weapon's fire gate ONLY when its own label matches
  (Cfile:862060-862085). Both bindings were silent no-ops, and a weapon kept
  a single `__aim` -- for the seven `TurretDualManipulators` units
  (weapon.lua:78-87: Torso, Right, Left; fire control 'Right') the LAST
  manipulator created overwrote the others and wrote the gate. Now a weapon
  owns `__aims`, all of them tick, and `__weaponFireControlAim` names the
  one that may open the gate. The old comment claimed the engine compares no
  labels at all; it does.
* **`OnStartTracking` / `OnStopTracking` were never called.** `Track` fires
  them on the edges of "the heading moved this tick" (Cfile:861850-861880)
  with the manipulator's label; weapon.lua:232-243 plays the barrel sounds
  there and freezes a structure's reset pose.

Confirmed on the way, against a wrong suspicion of mine: the turret slew IS
`deg/s * DEG2RAD * 0.1` per tick -- the binding scales the two slews by 0.1
after the degree conversion (Cfile:862796-862802). `docs/research/weapons.md`
now carries the decompilation lines next to its faf-re ones.

Still open in the same area, named: the frame in which `CheckTracking`
measures the remaining angle (Cfile:861760-861880 reads the bone's composite
transform; whether that includes the manipulator's own rotation from the
previous tick decides how the unlimited-arc branch converges) -- our
`aimAxis` is a working model, not a transcription. And `func_PickTargetPoint`
(Cfile:984750-984845) rejects Seabed targets for `AboveWaterTargetsOnly` /
`BelowWaterTargetsonly` weapons through `PickTargetPointAbove/BelowWater`;
we do not implement that pair yet.

## The browser Sim never saw the terrain-type layer

`GetTerrainType(x, z)` was corrected earlier to read the map's type layer --
in the suites, which hand `terrainTypeAt` to the engine themselves. The
browser did not: `luaSimWorker.ts` built its terrain source from the heights
alone, so every position in a real session answered the default type. Lava
did no damage (`HealthEffectPerSecond`), every wreck took the offset of the
wrong type (`GetTerrainTypeOffset`, unit.lua:1100), and the footfall and
impact effect sets were the default's -- silently, in every browser session
so far.

Now `HeightfieldData` carries the layer (`terrainType`, the scmap's
`width × height` bytes), `terrain.ts terrainTypeSampler` is the ONE lookup
(STIMap::GetTerrainType, Cfile:1087700-1087705: unsigned cast, code 1 at or
beyond the map size), the worker refuses to boot a map without the layer,
and it logs `Sim: terrain types on the map: …` so a session shows what it
read. `verify-browser-session.ts` uses the same sampler and is red when the
layer is missing (nine type names on SCMP_009, one without).

## Two more from the weapon and unit-state bindings

* **A unit that must unpack does not look for targets while it moves.**
  `CAcquireTargetTask::TaskTick` skips the whole check for `AI.NeedUnpack`
  units in the Moving, TransportLoading or WaitingForTransport state and only
  re-arms its interval (Cfile:792913-792917). The five units that carry the
  flag are the four T3 mobile artilleries and the Monkeylord; ours acquired
  on the move. `verify-combat.ts` drives a uel0304 through a real move order.
* **`SetUnitState(name, bool)` was a silent no-op.** The binding sets or
  clears the state's bit in the unit's own bitfield (Cfile:974353-974390);
  the enhancement task uses it for Enhancing and Upgrading
  (enhancetask.lua:14-22), so `IsUnitState('Enhancing')` could never be true.
  Now the Lua-set bits live next to the task-derived ones and are OR-ed -- a
  named reduction, the engine has one bitfield. `IsUnitState` also validates
  its name against the 45 EUnitState names (Cfile:702955-703060) and throws
  like SCR_GetEnum; `SetUnitState` with an unknown name does nothing, like
  SetLexical.

## Every ACU could build T2 and T3 from the first second

`Unit:AddBuildRestriction`, `RemoveBuildRestriction` and
`RestoreBuildRestrictions` were three of the silent no-ops, and
`Unit:CanBuild` did not exist at all. The ACU scripts live on them:
uel0001_script.lua:117 (and the other three factions alike) restricts
`UEF * (BUILTBYTIER2COMMANDER + BUILTBYTIER3COMMANDER)` when the commander
is done, and the engineering enhancements remove `BuildableCategoryAdds`
again (uel0001_script.lua:334-335, 370-371). With the no-ops, the T2
extractor and the T3 generator were buildable from the start; the AI's
builders, which ask `CanBuild` before every structure
(aibuildstructures.lua:623, aibrain.lua:2996), died with "attempt to call
a nil value" instead.

The engine keeps `UnitAttributes::mRestrictionCategory` as a SET of
blueprints: add is a union (Cfile:975286-975288), remove a set difference
(Cfile:975342-975344), restore empties it (Cfile:975399-975410), and
`Unit::CanBuild` tests the blueprint's bit in `(buildable x army category)
minus restriction` (Cfile:953352-953391). The enhancement removes a
DIFFERENT expression than the one added, which only set arithmetic gets
right -- the old list-of-terms model could never have. Because our
blueprints register lazily, the unit keeps the ordered add/remove log and
answers per blueprint from it, which gives the set's answer whenever the
blueprint arrived. `verify-restrictions.ts` walks a UEF ACU through it.

The user layer follows: `GetUnitCommandData` subtracts the unit's own
restriction category from the buildable set (Cfile:1264642-1264646), so an
unenhanced ACU's build menu holds no T2 structures. The blueprint DSL has
no subtraction, so the category travels per beat in the prefix text form of
`globals.lua __categoryToString` (`sub(and(tok:UEF,or(...)),...)`) and the
UI VM reads it back with `__categoryFromString`; `verify-ui-panels.ts` shows
ueb1201 leaving and re-entering the ACU's menu with it. `mRequestRefreshUI`
is still only recorded (`__requestRefreshUI`); the per-beat mirror makes a
refresh signal unnecessary here.

## GetFocusUnit was a no-op -- and the build cost was an invention on top

`Unit:GetFocusUnit()` returned nil for every unit. The engine answers with
the focus entity when it is a unit (cfunc_UnitGetFocusUnitL,
Cfile:972698-972712), and `CBuildTaskHelper::SetFocus` makes the build target
that focus before `OnStartBuild` (Cfile:815090-815102, with the script's
`OnAssignedFocusEntity` in between); `OnStopBuild` unlinks it again
(Cfile:815022-815030). unit.lua:698 reads it in `UpdateConsumptionValues`,
cybranunits.lua:180 for the build effects.

Making it real exposed the second half. `UpdateConsumptionValues`
(unit.lua:697-745) prices the focus blueprint with `GetBuildCosts` and sets
the BUILDER's consumption rate -- and that request is the build's whole
economic demand: `Unit::HandleResourceManagement` takes
`perSecond x LimitingRate` from the army and keeps the LimitingRate as
`mResourceConsumed` (Cfile:953945-953965), which `UpdateWorkProgress`
multiplies into the progress delta. There is no build request in the engine.
Ours had one: while GetFocusUnit was nil the Lua could price nothing (its
floor of 1, unit.lua:717), so `build.lua` registered a TS-side request per
task from the blueprint cost and read its LimitingRate back. With both alive
every build was charged twice -- 120 energy/s for a T1 generator instead of
60, in `verify-build.ts` and in the game. The stand-in is gone; the progress
rate is the builder's `GetResourceConsumed()`. The golden master moved by
exactly the double charge (army 1 keeps 20.5 more mass), nothing else.

## Every ACU was drawn with all three upgrade pods

`HideBone` and `ShowBone` were silent no-ops. uel0001_script.lua:110-112
hides `Right_Upgrade`, `Left_Upgrade` and `Back_Upgrade_B01` when the
commander is complete, and the enhancements show them again; factories hide
and show their build arms the same way. The engine binding
(cfunc_UnitHideBoneL, Cfile:981560-981600) resolves the bone with
ENTSCR_ResolveBoneIndex (Cfile:936279-936330: a number must lie in
[0, boneCount) -- HideBone/ShowBone pass 0 as the third argument, which
sets the minimum to 0, so the pseudo bones -1/-2 are errors there; the
Attach* bindings and the effect, beam and projectile bindings pass 1 and
admit -2 -- a name must exist) and clears `CAniPoseBone::mVisible` -- over the whole subtree when
`affectChildren` is true (SetVisibleRecur), which is why the fresh ACU hides
seven bones: the three pods, their muzzles and `Back_Upgrade_B02`.

The skeleton now keeps its parent table (`bones.lua`), the unit row carries
the hidden names, and the renderer collapses those bones' skin matrices to
zero scale (`animator.ts setHiddenBones`) so their geometry rasterises
nothing in the main and the shadow pass alike. `verify-restrictions.ts`
walks the ACU through hide, show, the two engine errors and the root.

## Five unit setters that were silent no-ops

Each one is a single engine field, and each had a consumer that never saw
the value:

| Binding | Engine | Consumer |
| --- | --- | --- |
| `SetUnSelectable(bool)` | bit 33 `UNITSTATE_UnSelectable` (Cfile:974215-974260) | the ACUs raise it while they teleport (uel0001_script.lua:185-200); the user layer now drops such units from `SelectUnits`. **UNVERIFIED** which user-layer function reads the bit -- `UserEntity::IsSelectable` (Cfile:1357434) tests the SELECTABLE category, not this state. |
| `SetDoNotTarget(bool)` | bit 34 `UNITSTATE_DoNotTarget` (Cfile:974281-974326) | the free target search skips it (CAcquireTargetTask, Cfile:792119); the Aeon tractor beam and the UEF transport flag their victim/cargo |
| `SetReclaimable(bool)` | `UnitAttributes::mReclaimable`, 1 from the ctor (Cfile:976068-976090, 772327) | an unreclaimable unit is refused as a reclaim target (Cfile:1007090) and ends a running reclaim (Cfile:847982); unit.lua:3468 clears it on a unit being captured |
| `SetIsValidTarget(bool)` | `mUnitVarDat.mIsValidTarget`, 1 from the ctor (Cfile:974478-974490, 772274) | `IsValidTarget()` (Cfile:974550) |
| `SetCustomName(string)` | `Unit::SetCustomName` (Cfile:979089-979120) | the user layer's `GetCustomName` -- the name now travels with the unit row |

Pinned in `verify-moho-sim-contracts.ts`, `verify-combat.ts` (the gun
passes over the flagged tank), `verify-reclaim.ts` and
`verify-user-unit-state.ts`.

The hidden-bone renderer path (`animator.ts setHiddenBones`) is not
screenshot-verified yet: the headless sandbox without `selftest` frames the
whole map, not the commander.

## The attach family was four silent no-ops -- now entities hang on bones

`AttachTo`, `AttachBoneTo`, `DetachFrom` and `DetachAll` did nothing, and
`GetParent` answered nil. The original Lua leans on them everywhere: a
factory hangs the unit it builds on its `BuildAttachBone`
(defaultunits.lua:669-670 `AttachBoneTo(-2, self, bone)`, released in
FinishBuildThread with `DetachFrom(true)` + `DetachAll(bone)`), every shield
hangs on its owner's collision centre (shield.lua:50 `AttachBoneTo(-1, Owner,
-1)`, lifted by `SetParentOffset`), ambient-sound entities hang on their unit
(unit.lua:2789), transports carry units as attachments
(scenarioframework.lua:1364). Without the state a tank under construction
sat at the factory origin and `IsUnitState('Attached')` was never true.

What the engine does (all Cfile): `SEntAttachInfo` is one parent link per
entity -- parent, PARENT bone, OWN reference bone, offset (914497-914500
defaults) -- plus the parent's list `mAttachedEntities`. `Entity::AttachTo`
(915773-915880) refuses an entity that already has a parent, a cycle up the
parent chain and a duplicate list entry; on success it wakes the entity's
task thread so the first follow happens in the same frame. `Entity::TaskTick`
(916175-916190) recomputes the transform every tick once the parent has
ticked: `CalculateAttachedTransform` (916355-916377) = parent bone world o
offset o inverse(own bone local), where `GetBoneLocalTransform`
(916242-916296) is the inverse rest pose for a real bone, the collision
centre for -1 and the identity for -2. `Unit::AttachTo` (954378-954392) adds
`CUnitMotion::NotifyAttached` (motion state Attached) and the Attached state
bit; `Unit::DetachFrom` (954394-954427) adds `NotifyDetached` (965794-965870:
Ballistic + Air layer for a non-flying unit unless skipBallistic, otherwise
motion state None; mProcessSurfaceCollision), clears the bit and releases
`mTransportedBy`. `Entity::Kill` (916064-916084) fires OnAttachedKilled on
the parent and OnParentKilled on the children; `Entity::OnDestroy`
(916143-916162) OnAttachedDestroyed, the detach, OnParentDestroyed. The
bindings: `AttachTo` = own bone 0 (931927), `AttachBoneTo` with the given own
bone (932049), both resolving bones with the pseudo bones admitted;
`DetachAll` resolves without them and releases only the entities on that bone
(932312, 932356-932362); `GetParent` returns the entity itself when
unattached (932423); `SetParentOffset` takes exactly one vector and errors
without a parent (932132-932133, 932147); `DetachFrom` answers false without
a parent (932229, 932239).

Implemented in `bones.lua` (bookkeeping, transform, the per-beat follow
after the motion loop), `moho.lua` (the six bindings with the engine's
argument counts and error texts, the Kill hook), `motion.lua` (an attached
unit does not move and follows its parent's layer unless that parent is
building it, Cfile:966205-966229; NotifyAttached/NotifyDetached; the
surface snap after a release -- NotifyDetached's mProcessSurfaceCollision
(965870) makes the next CalcMoveLand snap the unit to the ground,
Cfile:971709-971716, CalcMoveHover 971573-971575) and `damage.lua` (the
destroy callbacks).
`ToggleScriptBit` now also honours the TRANSPORTATION gate
(Cfile:951400-951424), which the old comment had declared out of reach.

Seen: the factory suite's site now stands on the factory's `Attachpoint`
bone (120.000, 20.491, 120.335) instead of the origin, next to the factory's
own ambient-sound entity in the attach list; the shield follows a moving ACU
beat by beat and `SetParentOffset(0, 2.5, 0)` lifts it on the next beat; 36
contract checks cover argument counts, bone ranges, refusals, the follow
(own bone -2 and the real `Turret` bone, an offset that turns with the parent
heading), DetachAll per bone, a dead unit released by DetachAll without
skipBallistic, and the Kill/Destroy callbacks on both sides. Of the first 27,
21 were seen red on the old no-ops, plus 6 factory, 4 shield and 1
restriction check; of the 9 added after the review, 8 were seen red under a targeted mutation of the four behaviours they cover (the ninth, the attach call itself succeeding, is their precondition).
The playthrough's finding list lost five entries (the four attach no-ops
and `GetFocusUnit`, which had already become real). The golden master
moved, and the dump on both states differs in exactly two fields: the final
headings of the two factory-built tanks (1.91567 -> 2.06258 and -1.81956 ->
-1.87193). They now begin their roll-off from the Attachpoint pose rather
than from the factory origin; positions, health and the economy are
identical. The hash was updated with that explanation.

Not implemented, recorded rather than faked:

* **The ballistic drop.** `DetachFrom` without `skipBallistic` on a
  non-flying unit (a transport unload, Cfile:965830-965848) puts the engine
  unit into UMS_Ballistic and the Air layer until `CalcMoveBallistic` lands
  it. Here that call is refused with an error naming the gap for a LIVE unit
  (the tractor claw's `DetachAll` in aeonweapons.lua:179, scenario detaches).
  A DEAD unit is exempt and released in place, keeping its layer: the factory
  releases a dead site with `DetachAll(bone)` and no `skipBallistic`
  (defaultunits.lua:539-542, FinishBuildThread skips `DetachFrom(true)` for
  a dead site), and a refusal there would kill the factory's thread while it
  is busy. Likewise the children of a destroyed parent are released in place
  instead of dropping (Cfile:966231-966238), and a dying attached unit's own
  detach in OnDestroy (916158) keeps only the state bookkeeping of
  Unit::DetachFrom, not the Ballistic/Air callbacks.
* **Motion events.** `NotifyAttached` also forces the horizontal event to
  Stopped and the vertical one to Top with their callbacks and `UpdateIntel`
  (965760-965785); this motion model tracks neither event anywhere, so the
  two callbacks are not fired. `NotifyDetached`'s steering target one unit
  behind the parent's facing (965803-965816) has no counterpart either.
* **UNVERIFIED: the predicate gating the unit side of AttachTo and
  DetachFrom.** The calls at 954384 and 954405-954409 go through slot 0x30 of
  the unit's IUnit vtable, which the decompilation does not list (the IDA
  server was unreachable); NotifyAttached, NotifyDetached and the Attached
  bit are applied to every unit here.
* **Scale.** `GetBoneLocalTransform` scales the rest pose by
  `mVarDat.mScale` (916249-916253); the rest pose here already carries the
  blueprint's `Display.UniformScale` (bones.lua), a runtime `SetScale` is
  not modelled.
* **The navigator goal survives.** NotifyDetached replaces the steering
  target (965803-965816); a goal the unit held before the attach is kept here
  and resumes after `DetachFrom`.
* The engine's own error text for a non-entity argument
  (`SCR_FromLua_Entity`) is not reproduced.

A side finding on the way: `ENTSCR_ResolveBoneIndex`'s third argument admits
the pseudo bones when it is 1 (minimum -2) and rejects them when it is 0
(minimum 0, Cfile:936295). `HideBone`/`ShowBone` pass 0 (981522/981598), so
`HideBone(-1)` is an engine error -- the earlier claim that it "passes and
does nothing" was wrong and is corrected above and in `verify-restrictions`.

## ShakeCamera was the last no-op the game reached -- the camera shakes now

`Entity:ShakeCamera(radius, max, min, duration)` is what every explosion and
every heavy footstep calls (defaultexplosions.lua:99/179, unit.lua:2308/
2526/2615 with the blueprint's `CameraShake` table). It was a silent no-op.

The engine path (all Cfile): the binding (cfunc_EntityShakeCameraL,
931108-931169) takes exactly five arguments, type-checks the four numbers
and packs the entity's position with them into an SCamShakeParams appended to
Sim::mSyncCamShake (func_ShakeCamera, 936387). Sim::Sync hands the list to
the user layer with the beat (1074494-1074501); the user side calls
CameraImpl::CameraShake for every entry on every camera (1327867).
CameraImpl::CameraShake (1149138-1149153) accepts a request only while
mCanShake, and only when the running shake is over or the new one is
stronger (max); it then restarts mTotalTime. CameraImpl::Frame
(1150647-1150651) advances mTotalTime, clamped to the duration, and flips a
sign every frame. func_CameraImplUpdateShake (1148657-1148712) computes the
eye offset: direction focus -> epicentre in the XZ plane (random closer than
10 units), amplitude (1 - t/duration) * ((min - max) * clamp(dist/radius) +
max), rand(0, amp) * sign * 0.5 along the direction, rand(-amp, amp) * 0.25
across it, times `cam_ShakeMult` (421830, default 1.0); the offset is added
to the eye (1151445-1151452).

Implemented: the sim binding in `moho.lua` with the engine's help text and
argument checks, the per-beat list in `weapons.lua` next to the audio
requests, the `camShakes` field of the worker's states message, the
`SimCamShake` type and drain in `luaSimClient.ts`, the pure state and math
in `src/viewer/cameraShake.ts`, the eye offset in `applyRtsCameraTransform`
and the `cam_ShakeMult` convar. `scripts/verify-camera-shake.ts` (asset-free)
checks the replacement rule, the clock, the sign flip, the falloff, the
decay, the two random terms and the multiplier with a deterministic rand --
8 of its 16 checks went red under a mutation of the along factor and the
replacement rule. Three contract checks (argument count, type error, the
drained request) were red against the old no-op. The playthrough's finding
list is now free of reached no-ops.

Not modelled: the engine's mCanShake is cleared for an orthographic world
view (CRenderWorldView::SetOrthographic, 1297718-1297735); this viewer has
no orthographic mode, so the flag stays true. The shake is applied to the
one rendered camera; the engine applies it to every camera of the session
(the minimap's SimpleRenderWorldView answers CanShake as well, 1210359 --
not read). The camera runs on the system clock (TIMESOURCE_System,
1149644); `Camera:UseGameClock` (1153602, reached through
Sync.CameraRequests from cinematics.lua) has no counterpart here. The type
error of a non-number argument carries luaG_typeerror's text (1424984-
1424985), without a position prefix in the engine; ours adds the usual Lua
position. A shake request with a non-finite number would break the per-beat
JSON here where the engine takes any float -- no original caller passes one.

A regression of this block that no Node suite could see: the RTS camera
reads `cam_ShakeMult` every frame, and the viewer's own start table of
engine convars (the values compiled into the engine, which exist before any
Lua runs) did not carry it -- the first frame threw "ConVar cam_ShakeMult
ist nicht gesetzt" before the UI VM's ConExecute pass could deliver it, and
the browser self-test ended with "keine ACU". The headless self-test gate
(`scripts/selftest-gate.ts`) found it; the seed (Cfile:421830, 1.0) is in
the table now and the gate runs through (SELFTEST-OK).

## The motion events never fired -- no start/stop sounds, no movement effects

`CUnitMotion` reports every unit's horizontal motion event (Cruise,
TopSpeed, Stopping, Stopped -- Cfile:421837) and vertical one (Top, Bottom,
Up, Down, Hover -- 421838, unit.lua:2213-2221) through
`OnMotionHorzEventChange(new, old)` and `OnMotionVertEventChange(new, old)`.
unit.lua:2133-2260 turns them into the start/stop move sounds, the ambient
move loops, `StartRocking`/`StopRocking` on water, the movement effects
(`UpdateMovementEffectsOnMotionEventChange`), the horizontal start-move
callbacks and every weapon's `OnMotionHorzEventChange`
(defaultweapons.lua:90-105: `PackAndMove` for unpack-locking weapons and
`FiringRandomnessWhileMoving`). This motion model fired none of them.

The engine (Cfile): a fresh CUnitMotion is Stopped / Bottom (964772-964773).
`SetMotionHorzEvent` (965503-965520) and `SetMotionVertEvent`
(965524-965538) fire the callback on a change only; Stopped also refreshes
the intel. `ProcessCommonMotionState` (971451-971510) closes every land,
hover and water tick (971718, 971575, 971856) with CalcMoveCommon's result:
not moving -> Stopped; |velocity| (per tick) above mTopSpeed * 0.08 (the top
speed per second, i.e. 80 % of it) -> TopSpeed; otherwise Stopping when the
event is not Stopped and the target lies within one second of travel at
MaxSpeed * speed mult (or the next waypoint is a PPS_1 point), else Cruise.
NotifyAttached forces Stopped / Top (965766-965785).

Implemented in `motion.lua` (`__setMotionHorzEvent`/`__setMotionVertEvent`,
`processCommonMotionState` after every unit's tick with a `moving` flag that
mirrors CalcMoveCommon -- true only when a move was computed; the attach
path forces Stopped/Top) and `units.lua` (the constructor values).
`verify-motion` drives an ACU 60 m and sees exactly
`Cruise<Stopped TopSpeed<Cruise Stopping<TopSpeed Stopped<Stopping`, a
0.4 m hop `Cruise<Stopped Stopping<Cruise Stopped<Stopping` (never
TopSpeed, and Stopped never turns straight into Stopping), nothing while
standing, and unit.lua's own handler running (the horizontal start-move
callback fires once); five of those checks were red on the old code.
`verify-moho-sim-contracts` checks the forced Stopped/Top on attach.

With the events firing, unit.lua's movement effects run for the first time
and reached two more silent no-ops, `AddThreadScroller` and `RemoveScroller`
(the tread texture scrollers) -- implemented in the next section.

Not modelled: the `PPS_1` condition of Stopping (971469-971470) -- PPS_1 is
the state the path spline gives its own start point (765664) and its
meaning for the NEXT waypoint is unresolved; the intel refresh on Stopped
(no intel model); the vertical events of air, hover and amphibious motion
(Up/Down/Hover, Top/Bottom on surfacing, 969729-969885, 971775-971812) --
those motion types are not driven here yet, so their units keep the
constructor's Bottom. A live stunned or immobile unit keeps running
CalcMoveCommon in the engine (966266-966274), so its residual velocity
brakes over a few ticks and the events follow that braking; this motion
model stops such a unit at once and therefore reports Stopped at once. A
unit that arrives with zero velocity reports Stopped on the arrival tick
(CalcMoveCommon returns 0 for a zero velocity, 971329-971338).

## The texture scrollers -- tank treads scroll again

`AddThreadScroller`, `AddManualScroller`, `AddPingPongScroller` and
`RemoveScroller` were silent no-ops; the first two the movement effects
reach as soon as a tank drives (unit.lua:2621-2624 `CreateTreads` ->
`AddThreadScroller(1.0, treads.ScrollMultiplier)` for every blueprint with
`Display.MovementEffects.<layer>.Treads.ScrollTreads` -- 37 of them -- and
`RemoveScroller` when the effects are destroyed, unit.lua:2537-2538);
`AddPingPong` (defaultunits.lua:1415-1424) feeds `Display.PingPongScroller`.

The engine (Cfile): an entity owns one CTextureScroller; the bindings
(935407-935760) create it on first use and hand it an SScroller through
Entity::AddScroller (1110823-1110842: a PingPong spec zeroes its directions
and countdowns, a None spec freezes the scroll, mScroll2 = mScroll1). The
scroll itself is the entity's mVarDat.mScroll1/mScroll2 -- a pair for the
renderer's interpolation -- part of the per-entity sync (701559-701562,
701700-701703); the user entity copies it to its mesh instance every sync
(1358126-1358133) and interpolates mScroll1 -> mScroll2 with the beat
interpolant (1297389-1297393). CTextureScroller::Tick runs first thing in
Entity::TaskTick every tick (916174-916176, 1110848-1111068): ping-pong
flips each of two channels when its countdown ends and reloads
floor(speed * 10) ticks of the side it enters; manual adds (speed1, speed2)
per tick; the thread scroller, when the position changed, moves the points
at +/- sideDist along the local X axis with the entity and adds each point's
displacement projected on the averaged forward axis, times scrollMult, to
mScroll2.x (the + side) and mScroll2.y (the - side). The shader
(effects/mesh.fx:438-452 ComputeScrolledTexcoord, gated by the LOD's
`Scrolling` flag, Cfile:1191018) adds the interpolated scroll to U for the
UV bands texcoord.y > 0.95 (scroll.x) and 0.90 < y <= 0.95 (scroll.y).

Implemented: the scroller model and tick in `bones.lua`, the bindings in
`moho.lua`, the tick from the motion loop, the `scroll` pair in the unit
rows, the `scrolling` LOD flag in `unitPaths.ts`, the `scroll`/`scrolling`
uniforms of the unit material with `unit.vert.glsl` scrolling the two UV
bands, and the per-frame interpolation in `main.ts`.
`scripts/verify-scrollers.ts` checks the argument errors, the zero start,
the thread scroll of a straight drive (both treads = distance * mult, the
interpolation lag), the unequal scroll in a turn, the freeze of
RemoveScroller, the manual and ping-pong ticks, and the real chain of a
driving uel0201 (ScrollMultiplier 0.75) down to the sync row; 6 of its 24
checks went red under a mutation of the thread multiplier, the ping-pong
dwell and the freeze. The golden master moved by exactly the new `scroll`
field of the three tread units -- the dump on both states differs in nothing
else -- and was updated; the coverage floor is 794 real / 146 no-op.

Both accumulations carry the scrollMult factor (the .x term explicitly at
1111061, the .y term inside its v37 expression at 1111051-1111058). The
SScroller field layout behind the ping-pong arguments follows from the
0x2C-byte copy in Entity::AddScroller starting one slot before the nested
struct: channel 1 (ping1/pingSpeed1/pong1/pongSpeed1) drives the x tread,
channel 2 the y tread, the dwell taken from the side just entered.
UNVERIFIED: whether mesh.fx keys the second UV set's band off its own V
(the shader tests texcoord.y only; unit.vert.glsl uses the first set's V for
both). Not modelled: the build materials do not scroll (mesh.fx applies the
scroll in the build techniques too).

## UI, interaction and picture -- the audit of 2026-09-03 and its work list

The user reported offset icons, missing effects and a picture that is not
the original's. Four parallel research passes (maui layout and icons, the
build-command chain, the effect system, the shaders) plus a headless run
with screenshots gave this picture; each item names its evidence.

**Icons.** The maui substrate is faithful: the engine's seven LazyVars per
control start raw (CMauiControl ctor, Cfile:1123926-1123972), every pixel
snap happens in the original Lua (LayoutHelpers/grid.lua `math.floor`,
executed unmodified), and CMauiBitmap::Draw builds its quad from
Left/Top/Right/Bottom without any half-pixel term (Cfile:1119309-1119395)
-- the DOM renderer does the same. The construction panel was checked
number by number in the running page: the build button, its icon and its
strategic-icon overlay sit exactly where construction.lua:399-401 and
:463-466 put them (48x48, the overlay 36x40 at +4/+4), and the 36x40 comes
from the DDS header itself. The one real deviation was the strategic icons
over the world: RenderUnitIcon (Cfile:1285668-1285760) projects the unit
position, FLOORS it (1285692-1285693) and places the quad at that pixel
minus the integer half size of the texture (1285726-1285727); ours used the
raw fractional projection and a CSS -50 % shift, so a 1-bit-alpha icon was
resampled and sat visibly off the crisp bar under the same unit -- fixed in
`hud.ts`, verified in the headless page (integer transforms). UNVERIFIED:
`GetTextureDimensions(filename, border=1)` (Cfile:1119423-1119507) hands
the border into the atlas loader; whether it changes the reported size is
not settled (our sizes come from the DDS header).

**The build chain** (Cfile:1264504-1264808 GetUnitCommandData,
1265706 IssueBlueprintCommand, 1242134-1242178 the world click,
815090-815102 the build task, 953443-953476 progress, 1257038-1257380 the
queue) matches step for step through the real construction.lua,
commandmode.lua, gamemain.lua and orders.lua. Open, ranked: the ARMY
build-restriction category (Cfile:1264632) is not subtracted in the UI
mirror (the army's `mVarDat.mCat` is an allowed-to-build set seeded with
ALLUNITS, Cfile:1017296-1017307, changed only by the sim-only
AddBuildRestriction/RemoveBuildRestriction, 1016787-1016830; the sim side
here enforces it, the menu does not hide the button); a finished factory
copies EVERY command of its rally queue into the product -- Guard, Patrol,
Attack, all of them, only TransportLoadUnits is skipped for AIR/NAVAL
products (sub_5FA340, 818487-818600) -- DONE below ("The factory command
list"); `DecreaseBuildCountInQueue` on the queue head removes the command
and the dispatcher interrupts the running CFactoryBuildTask -- DONE below
("The factory queue is one command per unit"); the player's Stop button
is a clear-then-Stop (ISSUE_Command with clear=1, 1255059-1255063,
ClearCommandQueue 1005371-1005399, then IAiCommandDispatchImpl::Stop
1231239-1231256 stops the attacker and silo builds) and is right here, but
the sim-only `IssueStop(units)` appends a Stop with clear=0
(1007889-1007952) and ours clears like the button. Ranked by play impact:
the army restriction mirror, the soft IssueStop (the factory command list,
the rally marker and the queue-head abort are done, see below).

**Effects.** The emitter/trail/beam pipeline is real and verified
(CEfxEmitter::Tick port). Missing or dead: `CreateLightParticle`/
`CreateLightParticleIntel` are empty (the flash core of nearly every impact,
nuke and build/reclaim glow -- engine object CEffectManagerImpl::
CreateLightParticle, Cfile:905874-906033: an additive billboard of constant
size whose ramp texture drives colour and alpha over the lifetime, spawned
only when a ramp is given; the Intel variant is gated by the focus army's
line of sight, 909075-909090); `CreateSplat`/`CreateDecal`/
`CreateSplatOnBone` carry sim state but nothing draws them (CDecal,
Cfile:907293-907441: a ground-projected quad with size, yaw, expiry tick,
type Albedo/Normals/Glow/Water, per-army visibility, 1112197-1112337;
the map-decal renderer already has the projection); the shield dome is
never drawn (shield.lua:263-283 hangs two sphere entities on the owner with
SetMesh/SetDrawScale/SetParentOffset -- ShieldUEF and ShieldFill techniques
in mesh.fx, the unit-mesh swap of personal shields via SetMesh(mesh, true)
keepActor, Cfile:954614-954634); `SetEmitterParam`/`SetEmitterCurveParam`
are write-only; `SetBeamParam` and `ResizeEmitterCurve` are missing.

**The picture.** The original renderer is NOT colour-managed: the device
default state sets D3DSAMP_SRGBTEXTURE to 0 for all samplers and
D3DRS_SRGBWRITEENABLE to 0 (Cfile:1464960-1465074) and never toggles them;
the back buffer is A8R8G8B8 (1394107); there is no gamma ramp (no
SetGammaRamp, no ren_Gamma; the only "gamma" is libpng's); the HLSL has no
pow(2.2) anywhere. Our raw-texture, raw-output shaders are therefore right
-- recorded in docs/research/verified-facts.md. Real deviations: the
Seraphim unit shader replaced the environment cube reflection of
UnitFalloffPS (mesh.fx:2659, 2670) with two invented constants -- fixed, it
samples the map's cube map like the other unit shaders now; the water
lacks the scene reflection target, the refraction offset and the shoreline
geometry (water2.fx:206-213, 612-629, documented in the shader); particle
blend mode 5 (REFRACT) falls back to alpha blending. Terrain, decals, sky
and bloom were checked against terrain.fx/sky.fx and match.

## The binding checklist missed 66 bindings -- the whole Issue* family among them

The review of the factory command list found `IssueFactoryRallyPoint` and
`IssueClearFactoryCommands` present in the UI VM: `globals.lua` is loaded
into both VMs and `ui-sim-globals.lua` strips only what
docs/research/engine-api.md lists as Sim-only -- and the generated checklist
did not know these two bindings. Cause: `scripts/dump-engine-api.ts` matched
the three luadef assignments (mPrevDef, mMethodName, mClassName) with ONE
regex in a fixed order, and every luadef whose decompiled lines come in
another order fell out silently (IssueFactoryRallyPoint has mMethodName
before mPrevDef, Cfile:1008266-1008270). The generator now collects the
three fields per luadef regardless of order, and resolves the 20 luadefs
whose list head IDA left as a raw address (`mPrevDef = MEMORY[0xF5A124]`,
e.g. UnitIsMobile at 977841) through the list their class mates name
symbolically (Unit/UnitWeapon are sim_SimInits, UserUnit scr_UserInits).
The checklist grew from 1149 to 1215 bindings: 40 Sim globals (the entire
Issue* family, IsCommandDone, CoordinateAttacks), 18 Unit/UnitWeapon methods
(GetCurrentLayer, GetFireState, GetGuards, GetVelocity, IsMobile,
IsValidTarget, RecoilImpulse, SetSpeedMult, ...), 5 UI globals
(CreateUnitAtMouse, Dump, DisableWorldSounds, EnableWorldSounds,
StopAllSounds) and 2 UI bindings (UserUnit.GetGuardedEntity,
SetCurrentFactoryForQueueDisplay). Still unlisted, with the reason:
`UnitGetGuardedUnit` has no mClassName line and `LaunchReplaySession` no
mMethodName line in the decompilation (recorded, not guessed).

What the wider checklist exposes, now in the coverage baseline (1149 ->
1215 bindings, 794 -> 819 real, 146 -> 150 no-ops): the Sim has NONE of
the 32 AI command bindings `IssueAttack`, `IssuePatrol`, `IssueRepair`,
`IssueReclaim`, `IssueBuildMobile`, `IssueBuildFactory`, `IssueFerry`,
`IssueTransportLoad/Unload`, `IssueFactoryAssist`, `IssueMoveOffFactory`,
... (only the player's `__dispatch*` path exists; aibrain.lua and
platoon.lua call these -- the next branch); `Unit.IsMobile`,
`HasValidTeleportDest` and `RevertCollisionShape` are missing; four silent
no-ops were never counted before (`Unit.RevertElevation`,
`Unit.SetBreakOffDistanceMult`, `CAiBrain.GetNumPlatoonsTemplateNamed`,
`CAiBrain.GetNumPlatoonsWithAI`). `IssueUpgrade` had leaked into the UI VM
too; the strip list now carries every documented Sim global plus the
factory-list helpers, and check-vm-separation is green. `IssueFactoryAssist`
is a real Sim binding -- the lead for the open factory-assist question.

## The factory queue is one command per unit; removing the running head aborts the build

The sim stacked queued units at issue time (`{ id, count }` per blueprint
run) and edited a stack's count in place; a decrease that emptied the stack
of the RUNNING build left the build running. The engine has neither.

The engine (Cfile): `IssueBlueprintCommand("UNITCOMMAND_BuildFactory", id,
count)` loops ISSUE_Command `count` times (1265867-1265872) -- ONE
BuildFactory command per unit, each with its own count of 1. The stacks the
construction panel shows are the USER side's merge: sub_835DF0
(1256786-1256813) walks the factory's command list front to back and folds
every command whose blueprint equals the previous item's into that item,
count accumulated, CmdIds kept. `DecreaseBuildCountInQueue(index, count)`
(1257301-1257395) walks the chosen item's commands from the NEWEST
backwards and sends Sim::DecreaseCommandCount per command until the count
is used up (1257350-1257390); CUnitCommand::DecreaseCount (1007719-1007775)
clamps at 0 and, at 0, removes the command from the unit's queue
(RemoveCommandFromQueue 1005104-1005155). Removing the HEAD broadcasts
UCQS_NeedsRefresh (1005110-1005117); the dispatcher's OnEvent
(746664-746706) interrupts its subtasks (TaskInterruptSubtasks
438613-438636) and the CFactoryBuildTask destructor runs (818337-818390):
mWorkProgress = 0, CBuildTaskHelper::OnStopBuild(helper, 0)
(814989-815060) -- OnFailedToBuild on the FACTORY (815007;
defaultunits.lua:560 sets FactoryBuildFailed and goes idle),
OnFailedToBeBuilt on the SITE (815018; unit.lua:1632 destroys it), the Lua
OnStopBuild(site, order) (815022; FactoryUnit.OnStopBuild skips the
roll-off on FactoryBuildFailed, defaultunits.lua:518), the focus dropped.
No refund exists in the engine. The next TaskTick dispatches the new head
(746591-746594). `IncreaseBuildCountInQueue` (1257188-1257270 ->
ISSUE_IncreaseCommandCount 1351002-1351150) issues one FRESH BuildFactory
command per requested unit through ISSUE_Command (1351091-1351112),
appended at the back of the queue -- no count is bumped, so an increase on
an earlier stack shows up at the end (merged into the last stack when the
blueprint matches). Stop / IssueClearCommands remove the head with the
whole queue (ClearCommandQueue 1005371-1005399) -- the same destructor
path, so the half-built unit is destroyed.

Implemented (build.lua, units.lua, ui-globals.lua, motion.lua):
`__queueFactoryBuild` appends one command per unit; `__factoryQueueGroups`
/ `__factoryQueueDisplay` are the panel's merge (the unit row's
`buildQueue` and the edit index are display stacks); `__adjustFactoryQueue`
walks newest-first, removes commands at 0 and calls `__abortFactoryBuild`
when the removed command is the running task's (by identity), or appends
fresh commands for an increase; `__abortFactoryBuild` is the destructor
path (work progress 0, OnFailedToBuild, OnFailedToBeBuilt, OnStopBuild,
focus dropped); `__abortBuildTasks` routes FactoryBuild tasks through it
(Stop, IssueClearCommands). The completion path is unchanged (the task's
own command, count <= 1 removed, Cfile:838029). `__unitCheckDetach` exempts
a destroy-queued unit: Entity::OnDestroy detaches it at the end of the beat
anyway (916158), and FactoryUnit.BuildingState's DetachAll(bone)
(defaultunits.lua:669) reaches the destroyed site first when the next head
starts in the same beat. `verify-factory` gained 9 checks (four commands
shown as three stacks -- only consecutive commands merge; the newest
command leaves first while the running build continues; increases land at
the back; removing the running head sets FactoryBuildFailed, destroy-queues
the site, zeroes the work progress and drops the task; the site is gone a
beat later; the new head starts on the next tick) and two updated ones
(commands versus stacks; Stop sees three commands). Three went red without
the abort call.

## The factory command list -- the rally point is a command, and the product inherits all of them

The sim modelled a factory's rally point as one stored vector (an invented
`SetRallyPoint`, no engine binding of that name exists) and forwarded a
single Move to each product. The engine keeps a COMMAND LIST on the
factory's builder, and every finished unit inherits the whole list.

The engine (Cfile): a unit in category FACTORY gets a builder whose mBool1
is set (the Unit constructor calls SetBool1(1) only for
IsInCategory("FACTORY"); GetBool1 reads it). Beside the unit's own command
queue -- where the BuildFactory entries live (838000-838062) -- that
builder holds `CAiBuilderImpl::mCommands`. UNIT_IssueFactoryCommand
(1007613-1007700) fills it: per live, untransported unit whose builder
answers GetBool1, the list is emptied first when the clear flag is set
(mBuilder->RemoveAllUnits, 1007672-1007673) and the command appended
(AddUnitToCommand at index -1, 1007674-1007677). The three callers and
their clear flag: the Lua `IssueFactoryRallyPoint` passes 0 (1008356) --
it APPENDS, which is why aibrain.lua:2114-2115 calls
`IssueClearFactoryCommands` first; the engine's own
`CAiBuilderImpl::IssueRallyPoint` passes 1 (751323); the player's
`ISSUE_FactoryCommand` passes the ClearQueue byte of the message, i.e. not
shift (CDecoder::DecodeIssueFactoryCommand 997129-997159).
`IssueClearFactoryCommands` (1008405-1008460) is RemoveAllUnits (vtable
+56) on every unit with a builder; it never touches the unit's own queue.
`GetRallyPoint` (980873-980905) answers the target position
(CAiTarget::GetTargetPosGun) of the list's FIRST command and nil without
one. The unit constructor issues the initial rally point for every FACTORY
builder before OnCreate (950550-950554): the blueprint's
`Economy.InitialRallyX/Z` (struct defaults 0 and 5, RUnitBlueprintEconomy
ctor 656498-656499) as a local offset rotated by the unit's orientation
and added to its position, a factory Move with AITARGET_Ground and the
clear flag (751236-751296). `CAiBuilderImpl::OnTick` (751344-751458, FACTORY
builders only) drops TransportLoadUnits commands whose target is no
FERRYBEACON / TRANSPORTATION / AIRSTAGINGPLATFORM and puts the initial
rally point back whenever the list is empty (751444-751445).
`CFactoryBuildTask::InheritCommandsTo` (818487-818600) runs after the
completed build's OnStopBuild (818844-818966, where RollOffUnit issues its
Move): every command of the list goes into the product's queue in order;
only TransportLoadUnits is skipped for AIR/NAVAL products. The user side:
`CWldSession::GetLeftMouseButtonAction` splits the selection by IsMobile
(sub_81EB20, 1239941-1240011: `!IsMobile() || <flag at +440>` goes to the
factory set) and sends the factory set's command through
`ISSUE_FactoryCommand` (1241182, 1241396-1241420, 1241506-1241534,
1241833) and the rest through ISSUE_Command -- the same command type for
both. `UserUnit::GetCommandQueue` (1367107-1367200) answers the factory
command queue when the unit has one, else the unit's queue: id, type and
position per command; rallypoint.lua:16-36 shows the LAST entry of a
selected structure factory as a WorldMesh marker. The command graph draws
the factory list beside the unit's own queue for an immobile FACTORY
(1245537-1245575).

Implemented (globals.lua, units.lua, build.lua, moho.lua, luaSimWorker.ts,
luaSimClient.ts, worldCommands.ts, world-commands.lua, gameUi.ts,
ui-globals.lua, main.ts): `__factoryCommands[unitId]` with
`__issueFactoryCommand(id, cmd, clear)`, `__clearFactoryCommands`,
`__issueInitialRally` (offset turned by the unit's heading), the builder
tick inside `__factoryTick`, `__inheritFactoryCommands` after OnStopBuild
(TransportLoadUnits skipped for AIR/NAVAL), the bindings
`IssueFactoryRallyPoint` (two-argument check, appends) and
`IssueClearFactoryCommands` (one-argument check), `GetRallyPoint` from the
list head (nil without one; `SetRallyPoint` is gone), the player's factory
commands as the worker message `factoryCommand` (Move/Patrol/Attack/
AttackGround/Guard, clear = not shift) routed by the selection's new
`isMobile` flag in worldCommands.ts (Move, Patrol and Attack on an
immobile FACTORY go into its list), the unit row's `fcmds` (id, type,
position) and `id`/`y` on every synced queue entry, the UI VM's
`__uiSetCommandQueue` behind a real `GetCommandQueue()`, and the rally
polyline in the command graph. `verify-factory` gained 15 checks (initial
rally at pos + 5 forward and turned by a 90-degree yaw, GetRallyPoint,
append, clear and the tick's re-issue, clear+rally in one step, both
arg-count errors, shift queueing versus replacing, the ACU refusal, the
row's fcmds, and the inheritance order Move,Patrol behind the roll-off);
`__spawnUnit` takes the creation heading so the initial rally sees it. The
golden master moved from 1ef2f9abc3d932006c860c4b80a601d9: the factory
row carries `fcmds`, and both tanks now drive to the initial rally point
(x/z/heading/scroll of two rows; the economy unchanged).

Not done / open, with evidence in hand:

- **Guard on an immobile factory** stays a UNIT Guard here (factory assist
  by queue sharing, which the sim's factory tick reads from mGuardedUnit,
  Cfile:838192-838234). By the IsMobile split the retail UI would send it
  as a factory command; how retail reaches the assist path from that (the
  +440 flag in sub_81EB20 is unidentified; UserUnit::GetFactoryCommandQueue2
  is `*(this + 243)`, not +440) is UNRESOLVED -- changing it blind would
  break a verified feature.
- **The NoRush gate** of UNIT_IssueFactoryCommand (1007648-1007655) is not
  modelled: no NoRush timer in this sim.
- **The queue-head abort** is done -- see "The factory queue is one command
  per unit" above.
## The rally marker: WorldMesh (CUIWorldMesh) lives in the UI VM and the renderer draws it

With the real `GetCommandQueue`, gamemain.lua:369 reaches rallypoint.lua on
every selection change, and rallypoint.lua:24 calls `WorldMesh()` for every
selected structure factory -- `InternalCreateWorldMesh` sat in the fail-loud
list, so selecting a factory would have thrown. The whole class is real now.

The engine (Cfile): `moho.world_mesh_methods` carries 16 bindings
(docs/research/engine-api.md:85), UI VM only. CUIWorldMesh is thin
(1295875-1295905): a CScriptObject with ONE mMeshInstance, null until
SetMesh. `InternalCreateWorldMesh(luaobj)` takes exactly one argument
(1296242-1296270). `SetMesh` (1295906-1296230) reads UniformScale (default
1.0), Color (FFFFFFFF), LODCutoff (1000); with MeshName it needs ShaderName
and TextureName (else "MeshName specified, but ShaderName or TextureName
were not specified", 1296058-1296060); otherwise BlueprintID takes the unit
blueprint's Display.MeshBlueprint and Display.UniformScale (1296154-1296180);
neither: "no mesh specified" (1296141). `SetStance(position[, orientation])`
takes two or three arguments (1296432-1296433), copies a Vector3 and an
optional Quaternion and applies them to the instance only (1296492);
`SetLifetimeParameter` (1296838-1296860) writes mLifetimeParameter, `SetColor`
(1296902-1296935) decodes a colour into the instance -- every setter is a
silent no-op before SetMesh (`if ( mMeshInstance )`). The mesh renderer
draws each instance with its technique: RallyPoint (mesh.fx:4873-4894) is
CommandFeedbackVS(0.7) -- the mesh scales from 1.0 to 0.7 over material.y,
the lifetime (:1937-1940) -- with CommandFeedbackPS0(false): the albedo with
its own alpha, no fade (:2435-2439); SrcAlpha/InvSrcAlpha writing RGB, cull
CW, depth disabled, alpha test > 0x23, stage post-water/pre-effect. The
assets: meshes/game/Rally_lod0.scm (32,059 B) and Rally_Albedo.dds
(22,000 B) in gamedata/meshes.scd.

Implemented: `moho.world_mesh_methods` in moho.lua (SetMesh, SetStance,
SetHidden, IsHidden, SetColor, SetScale, the four parameter setters,
GetInterpolatedPosition, Destroy; the four bounding queries fail loudly --
no retail UI file calls them), the registry `__uiWorldMeshes` with
`InternalCreateWorldMesh` and `__uiWorldMeshesJson()` in ui-globals.lua,
`gameUi.connectWorldMeshes` handing the registry over after every beat, and
`src/viewer/worldMeshes.ts` reconciling it against three.js meshes with the
feedback-family material of commandFeedback.ts (whose RallyPoint entry said
scaleTo 1.0 -- mesh.fx:4890 says 0.7; fixed). `verify-ui-panels` gained 17
checks: the registration, the arg-count and type errors, the no-op setters
before SetMesh, the two SetMesh refusals, the descriptor defaults, the
stance/lifetime/visibility in the registry, GetInterpolatedPosition, the
loud bounding query, Destroy, `GetCommandQueue` (id/type/position), and
rallypoint.lua end to end: selecting a factory with a synced queue hangs the
LAST command's mesh on it at that position, the beat moves it, deselecting
clears it. Four of them went red when the stance write was removed. In the
headless page (`?sandbox=SCMP_009&selftest=ueb0101`, SELFTEST-OK): selecting
the factory yields one live world mesh -- Rally_lod0.scm, RallyPoint, scale
0.1, lifetime 10 -- at the factory's initial rally point 5 units forward,
where its two products stand; deselecting drops it to zero.

Not modelled / UNVERIFIED: the distance enlargement of CommandFeedbackVS
(`lodBasis`, mesh.fx:1936 -- the four floats at frame+660, Cfile:1193426,
whose writer was not traced); the visibility default of a fresh mesh
instance (both consumers call SetHidden(false) right after SetMesh); a
shader name outside the feedback family (tutorial.lua:90 'Unit') falls
back to the CommandFeedback parameters.

## Light particles: the flash core of impacts, explosions and build glow

`CreateLightParticle` and `CreateLightParticleIntel` were empty. Every
explosion (defaultexplosions.lua:204), most projectile impacts
(cybranprojectiles.lua:70-71, terranprojectiles.lua:282, the nuke
controllers), the build glow (effectutilities.lua:733/795) and the reclaim
glow (:1218, the Intel variant) call them.

The engine (Cfile): the binding takes exactly seven arguments, resolves the
bone with the pseudo bones admitted and takes its world transform once
(908832-908848) -- a one-shot spawn point that never follows the bone;
size and lifetime are numbers, the two names optional strings
(908871-908909). CEffectManagerImpl::CreateLightParticle (905874-906033)
builds one SWorldParticle at that point with blend mode 3 (ADD), a
constant size (mBeginSize = mEndSize), the raw lifetime, the texture
`/textures/particles/<name>.dds` or beam_white_01.dds without a name, tags
it "TLight" and pushes it into the particle buffer -- all of that only when
a ramp name is given (`if (ramp->_Mysize)`, 905929-906023). The tag selects
particle.fx's TLight_ADD technique: a FLAT quad (WorldVS(false, true),
:1097), additive, depth test off (Depth_Disable_Write_None, :1094), the
ramp sampled with t/lifetime (LightPS, :272-275). The Intel variant spawns
only when the focus army has line of sight on the point (ReconCanDetect2
with RECON8_LOSNow, 909075-909090).

Implemented: `globals.lua` records each spawn (`__lightParticles`,
`__drainLightParticlesJson`), the worker's states message carries them as
`lights`, `luaSimClient.ts` accumulates and drains them, and `main.ts`
puts each into the particle system as one SpawnedParticle of a batch per
texture/ramp pair (blend 3, flat, single frame, depth test off -- the
particle material and batch gained that option). `verify-light-particles`
(16 checks) covers the argument errors, the bone point (-2 the entity, -1
the collision centre), size and lifetime, the texture default, the ramp
gate, the Intel variant and the drain; two mutations (the bone point, the
texture default) went red and the removed ramp gate crashed the suite on
the nil concatenation. In the headless self-test the live page holds three
light batches with particles after the first combat.

Not modelled: the Intel variant's line-of-sight gate -- this sim has no
recon model and the browser draws the whole world, so it spawns
unconditionally (recorded, not faked).
