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

* **The ballistic drop -- now modelled for a LIVE unit** (see "The
  transport" below): `DetachFrom` without `skipBallistic` on a non-flying
  unit puts it into UMS_Ballistic and the Air layer (NotifyDetached,
  Cfile:965830-965848) and `__ballisticStep` (motion.lua) lands it
  (CalcMoveBallistic 970009-970420). A DEAD unit (or one queued for
  deletion) is still released in place, keeping its layer: the factory
  releases a dead site with `DetachAll(bone)` and no `skipBallistic`
  (defaultunits.lua:539-542, FinishBuildThread skips `DetachFrom(true)` for
  a dead site) while its DeathThread runs, and the engine's dead-body path
  (OnImpact + UMS_Crashed, 970344-970356) is not run for it. Likewise the
  children of a destroyed parent are released in place instead of dropping
  (Cfile:966231-966238), and a dying attached unit's own detach in OnDestroy
  (916158) keeps only the state bookkeeping of Unit::DetachFrom, not the
  Ballistic/Air callbacks.
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
AddBuildRestriction/RemoveBuildRestriction, 1016787-1016830) -- DONE below
("The army's build restrictions reach the build menu"); a finished factory
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
(1007889-1007952) -- DONE below ("IssueStop appends"). All four ranked
items of this audit (the factory command list, the queue-head abort, the
army restriction mirror, the soft IssueStop) are done, see below.

**Effects.** The emitter/trail/beam pipeline is real and verified
(CEfxEmitter::Tick port). Missing or dead: `CreateLightParticle`/
`CreateLightParticleIntel` are empty (the flash core of nearly every impact,
nuke and build/reclaim glow -- engine object CEffectManagerImpl::
CreateLightParticle, Cfile:905874-906033: an additive billboard of constant
size whose ramp texture drives colour and alpha over the lifetime, spawned
only when a ramp is given; the Intel variant is gated by the focus army's
line of sight, 909075-909090); `CreateSplat`/`CreateDecal`/
`CreateSplatOnBone` are drawn now (see "Splats and decals" below; the
per-army visibility of CDecalBuffer::CreateHandle is not modelled); the
shield dome and
the personal shield's unit-mesh swap are drawn now (see "The shield dome"
and "The personal shield" below); the IEffect parameters
(`SetEmitterParam`, `SetEmitterCurveParam`, `ResizeEmitterCurve`,
`SetBeamParam`) reach the emitter runtime now (see "The IEffect
parameters" below; the beam ones are carried, not yet drawn).

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

## IssueStop appends; only the Stop button clears

The sim-side `IssueStop(units)` routed to the same full clear as the
player's Stop button (T021 of specs/001 recorded the deviation). The engine
keeps them apart: cfunc_IssueStopL (Cfile:1007889-1007952) takes exactly one
argument (1007926) and sends UNITCOMMAND_Stop through UNIT_IssueCommand
with clear = 0 (1007950) -- APPENDED behind whatever runs; a Stop is accepted
even while Enhancing (1006817-1006819). When it reaches the head the
dispatcher runs IAiCommandDispatchImpl::Stop (DispatchTask 830524/830650;
the decompiled switch labels sit one enum value off, the Stop case is the
one IDA labelled None): CAiAttackerImpl::Stop clears the attacker's desired
target (790323-790330), a running silo build stops (831246-831248),
mRequestRefreshUI is set and the command completes at once (AIRES_1,
831250-831251). The player's Stop is ISSUE_Command(Stop, clear = 1)
(1255059-1255063) -- ClearCommandQueue first -- and IssueClearCommands is
ClearCommandQueue plus the attacker stop (1007874-1007890);
scenarioframework.lua:840/932 pairs IssueStop with IssueClearCommands.

Implemented (globals.lua): `IssueStop` checks its one argument and appends
`{ type = 'Stop' }` with clear = false; `__startOrder` runs the
dispatcher's Stop for it (the attacker target cleared, the order complete
at once); `IssueClearCommands` / `__dispatchStop` stay the clear.
`verify-combat` gained five checks (the Stop queued behind the running
Move, still Moving eight beats later, IssueClearCommands stops it, an idle
unit's Stop dispatches at once and clears the attacker target, the
arg-count error); two went red when the append was turned into a clear.
Not modelled: SiloStopBuild (StopSiloBuild is still a silent no-op in
moho.lua).

## The army's build restrictions reach the build menu

The lobby's restricted units (AddBuildRestriction, siminit.lua:190) were
enforced by the sim only: the build menu still showed a restricted unit and
the factory dropped it from its queue.

The engine (Cfile): the army keeps an ALLOWED set, `army->mVarDat.mCat`,
seeded with ALLUNITS (1017296-1017307); CArmyImpl::AddBuildRestriction cuts
the category's set out of it (BVIntSet::RemoveAllFrom, 1016787-1016793) and
RemoveBuildRestriction adds it back (EntityCategory::Add, 1016818-1016824).
GetUnitCommandData intersects every selected builder's buildable category
with that set before subtracting the unit's own restriction
(1264632-1264646), so a restricted unit never appears in the panel.

Known limit of the sim's deny-list model (globals.lua
`__armyBuildRestrictions`, older than this step): the engine does set
arithmetic on the allowed set, so a RemoveBuildRestriction of a SUPERSET
frees what an overlapping earlier term still denies here, and a term added
as text is only removed by the same text (term identity, not set
membership). Not reachable in play: siminit.lua:187-191, the one production
caller, adds a single pre-unioned category once per army and never removes
it. Recorded, not modelled.

Implemented: the sim serialises each army's deny-list (the complement it
keeps, globals.lua `__armyBuildRestrictions`) as category text
(`__armyRestrictionsJson`, the __categoryToString form); the worker's
states message carries it (`armyRestrictions`), luaSimClient keeps the last
map, main.ts hands it to gameUi.beat, which pushes the whole map every beat
(`__uiSetArmyRestrictions`, so a lifted restriction clears), and the UI
VM's GetUnitCommandData subtracts the army's category before the unit's
(the intersection with the allowed set, expressed on the deny-list).
`verify-ui-panels` gained four checks (FACTORY restricted for army 1 drops
ueb0101 from the ACU's menu while ueb1101 stays; another army's restriction
does not touch it; an empty map puts it back) -- one went red with the
subtraction removed; `verify-restrictions` gained two (the text is
parseable category text after AddBuildRestriction, empty again after
RemoveBuildRestriction).

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

## The shield dome: Entity:SetMesh, the mesh-entity registry and the mesh.fx shield techniques

**What was wrong.** A shield went up in the sim and nothing appeared: the
plain Entity's `SetMesh`, `SetDrawScale` and the four `SetVizTo*` were
no-ops, so shield.lua:263-283 -- which hangs a dome (the shield entity
itself, `SetMesh(MeshBp)`, `SetParentOffset(0, VerticalOffset, 0)`,
`SetDrawScale(Size)`) and a depth shell (`MeshZ = Entity{Owner}`,
`SetMesh(MeshZBp)`, `AttachBoneTo(-1, Owner, -1)`) on the owner -- had no
effect the renderer could see.

**The sim side.** `Entity:SetMesh(name[, keepActor])` is the engine's
(Entity::SetMesh, Cfile:916731-916811: the mesh blueprint is looked up by
its long id; an unknown one warns "Failed to load mesh for blueprint" and
keeps the old mesh; the binding fails with "SetMesh failed with %s" only
when the entity ends up with no mesh at all, :935092-935101; `'<none>'` is
left alone :935080, `''` clears). `SetDrawScale(size)` is the uniform
mScale (:935139-935178). `SetVizToFocusPlayer/Allies/Enemies/Neutrals`
take the VIZMODE enum through SCR_GetEnum with its error text "Invalid enum
value %s\nValid Options are:\n   Always\n   Never\n   Intel\n"
(:598371-598420, values :640586-640600); a fresh Entity starts Always for
all four (ctor :914515-914518), StandardInit turns Enemies to Intel
(:914882-914883); shield.lua:45-48 sets Always/Always/Intel/Intel itself.
Every plain entity that carries a mesh sits in `__meshEntities`
(props.lua): one row per beat with the mesh blueprint's long id, the world
position (attached entities follow their parent through bones.lua), the
heading, the draw scale, the health fraction (PARAM_FRACTIONHEALTH --
ShieldPS tints by it), the army and the four visibility modes. Units and
props are excluded (they have their own channels).

