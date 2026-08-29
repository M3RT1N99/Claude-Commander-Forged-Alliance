import { readFileSync } from 'node:fs'
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { beginSession } from '../src/sim/session'
import { parseScmap } from '../src/formats/scmap'
import { GameFiles, GAME_DIR } from './gameFiles'
const MAP = 'SCMP_009'
const game = await GameFiles.open()
const warn: string[] = []
const host = await LuaHost.create(game.luaFiles, (l, m) => { if (l === 'WARN') warn.push(String(m)) })
const session = {
  type: 'skirmish' as const,
  map: `/maps/${MAP}/${MAP}.scmap`,
  scenarioFile: `/maps/${MAP}/${MAP}_scenario.lua`,
  armies: [
    { name: 'ARMY_1', index: 1, faction: 1, human: true },
    { name: 'ARMY_2', index: 2, faction: 1, human: false },
  ],
}
let fehler = ''
let engine = null
try { engine = installEngine(host, undefined, session) } catch (e) { fehler = (e as Error).message }
console.log('installEngine mit KI-Armee:', fehler ? fehler.slice(0, 200) : 'OK')
if (engine) {
  const scmap = parseScmap(new Uint8Array(readFileSync(`${GAME_DIR}/maps/${MAP}/${MAP}.scmap`)))
  const stride = scmap.width + 1
  setTerrainSource(host, (x, z) => {
    const xi = Math.max(0, Math.min(scmap.width, Math.round(x)))
    const zi = Math.max(0, Math.min(scmap.height, Math.round(z)))
    return (scmap.heightmap[zi * stride + xi] ?? 0) * scmap.heightScale
  }, { width: scmap.width, height: scmap.height, waterElevation: scmap.water.hasWater ? scmap.water.elevation : undefined })
  for (const id of host.pull<string[]>('__sessionInitialUnitsJson()')) await game.giveUnit(host, id)
  game.loadProps(host); game.loadProjectiles(host)
  let bs = ''
  try { beginSession(host, session) } catch (e) { bs = (e as Error).message }
  console.log('BeginSession:', bs ? bs.slice(0, 200) : 'OK')
  for (let i = 0; i < 60; i++) beat(engine)
  const q = (c: string): unknown => { try { return host.eval(c) } catch (e) { return 'WIRFT: ' + (e as Error).message.slice(0, 80) } }
  console.log('Einheiten            :', q(`local n=0 for _ in pairs(__units) do n=n+1 end return n`))
  console.log('ArmyPool(2) Einheiten:', q(`return #ArmyBrains[2]:GetPlatoonUniquelyNamed('ArmyPool'):GetPlatoonUnits()`))
  console.log('Platoons Armee 2     :', q(`return #ArmyBrains[2]:GetPlatoonsList()`))
  console.log('PlatoonExists        :', q(`local p = ArmyBrains[2]:GetPlatoonUniquelyNamed('ArmyPool') return ArmyBrains[2]:PlatoonExists(p)`))
}
console.log('\nWARNs:')
const rel = warn.filter((w) => /error|fehler|nil value|attempt/i.test(w))
for (const w of rel.slice(0, 10)) console.log(' ', w.slice(0, 200))
console.log(`(${rel.length} von ${warn.length})`)
host.close(); await game.close()
