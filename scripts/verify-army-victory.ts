/**
 * The per-army state and the victory / game-over chain (sim_SimInits, so
 * sim-only). aibrain.lua and victory.lua drive defeat and end-of-game with
 * these; without them the AI's IsDefeated loop (aibrain.lua:806) and
 * CallEndGame (victory.lua:89-99) threw "access to nonexistent global".
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-army-victory.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { installUiEngine } from '../src/lua/uiEngine'
import { findFiles } from '../src/vfs/glob'
import { spawnLuaUnit } from '../src/lua/unitFactory'
import { GameFiles } from './gameFiles'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()
const host = await LuaHost.create(game.luaFiles, () => {})
// The default session is SANDBOX_SESSION (installEngine's 3rd param).
const eng = installEngine(host)
setTerrainSource(host, () => 20, { width: 256, height: 256 })
for (const id of ['uel0001', 'uel0201']) await game.giveUnit(host, id)

console.log('\n== Game over (EndGame / IsGameOver) ==')
check(host.eval('return IsGameOver()') === false, 'the game is not over at start')
host.eval('EndGame()')
check(host.eval('return IsGameOver()') === true, 'EndGame() -> IsGameOver() is true (Cfile:1077505)')

console.log('\n== Army defeat (SetArmyOutOfGame / ArmyIsOutOfGame) ==')
check(host.eval('return ArmyIsOutOfGame(1)') === false, 'army 1 is in the game')
host.eval('SetArmyOutOfGame(1)')
check(host.eval('return ArmyIsOutOfGame(1)') === true, 'SetArmyOutOfGame(1) -> defeated (Cfile:1026283)')
check(host.eval('return ArmyIsOutOfGame(2)') === false, 'army 2 is unaffected')

console.log('\n== Civilian flag from the session (Cfile:1025673) ==')
check(host.eval('return ArmyIsCivilian(1)') === false, 'the sandbox armies are not civilian')

console.log('\n== ListArmies: the names, 1-based (Cfile:1024337) ==')
{
  const names = String(
    host.eval(`local t = ListArmies() return (t[1] or '?') .. ',' .. (t[2] or '?')`),
  )
  check(names === 'ARMY_1,ARMY_2', `ListArmies() = {${names}} (names, not brains)`)
}

console.log('\n== Unit cap (Cfile:1024961/1025008) ==')
check(host.eval('return GetArmyUnitCap(1)') === 500, 'the default unit cap is 500 (Cfile:1017634)')
host.eval('SetArmyUnitCap(1, 250)')
check(host.eval('return GetArmyUnitCap(1)') === 250, 'SetArmyUnitCap(1, 250) sticks')
check(
  host.eval(`local ok = pcall(SetArmyUnitCap, 1, 'x') return ok`) === false,
  'a non-number cap errors (Cfile:1025008)',
)

console.log('\n== GetArmyUnitCostTotal sums CapCost (Cfile:1016520) ==')
{
  const before = Number(host.eval('return GetArmyUnitCostTotal(1)'))
  check(before === 0, `no units -> 0 (${before})`)
  const acu = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
  spawnLuaUnit(host, 'uel0201', { x: 110, y: 20, z: 100 }, 1)
  for (let i = 0; i < 4; i++) beat(eng)
  const acuCost = Number(host.eval(`return __units[${acu}].__bp.General.CapCost or 1`))
  const total = Number(host.eval('return GetArmyUnitCostTotal(1)'))
  // Each unit contributes its CapCost (default 1).
  check(total >= 2, `two units of army 1 sum their CapCost (${total}, ACU CapCost ${acuCost})`)
  check(
    Number(host.eval('return GetArmyUnitCostTotal(2)')) === 0,
    "army 2's total is unaffected",
  )
}

console.log('\n== SetIgnoreArmyUnitCap / SubmitXMLArmyStats / CheatsEnabled ==')
check(host.eval(`local ok = pcall(SetIgnoreArmyUnitCap, 1, true) return ok`) === true, 'SetIgnoreArmyUnitCap is callable')
check(host.eval(`local ok = pcall(SubmitXMLArmyStats) return ok`) === true, 'SubmitXMLArmyStats does not throw (victory.lua:91)')
check(host.eval('return CheatsEnabled()') === false, 'cheats are off by default')

console.log('\n== These are SIM-ONLY: the UI VM must not have them ==')
{
  const files = new Map<string, Uint8Array>()
  const allPaths = new Set<string>()
  for (const [k, v] of game.luaFiles) {
    if (k.endsWith('.lua')) {
      files.set(k, v)
      allPaths.add(k.toLowerCase())
    }
  }
  const ui = await LuaHost.create(files, () => {})
  installUiEngine(ui, {
    exists: (p: string) => allPaths.has(p),
    find: (dir: string, pattern: string) => findFiles(allPaths, dir, pattern),
    textureSize: () => null,
    stringAdvance: () => 0,
    fontMetrics: () => [0, 0, 0],
  })
  for (const name of ['EndGame', 'ArmyIsOutOfGame', 'SetArmyUnitCap', 'GetArmyUnitCostTotal', 'ListArmies']) {
    check(
      ui.eval(`return rawget(_G, '${name}') == nil`) === true,
      `${name} is NOT in the UI VM (sim_SimInits)`,
    )
  }
  ui.close()
}

await game.close()
console.log(failures === 0 ? '\nARMY VICTORY PASSED' : `\nARMY VICTORY FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