**A bug found on the way.** The registry never pruned destroyed entries:
`__meshEntities[id] = dead and nil or e` is Lua's ternary trap (`x and nil
or e` is always `e`). An energy-stalled shield cycles up and down every
few seconds with a fresh MeshZ per cycle, and the browser session showed
18 dead shells piling up. Explicit if/else now; the shields suite checks
the registry TABLE after RemoveShield, not only the rows (seen red first).

**The mesh blueprints the sim did not have.** LoadBlueprints takes every
.bp under /effects, /env, /meshes, /projectiles, /props and /units
(lua/system/blueprints.lua:330-331). Our boot payload had effects/,
projectiles/, props/ and env/**_prop.bp only, so the 12 `units/**_mesh.bp`
(the ACU's PhaseShield, the personal shields), the 33 `meshes/**` and
`env/devtest/props/sphere01_mesh.bp` were never registered -- "Failed to
load mesh for blueprint /units/uel0001/UEL0001_PhaseShield_mesh" in every
session with an ACU. `simBootPaths`, the worker's `loadBlueprintGroups`
and the suites' `GameFiles.loadProjectiles` now carry them (the unit
blueprints themselves stay on demand, a deliberate narrowing that is
documented at DiskFindFiles); verify-browser-session and verify-shields
check the payload (red before the fix).

**The renderer** (src/viewer/meshEntities.ts, the shaders under
src/viewer/shaders/shield*.glsl). The mesh blueprint's LOD0 is resolved
like a unit's (`resolveMeshBlueprintLod`: MeshName and the texture names
against the blueprint's directory, Albedo/Normals/Specular and the
SecondaryName mesh.fx's secondarySampler reads); the SCM goes in with its
tangent/binormal for the normal-mapped domes; the textures wrap. The
techniques are ported pass by pass from mesh.fx with their vertex-shader
parameters (texture scales and shifts) and render states:

| ShaderName | passes | mesh.fx |
| --- | --- | --- |
| ShieldFill | depth only, no colour, cull CW | :6160-6178 (FlatVS + ShieldFillPS) |
| ShieldUEF | FourUVTexShiftScaleVS(1,3,32,6, ...) + ShieldPS, SrcAlpha/InvSrcAlpha RGBA, cull none | :5965-5984, :1614-1671, :3076-3115 |
| ShieldCybran | two passes, the second NORMAL_OFFSET 0.01 (ShieldPositionNormalOffsetVS), ShieldCybranPS, cull CW | :6010-6038, :1739-1801, :3145-3189 |
| ShieldAeon | ShieldNormalVS (normal-mapped) + ShieldAeonPS, cull CW | :6063-6082, :1673-1737, :3210-3243 |
| ShieldSeraphim | ShieldNormalVS + ShieldSeraphimPS, additive (SrcAlpha/One), cull CW | :6108-6130, :3260-3300 |

Three facts settled while making it show:

- **Rasterizer_Cull_CW is the ordinary back-face cull.** The opaque unit
  techniques use the same state (Unit_HighFidelity :4719, :4739) and show
  their outer faces, and every one of Sphere01_lod0.scm's 960 triangles is
  wound counter-clockwise seen from outside (measured) -- three.js
  FrontSide. The depth shell therefore holds the NEAR hemisphere and the
  dome's far half fails LessEqual behind it, which is the whole point of
  Shield01z (SortOrder 999 before the dome's 1000).
- **The shell and the dome must rasterise bit-identical depth.** With the
  shell on a built-in material (modelViewMatrix on the CPU) and the dome's
  own vertex shader (viewMatrix * modelMatrix on the GPU) the dome's
  LessEqual test lost to the shell's z by rounding and nothing but a few
  rim speckles survived. The shell now uses the dome's vertex shader with
  a constant-zero fragment; both compute `projectionMatrix *
  modelViewMatrix * position`.
- **sqrt() of a negative under ps_2_0 is sqrt(|x|).** ShieldPS rebuilds
  the normal's z as `sqrt(1 - x^2 - y^2)` unguarded; Shield01_Secondary's
  alpha is 255 everywhere (y = 1), so the argument is negative for every
  texel with x != 0. HLSL sqrt() is rsq + rcp on ps_2_0, and rsq "takes the
  absolute value before processing" (D3D9 shader reference, rsq - ps) --
  the port says `sqrt(abs(...))`, where an earlier draft clamped to 0.

**mesh.fx `time` is game ticks, not seconds.** MeshRenderer::Batch gets
sCurGameTick + sDeltaFrame (Cfile:1212805-1212810), ConfigureShader sets
the shader variable to that sum modulo 36000 (:1194898-1194903, flt_F57F08
= 36000 :421818); a MeshInstance's material.x is the tick it was created
on (:1193097, :1191960); the lifetime parameter is raw ticks
(SetLifetimeParameter stores the Lua number as is :1296871, rallypoint.lua
:33 passes 10 -- one second -- and the engine's command feedback blips
store mDuration * 10, :1281923). The shield shaders and the rally marker
(WorldMesh) both ran on a seconds clock before; the rally marker's shrink
took ten seconds instead of one. Both take `meshShaderTime()` now.

**Verified in the browser** (headless, `__cfa.spawn('ueb4301', ...)` with
48 T1 power generators so the shield stays up): both rows arrive, both
meshes draw, the far view shows one translucent dome of radius 22 (scale
44 on the unit sphere) with its rim, the near hemisphere only; the
wireframe probe confirmed the dome rasterises across the whole view when
zoomed in. The unit-side WARN for the ACU's PhaseShield mesh is gone.

**UNVERIFIED / not modelled.**

- The look was not compared side by side with the original renderer: the
  shader math, states, textures and clock are ported from mesh.fx and the
  Cfile, the glow feed is the frame alpha the bloom chain already reads,
  but "the same picture" is a claim only a reference capture could settle.
- Only the MedFidelity techniques are ported; the fidelity option
  (:1376670-1376690) selecting Low/High variants is not.
- Plain entities have no army in the spec here (`Entity { Owner }` gives
  the shell army -1, drawn as neutral = Always); Intel is drawn like
  Always (no recon gating for mesh entities yet).
- The personal-shield unit-mesh swap (SetMesh(mesh, true) keepActor on a
  unit) is still the next branch.

## Every engine shader clock counts game ticks -- not only mesh.fx

**What was wrong.** After the shield dome settled that mesh.fx `time` is
sCurGameTick + sDeltaFrame (see above), the other ported shaders turned
out to run on seconds: the build techniques' `unitAge`/`time` (UEF grid,
Cybran/Aeon/Seraphim overlays -- mesh.fx material.x is `time - creation
tick`), the wreck's `creationTime` (WreckagePS shifts the specular lookup
by frac(0.01 * material.x), mesh.fx:2344-2345 -- a per-instance offset
that depends on the tick), the prop sway (mesh.fx `time`), the terrain
glow scroll and the water wave layers. Every one of them animated ten
times too slowly, and the wreck offset was a different number.

**The evidence.** terrain.fx `Time` is set to `(float)tick + delta` in
MediumFidelityTerrain::Func3 (Cfile:1220731-1220732; :1217856-1217857 and
:1223673-1223674 are the other fidelity paths), water2.fx `Time` the same
way in the water renderers (sub_80FC80 :1228809-1228810,
HighFidelityWater::Func3 :1229395-1229396); the viewport render loads
sCurGameTick and sDeltaFrame right before it calls them (:1212790-1212800).
sky.fx:160 already counted ticks in this repo.

**The fix.** The viewer owns one shader clock (`setShaderTime`, ticks):
the session feeds `meshShaderTime()` per frame; the tools without a sim
run real time x 10. Terrain, water, props, sky, the build materials and
the wreck creation tick take it. Only the command feedback blips keep a
seconds clock: their shader divides `time - material.x` by
`mLifetimeParameter = mDuration * 10` (:1281923), a unit-free ratio.

**UNVERIFIED.** No suite measures animation speed; the change is a unit
conversion checked by reading, plus a headless session showing the
shaders still compile and draw.

## The personal shield: Unit:SetMesh swaps the owner's mesh, the renderer follows the row

**What was wrong.** UnitShield (shield.lua:420-494) does not hang a dome
on its owner; it swaps the OWNER's mesh: CreateShieldMesh :476-479
`Owner:SetMesh(OwnerShieldMesh, true)`, RemoveShield :481-484 back to
`Display.MeshBlueprint`. The sim already did that (Entity:SetMesh sets
`__meshBp`), and the ACU's PhaseShield mesh blueprint registers since the
dome commit -- but no row told the renderer, and the renderer had no
notion of a unit changing its mesh: a shielded Obsidian looked like an
unshielded one.

**The sim side.** The unit row carries `mesh` whenever `__meshBp` is not
the blueprint's `Display.MeshBlueprint` (units.lua swappedMesh) -- the
swapped-in blueprint's long id, or `''` for no mesh at all (Entity::
SetMesh(''), mMesh = 0, Cfile:916809-916812). Absent otherwise: the row
stays small and the golden master unmoved for every unit that never
swaps. The build mesh (unit.lua:1607 `SetMesh(BuildMeshBlueprint, true)`)
reports the same way; the renderer's construction-site path is still the
fraction-driven one and takes precedence while the site is unfinished.

**The renderer** (main.ts applySwap/undoSwap, unitMaterial.ts
createPhaseShieldOverlay, shaders phaseShield.vert/frag.glsl). A row with
`mesh` loads that blueprint's LOD0 like a unit's (resolveMeshBlueprintLod:
SCM, albedo/normals/specteam, LookupName, SecondaryName; the lookups
wrap), rebuilds the body material with the technique's P0 and, for
PhaseShield and SeraphimPersonalShield, adds the shell pass P1:

- **keepActor.** shield.lua passes `true`; Unit::SetMesh then skips the
  actor rebuild (Cfile:954635-954717; the binding negates the flag,
  :935091) -- the animator and its bone palette stay, the new LOD0 is
  skinned against them. A model with another bone count cannot ride that
  palette; keepActor=false's rebuild is not modelled (the body keeps its
  geometry, the material still changes, logged).
- **P0 is the ordinary body pass.** PhaseShield's NormalMappedPS(true,
  true,true,false,0,0) is Unit_HighFidelity's (mesh.fx:4721-4722 vs
  :5821-5822), SeraphimPersonalShield's UnitFalloffPS(true) is
  Seraphim_HighFidelity's (:5230-5231 vs :5856-5857): the existing 'Unit'
  and 'Seraphim' materials, built by the viewer as addUnit builds them.
- **P1 is the shell.** PositionNormalOffsetVS(0.05) (:1473-1511: the
  vertex pushed along its normal by normalOffset / bone scale before the
  bone transform) + PhaseShieldPS (:3348-3369) / SeraphimPhaseShieldPS
  (:3371-3392, the same arithmetic on secondarySampler): three samples of
  one lookup at three scales, scrolled by the age (material.x = time -
  creation tick, game ticks), electricity and pulse, no light, no team
  colour. AlphaBlend_SrcAlpha_InvSrcAlpha_Write_RGBA, Rasterizer_Cull_CW
  (FrontSide), no DepthState in the pass (device default: test LessEqual,
  write). Draw scale = Display.UniformScale stands in for the bone scale.
- The row dropping `mesh` (RemoveShield) restores the blueprint material
  and geometry and removes the shell.

**Checks** (verify-shields.ts, the ACU's own enhancement block
uel0001_unit.bp:527-545 through CreatePersonalShield as uel0001_script.lua
:311-315 does it): the fresh unit carries its Display.MeshBlueprint and
the row omits `mesh`; the shield up swaps `__meshBp` to the lowercased
OwnerShieldMesh and the row carries it; the mesh blueprint names
PhaseShield; 30000 damage drops the shield, the mesh and the row field go
back; `SetMesh('')` reaches the row as `''`. Seen red (the row field)
before the writer existed. Headless: an Obsidian (ual0202, innate
personal shield, StartOn) shows the blue shell over its body, the DEV
bridge reports the swap applied with the shell.

**UNVERIFIED / not modelled.**

- The look was not compared side by side with the original renderer; the
  shell's depth write is the device default by reading (no DepthState in
  the pass), not measured.
- material.x for the swapped mesh is the tick the swap was seen; whether
  the engine creates a fresh MeshInstance at SetMesh (creation tick = swap
  tick) or keeps the entity's is not traced -- a phase offset of the
  shell's scroll either way.
- keepActor=false (a swap that rebuilds the actor from the new skeleton,
  Cfile:954635-954717) is not modelled. shield.lua always passes true;
  unit.lua:1616-1623 (StopBeingBuiltEffects with Display.TerrainMeshes)
  calls SetMesh WITHOUT it -- that swap is followed like any other once
  the site is complete, the actor rebuild is not.
- The shell's normal offset divides by the bone scale (transPalette.w);
  the port divides by Display.UniformScale, the scale the actor's pose is
  built with (Cfile:954667). A per-bone scale in an animation is not
  honoured; whether any unit has one is UNVERIFIED.
- The construction site is still the fraction-driven build path; the 1:1
  way (the build mesh arriving as a swap like any other) is a later step.

## Splats and decals: CreateSplat / CreateDecal / CreateSplatOnBone reach the ground

**What was wrong.** The three bindings existed in globals.lua but rode the
emitter list as a "fixed ground effect" with the texture name in the
emitter's blueprint slot: no particle blueprint of that name, so the tread
marks, scorch splats, craters and tarmacs of the original Lua
(unit.lua:2325/2649, defaultexplosions.lua:211-219, defaultunits.lua:135-
150, the nuke scripts) were never drawn; sizeZ, the type, the second
texture, the lodParam and the fidelity were dropped on the way.

**The sim side** (globals.lua, the decal block). The bindings parse as
cfunc_CreateSplatL (Cfile:908309-908450: 8-9 arguments, fidelity 1 when
absent, texName2 and type '', isSplat), cfunc_CreateDecalL (908117-
908283: 9-11, fidelity 1 when nil) and cfunc_CreateSplatOnBoneL
(908478-908610: exactly 9 -- entity, offset, bone, ... -- the mHelp at
908465 has the first two the other way round, the parser and
unit.lua:2648 agree; fidelity 1). CDecal::CDecal (907293-907423) is the
record: the expiry tick is the truncated duration * 10 plus the current
tick (frndint corrected down when it rounded up, 907344-907360; 0 = never)
and the stored position is the footprint's CORNER -- the Lua position
minus half the size along the transform's x and z axes (907380-907400) --
because the render side spans the quad from that corner (ComputeCorner
1335287-1335306) and reads the heading back as mRot.y = -yaw
(907398-907400). The texture name resolves as CDecalManager::AddDecals
does it (1305895-1305930): an absolute path (a leading separator, UNC, a
drive letter) stays, a bare name becomes /env/common/splats/<name>.dds
resp. /env/common/decals/<name>.dds. Only CreateDecal returns a handle
(908270-908280; the two splat bindings return nothing, 908425-908460 and
908610-908637), and it has one method, Destroy (luadef_CDecalHandleDestroy
908048; cfunc_CDecalHandleDestroyL 908061-908075 removes it from the
buffer); the sweep destroys expired handles
with the tick (CDecalBuffer 1112362-1112600, __decalSweep from
threads.lua). The beat's adds and the destroyed ids go to the renderer as
two drained channels (AddDecals / RemoveDecals with the sync,
1327849-1327850); an expiry sends nothing, the renderer knows the tick.

**The renderer** (src/viewer/runtimeDecals.ts, shaders splat.vert/frag,
decalGlow.frag, decal.vert/frag and decalNormals.frag extended):

- A SPLAT is a CWldSplat: one quad whose corners are position + u * (sx
  cos a, sx sin a) + v * (-sz sin a, sz cos a) with a = -heading, each
  corner's Y from the heightfield (UpdateVertices 1335570-1335625; the
  engine re-reads them per frame, this heightfield does not deform),
  UVs (0,0) (1,0) (1,1) (0,1) (UpdateBatchTexture 1335626-1335661), drawn
  with terrain.fx TSplats (:1436-1447; SplatsVS/PS :1372-1434: the albedo
  lit on the screen-space normal buffer like a decal, alpha = albedo.w *
  mAlpha, SrcAlpha/InvSrcAlpha on RGB, depth LessEqual without write, cull
  none with a small negative bias). The engine packs every splat texture
  into one atlas and draws one call (sub_802830 1219271-1219322); here one
  non-indexed batch per texture.
- A DECAL is a CWldTerrainDecal like the map's own: the mapDecals.ts
  patch (the inverse DecalMatrix on the heightmap) as an instanced batch
  per (type, textures) with a per-instance fade and cutoff. Types drawn:
  Albedo (TDecals), Normals and Alpha Normals (TDecalsNormals /
  TDecalsNormalsAlpha -- DecalsNormalsPS ignores its alphablend flag,
  :1108-1129), Glow (TDecalsGlow :1286-1298: glow = albedo.a, mask =
  tex2.x * 0.25, AlphaBlend_One_One_Write_A -- added into the frame ALPHA
  the bloom reads; an unbound mask reads (0,0,0,1), so a Glow decal
  without a second texture adds nothing, which the tarmacs' Glow entries
  pass), AlbedoXP (TDecalsXP). Water Mask/Albedo/Normals and Glow Mask are
  counted, not drawn (LookupDecalType 1334911-1334927, sTypeDesc
  1966195-1966229).
- Alpha = GetLODAlpha (1335082-1335114: a linear fade from cutoff *
  ren_DecalFadeFraction 0.5 to cutoff, :421725) x mCurAlpha. The cutoff is
  the lodParam, or ComputeCutoffLOD's diagonal x 15 for a splat, Water
  Albedo and Glow Mask and x 6 for every other type when it is 0
  (1335313-1335329; every shipped caller passes a lodParam). The static
  map decals take the same fade now instead of a hard cut.
  mCurAlpha starts at 1; once the tick passes mRemoveTick -- the expiry
  tick, or 1 after Destroy (RemoveDecals 1306039-1306058) -- ProcessRemovals
  (1306063-1306135) steps it down per tick, 0.2 for a decal and 0.03 for a
  splat, and the object goes at 0.

**Checks** (scripts/verify-decals.ts, new): the original CreateTarmac on a
spawned T1 power generator (aibrain.lua:459 calls it so; ueb1101_unit.bp
:71-87) queues an Albedo and an Alpha Normals decal with the resolved
paths (the files exist), 6.4 x 6.4, lodParam 150, permanent, one of the
block's four orientations, the corner plus half the rotated size on the
unit; DestroyTarmac queues both removals; CreateSplat / CreateDecal /
CreateSplatOnBone argument parsing, the absolute path, the default
fidelity, the truncated expiry (2.06 s -> 20 ticks), the argument-count
errors, Destroy once, the sweep, no emitter row. Seen red before the
registry existed. Headless: a tarmac centred under the generator, a
tread mark and a scorch splat on the ground (screenshots in the session).

**Found on the way.** A 32-bit index buffer drew nothing in the headless
WebGL context while a 16-bit one did; the splat batches are non-indexed
triangle soups now (six vertices a quad). Whether that is the context or
the renderer is UNVERIFIED -- nothing else in the renderer indexes beyond
16 bits.

**UNVERIFIED / not modelled.**

- The per-army visibility (CDecalBuffer::CreateHandle 1112277-1112325:
  allies see a splat, a decal follows line of sight; the per-tick LOS
  re-check in sub_779710) -- everything is drawn.
- The rotation sign convention comes from mRot.y = -yaw (907392-907395)
  and the corner math; a mirrored texture would be the symptom. Not
  compared with the original picture.
- The D3D DepthBias of the splat states (-0.001, low fidelity -0.02) to
  polygonOffset mapping; the decal's offset is used for both.
- GetLODAlpha's distance: the shaders take the per-fragment distance to
  the camera; the engine feeds a per-object value from the footprint's
  extents centre (1220780-1220811) -- a large decal could show a gradient
  the original does not.
- Fidelity: the High/Medium techniques; LowFidelitySplat (unlit) is not.
- A handle destroyed while its textures still load is placed already
  fading (the engine's object exists from the sync on); the frame or two
  of difference are the asynchronous load's.

## The IEffect parameters: SetEmitterParam, SetEmitterCurveParam, ResizeEmitterCurve, SetBeamParam

**What was wrong.** The emitter object took `SetEmitterParam` and
`SetEmitterCurveParam` into a private table nothing read, and had no
`SetBeamParam` or `ResizeEmitterCurve` at all. The shipped Lua uses them:
defaultexplosions.lua:341-342 randomises a fire plume's REPEATTIME and
LIFETIME per spawn, effectutilities.lua:516 and unit.lua:2603 lift the
Aeon build beam and the air contrails with `SetEmitterParam('POSITION_Z',
...)` -- which in the engine is the very slot `OffsetEmitter` accumulates
on, so those effects sat at Z 0 here -- and effectutilities.lua:355-356
spreads the Aeon "being built" ripple over the footprint with
`SetEmitterCurveParam`.

**The engine.** All six methods are `IEffect`'s (sim only). SetEmitterParam
and SetBeamParam share one body (Cfile:907419-907472): the name is
resolved case-insensitively (sub_8D9FD0, 1382386-1382398) against
EEmitterParam (1105690-1105787: POSITION/_X/_Y/_Z, TICKCOUNT, LIFETIME,
REPEATTIME, TICKINCREMENT, BLENDMODE, FRAMECOUNT, USE_LOCAL_VELOCITY,
USE_LOCAL_ACCELERATION, USE_GRAVITY, ALIGN_ROTATION, INTERPOLATE_EMISSION,
TEXTURE_STRIPCOUNT, ALIGN_TO_BONE, SORTORDER, FLAT, SCALE, LODCUTOFF,
EMITIFVISIBLE, CATCHUPEMIT, CREATEIFVISIBLE, SNAPTOWATERLINE,
ONLYEMITONWATER, PARTICLERESISTANCE) resp. EBeamParam (1105815-1105895),
an unknown one is "Invalid Effect Parameter %s", and the value goes to
mParams[index] (SetFloatParam 889215-889221); three arguments
(907507-907520 / 907556-907570). ScaleEmitter is SetFloatParam(18 = SCALE)
(907605-907643); OffsetEmitter reads the three POSITION slots, adds and
writes them back (907918-907968). SetEmitterCurveParam(name, height,
size) resolves EEmitterCurve (1105583-1105689) and installs a fresh curve
with the single key {0, height, size} (907794-907909, sub_5151B0
649144-649194) -- SEfxCurve::GetValue (649014-649062) then returns height
+/- size/2 for every sample. ResizeEmitterCurve(name, ticks) copies the
current curve and scales its key times by ticks over the old range
(907678-907770, sub_515090 649104-649136). Only SetBeamParam and
ResizeEmitterCurve have no caller in the shipped Lua.

**The port.** globals.lua: the three name tables, the aliases resolving to
their slot (POSITION -> POSITION_X, STARTCOLOR -> STARTCOLOR_R), the
engine's argument counts and error texts; POSITION_X/Y/Z write the
`__offset` slots OffsetEmitter accumulates on and SCALE the `__scale` slot
ScaleEmitter writes -- the slots the renderer already read; every other
parameter lands in `__params` by its canonical name, the curves in
`__curves` by the blueprint field they replace (XDIR_CURVE ->
XDirectionCurve, BEGINSIZE_CURVE -> StartSizeCurve, ROTATION_CURVE ->
InitialRotationCurve, ...), ResizeEmitterCurve reading the source curve
from the override or the registered emitter blueprint. The emitter row
carries `params`, `curves` and `beam` when set; the renderer builds the
EmitterRuntime from the blueprint with those applied
(src/effects/emitterOverrides.ts: LIFETIME, REPEATTIME, FRAMECOUNT,
TEXTURE_STRIPCOUNT, BLENDMODE and the seven flags onto their fields, a
flag tested > 0 like the engine, Cfile:894849; the curves as key lists)
and rebuilds it should the overrides change.

**Checks** (verify-sim-entities.ts, new block): a fire plume emitter on an
ACU with the defaultexplosions calls, POSITION_Z plus OffsetEmitter (oz
0.55), ScaleEmitter and SetEmitterParam('SCALE') on one slot, the
single-key curve, ResizeEmitterCurve doubling the blueprint's EmitRateCurve
key times (XRange 20 -> 40), the unknown-name and argument-count errors,
case-insensitive names, SetBeamParam on a beam effect. Seen red first
(ResizeEmitterCurve was nil). verify-emitter-runtime.ts: the overrides on
the runtime -- LIFETIME/REPEATTIME on their fields, a flag at -1 off and
at 2 on, an unknown name left alone, the replaced curve's shape, an
emitter with LIFETIME 12 spawning for 12 ticks (the flag check seen red
while the port still tested != 0).

**UNVERIFIED / not modelled.**

- The beam parameters (THICKNESS, the colours, the UV shifts, LENGTH,
  LIFETIME) reach the row and stop there: which render-side code reads
  them off mParams to build the beam quad is not traced
  (CEfxBeam::Update 889527-889626 uses only the positions and LENGTH); no
  shipped Lua calls SetBeamParam.
- TICKCOUNT, TICKINCREMENT, ALIGN_ROTATION, SORTORDER, LODCUTOFF,
  EMITIFVISIBLE, CATCHUPEMIT, CREATEIFVISIBLE, SNAPTOWATERLINE and
  ONLYEMITONWATER have no reader in the runtime (the features behind
  them are not modelled); no shipped Lua sets them.
- A parameter change after the emitter's first frame rebuilds the runtime
  and so resets its tick counter; the engine changes one slot in place.
  The shipped Lua sets its parameters in the creating tick.
- The curve header's x start is taken as 0 for the resize ratio (the
  blueprint XRange as the old range); the header layout (sub_514FF0) is
  read, not decoded field by field. Resizing a curve without a range
  (the single key SetEmitterCurveParam installs) is refused with an error
  where the engine would write infinite key times.
- The particle BATCH is built once per blueprint id from the blueprint
  (blend mode, frame count, flat, drag shading): an override of
  BLENDMODE, FRAMECOUNT, FLAT or PARTICLERESISTANCE changes the runtime's
  kinematics, not the drawn batch. No shipped Lua sets those four.
- The beam parameters do not enter the runtime's override signature
  (nothing reads them yet).

## The Sim's Issue* family: Patrol, Attack, AggressiveMove, Repair, Reclaim, MoveOffFactory

**What was wrong.** Of the 38 Issue* bindings the Sim registers, seven
existed (Move, Guard, Stop, Upgrade, ClearCommands, FactoryRallyPoint,
ClearFactoryCommands). The AI and the scenario scripts call others on
every path: platoon.lua:2519 `IssueAttack`, scenarioframework.lua:579
`IssueAggressiveMove` (attack chains) and its patrol routes,
ai/aiutilities.lua:1738 `IssueRepair` and :1717 `IssueReclaim`, the T3
air factories' scripts `IssueMoveOffFactory` (uaa0310_script.lua:114) --
each a strict-_G error that killed the calling thread.

**The engine** (one shape for all of them). The unit list
(func_GetUnitList), the target through CAiTarget::SetTarget
(Cfile:1006044-1006110: an entity or a Vec3, else "Invalid target set in
%s; expected an entity or a Vec3 but got a %s"), the units filtered by
func_Validate_IssueCommand (1005910-1005945: the rule must be in the
unit's command caps; for Move/Guard/Patrol/Ferry a unit with a factory
builder stays only when IsMobile), one SSTICommandIssueData(UNITCOMMAND_x)
through UNIT_IssueCommand with clear = 0 -- appended, never a clear. The
point bindings refuse an unusable target with "%s: Passed in an invalid
target point." (1010153-1010154, 1010444-1010445, 1008696-1008697); the
entity bindings take the target through SCR_FromLua_Entity. Attack,
AggressiveMove and MoveOffFactory push the command handle, the others
return nothing -- and nil when no unit passed the validation
(1009261). An AggressiveMove is dispatched as a CUnitPatrolTask to
the one point (DispatchTask 831100-831104, physically under the label
OverCharge: the switch's labels sit one value off, docs/research/
command-dispatch-binary.md:49-62): it engages on the way like a patrol
leg and completes at the point without the ring rotation.
IssueMoveOffFactory is a Move with a flag on the command (1008727) whose
consumer is not traced (carried as rollOff). IssueRepair and IssueReclaim
run EntitySetTemplate_Unit::Contains (804956-804980) with the target on
the issuers -- it removes the match, so a unit never repairs or reclaims
itself. CAiTarget::SetTarget takes nil as no target (no error), an entity,
or a table of exactly three numbers as the Vec3 (lua_getn == 3, 1006082);
anything else is its "Invalid target set" error (1006087).

**The port** (globals.lua after the dispatch functions): the six
bindings, the validation on the unit's own cap mask (`__ensureCommandCapMask`)
with the factory-builder exception, the target parsing, the errors; the
`AggressiveMove` order type rides the Patrol branches of `__startOrder`
and `__ordersTick` (speed-through, engage on the way, complete in the
goal cell) and stays out of the rotation; the unit row resolves its
waypoint like a Move.

**Checks** (verify-combat.ts, new block): a Patrol leg appended with no
return value; an Attack on a unit and a Vec3 ground attack queued behind
it, the handle not done while waiting; an AggressiveMove leg; a Move
flagged as the roll-off; Repair on a unit without the cap and Patrol on a
factory queue nothing, IssueAttack on a factory returns nil; Repair then
Reclaim in an engineer's queue, the engineer as its own target queues
nothing; the argument-count, SetTarget, invalid-point and game-object
errors; an aggressive move that runs to its point and completes, and one
that engages the enemy beside its route. Seen red first (IssuePatrol was
a strict-_G miss). The command graph draws an AggressiveMove in the
attack colours with its own waypoint (commandgraphparams.lua:54-58).

**Still missing** (each a strict-_G error when called; shipped callers in
brackets; IssueTransportLoad and IssueTransportUnload have since arrived --
"The transport" below): IssueFactoryAssist [aibrain.lua:2076], IssueScript [platoon.lua:293],
IssueTactical [platoon.lua:382], IssueNuke [platoon.lua:417],
IssueTeleport [aibehaviors.lua:59], IssueFormAttack [platoon.lua:2517],
IssueFormPatrol [scenarioframework.lua:572]; without a shipped caller:
IssueBuildFactory, IssueBuildMobile, IssueDestroySelf, IssueFerry,
IssueFormAggressiveMove, IssueFormMove, IssueKillSelf, IssuePause,
IssueSacrifice, IssueSiloBuildNuke, IssueSiloBuildTactical,
IssueTeleportToBeacon, IssueTransportUnloadSpecific. The dive,
overcharge, silo and teleport TASKS behind the first group are not
modelled in the sim, which is why the bindings stay absent rather than
queueing orders that nothing runs. IssueCapture, IssueOverCharge and
IssueDive and their mechanics are ported since ("The capture", "The
overcharge", "The dive" below).

**UNVERIFIED.** IsValid_Vector3f's exact test (here: present and not
NaN); the roll-off flag's consumer; the AggressiveMove line texture
(orderline_arrow04) like Patrol's.

## The transport: CAiTransportImpl, the load/call/unload tasks, IssueTransportLoad and IssueTransportUnload

**What was wrong.** A transport could carry nothing: no unit had a
transport component, `IssueTransportLoad` / `IssueTransportUnload` were
strict-_G misses (ai/aiutilities.lua:1453/1499, platoon.lua:2462,
scenarioframework.lua:1259), `GetCargo`, `TransportHasSpaceFor`,
`TransportHasAvailableStorage`, `TransportDetachAllUnits` and
`AddUnitToStorage` were silent no-ops, a right-click of a tank on a
transport (or of a transport on a tank) was "not wired to the sim yet",
`DetachFrom` on a live non-flying unit was refused with an error, a flyer
moved at its ground `Physics.MaxSpeed` (0.5 for uea0107), and the
uea0107's own script died in OnStopBeingBuilt on
`CreateThrustController(self, "thruster", bone)` (two arguments taken,
three passed) and `SetThrustingParam` (absent).

**The engine** (all Cfile). A unit owns a `CAiTransportImpl` when
RULEUCC_Transport is in its command caps or it is a PODSTAGINGPLATFORM
(Unit ctor 950494-950512). `SetUpAttachPoints` (801771-801976) sorts the
skeleton's bones by name substring -- "Launchpoint", "Attachpoint_Spr" (class
4), "Attachpoint_Lrg" (3), "Attachpoint_Med" (2), a plain "Attachpoint" (1),
"AttachSpecial" -- into per-class lists, a class going to the generic list
once the blueprint's `Transport.ClassGenericUpTo` reaches it (default 0,
655688); uea0107 has 6 small, 2 medium and 1 large point. A passenger of
class n takes `ClassNAttachSize` points of the hook list nearest to its
class point (GetClosestAttachPointsTo 801983-802083, TransportFindAttachList
803468-803522, TransportHasSpaceFor 803523-803605, TransportAssignSlot
803606-803718, the reservation ReserveBone 802115-802156);
`TransportCanCarryUnit` (803349-803428) refuses an immobile or flying unit,
a commander without CANTRANSPORTCOMMANDER, and a class without enough
points. The pickup: `TransportAddPickupUnits` (803050-803151) stores the
point, the facing and the waiting list; `TransportGetPickupUnitPos`
(803295-803342) doubles the reserved bone's rest offset around it;
`TransportGetAttachPosition` (804107-804162) is the cell under the live
bone; `TransportIsReadyForUnit` (804101-804105) needs mHasSpace, set by
`TransportAtPickupPosition` (804095-804099). `TransportAttachUnit`
(803719-803744) attaches through Entity::AttachTo with the reserved bone and
the passenger's "AttachPoint" bone (GetBestAttachPoint 802157-802180: bone 0
for a flyer, the collision centre otherwise), sets mTransportedBy and runs
`OnTransportAttach(boneName, unit)`; `TransportDetachUnit` (803748-803863)
refuses under an airborne transport when the footprint does not fit,
detaches WITHOUT skipBallistic, releases the reservation and runs
`OnTransportDetach`; `TransportDetachAllUnits` (803868-804094) kills each
passenger with 99 % when asked to destroy some (a commander that cannot be
killed takes 10000 damage), stored units die with the transport.

The commands: `IssueTransportLoad` (1011850-1011985) refuses an attached or
carried unit ("One or more units are already attached to something.") and
an empty list ("Couldn't find any units to load."), adds the transport to
the set and issues ONE UNITCOMMAND_TransportLoadUnits targeting the
transport, clear = 0, no handle; `IssueTransportUnload` (1012005-1012090)
validates RULEUCC_Transport and issues TransportUnloadUnits with the
target's position. The user side: the default right-click is CallTransport
when the selection can be carried and `func_RightClickWithTransport`
(1238669-1238853) accepts the hovered transport, or Transport when the
hovered unit carries RULEUCC_CallTransport and `func_RightClickTransport`
(1238854-1239027) accepts it -- both before Repair and Guard
(GetRightMouseButtonAction 1240291-1240304); the CallTransport click adds
the transport to the set (HandleEvent 1241826-1241836); the Transport click
on a unit issues TransportReverseLoadUnits (1241600-1241617), which
UNIT_IssueCommand reshapes to the closest transport with space plus the
target (sub_6EF660 1006333-1006500, an idle transport at half its distance);
the Transport click on the ground unloads there (1241640-1241665).
func_ProcessUnitCommand validates each unit (1007144-1007334: the
CallTransport cap, no seabed target, a live finished transport that can
carry it, else "OnTransportReject").

The tasks (DispatchTask 830700-830991, labels one value off):
`CUnitLoadUnits` on the transport (ctor 852325-852382: the TransportLoading
bit and OnStartTransportLoading; TaskTick 852997-853213: the sync gate --
every passenger on the same command -- then the slot assignment, then an
air transport runs OnTransportOrdered and flies a Land-layer move to the
passengers' average position, mHasSpace at the pickup, then the wait for
the pickup count with the 300-tick timeout; dtor 852391-852463:
OnStopTransportLoading, on failure OnTransportAborted and the pickups
released). `CUnitCallTransport` on each passenger (822991-823249: wait for
the transport's TransportLoading and the shared command, the
WaitingForTransport bit, the walk to the staging or attach cell, then
within twice the transport's footprint of the attach bone the beam-up --
OnStartTransportBeamUp, the Teleporting bit, ten ticks of
cos(t*pi*0.1)*0.5+0.5 easing toward the live bone less the unit's SizeY,
OnStopTransportBeamUp, TransportAttachUnit; five retries). `CUnitUnloadUnits`
(ctor 853241-853347: the set filtered to this transport's own cargo, the
TransportUnloading bit, the move aborted; TaskTick 853499-853809: the move
to the point, then TransportDetachAllUnits or TransportDetachUnit per unit;
an air transport leaves the placement to the fall, a ground one warps each
unit to a free cell and orders it to the point). The drop:
`CalcMoveBallistic` (970009-970420) -- gravity * 0.01 per tick on the
velocity, the segment cut with the surface, the landing layer (Land, Water,
Seabed for an amphibious unit), the kill on a blocked footprint, UMS_None
for a live unit, OnImpact + UMS_Crashed for a dead one.

**The port.** `src/engine-lua/transport.lua` (new; loaded by
src/sim/transport.ts after the motion): the component (`__transportOf`),
every function above, the three tasks as per-unit state machines ticked
from `__ordersTick` through the new order types `TransportLoad`,
`TransportReverseLoad` and `TransportUnload` (globals.lua branches;
`__abortActive` / `__dispatchStop` / the destroyed branch run the task
destructors), the bindings, and the user-side dispatch functions
`__dispatchTransportLoad` / `__dispatchTransportReverseLoad` /
`__dispatchTransportUnload`. motion.lua: `__unitOnDetached` starts the
fall, `__ballisticStep` lands it, `__footprintFitsAt` is the occupancy test,
`blockedAt` no longer counts attached units or air units, a flyer's top
speed is `Air.MaxAirspeed` (Unit::UpdateInfoCache 953164-953174).
moho.lua: the five Unit methods with the engine's errors. globals.lua:
`CreateThrustController(unit, label, thrustBone)` (mHelp 881245) and
`ThrustManipulator:SetThrustingParam` (mHelp 881321-881322, nine values).
The UI: world-commands.lua's selection row carries the two caps and the
categories the predicates test; worldCommands.ts has the predicates, the
transport defaults before Repair/Guard and the RULEUCC_Transport /
RULEUCC_CallTransport modes; main.ts describes the hovered own unit for
them; the sim client/worker carry `transportLoad`, `transportReverseLoad`
and `transportUnload`; the command graph draws the three order types in
default_TransportColors (commandgraphparams.lua:93-110).

**Checks** (scripts/verify-transport.ts, new): the attach-point counts of
uea0107, TransportHasSpaceFor for a class-1 tank and a class-3 Titan,
TransportCanCarryUnit for the ACU and an air unit, the errors of GetCargo
and TransportDetachAllUnits on a tank; IssueTransportLoad queueing one
shared command on the transport and both tanks, the TransportLoading bit
and OnStartTransportLoading at once, WaitingForTransport and Teleporting on
the way, OnTransportOrdered, the beam-up callbacks, OnTransportAttach with
the bone names, GetCargo, the Attached bit and mTransportedBy, the
passenger gun disabled (weapon.lua:481), the passengers riding along, the
task's end with OnStopTransportLoading; IssueTransportUnload with the
TransportUnloading bit, both tanks passing UMS_Ballistic and landing in the
Land layer on the terrain near the point with OnTransportDetach and the
motion-state callbacks, the cargo empty, the gun enabled again, an unload on
an empty transport queueing nothing; the argument, empty-list, non-object,
non-target and attached-unit errors; `DetachFrom()` on a live tank accepted
and landed; the reverse load choosing the closer transport, the
CallTransport dispatch adding the transport; the two right-click predicates
on nine constellations; TransportDetachAllUnits(false) releasing both. Seen
red first (the spawn died on SetThrustingParam, then the ballistic and
attach checks under a mutation that skipped UMS_Ballistic).

**Not modelled, recorded rather than faked.**

* **The air motion** was the next branch and is ported since ("The air
  motion" below): a transport flies, lands and hovers on CalcMoveAir.
* **The ogrid of mobile units.** `__footprintFitsAt` counts standing
  structures; whether an idle mobile unit's reservation
  (Unit::ReserveOgridRect) is on the grid when a dropped unit lands is
  UNVERIFIED, so a drop onto standing units is not a kill here, and the
  engine's playable-rect and upright tests of that kill (970325-970331) and
  the tumble of the falling body (970038-970060) are not run. A land unit
  landing on water keeps the Water layer here (the engine's layer test of
  the footprint would kill it).
* **The waiting formation.** `TransportGetUnitsWaitingForPickup` and the
  formation instance (802850-802858, 802871-802949) are empty here: the
  load task re-fetches nothing after the pickup, and the Complete state of
  a staging platform waits on the loaded set only.
* **Ferry, carrier, staging platform, teleporter.** A load whose target is a
  FERRYBEACON, CARRIER, AIRSTAGINGPLATFORM or TELEPORTATION unit, the
  right-click's third transport branch (a hovered FERRYBEACON with a
  selection that may use it, sub_81DA20, 1240310-1240315), and the storage
  side (`AddUnitToStorage`, `TransportAddToStorage` 804308-804345) beyond
  the bookkeeping, have no task here; `IssueTransportUnloadSpecific` stays
  absent.
* **The engine's own random stream.** TransportDetachAllUnits' 99 % roll
  draws from `Random()`, not the engine's MT19937 state.

**UNVERIFIED.** The class-4 case of TransportFindAttachList runs on into the
special case as decompiled (803493-803506) -- ported as decompiled, no
shipped unit has TransportClass 4; the "uses bones" flag of CUnitLoadUnits
(v17, 853082), read as "a bone slot was assigned"; the CUnitCallTransport
destructor's clearing of WaitingForTransport / Teleporting (done here);
whether func_QuatLERP is a spherical or a normalised linear interpolation;
the vtable+44 test of func_RightClickWithTransport (read as "attached", not
carried by the UI row) -- its byte-872 flag is resolved since: the byte is
`mAir.mCanFly` (CUnitMotion::AtTarget tests the same byte at 965902), a
transport target takes a selected unit that cannot fly, a staging platform
one that can (worldCommands.ts) -- and the field test at 1238912 of
func_RightClickTransport (not modelled); the
engine's unstable sort of the attach points (func_SortAttachData) against
the bone-order tie-break here; the mHelp strings of the five Unit methods
(the bare names are used in the argument-count errors).

## The air motion: CalcMoveAir, the PhysBody, the winged and the hover pose, landing and take-off

**What was wrong.** A flyer moved on the ground model -- a named
reduction in motion.lua: it took `Air.MaxAirspeed` at once, turned
freely, kept no altitude (a transport hovered at terrain height), never
banked or pitched, never landed after `Air.AutoLandTime`, and a loaded
transport was not slowed by its cargo. The transport branch above flew
its pickups and drops on that model.

**The engine.** `CUnitMotion::CalcMoveAir` (969188-970006) is the tick
of every unit whose blueprint has `Air.CanFly` (966254-966261). The unit
is a rigid body (the PhysBody: position, orientation, velocity, angular
impulse, mass = AverageDensity * SizeX * SizeY * SizeZ, the inverse
inertia 1 / (InertiaTensor * mass), CUnitMotion ctor 964840-964854; the
box tensor when the .bp leaves it at 0, RUnitBlueprint 647192-647199).
`ComputeAirControl` (968961-969184) turns the desired velocity into a
force -- (desired * KMove - velocity * CalcAirMovementDampingFactor -
gravity) * mass -- and the desired pose into a torque -- angular velocity
* KTurnDamping plus the axis-angle of the pose error * KTurn, scaled by
the inertia into the world frame. The desired pose comes from
`CalcWingedOrientation` (968384-968648: the bank from the turn rate and
BankFactor, the turn clamped to TurnSpeed, the lift of CalcWingedLift
967793-967834) or `CalcHoverOrientation` (968873-968960: the lean into
the relative velocity by BankFactor, scaled by the height reached). The
cruise height is `Physics.Elevation` plus a random offset of +-1
(GetElevation 967776-967791, SimConVar_RandomElevationOffset); the terrain
look-ahead (STIMap::LookAheadForMaxTerrain 859169-859220 over the height
pyramid, GetTierBoundsUWord 525225-525290) lifts the target elevation
before a ridge (969629-969673). Within `Air.StartTurnDistance` of the
target an idle flyer waits `Air.AutoLandTime` from mPreparationTick
(MotionTick 966189-966202: 0 while a command is queued, else the tick of
becoming idle), finds a landing spot (Unit::PrepareMove 857914-858170: a
square footprint on the land cap, water when CANLANDONWATER, the target
cell then a ring search), descends with MovingDown, touches down
(969706-969739: velocity zero, the landing layer, UMS_Down/Top), and takes
off again with the next order (969748-969753, MovingUp). A transport with
cargo hovers at `Air.TransportHoverHeight` instead
(ShouldHoverInsteadOfLand 967749-967775). The body integrates with dt =
0.1 (sub_697B00 940931-940964 for the velocity and position, sub_6978D0
940860-940930 for the angular impulse and the orientation, inlined at
969950-969975); HandleGroundCollision (967589-967745, sub_698350
941347-941440) stops a body that meets the heightfield with a damped
impulse. A dead body keeps the Air layer, UMS_Ballistic and no force
(969888-969949) for one last CalcMoveAir tick; from the next one the
motion tick dispatches on UMS_Ballistic (966250-966253) to
CalcMoveBallistic, which carries the fall from Unit::GetVelocity to the
surface, OnImpact and UMS_Crashed (970106-970115, 970344-970356). The top speed is
`Air.MaxAirspeed` * speedMult / CalcTransportLoadFactor, computed every
tick by Unit::UpdateInfoCache (953100-953198, from Unit::OnTick 952785;
the division 953164-953174). CalcTransportLoadFactor (952480-952513) is a
cache: (cargo mass + own mass) / own mass is computed when the field is
below 0 and kept; the field starts at -1 (949682) and only AttachTo /
DetachFrom of the unit being attached reset it (954392, 954415 -- the
cargo's own field), never a load on the transport's. So a transport's
factor is the 1 of its first tick: **the retail engine does not slow a
loaded transport** (verified-facts.md). The navigator:
CAiNavigatorAir::SetGoal / SetTarget (755918-755958, 755824-755841) hand
the goal and its layer (LAYER_None -> Air, 755838-755841) to
CUnitMotion::SetTarget (965091-965180); AbortMove (756062-756096) stops a
flyer at Unit::PredictAheadBomb(1.0) (858914-858975: the per-tick velocity
followed for ten steps, turned each step by the yaw of the angular
impulse's y * 0.1) through CUnitMotion::Stop (965024-965077); Dispatch
(756132-756236) ends the goal when AtTarget (965877-965925: within 0.25,
or a quarter of the top speed when always at top speed; not a quarter
for a winged unit; a hovering or a parked flyer counts).

**The port.** `src/engine-lua/air.lua` (new; src/sim/motion.ts evals it
after motion.lua): the body from the blueprint (`__airInit`), the
controller, both orientations, the lift, the damping factor, the
elevation, the look-ahead, the landing spot, both integrators, the
ground collision, and the navigator side `__airSetTarget` / `__airStop`
(the PredictAheadBomb curve) / `__airAtTarget`; `__airStep` is the tick.
The landing spot takes the water cap once from the target and the nearest
fitting cell of a ring (858041-858049, 858230-858256); the load factor is
the engine's cache (`u.__transportLoadFactor`, reset by the cargo's own
attach and detach in motion.lua); a dead body's last air tick hands its
displacement to the ballistic drop (`u.__ballisticDrop`, motion.lua
`__ballisticStep`). motion.lua: the tick's flyer
branch (a crashed body lies still, an Immobile or stunned flyer only
reports Stopped), the navigator's `SetGoal(pos, [layer])`, `AbortMove`
and `SetSpeedThroughGoal` reach the air motion, the ground reduction is
gone. blueprints.lua: the entity body defaults (AverageDensity 0.49,
Size 1, InertiaTensor 0, CollisionOffset 0; REntityBlueprint ctor
646969-646979), every field of the RUnitBlueprintAir ctor
(656086-656129) and the box tensor. engineGlobals.ts: `__terrainMaxTier`,
the height pyramid the look-ahead samples. transport.lua: the load task's
goal carries LAYER_Land (853121; the transport lands or hovers), the
unload re-targets in the Air layer (853603-853611). units.lua /
luaSimClient.ts / main.ts: a flyer's row carries its full pose (`orient`),
the renderer slerps it between beats like the heading. worldCommands.ts:
the byte-872 test of the right-click predicates is `Air.CanFly`.

**Checks** (scripts/verify-air-motion.ts, new, 47 checks): the body of
uea0107 from the blueprint (the ctor defaults, the box inertia, the mass,
the spawn at Elevation +-1, a random offset that a POD (uea0003) does not
draw); a move that arrives at about the blueprint's speed with TopSpeed
and Stopped, in the Air layer, at the cruise height, with the pose as a
unit quaternion in the JSON row; the AutoLandTime landing (MovingDown, UMS_Down, Bottom
and the Land layer, the ground height, zero velocity), the take-off with
the next order (MovingUp, UMS_Up, airborne) and the second arrival; the
winged uea0102 banking into its turn (|up.x| > 0.1), arriving and never
touching the ground; the flight over a ridge of 60 that lifts the target
elevation before the slope and clears it; a loaded uea0107 hovering at
TransportHoverHeight with the Hover event, its load factor the cached 1
of the first tick and above 1 once the cache is reset; the Aeon uaa0107
with its collision offset landing on its point and resting, and its
ground collision called directly on a level, moving, spinning body: the
lever arm's point velocity, the impulse r x (-m vp/2) and the velocity
-vp/2 damped by 0.9, the lift by the penetration; a killed uea0102
losing height with UMS_Ballistic and OnImpact("Terrain") + UMS_Crashed on
the ground; no Lua errors. Seen red first: the winged checks under the
controller's rotation in the wrong frame (the up axis inverted, the jet
went underground), the arrival before the preparation tick followed
MotionTick, the death checks under DestroyNoFallRandomChance = 0
(MobileUnit.OnKilled destroyed the unit in the air), the body checks
without the ctor defaults, the cache check while the factor was
recomputed every call.

**Review corrections** (a fresh agent against the Cfile): the turned
forward of a winged unit keeps the desired direction's y (968576-968579;
it was flattened -- no pitch, no climb-linked bank); the ground
collision lifts the body only for a point that moves down (941421-941442;
it snapped every tick); the landing spot's water cap is decided once from
the target and a ring's nearest fitting cell wins (it took the first);
the load factor is the engine's cache (it was recomputed, which slowed a
loaded transport the retail engine does not slow); the stop point is the
PredictAheadBomb curve (it was a straight second); the height pyramid's
first level is a cell's four corners (it was one sample per cell, so a
ridge sample on an even boundary belonged to the next block only); the
top speed's function is Unit::UpdateInfoCache, not UpdateSpeedThroughStatus
(955372-955449, which only toggles the speed-through flag); the byte-872
test is at 965902; the texture scroller ran twice a tick for a flyer;
the axis-angle helper's w <= -1 value is 8.0 (four * 2.0). Rejected after
reading: the per-tick velocity of the motion events (Entity::GetVelocity
915398-915413 is the displacement per tick; AbortMove multiplies it by 10
for m/s, 756087), the dead branch's force (zero in the engine too,
969912-969916). A second round on the corrections: the stop curve turns
by GetImpulse's world angular velocity (941106-941130), not the raw
angular impulse; the ground collision applies the one point's lever arm
-- its velocity v + w x r, the angular impulse r x (-m v/2)
(941397-941442) -- which the flat version had dropped for a body with a
CollisionOffset (uaa0107: -2); the height pyramid reads the exact corner
sample at the field's far edge (Heightfield.sample), where the bilinear
world query clamps to width - 0.001. Found while checking that: the
dead flyer's crash was read into CalcMoveAir's readback, but the motion
tick dispatches on the state (966203-966262) -- after the dead branch's
UMS_Ballistic the next ticks are CalcMoveBallistic's, the ballistic drop
of motion.lua, which lands the body; the port hands it over.

**Not modelled, recorded rather than faked.**

* **The combat tactics.** ComputeAirCombatTactics (967997-968379) --
  attack runs, break-off, the bomb-drop prediction, the combat turn speed
  -- every flyer flies in ACS_Normal; UNITSTATE MakingAttackRun is never
  set.
* **The circling orientation** (968649-968870) is the hover orientation
  here; the circling parameters of the blueprint are carried, not read.
* **The carrier events** (UMCE_1/2, with the force law near a carrier
  969122-969149) and **formations** (the top-speed clamp of
  Unit::UpdateInfoCache 953176-953196, which bounds the mTopSpeed every
  CUnitMotion read takes): none.
* **The collision geometry.** HandleGroundCollision walks the terrain
  collision points of the mesh with a per-point margin (Elevation + the
  point's w - bp+780, 967704-967709); one point, the entity's position,
  stands for it. A landing spot is not reserved on the ogrid
  (CanReserveOgridRect) and PrepareMove's skirt test is not run; the
  playable-rect clamp of SetTarget is not run; the dead body's random
  tumble (969915-969949) and its rotation during the ballistic fall
  (970056-970060) are not run. CUnitMotion::SetMotionTurnEvent
  (965543-965546) is an empty function in the engine.
* **The random elevation offset** draws from `Random()`, not the engine's
  MT19937 state -- and the port's `Random()` is Lua's `math.random`,
  which Lua 5.4 seeds per process: every run draws a different offset.
  The ridge check of verify-air-motion.ts therefore reads the look-ahead's
  target elevation, not the flown height (which sat within a metre of the
  ridge top and flipped the gate once).

**UNVERIFIED.** mAlwaysUseTopSpeed is set by the steering's
CalcAtTopSpeed (787876-787902); it is read here as "winged, or the
speed-through flag" -- the steering's own condition is not read. The
rotation-vector-to-quaternion helper (func_VecToQuatB, called at
940911-940916, no decompiled body) is ported as the exponential map;
whether the engine approximates for small angles is not read.
HandleGroundCollision's height limit reads bp+172 / bp+180 as SizeY /
SizeZ; the mass factor of the collision's angular impulse is the body's
second float (v2[1], 941423), read as mMass. The numbers of
EAirCombatState beyond ACS_Normal = 0 (964785) are read off the
comparisons (never set here).

## The capture: CUnitCaptureTask, IssueCapture, ChangeUnitArmy and the task requests of the economy

**What was wrong.** `IssueCapture` was a strict-_G miss (platoon.lua:1342,
ai/aiutilities.lua:1719); the UI's Capture order mode and the Guard click
on an enemy issued nothing ("not wired to the sim yet"); `ChangeUnitArmy`
was absent from the Sim (unit.lua:555 OnCaptured -> simutils.lua:97
TransferUnitsOwnership, scenarioframework.lua:224) -- so nothing could ever
change hands; and the economy events (`CreateEconomyEvent`, globals.lua)
called `__econSetBuildRequest` / `__econBuildRate` /
`__econClearBuildRequest`, which nothing defined -- the first event was a
strict-_G error.

**The engine.** `UNITCOMMAND_Capture` becomes a `CUnitCaptureTask`
(AiUnitCapture.cpp; DispatchTask 830696-830697, under the off-by-one case
label). The dispatch constructor (826361-826459) takes the command's target
and makes it the captor's focus entity with OnAssignedFocusEntity. TaskTick
(826579-827099): a target that is gone or not capturable
(UnitAttributes.mCapturable, `SetCapturable`) ends the task with
OnStopCapture (826629-826650); a target without an army, in the Air layer
or allied ends it silently (826651-826690); the distance is the XZ
distance minus both units' larger footprint side (826692-826716); a mobile
target already being captured that is more than 10 away ends it
(826717-826729). Preparing: more than 5 away the captor moves beside the
target's skirt (PrepareMove, ReserveOgridRect, NewMoveTask, 826733-826782).
Waiting: more than 10 away ends it; a blip resolves to its creator; the
target must be a live unit; the build arm is prepared; the captor gets
UNITSTATE Capturing (826784-826849). Starting: the captor's
`GetCaptureCosts(target)` (unit.lua:2734-2743: BuildTime / BuildRate / 2
seconds, BuildCostEnergy, 0 mass) -- three numbers or "Failed to get valid
capture costs from the target" -- gives mCapTime = max(1, time * 10) ticks,
plus the same for every attached unit of the target that is not being
built (826851-826935); the rates are cost / mCapTime per tick, held by a
CEconRequest of the task's own (826936-826950); DoCallback(true) marks the
target BeingCaptured, counts a capturer on it and runs
OnStartBeingCaptured(captor) / OnStartCapture(target) (827160-827175).
Processing: once the request holds a tick's rate of both resources they
are taken (sub_773740) into mResourcesSpent and the progress advances by
the target's capturer count, capped at mCapTime; mWorkProgress is the
fraction (826956-826990). Complete: OnStopCapture(target) on the captor,
OnStopBeingCaptured(captor) and OnCaptured(captor) on the target
(826992-827005). The destructor (827294-827453) releases the focus entity
and the blip, clears Capturing and mWorkProgress, runs DoCallback(false)
-- for a target that is still a live unit not queued for deletion: one
capturer less, BeingCaptured cleared at zero, OnFailedBeingCaptured /
OnFailedCapture (827115-827181) -- and deletes the request. The Guard click
on a unit (sub_613A80, 838839-838905) repairs an ally and captures anyone
else. `ChangeUnitArmy` (cfunc_ChangeUnitArmyL 1089461-1089587) validates
the army (ARMY_FromLuaState: "Invalid army %d"), refuses the unit's own
("Unit already belongs to army %d") and a unit carrying a COMMAND unit
(nil), then `Sim::TransferUnit` (1073702-1074080): nothing for a dead or
deletion-queued unit; the attached live mobile units are detached and
transferred first; a new unit of the same blueprint for the new army at the
same transform and layer, complete, the elevation fixed; the poses shared,
the health and the custom name copied; the passengers re-attached to their
bones (a transport assigns the slot, OnTransportAttach); the old unit
destroyed; a creation the unit cap refuses gives the brain
OnFailedUnitTransfer. A CEconRequest (ctor 847554-847570) carries the
per-tick demand and the grant it has accumulated (mAddWhenSetOff); the
economy grants it like any consumer, the owner takes the accumulation.

**The port.** `src/engine-lua/capture.lua` (new; src/sim/capture.ts after
the transport): the task as a per-captor state machine ticked from
`__ordersTick` through the order type `Capture` (`__captureStart`,
`__captureOrderTick`, `__captureAbort` -- the destructor, also from the
abort and stop paths), `doCallback`. globals.lua: the order type, the
user dispatch `__dispatchCapture`, the binding `IssueCapture`. units.lua:
`__transferUnit` and `ChangeUnitArmy`. economy.ts: the task requests
(`setRequest` / `requestRate` / `requestGranted` / `requestTake` /
`clearRequest`, consumers in the two-ratio split with an accumulating
grant) and the bindings `__econSetBuildRequest`, `__econBuildRate`,
`__econClearBuildRequest` -- the economy events run again --
`__econRequestGranted`, `__econRequestTake`. The UI: the selection row
carries `canCapture` (RULEUCC_Capture); worldCommands.ts issues the
capture for the Capture order mode on an enemy unit and for the Guard
mode on an enemy (sub_613A80); the sim client / worker carry `capture`.

**Checks** (scripts/verify-capture.ts, new, 48 checks): the binding's
arity and target errors, the RULEUCC_Capture filter, the target taken out
of the set, the focus entity and OnAssignedFocusEntity; the walk up to
the target, Capturing / BeingCaptured, one capturer,
OnStartBeingCaptured / OnStartCapture, mCapTime 125 from GetCaptureCosts
(125 / 5 / 2 s), the rates 6 energy and 0 mass per tick, the request
supplied; one step per tick, the energy taken at the rate, mWorkProgress,
the stall without energy and the resumption; the completion with
OnStopCapture / OnStopBeingCaptured / OnCaptured, one new ueb1101 for the
captor's army at the position with the health, the old unit destroyed,
the OnCapturedNewUnit callback, no failed pair, the destructor's clears;
the abort through IssueClearCommands with OnFailedBeingCaptured /
OnFailedCapture, the capturer taken back, the request deleted; a
non-capturable and an allied target refused; ChangeUnitArmy's errors,
the new unit with the custom name and the health, the old destroyed; two
capturers advancing by two per tick and the late task ending on the
vanished target; an economy event reaching 1 over its ticks; no Lua
errors. Seen red first: the abort checks under IssueStop (it queues
behind the running command; the engine's ClearCommandQueue is the
abort), the health copy while a tank of the captor's army shot the
target, the two-capturer block with one engineer still walking, the
stall check under a mutation that ignored the grant.

**Review corrections** (a fresh agent against the Cfile): the preamble's
OnStopCapture passes the captor itself as the argument (826721: &mUnit,
the pointer DoCallback hands the target as "captor"; the Complete state
passes the target, 827077) -- it passed the target; the transfer of
attached passengers runs only for a unit with a transport component
(1073756-1073889) -- it ran for every unit; the occupancy flag of the old
unit (1074031) is not a per-unit flag here (the structure's footprint
goes with its destroy) -- the comment claimed it; the Guard-on-ally
branch of sub_613A80 is a decision on health, shield and focus, not a
plain repair; the port's guard in DoCallback(true) and the MotionType
reading of IsMobile in the transfer are disclosed; the request check of
the suite gained a negative control.

**Not modelled, recorded rather than faked.**

* **The landing spot** beside the target's skirt (PrepareMove,
  ReserveOgridRect, 826745-826776): the navigator goal is the target and
  the ground model stops at its footprint.
* **The build arm** (PrepareArmToBuild 826831-826845, 827355-827362): no
  arm model.
* **Recon blips** as targets (826791-826805): the target is the unit.
* **The AIRES result codes** of the task (AIRES_1 / AIRES_2): the command
  simply ends.
* **The transfer**: the transport's stored units (TransportGetStoredUnits
  1073760-1073817), the shared poses (1073911-1073913), the flyer's full
  pose (the heading is carried), the unit cap (`__spawnUnit` enforces
  none, so OnFailedUnitTransfer never runs), the old unit's occupancy
  flag (1074031: the structure's footprint ends with its destroy).

**UNVERIFIED.** The target's vtable slot 4 read as IsMobile (826717) and
the passengers' IsMobile of the transfer (1073822), both read off the
blueprint's MotionType; the attached unit's slot 10 read as IsBeingBuilt
(826890); the target's field at +332 read as its army (826731); the
SCR_FromLua_Unit and the integer TypeError texts of ChangeUnitArmy.

## The overcharge: the attack task pinned to the OverChargeWeapon, IssueOverCharge, the paused flag in the user layer

**What was wrong.** `IssueOverCharge` was a strict-_G miss
(ai/aibehaviors.lua:147, ai/opai/opbehaviors.lua:96); the UI's Overcharge
button (orders.lua EnterOverchargeMode, RULEUCC_Overcharge) armed a mode
whose click the world handler refused as "not wired to the sim yet"; the
user layer's `IsOverchargePaused` answered false always, so the button
never greyed out during the ACU's pause.

**The engine.** `UNITCOMMAND_OverCharge` is no task of its own:
DispatchTask (831092-831098, under the off-by-one case label) creates the
attack task `CUnitAttackTargetTask` with the overcharge flag for an entity
target that is not allied, and nothing for any other target (the command
completes at once). The constructor with the flag (812610-812640) takes
the first weapon whose blueprint has `OverChargeWeapon`, keeps it as
mWeapon and runs its `OnEnableWeapon`. With a pinned weapon TaskTick
(813121-813506) never asks the attacker for one (813216-813218): Waiting
sets the navigator's goal through Update (812845-813013) -- within the
MaxRadius of the attacker's target weapon, the first weapon that can
attack the target (GetTargetWeapon 791305-791320; SetWeaponGoal
812691-812720, 813277-813299); Processing renews the goal when the
navigator went idle or a mobile target left it by more than 10 (2 for a
flyer; 813391-813410) and waits until the target is within the pinned
weapon's attack range (TargetIsWithinWeaponAttackRange 791447-791460: the
unit finished, the weapon enabled, CanAttackTarget, the range solution),
then the weapon takes the target (UnitWeapon::SetTarget 813431); Complete
waits for the script's `CanWeaponFire` (813474-813475; the weapon FSM
keeps it false while its economy drain runs, defaultweapons.lua:487-494),
sends a mobile unit whose position changed back through Update
(813477-813483), and fires once the weapon is enabled and
UnitWeapon::CanFire holds (813485-813490): UnitWeapon::Fire is
`RunScript("OnFire")` and one more shot at the target (985600-985602).
The fifth state aborts the move and ends the task (813493-813495,
sub_5F3420); the destructor runs `OnDisableWeapon` on the pinned weapon
and aborts the move (813679-813725). The price is the script's:
StartEconomyDrain (defaultweapons.lua:132-147) creates an economy event of
EnergyRequired over EnergyRequired / EnergyDrainPerSecond seconds -- not
before the first shot when the blueprint says `EnergyChargeForFirstShot =
false` (81-82, 133), and again right after each shot for the next
(615-617). The ACU's own OverCharge weapon (uel0001_script.lua:30-95)
disables itself after the shot and pauses the unit for 1 / RateOfFire
seconds through `SetOverchargePaused` (cfunc 976254; the user layer's
`UserUnit::IsOverchargePaused` 1362603-1362605 behind
cfunc_UserUnitIsOverchargePausedL 1366354-1366375 gates the button,
orders.lua:642/663). The
binding IssueOverCharge (cfunc_IssueOverChargeL 1008066-1008140): two
arguments, RULEUCC_Overcharge, an entity target left in the set,
UNITCOMMAND_OverCharge with clear = 0, no handle; the user's dispatch
needs the unit's RULEUCC_Overcharge cap (func_ProcessUnitCommand
1007470-1007472), and the world view issues the entity under the cursor
(1241977-1241990).

**The port.** `src/engine-lua/overcharge.lua` (new; src/sim/overcharge.ts
after the capture): the pinned-weapon attack task as a per-unit state
machine ticked from `__ordersTick` through the order type `OverCharge`
(`__overchargeStart` -- the dispatch and the constructor,
`__overchargeOrderTick`, `__overchargeAbort` -- the destructor, also from
the abort and stop paths). weapons.lua exposes the aim tick and the
target test (`__weaponAimTick`, `__weaponCanTarget`) for a task that
pins a ManualFire weapon the weapon tick skips. globals.lua: the order
type, `__dispatchOverCharge` (with the cap), `IssueOverCharge`. The user
layer: the unit row carries `overchargePaused` (units.lua -> the
snapshot -> gameUi.ts `__uiSetUnit` -> `UserUnitMeta:IsOverchargePaused`
in ui-globals.lua); the selection row carries `canOvercharge`;
worldCommands.ts issues the overcharge for the RULEUCC_Overcharge mode on
an enemy unit; the sim client / worker carry `overcharge`.

**Checks** (scripts/verify-overcharge.ts, new, 27 checks): uel0001's
OverCharge weapon disabled at rest; the binding's arity and target
errors and the cap filter; the army's store above EnergyRequired; the
command with its task and the pinned weapon's OnEnableWeapon; the weapon
taking the target within its range, the shot, OnWeaponFired, a hit of
more than 1000 in one beat that kills a T2 tank (the ACU's gun does about
100), the drain of about 5000 for the next shot, the weapon disabled and
the overcharge paused afterwards, the paused flag in the JSON row, the
command completed, the pause ending after 1 / RateOfFire seconds; a far
target approached to within MaxRadius 22 before the weapon takes it and
killed, the goal renewed when that target is warped away by more than
10 during the approach; an abort on the way running OnDisableWeapon
without a shot, the
weapon disabled, the move aborted; an allied target without a task; the
user dispatch refusing a unit without the cap; no Lua errors. Seen red
first: the shot and everything after it without the pinned weapon's aim
tick; the kill and the drain checks while a T1 tank died to the ACU's
gun and the drain was expected before the first shot (it follows it).
verify-command-chain's "unwired mode" check moved from Overcharge to
Nuke.

**Review corrections** (a fresh agent against the Cfile): Complete's
re-approach of a mobile unit whose position changed (813477-813483) was
claimed and not coded -- it is now, with the position of the last tick;
the approach goes by the attacker's target weapon (GetTargetWeapon,
Update 812965-812970), not the pinned weapon; Processing renews the goal
of a mobile target that left it (813393-813410); the user layer's
IsOverchargePaused is UserUnit's (1362603-1362605), not the Sim's
(976303); three citations off by one or two lines; the formation is none
on this path (831097) and left the "Not modelled" list;
docs/research/command-dispatch-binary.md's OverCharge row said
`CUnitFireAtTask`.

**Not modelled, recorded rather than faked.**

* **The coordinating command** of the attack task (813266-813275,
  813304-813330), **the "too close" back-off** (Starting, 813302-813360),
  **the attack angle facing** (813498-813525) and **the fit test of a
  renewed goal** (func_UnitWontFitAt 813404): none; a target closer than
  MinRadius stays untargetable through the range solution.
* **UNITSTATE Attacking** of the attack task (cleared in the destructor,
  813690): the port's attack orders do not set it either.

**UNVERIFIED.** The `mWeapon->v93` flag of the re-approach test (813479)
is not read and taken as clear; the Attacking bit's number (bit 3 of
mUnitStates, `&= ~8`).

## The vertical motion events: the decompilation's UMVE_Top and UMVE_Bottom labels are swapped

**What was wrong.** The port read the decompiled enum labels as the
strings: a landed flyer reported 'Top', a flyer in level flight 'Bottom',
every fresh unit started at 'Bottom', and NotifyAttached set 'Top'. The
original unit.lua plays "Landed" on 'Bottom' (2216-2218), "TakeOff" on
'Up' or a 'Top' after 'Down'/'Bottom' (2219-2221), switches the beam
exhaust on 'Bottom' (2225-2229) and the idle effects on 'Top' after 'Up'
(2246-2248) -- with the labels swapped the air unit's sounds and effects
came at the wrong moments.

**The engine.** `CScriptObject::CallbackStr2(..., "OnMotionVertEventChange",
&vertMotionEvent_names[new], &vertMotionEvent_names[old])` indexes the
table `{ "Top", "Bottom", "Up", "Down", "Hover" }` (Cfile:421838) with the
event value (SetMotionVertEvent 965524-965538). Three sites pair the
label `UMVE_Top` with `&vertMotionEvent_names[1]` -- "Bottom" -- as the
new name (964895-964903, 965780-965787, 966164-966171): the label
UMVE_Top is the value 1 and UMVE_Bottom the value 0. So the ctor's
`mVertEvent = UMVE_Bottom` (964773) is "Top", CalcMoveAir's level-flight
`UMVE_Bottom` (969884) is "Top", its touchdown `UMVE_Top` (969729) and
the AtTarget test (965922) are "Bottom", NotifyAttached's `UMVE_Top`
(965780-965787) is "Bottom", and a submarine spawned in the Sub layer
gets "Bottom" (964895-964903).

**The port.** motion.lua's `__setMotionVertEvent` documents the table
and the swap; the ctor default (units.lua) is 'Top', NotifyAttached
sets 'Bottom', air.lua's level flight is 'Top', its touchdown, take-off
test and AtTarget test are 'Bottom'. verify-motion.ts (a fresh unit is
Stopped / Top) and verify-air-motion.ts (Top in level flight, Bottom at
the landing) carry the corrected expectations -- both were red under the
old code. Found while reading the dive (UNITCOMMAND_Dive) for its port.

## The dive: UNITCOMMAND_Dive, the surfacing submarine's layer toggle, IssueDive

**What was wrong.** `IssueDive` was a strict-_G miss (platoon.lua:2294
surfaces the naval force with it, xss0201_script.lua:66 the newborn
Seraphim destroyer); the UI's Dive button (orders.lua DiveOrderBehavior
-> IssueCommand 'Dive') ended in main.ts's "noch kein Weg dorthin" log; a
surfacing submarine lay on the seabed in every layer (the ground model's
height for RULEUMT_SurfacingSub was the terrain); and the UI's
`IssueCommand` sent `clear = false` by default where the engine sends
true.

**The engine.** The command is no task: DispatchTask (830531-830543,
under the off-by-one case label) hands the motion a target layer --
Water for a unit in the Sub layer, Sub for any other -- through
IAiCommandDispatchImpl::SetNewTargetLayer (832195-832198) and
CUnitMotion::SetNewTargetLayer (965234-965274): from Sub to Water the
MovingUp bit and the "Up" event, from Water to Sub the MovingDown bit
and the "Down" event, the motion's mLayer takes the new one. The command
is instant (CommandIsInstant 842857-842872): the dispatcher pops it the
next tick (746616-746650) and the queue goes on while the boat still
dives; a second Dive during the dive is idempotent, the target layer
follows the unit's layer, which flips only at the end. The motion: a
unit in the Water or Sub layer ticks CalcMoveWater (966296-966310,
971814-971860) -- CalcMoveCommon, then HandleDivingAndSurfacing
(971735-971812), then SnapToWater (970979-971036) when it moved or dived.
HandleDivingAndSurfacing: nothing without a Physics.Elevation
(UnitAttributes.mElevation, 949113) or without MovingUp / MovingDown;
the depth is capped at terrain + 0.25 - water (shallow water, at most
0); the speed per tick is Physics.DiveSurfaceSpeed * 0.1 (the ctor
default 1.0, 656139 -- no shipped blueprint sets it) on a sine ramp over
the depth reached, at least a tenth of it; rising, mSubElevation reaches
0 and the unit takes the layer, drops the bit and reports "Top"; sinking,
it reaches the depth and reports "Bottom" (the labels UMVE_Bottom /
UMVE_Top are names[0] / names[1], "The vertical motion events" above).
SnapToWater: y = max(terrain + 0.25, water + mSubElevation), capped at
the water while submerged, mSubElevation following. A unit born in the
Sub layer starts at its depth with the "Bottom" event (the CUnitMotion
ctor 964891-964904; CalcSpawnElevation 683106-683111: Elevation +
water). IssueDive (cfunc_IssueDiveL 1008189-1008260): one argument, no
cap validation, UNITCOMMAND_Dive with clear = 0, the command handle or
nil; func_ProcessUnitCommand takes the command for a
RULEUMT_SurfacingSub only (1006861-1006864). The UI: DiveOrderBehavior
(orders.lua:241-266) issues `IssueCommand('Dive')`, whose clear defaults
to true (cfunc_IssueCommandL 1265527); GetIsSubmerged / the auto-surface
mode were in place already.

**The port.** `src/engine-lua/dive.lua` (new; src/sim/dive.ts after the
overcharge): `__diveSetNewTargetLayer`, `__diveTick`
(HandleDivingAndSurfacing), `__diveSnapY` (SnapToWater), `__diveInitSpawn`
(the ctor's Sub-layer start), `__diveStart` (the dispatch, instant),
`__dispatchDive` (the user's command with the SurfacingSub test),
`__isSurfacingSub`. motion.lua: a surfacing submarine's height is
`__diveSnapY` and its tick runs `__diveTick` after the ground model with
the snap after a move or a dive step. units.lua: the spawn hook.
globals.lua: the `Dive` order type (instant) and `IssueDive`.
ui-globals.lua: `IssueCommand`'s clear defaults to true. The sim client
/ worker carry `dive`; main.ts routes the UI's Dive to it.

**Checks** (scripts/verify-dive.ts, new, 31 checks): a Tigershark
(ues0203) born in the Sub layer at water minus 1.5 with mSubElevation
-1.5 and the "Bottom" event; the binding's arity error, a frigate
(RULEUMT_Water) getting no command and nil, an empty list nil, the
frigate on the water; the surfacing with the handle, MovingUp and "Up",
the instant command, the rise to the surface in the Water layer on a
monotonic sine ramp with steps in [0.01, 0.1] peaking above 0.05,
OnLayerChange(Water, Sub) before the "Top" event with MovingUp cleared;
the dive with MovingDown and "Down", the depth in the Sub layer with
"Bottom", two dives during a surfacing still ending on the surface; the
shelf at 39 capping the dive at 39.25; IssueDive appending behind a
move, the user's Dive clearing the queue, the user dispatch dropping a
frigate, a surfaced boat moving on the surface; the Seraphim destroyer
born submerged at -2, surfacing from its own OnStopBeingBuilt, its
turrets on at "Top" and off at "Down"; no Lua errors. Seen red first:
the shelf check under a completion depth without the cap; the ramp
check with the last remainder step counted; the destroyer's birth height
read after its first tick.

**Not modelled, recorded rather than faked.**

* **The attack task's auto-surface** (813228-813290: a submerged sub in
  auto-surface mode surfaces to attack what it cannot reach), **the
  transport unload's and the carrier's surfacing** (853573-853588,
  828062-828072).
* **SnapToWater's lift over an occupied rect** (970999-971011: the unit
  the boat rides).

**UNVERIFIED.** Whether the horizontal speed is throttled while
diving: no site in the Cfile reads MovingUp / MovingDown for it (a
negative grep). The decompiled completion test of the dive reads
`mElevation >= mElevation` (971801); the local is a MAPDST split
(971735) -- the capped target against the new depth -- read as "the
depth reached", the mirror of the surfacing side (971783). The fresh
review of this diff is still owed: the review agent died on the session
limit; the port was self-checked against every cited range.
