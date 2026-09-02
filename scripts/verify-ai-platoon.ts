/**
 * Das Platoon-System (Moho::CPlatoon) und die KI-Armee.
 *
 * Ein Platoon ist ein CScriptObject: `CPlatoon::CPlatoon` laedt
 * `import('/lua/platoon.lua').Platoon` (Cfile:1048422-1048435), setzt
 * `mName`/`mPlan` und ruft `OnCreate(mPlan)` (Cfile:1048347-1048349). Jede
 * Armee bekommt bei ihrer Erzeugung EIN Platoon: `MakePlatoon(army, "Pool",
 * "PoolAI")`, `mUniqueName = "ArmyPool"` (Cfile:1017576-1017578). Jede neue
 * Einheit landet darin, BEVOR ihr `OnCreate` laeuft (Cfile:950549 vor 950554).
 *
 * Ohne all das stirbt jede KI-Armee an `aibrain.lua:1144` — `plat:ForkThread`
 * auf dem Ergebnis von `GetPlatoonUniquelyNamed('ArmyPool')`.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-ai-platoon.ts
 */
import { readFileSync } from 'node:fs'
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { beginSession } from '../src/sim/session'
import { parseScmap } from '../src/formats/scmap'
import { GameFiles, GAME_DIR } from './gameFiles'

const MAP = 'SCMP_009'
let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()
const warnungen: string[] = []
const host = await LuaHost.create(game.luaFiles, (level, msg) => {
  if (level === 'WARN') warnungen.push(String(msg))
})

// EINE KI-ARMEE — das ist der Punkt. `human: false` laesst `InitializeArmyAI`
// den Zweig `brain:OnCreateAI(plan)` nehmen (Cfile:724516-724518), und der geht
// durch das Platoon-System.
const session = {
  type: 'skirmish' as const,
  map: `/maps/${MAP}/${MAP}.scmap`,
  scenarioFile: `/maps/${MAP}/${MAP}_scenario.lua`,
  armies: [
    { name: 'ARMY_1', index: 1, faction: 1, human: true },
    { name: 'ARMY_2', index: 2, faction: 1, human: false },
  ],
}

console.log('== Eine KI-Armee kommt durch den Sitzungsstart ==')
// Das Gelaende geht MIT in den Boot: die Bedrohungskarte entsteht in der
// Armee-Erzeugung und liest dabei das Heightfield (Cfile:1017321-1017333) —
// `AddInitialEnemyThreat` laeuft also, bevor `setTerrainSource` frueher an der
// Reihe war.
const scmap = parseScmap(new Uint8Array(readFileSync(`${GAME_DIR}/maps/${MAP}/${MAP}.scmap`)))
const stride = scmap.width + 1
const gelaende = {
  heightAt: (x: number, z: number): number => {
    const xi = Math.max(0, Math.min(scmap.width, Math.round(x)))
    const zi = Math.max(0, Math.min(scmap.height, Math.round(z)))
    return (scmap.heightmap[zi * stride + xi] ?? 0) * scmap.heightScale
  },
  size: {
    width: scmap.width,
    height: scmap.height,
    waterElevation: scmap.water.hasWater ? scmap.water.elevation : undefined,
  },
}
let bootFehler = ''
let engine = null
try {
  engine = installEngine(host, undefined, session, gelaende)
} catch (e) {
  bootFehler = (e as Error).message
}
check(bootFehler === '', `installEngine mit ARMY_2 als KI${bootFehler ? ` — ${bootFehler.slice(0, 160)}` : ''}`)
if (!engine) {
  host.close()
  await game.close()
  process.exit(1)
}
const q = (code: string): unknown => host.eval(code)

console.log('\n== Jede Armee hat ihr Pool-Platoon (Cfile:1017576-1017578) ==')
for (const army of [1, 2]) {
  check(
    q(`return type(ArmyBrains[${army}]:GetPlatoonUniquelyNamed('ArmyPool'))`) === 'table',
    `Armee ${army} hat ein 'ArmyPool' — es entsteht MIT der Armee, nicht auf Zuruf`,
  )
}
check(
  q(`return ArmyBrains[1]:GetPlatoonUniquelyNamed('ArmyPool')
       ~= ArmyBrains[2]:GetPlatoonUniquelyNamed('ArmyPool')`) === true,
  'und jede ihr eigenes',
)
check(
  q(`return ArmyBrains[1]:GetPlatoonUniquelyNamed('ArmyPool'):GetAIPlan()`) === 'PoolAI',
  "sein Plan ist 'PoolAI' (MakePlatoon(army, 'Pool', 'PoolAI'))",
)
check(
  q(`return ArmyBrains[1]:GetPlatoonUniquelyNamed('ArmyPool'):GetPlatoonUniqueName()`) === 'ArmyPool',
  'und sein eindeutiger Name ArmyPool',
)
check(
  q(`return ArmyBrains[1]:GetPlatoonUniquelyNamed('gibtsNicht') == nil`) === true,
  'ein unbekannter Name liefert nil, keinen Fehler (die Bindung pusht lua_pushnil)',
)

