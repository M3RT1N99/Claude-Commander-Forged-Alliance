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

`src/engine-lua/moho.lua` füllt **147** Bindungen mit einem stillen No-op. Bis
jetzt war unbekannt, welche davon im laufenden Spiel überhaupt erreicht werden —
die Priorisierung war Raten. `scripts/verify-playthrough.ts` schaltet dafür
`__mohoNoopWarn` ein; jeder No-op meldet sich beim ersten Aufruf.

Eine vollständige Partie (ACU → Bau → Fabrik → Kampf → Wrack) ruft **9 von 147**:

| No-op | Wofür |
| --- | --- |
| `HideBone`, `ShowBone` | Knochen aus-/einblenden (Bau, Upgrade) |
| `AttachTo`, `AttachBoneTo`, `DetachFrom`, `DetachAll` | Anhängen — Transporter, Bauarme |
| `AddBuildRestriction` | Bau-Beschränkungen der Armee |
| `GetFocusUnit` | die Fokus-Einheit |
| `ShakeCamera` | Kamera-Erschütterung bei Einschlägen |

Das ist die Arbeitsliste, nach Messung sortiert. Die übrigen 138 werden auf
diesem Weg nicht erreicht — sie sind deshalb nicht harmlos, aber sie sind auch
nicht dringend. Ein **zehnter** aufgerufener No-op lässt den Durchlauf
fehlschlagen (eingecheckte Fund-Liste).

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

Der rote Lauf meldete `ForkThread-Fehler: /mod/lua/utilities.lua:50: attempt to
call a nil value (field 'pow')`. FAs Lua 5.0.1 hatte `math.pow`, Lua 5.4
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

Nicht nachgebildet, mangels Grundlage: die Engine blockt zusätzlich, solange die
Einheit an etwas aus der Kategorie TRANSPORTATION hängt
(Cfile:951400-951424). Einen Anhänge-Zustand gibt es hier nicht — `AttachTo` ist
einer der stillen No-ops, und einer der **neun**, die das Spiel wirklich ruft.

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
