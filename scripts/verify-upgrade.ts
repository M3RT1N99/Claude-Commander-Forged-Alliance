/**
 * Structure upgrade (T1 -> T2) — `Moho::CUnitUpgradeTask` (Cfile:816981/817198)
 * plus the hand-over `NotifyUpgrade` (Cfile:978489).
 *
 * The upgrade is NOT a special path in the engine: it is the same
 * CBuildTaskHelper as every other build, only with the helper name "Upgrade"
 * (ctor Cfile:816992) — and exactly that string is the `order` the original Lua
 * sees, which is why StructureUnit.OnStartBuild switches into its UpgradingState
 * (defaultunits.lua:223). So the whole chain runs through the ORIGINAL Lua:
 *
 *   IssueUpgrade({mex}, 'ueb1202')          cfunc_IssueUpgradeL, Cfile:1011315
 *     -> successor created at the old building's position/army/layer
 *        (SUnitConstructionParams, Cfile:817276-817290)
 *     -> mex:OnStartBuild(successor, 'Upgrade')  -> UpgradingState
 *     -> UNITSTATE_Upgrading (6) on the mex, UNITSTATE_BeingUpgraded (37) on
 *        the successor (Cfile:817000 / 817320)
 *     -> WorkProgress of the mex follows the successor (Cfile:815482)
 *     -> completion: UpgradingState.OnStopBuild -> NotifyUpgrade -> Destroy
 *        (defaultunits.lua:259-268)
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-upgrade.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit, readLuaUnit } from '../src/lua/unitFactory'
import { GameFiles } from './gameFiles'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()
const warnings: string[] = []
const host = await LuaHost.create(game.luaFiles, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})
const engine = installEngine(host)
setTerrainSource(host, () => 20)
for (const id of ['uel0001', 'ueb1103', 'ueb1202']) await game.giveUnit(host, id)

// The ACU gives the army its starting resources (GiveInitialResources) — an
// upgrade costs mass and energy like any other build.
const acu = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
const mex = spawnLuaUnit(host, 'ueb1103', { x: 120, y: 20, z: 130 }, 1)
for (let i = 0; i < 8; i++) beat(engine)

console.log('\n== The T1 mex stands and knows its successor ==')
check(mex > 0, `ueb1103 through the original StructureUnit (id ${mex})`)
check(
  host.eval(`return __units[${mex}].UpgradingState ~= nil`) === true,
  'It IS a StructureUnit (it carries the UpgradingState from defaultunits.lua:233)',
)
check(
  host.eval(`return __units[${mex}].__bp.General.UpgradesTo`) === 'ueb1202',
  'Blueprint General.UpgradesTo = ueb1202',
)

// A damaged building stays damaged across the upgrade (health RATIO,
// Cfile:978648-978652) — so damage it before the upgrade starts.
host.eval(`local u = __units[${mex}]; u:SetHealth(nil, u:GetMaxHealth() * 0.5)`)

console.log('\n== IssueUpgrade (cfunc_IssueUpgradeL, Cfile:1011315) ==')
host.eval(`IssueUpgrade({ __units[${mex}] }, 'ueb1202')`)
const successor = Number(
  host.eval(`
    for id, u in pairs(__units) do
      if u.__bp and u.__bp.BlueprintId == 'ueb1202' then return id end
    end
    return 0
  `),
)
check(successor > 0, `The successor exists (id ${successor})`)
const s0 = readLuaUnit(host, successor)
check(
  s0 !== null && Math.abs(s0.x - 120) < 0.01 && Math.abs(s0.z - 130) < 0.01,
  `It stands exactly where the mex stands (${s0?.x}/${s0?.z}) — SUnitConstructionParams(GetPosition())`,
)
check(s0 !== null && s0.fraction < 1, `It is a construction site (${((s0?.fraction ?? 0) * 100).toFixed(0)} %)`)
check(
  host.eval(`return __units[${mex}].__focusEntity == __units[${successor}]`) === true,
  'The successor is the mex\'s focus entity (Cfile:817310)',
)

// One beat: the task starts, OnStartBuild(order = 'Upgrade') runs.
beat(engine)
console.log('\n== The order string is "Upgrade" -> UpgradingState ==')
check(
  host.eval(`
    for _, t in pairs(__buildTasks) do
      if t.builder == ${mex} then return t.order end
    end
    return 'none'
  `) === 'Upgrade',
  'The build task carries the helper name "Upgrade" (Cfile:816992)',
)
check(
  host.eval(`return getmetatable(__units[${mex}]) == __units[${mex}].UpgradingState`) === true,
  'defaultunits.lua:224 switched the mex into its UpgradingState',
)
check(
  host.eval(`return __units[${mex}]:IsUnitState('Upgrading')`) === true,
  'IsUnitState(Upgrading) on the mex (mUnitStates |= 0x40, Cfile:817000)',
)
check(
  host.eval(`return __units[${successor}]:IsUnitState('BeingUpgraded')`) === true,
  'IsUnitState(BeingUpgraded) on the successor (bit 37, Cfile:817320)',
)

console.log('\n== WorkProgress follows the successor (Cfile:815482) ==')
for (let i = 0; i < 12; i++) beat(engine)
const wp = Number(host.eval(`return __units[${mex}].__workProgress or -1`))
const frac = Number(host.eval(`return __units[${successor}].__fraction or -1`))
// The task writes WorkProgress in __buildApply, the decay tick (Unit::OnTick,
// Cfile:952824) shaves the site's fraction afterwards in the same beat — so
// the two differ by at most one decay step.
const decayStep = Number(
  host.eval(`
    local e = __units[${successor}].__bp.Economy
    return 0.1 / math.max(e.BuildCostEnergy or 0, e.BuildCostMass or 0, e.BuildTime or 0)
  `),
)
check(wp > 0, `The mex reports WorkProgress ${wp.toFixed(4)} (> 0)`)
check(
  Math.abs(wp - frac) <= decayStep + 1e-9,
  `It IS the successor's fraction (${frac.toFixed(4)}, one decay step apart at most)`,
)

console.log('\n== Completion: NotifyUpgrade + the old building destroys itself ==')
let beats = 12
while (beats < 4000 && host.eval(`return __units[${successor}] ~= nil and (__units[${successor}].__fraction or 0) < 1`) === true) {
  beat(engine)
  beats++
}
check(beats < 4000, `The upgrade finished after ${beats} beats`)
// The destroy runs through the original OnDestroy thread — give it its beats.
for (let i = 0; i < 20; i++) beat(engine)
check(
  host.eval(`return __units[${mex}] == nil or __units[${mex}].__destroyQueued == true or __units[${mex}].__dead == true`) === true,
  'The old mex destroyed itself (defaultunits.lua:267 self:Destroy())',
)
const done = readLuaUnit(host, successor)
check(done !== null && done.fraction >= 1, 'The successor is finished')
check(
  done !== null && Math.abs(done.health / done.maxHealth - 0.5) < 0.02,
  `The health ratio was carried over: ${((done?.health ?? 0) / (done?.maxHealth ?? 1) * 100).toFixed(1)} % ` +
    '(the mex was at 50 %, Cfile:978648-978652)',
)
check(
  host.eval(`return __units[${successor}]:IsUnitState('BeingUpgraded')`) === false,
  'BeingUpgraded is gone with the task (dtor Cfile:817090)',
)

console.log('\n== The successor produces — it really is a finished T2 mex ==')
{
  const prod = Number(host.eval(`return __units[${successor}].__bp.Economy.ProductionPerSecondMass or 0`))
  const active = host.eval(`return __units[${successor}].__productionActive ~= false`)
  check(prod > 0, `ueb1202 ProductionPerSecondMass = ${prod} (blueprint)`)
  check(active === true, 'Its production is switched on (OnStopBeingBuilt ran)')
}

const upgradeWarnings = warnings.filter((w) => /Upgrade|OnStartBuild|OnStopBuild|OnStopBeingBuilt/i.test(w))
check(upgradeWarnings.length === 0, `No swallowed callback errors (${upgradeWarnings.slice(0, 2).join(' | ')})`)

console.log('\n== A second upgrade order on the same building fizzles out ==')
{
  const mex2 = spawnLuaUnit(host, 'ueb1103', { x: 160, y: 20, z: 160 }, 1)
  for (let i = 0; i < 4; i++) beat(engine)
  host.eval(`IssueUpgrade({ __units[${mex2}] }, 'ueb1202')`)
  beat(engine)
  host.eval(`IssueUpgrade({ __units[${mex2}] }, 'ueb1202')`)
  const n = Number(
    host.eval(`
      local n = 0
      for _, t in pairs(__buildTasks) do if t.builder == ${mex2} then n = n + 1 end end
      return n
    `),
  )
  check(n === 1, `Exactly one upgrade task (${n})`)
  check(
    warnings.filter((w) => /IssueUpgrade/.test(w)).length === 0,
    'and it does not warn — the engine just queues the command behind a unit that is about to vanish',
  )
}

await game.close()
console.log(failures === 0 ? '\nUPGRADE PASSED' : `\nUPGRADE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