console.log()
console.log('== Und NUR einer der beiden Pfade laeuft je Armee ==')
// `CAiBrain::CAiBrain` ruft weder `OnCreateHuman` noch `OnCreateAI`; das macht
// `InitializeArmyAI` (Cfile:1024677-1024699) mit der Entscheidung `IsHuman`
// (Cfile:724516-724518). Der Beweis, dass hier nicht BEIDE laufen: `VOTable`
// legt allein `InitializeVO` an, und das ruft allein `OnCreateHuman`
// (aibrain.lua:352, 916-921).
check(q(`return ArmyBrains[1].BrainType`) === 'Human', 'ARMY_1 ist Human')
check(q(`return ArmyBrains[2].BrainType`) === 'AI', 'ARMY_2 ist AI')
check(q(`return ArmyBrains[1].VOTable ~= nil`) === true, 'die menschliche Armee hat eine VOTable')
check(
  q(`return ArmyBrains[2].VOTable == nil`) === true,
  'die KI-Armee hat KEINE — sonst waere OnCreateHuman zusaetzlich gelaufen',
)

console.log('\n== MakePlatoon ruft OnCreate MIT dem Plan (Cfile:1048349) ==')
q(`__testPlatoon = ArmyBrains[1]:MakePlatoon('TestGruppe', 'TestPlan')`)
check(q(`return __testPlatoon:GetAIPlan()`) === 'TestPlan', 'GetAIPlan() gibt den Plan zurueck')
check(
  q(`return type(__testPlatoon.PlatoonData) == 'table' and __testPlatoon.Trash ~= nil`) === true,
  'platoon.lua:27-37 OnCreate lief (PlatoonData und Trash stehen)',
)
check(q(`return ArmyBrains[1]:PlatoonExists(__testPlatoon)`) === true, 'PlatoonExists sagt ja')
check(
  Number(q(`return #ArmyBrains[1]:GetPlatoonsList()`)) === 2,
  `GetPlatoonsList zeigt beide (${String(q(`return #ArmyBrains[1]:GetPlatoonsList()`))})`,
)

console.log('\n== Die Karte setzt die Einheiten, und sie landen im Pool ==')
for (const id of host.pull<string[]>('__sessionInitialUnitsJson()')) await game.giveUnit(host, id)
game.loadProps(host)
game.loadProjectiles(host)
let popFehler = ''
try {
  beginSession(host, session)
} catch (e) {
  popFehler = (e as Error).message
}
check(popFehler === '', `BeginSession mit KI-Armee${popFehler ? ` — ${popFehler.slice(0, 160)}` : ''}`)
// SOFORT, vor dem ersten Beat: eine frische Einheit gehoert dem Pool ihrer
// Armee. Danach darf die KI sie herausnehmen — und tut es auch.
for (const army of [1, 2]) {
  check(
    Number(q(`return #ArmyBrains[${army}]:GetPlatoonUniquelyNamed('ArmyPool'):GetPlatoonUnits()`)) === 1,
    `die ACU von Armee ${army} liegt im Pool (Cfile:950549 vor OnCreate)`,
  )
}
for (let i = 0; i < 60; i++) beat(engine)
// Und die KI raeumt ihn ab: `ExecuteAIThread` bildet aus den Pool-Einheiten
// Platoons (aibrain.lua:874-880). Die menschliche Armee tut das nicht.
check(
  Number(q(`return #ArmyBrains[1]:GetPlatoonUniquelyNamed('ArmyPool'):GetPlatoonUnits()`)) === 1,
  'nach 60 Beats liegt die ACU der MENSCHLICHEN Armee immer noch im Pool',
)
check(
  Number(q(`return #ArmyBrains[2]:GetPlatoonsList()`)) > 1,
  `die KI-Armee hat sich Platoons gebildet (${String(q(`return #ArmyBrains[2]:GetPlatoonsList()`))})`,
)

