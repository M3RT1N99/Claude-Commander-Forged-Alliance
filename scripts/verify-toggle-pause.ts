/**
 * Two UI commands that used to dead-end in the dispatcher now reach the sim:
 *
 *   ToggleScriptBit  -> Unit:SetScriptBit(bit, desiredState)
 *                       guards idempotently, fires OnScriptBitSet/Clear
 *                       (moho.lua:426; cfunc_ToggleScriptBitL).
 *   SetPaused        -> Unit:SetPaused(bool) sets mIsPaused; a paused builder
 *                       makes no build progress and requests no resources
 *                       (build.lua __buildCollect gate; cfunc_SetPausedL
 *                       "Pause builders in this list").
 *
 * This exercises the SIM side directly — exactly what the worker handler evals
 * (luaSimWorker.ts: `u:SetScriptBit(...)` / `u:SetPaused(...)`). The TS worker
 * wiring is thin and type-checked; here we prove the game logic.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-toggle-pause.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit, spawnBuildSite } from '../src/lua/unitFactory'
import { GameFiles } from './gameFiles'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()
const simHost = await LuaHost.create(game.luaFiles, () => {})
const engine = installEngine(simHost)
setTerrainSource(simHost, () => 20) // flat test ground at height 20
for (const id of ['uel0001', 'ueb0101']) await game.giveUnit(simHost, id)

const acu = spawnLuaUnit(simHost, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
// GiveInitialResources runs after WaitTicks(5) — only then does the army pay.
for (let i = 0; i < 8; i++) beat(engine)

// ── ToggleScriptBit: the sim flips the bit and fires the callbacks ──
console.log('\n== ToggleScriptBit reaches the sim (SetScriptBit) ==')
{
  simHost.eval(`
    local u = __units[${acu}]
    u.__sbSet, u.__sbClear = 0, 0
    u.OnScriptBitSet = function(self, bit) self.__sbSet = self.__sbSet + 1 end
    u.OnScriptBitClear = function(self, bit) self.__sbClear = self.__sbClear + 1 end
  `)
  const on = (): boolean => simHost.eval(`return __units[${acu}]:GetScriptBit(0)`) as boolean
  const sets = (): number => simHost.eval(`return __units[${acu}].__sbSet`) as number
  const clears = (): number => simHost.eval(`return __units[${acu}].__sbClear`) as number

  simHost.eval(`__units[${acu}]:SetScriptBit(0, true)`)
  check(on() === true, `bit 0 set (GetScriptBit -> ${on()})`)
  check(sets() === 1, `OnScriptBitSet fired once (${sets()})`)

  // Idempotent guard (moho.lua:429): the same desired state does nothing.
  simHost.eval(`__units[${acu}]:SetScriptBit(0, true)`)
  check(sets() === 1, `re-setting the same state does not fire again (${sets()})`)

  simHost.eval(`__units[${acu}]:SetScriptBit(0, false)`)
  check(on() === false, `bit 0 cleared (GetScriptBit -> ${on()})`)
  check(clears() === 1, `OnScriptBitClear fired once (${clears()})`)
}

// ── SetPaused: a paused builder makes no progress, then resumes ──
console.log('\n== SetPaused halts a builder, unpause resumes it ==')
{
  // Build site right next to the ACU so range never gates progress.
  const site = spawnBuildSite(simHost, 'ueb0101', { x: 105, y: 20, z: 105 }, 1)
  simHost.eval(`__issueBuildTask(${acu}, ${site})`)
  const frac = (): number => (simHost.eval(`return __units[${site}] and __units[${site}].__fraction or -1`) as number)
  const paused = (): boolean => simHost.eval(`return __units[${acu}]:IsPaused()`) as boolean

  for (let i = 0; i < 6; i++) beat(engine)
  const f1 = frac()
  check(f1 > 0, `build progresses while running (fraction ${f1.toFixed(3)})`)

  simHost.eval(`__units[${acu}]:SetPaused(true)`)
  check(paused() === true, 'IsPaused() true after SetPaused(true)')
  for (let i = 0; i < 10; i++) beat(engine)
  const f2 = frac()
  // A paused builder adds NO forward progress. (The pre-existing time-from-birth
  // decay clock, build.lua __decayTick, still ticks a hair — that is orthogonal
  // to pause; the point is the build no longer advances.)
  check(f2 <= f1 + 1e-6, `no forward progress while paused (${f1.toFixed(3)} -> ${f2.toFixed(3)})`)

  simHost.eval(`__units[${acu}]:SetPaused(false)`)
  check(paused() === false, 'IsPaused() false after SetPaused(false)')
  for (let i = 0; i < 10; i++) beat(engine)
  const f3 = frac()
  check(f3 > f2 + 1e-4, `progress resumes after unpause (${f2.toFixed(3)} -> ${f3.toFixed(3)})`)
}

console.log(failures === 0 ? '\nTOGGLE/PAUSE PASSED' : `\nTOGGLE/PAUSE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
