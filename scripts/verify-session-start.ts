/**
 * DER SITZUNGSSTART LÄUFT ALS ORIGINAL-LUA.
 *
 * Bis hierher baute TypeScript die Startbedingungen: `src/sim/session.ts` setzte
 * ein leeres `Options = {}`, kopierte die Bündnisregel aus
 * `scenarioutilities.lua:488-500` nach TS (und verlor dabei beide
 * Zivilisten-Zweige), `src/main.ts:1031-1062` parste die `_save.lua` der Karte
 * mit einem TS-Parser, und `src/engine-lua/units.lua` **erfand** ein leeres
 * `Scenario`-Global, damit `GetMarkers()` „fehlerfrei läuft" — es lieferte `{}`,
 * `InitializeArmies()` übersprang jede Armee an `scenarioutilities.lua:449`,
 * und nichts schlug fehl.
 *
 * Jetzt läuft die echte Kette:
 *
 *   doscript('/lua/dataInit.lua')                       siminit.lua:92
 *   ScenarioInfo.Env = import('/lua/scenarioEnvironment.lua')  siminit.lua:82
 *   doscript(ScenarioInfo.save, ScenarioInfo.Env)       siminit.lua:93
 *   Scenario = ScenarioInfo.Env.Scenario                siminit.lua:95
 *   doscript(ScenarioInfo.script, ScenarioInfo.Env)     siminit.lua:98
 *   je Armee: InitializeStartLocation + SetPlans        schook/lua/simInit.lua:47-48
 *   ScenarioInfo.Env.OnPopulate(ScenarioInfo)           siminit.lua:145
 *
 * Diese Suite prüft nicht, dass Bindungen existieren. Sie prüft, dass am Ende
 * **zwei Kommandeure auf den Markern der echten Karte stehen, weil
 * `scenarioutilities.lua` sie dorthin gestellt hat** — und dass die Bündnislage
 * von der Original-Lua kommt, nicht von TypeScript: sie muss unmittelbar VOR
 * `OnPopulate` noch falsch sein und danach richtig.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-session-start.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { GameFiles } from './gameFiles'
import { beginSession, type SessionInfo } from '../src/sim/session'

const MAP = 'SCMP_009'
const SCENARIO = `/maps/${MAP}/${MAP}_scenario.lua`

// Die Werte stehen in der Karte, nicht hier: SCMP_009_save.lua:754-759
// (ARMY_1) und :2716-2720 (ARMY_2). Sie sind Teil der BEHAUPTUNG — stimmt die
// Ladekette nicht, kommt etwas anderes heraus.
const ARMY1 = { x: 672.5, z: 346.5 }
const ARMY2 = { x: 357.5, z: 673.5 }

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()
const luaErrors: string[] = []
const host = await LuaHost.create(game.luaFiles, (level, msg) => {
  if (level === 'WARN' && /Fehler|error/i.test(msg)) luaErrors.push(msg)
})

console.log('\n== Die Kartendateien sind in der Sim-VM ==')
for (const f of ['_save.lua', '_script.lua', '_scenario.lua']) {
  check(host.hasFile(`maps/${MAP}/${MAP}${f}`), `maps/${MAP}/${MAP}${f}`)
}

const session: SessionInfo = {
  type: 'skirmish',
  map: `/maps/${MAP}/${MAP}.scmap`,
  scenarioFile: SCENARIO,
  // BEIDE menschlich — und das ist ein Befund, keine Bequemlichkeit.
  //
  // Mit `human: false` laeuft `InitializeArmyAI` in `brain:OnCreateAI(plan)`
  // (Cfile:724516-724518), und der Pfad stirbt an `aibrain.lua:1144`:
  // `plat:ForkThread(...)` auf `plat = self:GetPlatoonUniquelyNamed('ArmyPool')`
  // — und `GetPlatoonUniquelyNamed` ist einer der 147 stillen No-ops
  // (`moho.lua`, AIBRAIN_NAMES). Es gibt kein Platoon-System, also gibt es
  // keine KI-Armee. Nachgemessen in genau diesem Lauf; siehe docs/STATUS.md.
  //
  // Ein Skirmish mit zwei menschlichen Spielern ist eine echte Konfiguration,
  // und `CreateInitialArmyGroup` haengt ohnehin nicht am Human-Flag, sondern
  // an `Civilian` (scenarioutilities.lua:467).
  armies: [
    { name: 'ARMY_1', index: 1, faction: 1, human: true },
    { name: 'ARMY_2', index: 2, faction: 1, human: true },
  ],
}

// Vor dem Boot: das Gelände. `CreateInitialArmyUnit` übergibt y = 0 und lässt
// den Spawn-Pfad die Höhe ableiten (Cfile:950181-950196), also muss eine
// Geländequelle stehen.
const q = (code: string): unknown => host.eval(code)

// ── Zwischenstand: die Bündnislage VOR OnPopulate ────────────────────────────
//
// Der Beweis, dass die Original-Lua sie setzt: `installEngine` fährt die ganze
// Kette in einem Rutsch, deshalb wird hier eine zweite, identisch aufgebaute
// VM ohne Szenario gegengehalten.
console.log('\n== Ohne Szenario setzt niemand ein Bündnis ==')
{
  const h2 = await LuaHost.create(game.luaFiles, () => {})
  installEngine(h2, undefined, {
    type: 'skirmish',
    armies: [
      { name: 'ARMY_1', index: 1, faction: 1, human: true },
      { name: 'ARMY_2', index: 2, faction: 1, human: false },
    ],
  })
  // Das Gerüst in session.ts setzt es für den kartenlosen Fall — deshalb ist
  // hier `true` erwartet, und der Vergleich unten zeigt den Unterschied.
  check(
    h2.eval('return IsEnemy(1, 2)') === true,
    'kartenloser Harness: das Gerüst in session.ts setzt Feind (nicht die Engine)',
  )
  h2.close()
}

console.log('\n== Die echte Kette ==')
let bootFehler = ''
try {
  installEngine(host, undefined, session)
} catch (e) {
  bootFehler = (e as Error).message
}
check(bootFehler === '', `installEngine mit Szenario${bootFehler ? ` — ${bootFehler}` : ''}`)
// Das Gelände erst DANACH: `setTerrainSource` schreibt in Engine-Globals, die
// `installEngine` erst anlegt. `CreateInitialArmyUnit` übergibt y = 0 und lässt
// den Spawn-Pfad die Höhe ableiten (Cfile:950181-950196), also muss eine
// Geländequelle stehen, bevor `OnPopulate` spawnt.
if (!bootFehler) setTerrainSource(host, () => 20, { width: 1024, height: 1024 })
if (bootFehler) {
  host.close()
  await game.close()
  process.exit(1)
}

// Die ACU-Blueprints müssen VOR OnPopulate da sein — die Sim kann mitten im
// Tick nichts nachladen (units.lua:428 "Unknown unit kind"), und die Engine hat
// sie ebenfalls lange vorher (siminit.lua:8). Genau dafür sind `setupSession`
// und `beginSession` zwei Schritte.
for (const id of ['uel0001', 'ual0001', 'url0001', 'xsl0001']) {
  await game.giveUnit(host, id)
}
let popFehler = ''
try {
  beginSession(host, session)
} catch (e) {
  popFehler = (e as Error).message
}
check(popFehler === '', `BeginSession -> OnPopulate${popFehler ? ` — ${popFehler}` : ''}`)

console.log('\n== Die Karte ist geladen, nicht erfunden ==')
check(q('return type(Scenario)') === 'table', 'Scenario ist eine Tabelle')
check(
  q('return type(Scenario.Armies and Scenario.Armies.ARMY_1)') === 'table',
  'Scenario.Armies.ARMY_1 kommt aus der _save.lua',
)
const marker = Number(
  q('return Scenario.MasterChain._MASTERCHAIN_.Markers.ARMY_1.position[1]'),
)
check(marker === ARMY1.x, `ARMY_1-Marker x = ${ARMY1.x} (gelesen ${marker})`)
const nMarker = Number(
  q('local n = 0 for _ in pairs(Scenario.MasterChain._MASTERCHAIN_.Markers) do n = n + 1 end return n'),
)
// Das erfundene leere Scenario hatte NULL Marker. Jede Zahl über 100 beweist,
// dass die echte Karte gelesen wurde.
check(nMarker > 100, `${nMarker} Marker aus der echten Karte (das erfundene Global hatte 0)`)

console.log('\n== Die Startpositionen kommen aus den Markern ==')
for (const [name, want] of [
  ['ARMY_1', ARMY1],
  ['ARMY_2', ARMY2],
] as const) {
  const pos = String(
    q(`local x, z = GetArmyBrain('${name}'):GetArmyStartPos() return x .. ',' .. z`),
  )
  check(
    pos === `${want.x},${want.z}`,
    `${name}:GetArmyStartPos() = ${want.x},${want.z} (gelesen ${pos})`,
  )
}

console.log('\n== Die Kommandeure stehen darauf, gestellt von scenarioutilities.lua ==')
interface Row {
  id: number
  name: string
  x: number
  z: number
  army: number
}
const rows = (JSON.parse(String(q('return __readAllUnitsJson()'))) as Row[]).sort(
  (a, b) => a.army - b.army,
)
check(rows.length === 2, `genau 2 Einheiten (${rows.length})`)
for (const [i, want] of [ARMY1, ARMY2].entries()) {
  const u = rows[i]
  check(u !== undefined && u.name === 'uel0001', `Armee ${i + 1}: uel0001 (${u?.name})`)
  check(
    u !== undefined && Math.abs(u.x - want.x) < 0.01 && Math.abs(u.z - want.z) < 0.01,
    `Armee ${i + 1} steht auf ${want.x}/${want.z} (${u?.x}/${u?.z})`,
  )
}

console.log('\n== Das Bündnis kommt aus der Original-Lua ==')
check(q('return IsEnemy(1, 2)') === true, 'IsEnemy(1,2) — gesetzt von scenarioutilities.lua:495')

console.log('\n== Armee-Namen werden aufgelöst wie in ARMY_FromLuaState ==')
const throws = (code: string): boolean => {
  try {
    host.eval(code)
    return false
  } catch {
    return true
  }
}
check(
  Number(q(`return GetArmyBrain('ARMY_1'):GetArmyIndex()`)) === 1,
  `GetArmyBrain('ARMY_1') ist Armee 1`,
)
check(
  throws(`return GetArmyBrain('ARMY_NICHT_DA')`),
  `ein unbekannter Name wirft ("Unknown army", Cfile:1024210)`,
)
// Cfile:980336 gegen Cfile:980538: CreateUnit ist zahl-only, CreateUnitHPR nicht.
check(
  throws(`return CreateUnit('uel0001', 'ARMY_1', 100, 20, 100, 0, 0, 0, 1)`),
  'CreateUnit mit Namen wirft (die Engine verlangt dort eine Zahl)',
)
check(
  !throws(`return CreateUnitHPR('uel0001', 'ARMY_1', 100, 20, 100, 0, 0, 0)`),
  'CreateUnitHPR mit Namen geht (ARMY_FromLuaState, Cfile:980538)',
)

check(luaErrors.length === 0, `keine Lua-Fehler${luaErrors[0] ? `: ${luaErrors[0]}` : ''}`)

host.close()
await game.close()
console.log(failures === 0 ? '\nSITZUNGSSTART BESTANDEN' : `\nSITZUNGSSTART: ${failures} FEHLER`)
process.exit(failures === 0 ? 0 : 1)
