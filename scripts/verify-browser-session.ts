/**
 * The browser's Sim payload, checked in Node.
 *
 * `LuaSimClient.create()` cannot run under Node — it needs a Worker and the
 * browser VFS. What it CAN share is the decision of what goes into that worker:
 * `simBootPaths()` and `mapSession()` in `src/sim/mapSession.ts`. This suite
 * builds a VFS from exactly those functions, boots the ONE engine boot in it
 * and drives the real session start. If a file group ever falls out of the
 * browser payload, it falls out here — and here it fails.
 *
 * What that proves: with this payload the map's own `_save.lua`/`_script.lua`
 * run IN THE SIM, `OnPopulate` puts the ACUs on the map's ARMY_n markers, and
 * `GetArmyStartPos` answers. Nothing of that needs a line of TypeScript that
 * reads the map — which is what the browser path used to do.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-browser-session.ts
 */
import { readFileSync } from 'node:fs'
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { beginSession } from '../src/sim/session'
import { simBootPaths, mapSession, mapScenarioFile } from '../src/sim/mapSession'
import { loadProjectileBlueprints, loadPropBlueprints } from '../src/lua/unitFactory'
import { parseScmap } from '../src/formats/scmap'
import { terrainTypeSampler } from '../src/sim/terrain'
import { GameFiles, GAME_DIR } from './gameFiles'

const MAP = 'SCMP_009'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()

console.log('\n== Die Nutzlast, die der Worker bekaeme ==')
const paths = simBootPaths(game.luaFiles.keys(), MAP)
console.log(`  ${paths.core.length} Dateien lua/** + schook/** + loc/**`)
// Nicht die Anzahl ist der Pruefstein, sondern die vier Dateien, an denen der
// Retail-Boot in dieser Sitzung nacheinander gestorben ist:
for (const [datei, warum] of [
  ['schook/lua/globalinit.lua', 'definiert BuffBlueprint (ueber BuffBlueprints.lua)'],
  ['lua/system/localization.lua', 'globalInit.lua:22 laedt es'],
  ['lua/system/class.lua', 'globalInit.lua:20 — ohne das keine einzige Klasse'],
  ['lua/ui/uiutil.lua', 'die UI des Originals ist Lua und gehoert in den VM'],
] as const) {
  check(
    paths.core.some((p) => p.toLowerCase() === datei),
    `${datei} — ${warum}`,
  )
}
check(
  paths.core.some((p) => /^loc\/[^/]+\/strings_db\.lua$/i.test(p)),
  'ein loc/<sprache>/strings_db.lua — localization.lua:20-31 sucht genau danach',
)
check(paths.blueprints.length > 500, `${paths.blueprints.length} Projektil-/Prop-/Effekt-Blueprints`)
check(paths.map.length >= 3, `${paths.map.length} Lua-Dateien der Karte ${MAP}`)
for (const suffix of ['_save.lua', '_script.lua', '_scenario.lua']) {
  check(
    paths.map.some((p) => p.toLowerCase().endsWith(suffix)),
    `darunter ${MAP}${suffix} — SetupSession macht doscript darauf (siminit.lua:91-98)`,
  )
}
const scenario = mapScenarioFile(game.luaFiles.keys(), MAP)
check(
  scenario?.toLowerCase() === `/maps/${MAP}/${MAP}_scenario.lua`.toLowerCase(),
  `mapScenarioFile findet ${scenario ?? 'NICHTS'} (wie maputil.lua:106)`,
)

// Genau diese Nutzlast — nicht game.luaFiles. Fehlt eine Gruppe, fehlt sie hier.
const payload = new Map<string, Uint8Array>()
for (const group of [paths.core, paths.blueprints, paths.map]) {
  for (const p of group) payload.set(p, game.luaFiles.get(p)!)
}
// Die Unit-Blueprints kommen im Browser aus dem Payload-Cache je Blueprint
// (luaSimClient.payload()); hier stellt `giveUnit` dieselben bereit.
const luaErrors: string[] = []
const host = await LuaHost.create(payload, (level, msg) => {
  if (level === 'WARN' && /Fehler|error|not found/i.test(msg)) luaErrors.push(msg)
})

