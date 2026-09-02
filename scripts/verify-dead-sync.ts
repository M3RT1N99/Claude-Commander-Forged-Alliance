/**
 * A dying unit lingers in __units through its multi-beat death sequence (Kill ->
 * OnKilled thread -> Destroy), so readRow keeps sending it. The per-beat sync now
 * carries a `dead` flag (__dead or __destroyQueued); the UI mirror marks the unit
 * and SelectUnits excludes it — the engine drops IsDead AND DestroyQueued from a
 * selection (Cfile:1361497-1361498). Without it a dying unit stayed selectable
 * and shown alive until it was finally flushed.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-dead-sync.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit } from '../src/lua/unitFactory'
import { installUiEngine } from '../src/lua/uiEngine'
import { findFiles } from '../src/vfs/glob'
import { GameFiles } from './gameFiles'
import { FLAT_TEST_MAP_SIZE } from '../src/sim/terrain'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()

// ── Sim: readRow carries the dead flag ──
console.log('\n== readRow serializes the dead flag ==')
const simHost = await LuaHost.create(game.luaFiles, () => {})
const engine = installEngine(simHost)
setTerrainSource(simHost, () => 20, FLAT_TEST_MAP_SIZE)
await game.giveUnit(simHost, 'uel0001')
const u = spawnLuaUnit(simHost, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
for (let i = 0; i < 8; i++) beat(engine)

const deadField = (): unknown =>
  simHost.eval(`for _, r in ipairs(__readAllUnits()) do if r.id == ${u} then return r.dead end end`)
check(deadField() === false, `a live unit reports dead=false (${deadField()})`)
simHost.eval(`__units[${u}].__dead = true`)
check(deadField() === true, `a killed (lingering) unit reports dead=true (${deadField()})`)
simHost.eval(`__units[${u}].__dead = false; __units[${u}].__destroyQueued = true`)
check(deadField() === true, `a destroy-queued unit reports dead=true (${deadField()})`)

// ── UI mirror: a dead-flagged unit is excluded from selection ──
console.log('\n== UI mirror excludes a dead unit from SelectUnits ==')
const allPaths = game.paths
const uiHost = await LuaHost.create(game.luaFiles, () => {})
installUiEngine(uiHost, {
  exists: (p) => allPaths.has(p),
  find: (dir, pattern) => findFiles(allPaths, dir, pattern),
  textureSize: () => null,
  stringAdvance: () => 0,
  fontMetrics: () => [0, 0],
})
// Two mirrored units of the same army: #1 alive, #2 dead (deadFlag = true).
uiHost.eval(`__uiSetUnit(1, 'uel0001', 1, 0, 0, 0, 100, 100, 1, false, 0, 0, -1, false)`)
uiHost.eval(`__uiSetUnit(2, 'uel0001', 1, 0, 0, 0, 100, 100, 1, false, 0, 0, -1, true)`)
check(uiHost.eval(`return __uiUnits[1]:IsDead()`) === false, 'mirror keeps the live unit alive')
check(uiHost.eval(`return __uiUnits[2]:IsDead()`) === true, 'mirror marks the dead unit IsDead')

// SelectUnits filters IsDead (Cfile:1361497); the dead one drops out.
const selCount = uiHost.eval(`
  SelectUnits({ __uiUnits[1], __uiUnits[2] })
  local s = GetSelectedUnits()
  return s and table.getn(s) or 0
`)
check(selCount === 1, `SelectUnits keeps only the live unit (${selCount})`)

// A unit that dies WHILE selected drops out of the mirror's live view.
uiHost.eval(`SelectUnits({ __uiUnits[1] })`)
uiHost.eval(`__uiSetUnit(1, 'uel0001', 1, 0, 0, 0, 100, 100, 1, false, 0, 0, -1, true)`)
check(uiHost.eval(`return __uiUnits[1]:IsDead()`) === true, 'a selected unit that dies is now IsDead in the mirror')

console.log(failures === 0 ? '\nDEAD-SYNC PASSED' : `\nDEAD-SYNC FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
