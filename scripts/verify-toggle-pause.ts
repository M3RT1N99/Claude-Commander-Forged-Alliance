/**
 * Two UI commands that used to dead-end in the dispatcher now reach the sim:
 *
 *   ToggleScriptBit  -> Unit:ToggleScriptBit(bit)
 *                       flips the UI-filtered unit and fires
 *                       OnScriptBitSet/Clear (cfunc_ToggleScriptBitL).
 *   SetPaused        -> Unit:SetPaused(bool) sets mIsPaused; a paused builder
 *                       makes no build progress and requests no resources
 *                       (build.lua __buildCollect gate; cfunc_SetPausedL
 *                       "Pause builders in this list").
 *
 * This exercises the SIM side directly — exactly what the worker handler evals
 * (luaSimWorker.ts: `u:ToggleScriptBit(...)` / `u:SetPaused(...)`). The TS worker
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
// `ueb4202` ist der Schildgenerator — die einzige der drei mit einer ToggleCap
// im Blueprint (`General.ToggleCaps.RULEUTC_ShieldToggle`).
for (const id of ['uel0001', 'ueb0101', 'ueb4202']) await game.giveUnit(simHost, id)

const acu = spawnLuaUnit(simHost, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
// GiveInitialResources runs after WaitTicks(5) — only then does the army pay.
for (let i = 0; i < 8; i++) beat(engine)

// ── ToggleScriptBit: the sim flips the bit and fires the callbacks ──
console.log('\n== ToggleScriptBit reaches the sim ==')
{
  // NICHT die ACU. `Moho::Unit::ToggleScriptBit` prüft als erstes die
  // Toggle-Cap-Maske (Cfile:951398), und die ACU hat im Blueprint KEINE
  // ToggleCaps — nachgemessen: `uel0001` und `ueb0101` haben keine, `ueb4202`
  // hat `RULEUTC_ShieldToggle`, `ueb3101` `RULEUTC_IntelToggle`, `url0101`
  // `RULEUTC_CloakToggle`.
  //
  // Bis hierher legte diese Suite den Schild-Bit an einer Einheit ohne Schild
  // um und bekam ihn auch — also Verhalten, das die Engine nicht hat. Das fiel
  // erst auf, als das Tor eingebaut wurde.
  const shield = spawnLuaUnit(simHost, 'ueb4202', { x: 130, y: 20, z: 130 }, 1)
  // Der Schildgenerator setzt seinen eigenen Bit beim Erzeugen — das ist die
  // Original-Lua bei der Arbeit, nicht Rauschen. Also erst auf einen bekannten
  // Stand bringen, DANN die Zähler nullen; sonst zählt die Messung die
  // Einschaltung der Einheit mit.
  simHost.eval(`__units[${shield}]:SetScriptBit(0, false)`)
  simHost.eval(`
    local u = __units[${shield}]
    u.__sbSet, u.__sbClear = 0, 0
    u.OnScriptBitSet = function(self, bit) self.__sbSet = self.__sbSet + 1 end
    u.OnScriptBitClear = function(self, bit) self.__sbClear = self.__sbClear + 1 end
  `)
  const on = (): boolean => simHost.eval(`return __units[${shield}]:GetScriptBit(0)`) as boolean
  const sets = (): number => simHost.eval(`return __units[${shield}].__sbSet`) as number
  const clears = (): number => simHost.eval(`return __units[${shield}].__sbClear`) as number

  // Die Cap steht im Blueprint — ohne sie täte das Folgende gar nichts.
  check(
    simHost.eval(`return __units[${shield}]:TestToggleCaps('RULEUTC_ShieldToggle')`) === true,
    'ueb4202 hat RULEUTC_ShieldToggle im Blueprint',
  )
  simHost.eval(`__units[${shield}]:ToggleScriptBit(0)`)
  check(on() === true, `bit 0 set (GetScriptBit -> ${on()})`)
  check(sets() === 1, `OnScriptBitSet fired once (${sets()})`)

  // SetScriptBit remains the idempotent primitive used by the toggle.
  simHost.eval(`__units[${shield}]:SetScriptBit(0, true)`)
  check(sets() === 1, `re-setting the same state does not fire again (${sets()})`)

  simHost.eval(`__units[${shield}]:ToggleScriptBit(0)`)
  check(on() === false, `bit 0 cleared (GetScriptBit -> ${on()})`)
  check(clears() === 1, `OnScriptBitClear fired once (${clears()})`)

  // Und die Gegenprobe an der ACU: sie hat die Cap nicht, also passiert nichts.
  simHost.eval(`__units[${acu}]:ToggleScriptBit(0)`)
  check(
    simHost.eval(`return __units[${acu}]:GetScriptBit(0)`) === false,
    'die ACU hat die Cap nicht — bei ihr passiert gar nichts (Cfile:951398)',
  )
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

console.log('\n== The beat closes with ResetSyncTable() ==')
// Sim::Sync serialises the Sync table to the user layer and then runs
// `SCR_LuaDoString("ResetSyncTable()")` (Cfile:1074261, 1074772-1074773), driven
// from CSimDriver::Sync. The table is therefore PER BEAT: whatever the sim Lua
// writes during a beat is readable inside that beat and gone at the start of the
// next one. Without the reset it grew for the whole session and every consumer
// saw stale entries from earlier beats as if they had just happened.
{
  simHost.eval(`Sync.__probe = 'written during the beat'`)
  check(
    String(simHost.eval(`return tostring(Sync.__probe)`)) === 'written during the beat',
    'a Sync write is visible right after it happens',
  )
  beat(engine)
  check(
    simHost.eval(`return Sync.__probe == nil`) === true,
    'and it is gone once the beat has closed',
  )
  // The table itself must still be there — ResetSyncTable REPLACES it, it does
  // not delete the global (simsync.lua).
  check(
    simHost.eval(`return type(Sync) == 'table'`) === true,
    'Sync itself survives the reset (the table is replaced, not removed)',
  )
}

console.log('\n== The deletion queue drains until EMPTY, not one generation per beat ==')
// Sim::AdvanceBeat: `while (mDeletionQueue._Mysize) { pop_front; dtor(); }`
// (Cfile:1076638-1076657). An OnDestroy that destroys something else — a factory
// taking its half-built unit with it (unit.lua:1259-1263) — therefore completes
// in the SAME beat. Draining one snapshot deferred every such cascade by a beat.
{
  // Marked as projectiles so the flush takes the harmless __projectiles branch;
  // ids are required — the flush indexes the per-kind table by __id.
  simHost.eval(`
    __cascadeDone = false
    __cascadeA = { __id = 900001, __isProj = true,
                   OnDestroy = function(self) __cascadeB:Destroy() end }
    __cascadeB = { __id = 900002, __isProj = true,
                   OnDestroy = function(self) __cascadeDone = true end }
    setmetatable(__cascadeA, { __index = moho.entity_methods })
    setmetatable(__cascadeB, { __index = moho.entity_methods })
  `)
  // B is destroyed from INSIDE A's OnDestroy, i.e. it enters the queue while the
  // queue is already being drained — the second generation.
  simHost.eval(`__cascadeA:Destroy()`)
  simHost.eval(`__flushDeletions()`)
  check(
    simHost.eval(`return __cascadeDone == true`) === true,
    'a second-generation destroy runs in the SAME flush, not the next beat',
  )
  check(
    simHost.eval(`return __cascadeB.__destroyed == true`) === true,
    'and the cascaded entity is fully destroyed',
  )
}

console.log(failures === 0 ? '\nTOGGLE/PAUSE PASSED' : `\nTOGGLE/PAUSE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