console.log('\n== AssignUnitsToPlatoon verschiebt, es kopiert nicht ==')
q(`__acu = ArmyBrains[1]:GetPlatoonUniquelyNamed('ArmyPool'):GetPlatoonUnits()[1]`)
q(`ArmyBrains[1]:AssignUnitsToPlatoon(__testPlatoon, { __acu }, 'Attack', 'NoFormation')`)
check(Number(q(`return #__testPlatoon:GetPlatoonUnits()`)) === 1, 'die Einheit ist im Zielplatoon')
check(
  Number(q(`return #ArmyBrains[1]:GetPlatoonUniquelyNamed('ArmyPool'):GetPlatoonUnits()`)) === 0,
  'und NICHT mehr im Pool — eine Einheit gehoert zu genau einem Platoon',
)
check(
  q(`return (pcall(function()
       ArmyBrains[1]:AssignUnitsToPlatoon(__testPlatoon, { __acu }, 42, 'NoFormation')
     end))`) === false,
  'eine Zahl als Squad wirft — die Bindung verlangt string (TypeError)',
)
// aiutilities.lua:875 uebergibt den NAMEN statt des Objekts.
q(`ArmyBrains[1]:AssignUnitsToPlatoon('ArmyPool', { __acu }, 'Unassigned', 'NoFormation')`)
check(
  Number(q(`return #ArmyBrains[1]:GetPlatoonUniquelyNamed('ArmyPool'):GetPlatoonUnits()`)) === 1,
  'das erste Argument darf ein NAME sein (aiutilities.lua:875)',
)

console.log('\n== DisbandPlatoon gibt die Einheiten zurueck ==')
q(`ArmyBrains[1]:AssignUnitsToPlatoon(__testPlatoon, { __acu }, 'Attack', 'NoFormation')`)
q(`ArmyBrains[1]:DisbandPlatoon(__testPlatoon)`)
check(q(`return ArmyBrains[1]:PlatoonExists(__testPlatoon)`) === false, 'PlatoonExists sagt danach nein')
check(
  Number(q(`return #ArmyBrains[1]:GetPlatoonUniquelyNamed('ArmyPool'):GetPlatoonUnits()`)) === 1,
  'und die Einheit liegt wieder im Pool',
)
check(Number(q(`return #ArmyBrains[1]:GetPlatoonsList()`)) === 1, 'die Liste ist wieder bei einem')

console.log('\n== Was die KI-Armee jetzt noch bremst ==')
// Der naechste gemessene Halt, damit er nicht in Vergessenheit geraet:
// `GetHighestThreatPosition` ist ein No-op, also ist `insertTable.Strength` nil
// und `GetAllianceEnemy` vergleicht nil (aibrain.lua:3466 -> :3470).
// Eine RATSCHE: die zwei gemessenen Haltepunkte stehen namentlich da, alles
// andere ist ein neuer Fund und macht die Suite rot.
const BEKANNT = [
  {
    muster: /scenarioplatoonai\.lua:66/,
    was: 'platoon.BuilderHandle:SetPriority — es gibt noch keine BuilderManagers (aibrain.lua:1137)',
  },
  {
    muster: /aiarchetype-managerloader\.lua:51/,
    was: 'aiBrain:HasBuilderList — dieselbe Luecke von der anderen Seite (der Builder-Manager)',
  },
]
const threadFehler = warnungen.filter((w) => /ForkThread-Fehler/.test(w))
// Die Ratsche ist die RICHTUNG, nicht die Anwesenheit: ein bekannter Halt DARF
// verschwinden (dann ist er behoben), aber es darf keiner dazukommen. Welche
// gefeuert haben, steht im Protokoll — verschwundene fallen dort auf.
for (const b of BEKANNT) {
  console.log(`       ${threadFehler.filter((w) => b.muster.test(w)).length}x  ${b.was}`)
}
const neue = threadFehler.filter((w) => !BEKANNT.some((b) => b.muster.test(w)))
check(neue.length === 0, `kein NEUER Thread-Fehler${neue[0] ? `: ${neue[0].slice(0, 180)}` : ''}`)
// KEINE Untergrenze auf der Fehlerzahl. Hier stand
// `check(threadFehler.length > 0, …)` — das ist das Gegenteil der Ratsche, die
// der Kommentar oben verspricht: sobald jemand die BuilderManagers baut und
// beide Haltepunkte verschwinden, waere die Suite rot geworden, und der
// naechstliegende Ausweg waere gewesen, sie abzuschwaechen.
//
// Dass die KI ueberhaupt laeuft, zeigen die Pruefungen oben — sie bildet aus
// ihrem Pool eigene Platoons.

host.close()
await game.close()
console.log(failures === 0 ? '\nAI-PLATOON BESTANDEN' : `\nAI-PLATOON: ${failures} FEHLER`)
process.exit(failures === 0 ? 0 : 1)