console.log('\n== Und damit faehrt die echte Sitzung ==')
const session = mapSession(game.luaFiles.keys(), MAP)
check(session != null, 'mapSession liefert eine Sitzung mit Szenariodatei')
if (!session) {
  host.close()
  await game.close()
  process.exit(1)
}
const engine = installEngine(host, undefined, session)

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
    // The worker's own sampler (terrain.ts terrainTypeSampler), fed the same
    // HeightfieldData the browser builds from the scmap.
    terrainTypeAt: terrainTypeSampler({
      data: scmap.heightmap,
      width: scmap.width,
      height: scmap.height,
      scale: scmap.heightScale,
      terrainType: scmap.terrainTypeData,
    }),
  },
)
{
  // The layer must actually be read: SCMP_009 carries eleven type codes, and a
  // Sim that answers the default type everywhere would pass every other check
  // here while lava did no damage and wrecks sat at the wrong offset.
  const namen = new Set<string>()
  for (let x = 8; x < scmap.width; x += 37) {
    for (let z = 8; z < scmap.height; z += 37) {
      namen.add(String(host.eval(`return GetTerrainType(${x}, ${z}).Name`)))
    }
  }
  check(namen.size > 1, `the terrain-type layer reaches the Sim: ${[...namen].join(', ')}`)
  check(
    String(host.eval(`return GetTerrainType(${scmap.width}, 0).Name`)) === 'Default'
      && String(host.eval('return GetTerrainType(-1, 5).Name')) === 'Default',
    'at the map size and at a negative coordinate the engine answers type code 1 (Cfile:1087700-1087703)',
  )
}
// Und jetzt genau das, was der Worker tut: die Sim sagt, welche Blueprints
// dieser Sitzungsstart erzeugen kann, und erst dann werden sie geladen. Die
// Engine hat alle (siminit.lua:8); der Worker kann das nicht, weil zu jeder
// Einheit auch ihr Skelett gehoert (78 MB _lod0.scm fuer 580 Einheiten).
console.log()
console.log('== Die Sim sagt selbst, welche Blueprints sie braucht ==')
const initialUnits = host.pull<string[]>('__sessionInitialUnitsJson()')
console.log(`  angefordert: ${initialUnits.join(', ')}`)
check(
  initialUnits.includes('uel0001'),
  'uel0001 ist dabei — factions.lua Factions[1].InitialUnit (scenarioutilities.lua:336-338)',
)
check(initialUnits.length > 0 && initialUnits.length < 50, `${initialUnits.length} Blueprints, keine Vollliste`)
// Genau wie `prepare()` im Worker (luaSimWorker.ts:207-210): Script in den
// VFS, Blueprint registrieren, Skelett setzen.
for (const id of initialUnits) {
  const script = game.luaFiles.get(`units/${id}/${id}_script.lua`)
  check(script != null, `${id}_script.lua liegt im Spiel`)
  if (script) host.addFile(`/units/${id}/${id}_script.lua`, script)
  await game.giveUnit(host, id)
}
// Und die Projektil-/Prop-Blueprints aus DERSELBEN Nutzlast, mit derselben
// Aufteilung wie `loadBlueprintGroups` im Worker.
const nProj = loadProjectileBlueprints(
  host,
  paths.blueprints.filter((p) => p.endsWith('.bp') && (p.startsWith('projectiles/') || p.startsWith('effects/'))),
)
const nProps = loadPropBlueprints(
  host,
  paths.blueprints.filter((p) => p.endsWith('.bp') && (p.startsWith('props/') || p.startsWith('env/'))),
)
check(nProj > 250, `${nProj} Projektil-/Effekt-Blueprints aus der Nutzlast`)
check(nProps > 300, `${nProps} Prop-Blueprints aus der Nutzlast`)
beginSession(host, session)
for (let i = 0; i < 10; i++) beat(engine)

const q = (code: string): unknown => host.eval(code)
console.log('\n== Die Karte hat die Einheiten gesetzt, nicht TypeScript ==')
const nUnits = Number(q(`local n = 0 for _ in pairs(__units) do n = n + 1 end return n`))
check(nUnits === 2, `${nUnits} Einheiten aus OnPopulate (erwartet 2 ACUs)`)
for (const army of [1, 2]) {
  const pos = String(q(`local x, z = ArmyBrains[${army}]:GetArmyStartPos() return string.format('%d,%d', x, z)`))
  const marker = String(
    q(`local m = Scenario.MasterChain._MASTERCHAIN_.Markers['ARMY_${army}']
       return string.format('%d,%d', m.position[1], m.position[3])`),
  )
  check(pos === marker, `ArmyBrains[${army}]:GetArmyStartPos() = ${pos} = Marker ARMY_${army} der Karte`)
  const acu = String(
    q(`for id, u in pairs(__units) do
         if u:GetArmy() == ${army} then
           local p = u:GetPosition()
           return string.format('%d,%d', p[1], p[3])
         end
       end
       return 'KEINE'`),
  )
  check(acu === marker, `und die ACU von Armee ${army} steht dort (${acu})`)
}
// Und die HOEHE: `CreateInitialArmyUnit` uebergibt y = 0 und laesst den
// Spawn-Pfad sie aus dem Gelaende ableiten (Cfile:950181-950196). Steht die ACU
// auf 0, steht sie im Wasser statt auf dem Berg — und genau das sieht man im
// Browser erst, wenn man hinschaut.
const acuY = Number(
  q(`for _, u in pairs(__units) do if u:GetArmy() == 1 then return u:GetPosition()[2] end end return -1`),
)
const bodenY = Number(q(`local x, z = ArmyBrains[1]:GetArmyStartPos() return GetSurfaceHeight(x, z)`))
check(
  Math.abs(acuY - bodenY) < 0.5 && bodenY > 0,
  `die ACU steht auf dem Gelaende: y = ${acuY.toFixed(2)}, Boden = ${bodenY.toFixed(2)}`,
)

check(luaErrors.length === 0, `keine Lua-Fehler${luaErrors[0] ? `: ${luaErrors[0]}` : ''}`)

host.close()
await game.close()
console.log(failures === 0 ? '\nBROWSER-SITZUNG BESTANDEN' : `\nBROWSER-SITZUNG: ${failures} FEHLER`)
process.exit(failures === 0 ? 0 : 1)
