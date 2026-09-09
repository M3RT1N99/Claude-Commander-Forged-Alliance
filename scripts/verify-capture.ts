/**
 * The capture: CUnitCaptureTask (Cfile:826337-827453), IssueCapture
 * (1011584-1011666) and ChangeUnitArmy / Sim::TransferUnit
 * (1089461-1089587, 1073702-1074080) through the original blueprints and
 * the original unit.lua (OnStartCapture ... OnCaptured, GetCaptureCosts,
 * TransferUnitsOwnership).
 *
 * A UEF T1 engineer (uel0105, BuildRate 5) captures an enemy T1 power
 * generator (ueb1101, BuildTime 125, BuildCostEnergy 750): the walk, the
 * callbacks and unit states, the price in ticks and energy, the stall
 * without energy, the completion with the new unit for the captor's army,
 * the abort, the refusals, ChangeUnitArmy on its own, two capturers, and
 * the economy events that share the request facility.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-capture.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit } from '../src/lua/unitFactory'
import { GameFiles } from './gameFiles'
import { FLAT_TEST_MAP_SIZE } from '../src/sim/terrain'

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
setTerrainSource(host, () => 20, FLAT_TEST_MAP_SIZE)
game.loadProjectiles(host)
game.loadProps(host)
await game.giveUnit(host, 'uel0105')
await game.giveUnit(host, 'ueb1101')
await game.giveUnit(host, 'uel0201')
await game.giveUnit(host, 'uel0001')

const posOf = (id: number): number[] => host.pull<number[]>(`__jsonVal(__units[${id}]:GetPosition())`)
const isState = (id: number, s: string): boolean => host.eval(`return __units[${id}]:IsUnitState('${s}')`) === true
const queueLen = (id: number): number => Number(host.eval(`local n = __orderActive[${id}] and 1 or 0 return n + #(__orders[${id}] or {})`))
const alive = (id: number): boolean => host.eval(`return __units[${id}] ~= nil`) === true
const armyOf = (id: number): number => Number(host.eval(`return __units[${id}].__army`))
const errorOf = (code: string): string => {
  try {
    host.eval(code)
    return ''
  } catch (e) {
    return String((e as Error).message)
  }
}
const log = (): string[] => {
  const l = host.pull<unknown>(`__jsonVal(__capLog)`)
  return Array.isArray(l) ? (l as string[]) : []
}
// The callbacks of both units, logged with their arguments' ids.
const hook = (id: number): void => {
  host.eval(`
    __capLog = __capLog or {}
    local u = __units[${id}]
    for _, name in ipairs({ 'OnStartCapture', 'OnStopCapture', 'OnFailedCapture', 'OnStartBeingCaptured',
        'OnStopBeingCaptured', 'OnFailedBeingCaptured', 'OnCaptured', 'OnAssignedFocusEntity' }) do
      local base = u[name]
      u[name] = function(self, other, ...)
        local oid = (type(other) == 'table' and other.__id) or '-'
        __capLog[#__capLog + 1] = name .. ':' .. tostring(self.__id) .. ':' .. tostring(oid)
        if base then return base(self, other, ...) end
      end
    end
  `)
}
const taskOf = (id: number): { state: string; capTime: number; capProgress: number; rateE: number; rateM: number; key: number } | null =>
  host.pull(`(function() local t = __captureTasks[${id}] if not t then return nil end return __jsonVal({ state = t.state, capTime = t.capTime, capProgress = t.capProgress, rateE = t.rateE, rateM = t.rateM, key = t.key or 0 }) end)()`)

// Army 1: an ACU for the economy (storage and production), the engineer.
const acu = spawnLuaUnit(host, 'uel0001', { x: 40, y: 20, z: 40 }, 1)
beat(engine)
host.eval(`__capLog = {}`)
const topUp = (): void => {
  host.eval(`GetArmyBrain(1):GiveResource('ENERGY', 200) GetArmyBrain(1):GiveResource('MASS', 20)`)
}

console.log('\n== IssueCapture: the binding (cfunc_IssueCaptureL, Cfile:1011584-1011666) ==')
const eng = spawnLuaUnit(host, 'uel0105', { x: 60, y: 20, z: 60 }, 1)
// The tank far away: its gun would shoot the enemy generator during the capture.
const tank = spawnLuaUnit(host, 'uel0201', { x: 200, y: 20, z: 200 }, 1)
const pgen = spawnLuaUnit(host, 'ueb1101', { x: 76, y: 20, z: 60 }, 2)
beat(engine)
hook(eng)
hook(pgen)
{
  check(errorOf(`IssueCapture({ __units[${eng}] })`).includes('expected 2 args'), 'one argument is the arity error')
  check(errorOf(`IssueCapture({ __units[${eng}] }, 5)`).includes('Expected a game object'), 'a non-entity target is the SCR_FromLua_Entity error')
  host.eval(`IssueCapture({ __units[${tank}] }, __units[${pgen}])`)
  check(queueLen(tank) === 0, 'a tank without RULEUCC_Capture gets no command (func_Validate_IssueCommand)')
  host.eval(`IssueCapture({ __units[${eng}], __units[${pgen}] }, __units[${pgen}])`)
  check(queueLen(eng) === 1 && queueLen(pgen) === 0, 'the engineer queues one Capture command; the target is taken out of the set')
  check(host.eval(`return __units[${eng}]:GetFocusUnit() == __units[${pgen}]`) === true, 'the target is the captor\'s focus entity (the dispatch ctor, 826403-826409)')
  check(log().includes(`OnAssignedFocusEntity:${eng}:-`), 'OnAssignedFocusEntity ran on the captor (826410)')
}

console.log('\n== The walk, the start and the price (TaskTick Preparing/Waiting/Starting, Cfile:826733-826950) ==')
{
  const d0 = Math.hypot(posOf(eng)[0]! - 76, posOf(eng)[2]! - 60)
  let started = false
  let beats = 0
  for (let i = 0; i < 150 && !started; i++) {
    topUp()
    beat(engine)
    beats++
    started = taskOf(eng)?.state === 'Processing'
  }
  const d1 = Math.hypot(posOf(eng)[0]! - 76, posOf(eng)[2]! - 60)
  check(started, `the task reached Processing (${beats} beats)`)
  check(d1 < d0 && d1 <= 5 + 1 + 1 + 0.5, `the engineer walked up to the target (edge distance from ${d0.toFixed(1)} to ${d1.toFixed(1)} centre distance)`)
  check(isState(eng, 'Capturing') && isState(pgen, 'BeingCaptured'), 'UNITSTATE Capturing on the captor (826847), BeingCaptured on the target (827162)')
  check(host.eval(`return __units[${pgen}].__capturers`) === 1, 'the target counts one capturer (827166)')
  const l = log()
  check(l.includes(`OnStartBeingCaptured:${pgen}:${eng}`) && l.includes(`OnStartCapture:${eng}:${pgen}`), 'OnStartBeingCaptured(captor) on the target, OnStartCapture(target) on the captor (827172-827175)')
  const t = taskOf(eng)!
  // GetCaptureCosts (unit.lua:2734-2743): time = BuildTime / BuildRate / 2 =
  // 125 / 5 / 2 = 12.5 s -> 125 ticks; energy = BuildCostEnergy 750, mass 0.
  check(t.capTime === 125, `mCapTime = max(1, time * 10) ticks from GetCaptureCosts (${t.capTime}; 125/5/2 s)`)
  check(Math.abs(t.rateE - 750 / 125) < 1e-9 && t.rateM === 0, `the request's rates are cost / mCapTime per tick (E ${t.rateE}, M ${t.rateM})`)
  check(host.eval(`return __econBuildRate(1, ${t.key})`) === 1 && host.eval(`return __econBuildRate(1, ${t.key} - 12345)`) === 0, 'the task\'s own CEconRequest is registered and fully supplied (LimitingRate 1; an unknown key reports 0)')
}

console.log('\n== Processing: the grant, the progress, the stall (Cfile:826956-826990) ==')
{
  const p0 = taskOf(eng)!.capProgress
  const s0 = Number(host.eval(`return __units[${eng}].__spentEnergy or 0`))
  for (let i = 0; i < 20; i++) {
    topUp()
    beat(engine)
  }
  const p1 = taskOf(eng)!.capProgress
  const s1 = Number(host.eval(`return __units[${eng}].__spentEnergy or 0`))
  check(p1 - p0 === 20, `one step per tick per capturer with full supply (${p0} -> ${p1})`)
  check(Math.abs((s1 - s0) - 20 * 6) < 0.05, `the energy taken is rate * ticks (${(s1 - s0).toFixed(2)} for 20 ticks at 6)`)
  const w = Number(host.eval(`return __units[${eng}]:GetWorkProgress()`))
  check(Math.abs(w - p1 / 125) < 1e-6, `mWorkProgress is progress / mCapTime (${w.toFixed(3)})`)
  // The stall: no energy in store and none produced -> the request is not
  // granted, the progress does not move.
  host.eval(`__units[${acu}]:SetProductionActive(false) GetArmyBrain(1):TakeResource('ENERGY', 1e9)`)
  const p2 = taskOf(eng)!.capProgress
  for (let i = 0; i < 10; i++) beat(engine)
  const p3 = taskOf(eng)!.capProgress
  check(p3 === p2, `without energy the capture stalls (${p2} -> ${p3} in 10 ticks)`)
  host.eval(`__units[${acu}]:SetProductionActive(true)`)
  for (let i = 0; i < 5; i++) {
    topUp()
    beat(engine)
  }
  const p4 = taskOf(eng)!.capProgress
  check(p4 > p3, `with energy again it resumes (${p3} -> ${p4})`)
}

console.log('\n== The completion: OnCaptured and the new unit (Cfile:826992-827005; TransferUnit 1073702-1074080) ==')
{
  host.eval(`__units[${pgen}]:SetHealth(nil, 300)`)
  host.eval(`__units[${pgen}]:AddUnitCallback(function(newUnit, captor) __capLog[#__capLog + 1] = 'new:' .. tostring(newUnit.__id) .. ':' .. tostring(captor.__id) .. ':' .. tostring(newUnit.__army) end, 'OnCapturedNewUnit')`)
  const before = host.pull<number[]>(`(function() local out = {} for id, u in pairs(__units) do out[#out + 1] = id end return __jsonVal(out) end)()`)
  let done = false
  let beats = 0
  for (let i = 0; i < 200 && !done; i++) {
    topUp()
    beat(engine)
    beats++
    done = queueLen(eng) === 0
  }
  beat(engine)
  const l = log()
  check(done, `the command completed (${beats} beats)`)
  check(l.includes(`OnStopCapture:${eng}:${pgen}`) && l.includes(`OnStopBeingCaptured:${pgen}:${eng}`) && l.includes(`OnCaptured:${pgen}:${eng}`), 'OnStopCapture, OnStopBeingCaptured and OnCaptured in the Complete state (826994-827004)')
  const after = host.pull<Array<{ id: number; bp: string; army: number; x: number; z: number; hp: number }>>(`(function()
    local out = {}
    for id, u in pairs(__units) do
      out[#out + 1] = { id = id, bp = string.lower(u.__bp.BlueprintId or ''), army = u.__army, x = u.__pos[1], z = u.__pos[3], hp = u.__health or 0 }
    end
    return __jsonVal(out)
  end)()`)
  const fresh = after.filter((r) => !before.includes(r.id) && r.bp === 'ueb1101')
  check(fresh.length === 1 && fresh[0]!.army === 1, `one new ueb1101 for army 1 (${fresh.length})`)
  const nu = fresh[0]
  check(nu !== undefined && Math.abs(nu.x - 76) < 1e-6 && Math.abs(nu.z - 60) < 1e-6, 'at the old unit\'s position (the transform copied, 1073890-1073901)')
  check(nu !== undefined && Math.abs(nu.hp - 300) < 1e-6, `with the old unit\'s health (${nu?.hp})`)
  check(!alive(pgen), 'the old unit is destroyed (1074033)')
  check(nu !== undefined && l.includes(`new:${nu.id}:${eng}:1`), 'the OnCapturedNewUnit callback saw the new unit and the captor (unit.lua:614-618)')
  check(!l.some((e) => e.startsWith('OnFailed')), 'no failed pair after a completed capture (the target is deletion-queued at DoCallback(false), 827115-827130)')
  check(!isState(eng, 'Capturing') && Number(host.eval(`return __units[${eng}]:GetWorkProgress()`)) === 0, 'the destructor clears Capturing and mWorkProgress (827349-827353)')
  check(host.eval(`return __captureTasks[${eng}] == nil`) === true && host.eval(`return __units[${eng}]:GetFocusUnit() == nil`) === true, 'the task is gone and the focus entity released (827317-827331)')
}

console.log('\n== The abort: IssueStop mid-way (the destructor, DoCallback(false), Cfile:827115-827181) ==')
{
  const pgen2 = spawnLuaUnit(host, 'ueb1101', { x: 76, y: 20, z: 70 }, 2)
  beat(engine)
  hook(pgen2)
  host.eval(`__capLog = {}`)
  host.eval(`IssueCapture({ __units[${eng}] }, __units[${pgen2}])`)
  let started = false
  for (let i = 0; i < 150 && !started; i++) {
    topUp()
    beat(engine)
    started = taskOf(eng)?.state === 'Processing'
  }
  const key = taskOf(eng)?.key ?? 0
  for (let i = 0; i < 5; i++) {
    topUp()
    beat(engine)
  }
  // IssueStop queues a Stop BEHIND the running command (clear = 0); the
  // engine's ClearCommandQueue removes every command and runs the task's
  // destructor (IssueClearCommands, 1005371-1005399).
  host.eval(`IssueClearCommands({ __units[${eng}] })`)
  beat(engine)
  const l = log()
  check(started && l.includes(`OnFailedBeingCaptured:${pgen2}:${eng}`) && l.includes(`OnFailedCapture:${eng}:${pgen2}`), 'OnFailedBeingCaptured(captor) on the target, OnFailedCapture(target) on the captor (827176-827181)')
  check(!isState(pgen2, 'BeingCaptured') && host.eval(`return __units[${pgen2}].__capturers`) === 0, 'the capturer taken back, BeingCaptured cleared (827144-827158)')
  check(!isState(eng, 'Capturing') && armyOf(pgen2) === 2 && alive(pgen2), 'the captor is free again; the target keeps its army')
  check(host.eval(`return __econBuildRate(1, ${key})`) === 0, 'the request is deleted (827364-827376)')
  host.eval(`__units[${pgen2}]:Destroy()`)
  beat(engine)
}

console.log('\n== The refusals: not capturable, an ally (Cfile:826629-826690) ==')
{
  const pgen3 = spawnLuaUnit(host, 'ueb1101', { x: 68, y: 20, z: 52 }, 2)
  beat(engine)
  hook(pgen3)
  host.eval(`__capLog = {}`)
  host.eval(`__units[${pgen3}]:SetCapturable(false)`)
  host.eval(`IssueCapture({ __units[${eng}] }, __units[${pgen3}])`)
  beat(engine)
  beat(engine)
  let l = log()
  // The early exit hands the captor ITSELF as the argument (826721: &mUnit).
  check(l.includes(`OnStopCapture:${eng}:${eng}`) && !l.some((e) => e.startsWith('OnStart')) && queueLen(eng) === 0, 'a non-capturable target: OnStopCapture at once with the captor as the argument, no start (826646-826649, 826721)')
  host.eval(`__units[${pgen3}]:SetCapturable(true)`)
  host.eval(`SetAlliance(1, 2, 'Ally')`)
  host.eval(`__capLog = {}`)
  host.eval(`IssueCapture({ __units[${eng}] }, __units[${pgen3}])`)
  beat(engine)
  beat(engine)
  l = log()
  check(queueLen(eng) === 0 && !l.some((e) => e.startsWith('OnStart') || e.startsWith('OnStop') || e.startsWith('OnFailed')), 'an allied target ends the task without a word (826688-826690)')
  host.eval(`SetAlliance(1, 2, 'Enemy')`)
  host.eval(`__units[${pgen3}]:Destroy()`)
  beat(engine)
}

console.log('\n== ChangeUnitArmy (cfunc_ChangeUnitArmyL, Cfile:1089461-1089587) ==')
{
  check(errorOf(`ChangeUnitArmy(__units[${tank}])`).includes('expected 2 args'), 'one argument is the arity error')
  check(errorOf(`ChangeUnitArmy(__units[${tank}], 0)`).includes('Invalid army'), '"Invalid army %d" for an undeclared army (1089500; ARMY_FromLuaState through __resolveArmy)')
  check(errorOf(`ChangeUnitArmy(__units[${tank}], 1)`).includes('Unit already belongs to army 1'), '"Unit already belongs to army %d" for its own (1089503)')
  host.eval(`__units[${tank}]:SetCustomName('Rex') __units[${tank}]:SetHealth(nil, 123)`)
  const nid = Number(host.eval(`local n = ChangeUnitArmy(__units[${tank}], 2) return n and n.__id or -1`))
  beat(engine)
  check(nid > 0 && armyOf(nid) === 2 && host.eval(`return string.lower(__units[${nid}].__bp.BlueprintId) == 'uel0201'`) === true, 'the new unit of the same blueprint belongs to the new army')
  check(host.eval(`return __units[${nid}].__customName == 'Rex'`) === true && Math.abs(Number(host.eval(`return __units[${nid}].__health`)) - 123) < 1e-6, 'the custom name and the health are copied (1073938-1073944)')
  check(!alive(tank), 'the old unit is destroyed')
  const p = posOf(nid)
  check(Math.abs(p[0]! - 200) < 1e-6 && Math.abs(p[2]! - 200) < 1e-6, 'at the same position')
  host.eval(`__units[${nid}]:Destroy()`)
  beat(engine)
}

console.log('\n== Two capturers: one step per capturer per tick (Cfile:826975-826981) ==')
{
  // Two fresh engineers beside the target: both start within a few beats.
  const eng2 = spawnLuaUnit(host, 'uel0105', { x: 76, y: 20, z: 86 }, 1)
  const eng3 = spawnLuaUnit(host, 'uel0105', { x: 84, y: 20, z: 86 }, 1)
  const pgen5 = spawnLuaUnit(host, 'ueb1101', { x: 80, y: 20, z: 90 }, 2)
  beat(engine)
  host.eval(`IssueCapture({ __units[${eng2}], __units[${eng3}] }, __units[${pgen5}])`)
  let both = false
  for (let i = 0; i < 60 && !both; i++) {
    topUp()
    beat(engine)
    both = taskOf(eng2)?.state === 'Processing' && taskOf(eng3)?.state === 'Processing'
  }
  const a0 = taskOf(eng2)?.capProgress ?? -1
  const b0 = taskOf(eng3)?.capProgress ?? -1
  for (let i = 0; i < 10; i++) {
    topUp()
    beat(engine)
  }
  const a1 = taskOf(eng2)?.capProgress ?? -1
  const b1 = taskOf(eng3)?.capProgress ?? -1
  if (!both) console.log(`  · states: ${taskOf(eng2)?.state} / ${taskOf(eng3)?.state}, queues ${queueLen(eng2)} / ${queueLen(eng3)}`)
  check(both && host.eval(`return __units[${pgen5}].__capturers`) === 2, 'the target counts two capturers')
  check(a1 - a0 === 20 && b1 - b0 === 20, `each task advances by the capturer count per tick (${a0} -> ${a1}, ${b0} -> ${b1} in 10 ticks)`)
  // The first to finish transfers the target; the other task ends on the
  // vanished target with OnStopCapture (826629-826650).
  hook(eng3)
  host.eval(`__capLog = {}`)
  let over = false
  for (let i = 0; i < 120 && !over; i++) {
    topUp()
    beat(engine)
    over = queueLen(eng2) === 0 && queueLen(eng3) === 0
  }
  const l = log()
  check(over && l.some((e) => e.startsWith(`OnStopCapture:${eng3}:`)), `both commands ended; the late task heard OnStopCapture (${l.filter((e) => e.startsWith('OnStopCapture')).join(' ')})`)
  host.eval(`IssueClearCommands({ __units[${eng2}], __units[${eng3}] })`)
  beat(engine)
}

console.log('\n== The economy events share the request facility (CreateEconomyEvent, globals.lua) ==')
{
  host.eval(`
    __evLog = {}
    __ev = CreateEconomyEvent(__units[${acu}], 100, 10, 2, function(entity, progress) __evLog[#__evLog + 1] = progress end)
  `)
  for (let i = 0; i < 25; i++) {
    topUp()
    beat(engine)
  }
  const evLog = host.pull<number[]>(`__jsonVal(__evLog)`)
  check(host.eval(`return __ev:IsDone()`) === true && evLog.length >= 20 && evLog[evLog.length - 1] === 1, `the event reached 1 over its 20 ticks (${evLog.length} callbacks, last ${evLog[evLog.length - 1]})`)
  check(evLog.length > 1 && evLog[0]! > 0 && evLog[0]! < 0.1, `the first callback saw the first tick's share (${evLog[0]})`)
}

console.log('\n== What the sim reported ==')
const uniq = [...new Set(warnings.map((w) => w.split('\n')[0]?.slice(0, 120)))]
for (const w of uniq.slice(0, 14)) console.log(`  · ${w}`)
const luaErrors = uniq.filter((w) => w && /Error running lua script|attempt to|capture\.lua|Failed to get valid capture/i.test(w))
check(luaErrors.length === 0, `no Lua errors in the capture (${luaErrors.length})`)

console.log(failures === 0 ? '\nCAPTURE PASSED' : `\nCAPTURE: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
