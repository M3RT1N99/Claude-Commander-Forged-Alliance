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
let bootFehler = ''
let engine = null
try {
  engine = installEngine(host, undefined, session)
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
const scmap = parseScmap(new Uint8Array(readFileSync(`${GAME_DIR}/maps/${MAP}/${MAP}.scmap`)))
const stride = scmap.width + 1
setTerrainSource(
  host,
  (x, z) => {
    const xi = Math.max(0, Math.min(scmap.width, Math.round(x)))
    const zi = Math.max(0, Math.min(scmap.height, Math.round(z)))
    return (scmap.heightmap[zi * stride + xi] ?? 0) * scmap.heightScale
  },
  {
    width: scmap.width,
    height: scmap.height,
    waterElevation: scmap.water.hasWater ? scmap.water.elevation : undefined,
  },
)
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
for (let i = 0; i < 60; i++) beat(engine)
for (const army of [1, 2]) {
  check(
    Number(q(`return #ArmyBrains[${army}]:GetPlatoonUniquelyNamed('ArmyPool'):GetPlatoonUnits()`)) === 1,
    `die ACU von Armee ${army} liegt im Pool (Cfile:950549 vor OnCreate)`,
  )
}

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
const threat = warnungen.filter((w) => /aibrain\.lua:3470/.test(w))
check(
  threat.length > 0,
  `aibrain.lua:3470 vergleicht nil — GetHighestThreatPosition fehlt noch (${threat.length} WARN)`,
)
const andere = warnungen.filter((w) => /ForkThread-Fehler/.test(w) && !/aibrain\.lua:3470/.test(w))
check(andere.length === 0, `sonst kein Thread-Fehler${andere[0] ? `: ${andere[0].slice(0, 140)}` : ''}`)

host.close()
await game.close()
console.log(failures === 0 ? '\nAI-PLATOON BESTANDEN' : `\nAI-PLATOON: ${failures} FEHLER`)
process.exit(failures === 0 ? 0 : 1)
