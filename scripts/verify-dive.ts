/**
 * The dive: UNITCOMMAND_Dive of a surfacing submarine -- the motion's
 * target layer flip (DispatchTask Cfile:830531-830543,
 * CUnitMotion::SetNewTargetLayer 965234-965274), HandleDivingAndSurfacing
 * (971735-971812), SnapToWater (970979-971036), the instant command
 * (842857-842872) and IssueDive (1008189-1008260) through the original
 * blueprints and unit.lua's OnMotionVertEventChange / OnLayerChange.
 *
 * A UEF Tigershark (ues0203: RULEUMT_SurfacingSub, Physics.Elevation -1.5,
 * MaxSpeed 6, RULEUCC_Dive) in 40 m of water over a 20 m seabed, a UEF
 * frigate (ues0103, RULEUMT_Water) that cannot dive, a Seraphim destroyer
 * (xss0201) whose script surfaces it at birth and switches its turrets on
 * the events.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-dive.ts
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
// A seabed at 20 under 40 m of water, with a shelf at 39 across x in [140, 160).
const seabed = (x: number): number => (x >= 140 && x < 160 ? 39 : 20)
setTerrainSource(host, (x) => seabed(x), FLAT_TEST_MAP_SIZE)
host.eval('__setWaterLevel(40)')
game.loadProjectiles(host)
game.loadProps(host)
await game.giveUnit(host, 'ues0203')
await game.giveUnit(host, 'ues0103')
await game.giveUnit(host, 'xss0201')
host.eval('__diveLog = {}')

const posOf = (id: number): number[] => host.pull<number[]>(`__jsonVal(__units[${id}]:GetPosition())`)
const layerOf = (id: number): string => host.eval(`return __units[${id}].__layer`) as string
const vertOf = (id: number): string => host.eval(`return __units[${id}].__vertEvent or 'Top'`) as string
const isState = (id: number, s: string): boolean => host.eval(`return __units[${id}]:IsUnitState('${s}')`) === true
const queueLen = (id: number): number => Number(host.eval(`local n = __orderActive[${id}] and 1 or 0 return n + #(__orders[${id}] or {})`))
const errorOf = (code: string): string => {
  try {
    host.eval(code)
    return ''
  } catch (e) {
    return String((e as Error).message)
  }
}
const log = (): string[] => {
  const l = host.pull<unknown>(`__jsonVal(__diveLog)`)
  return Array.isArray(l) ? (l as string[]) : []
}
const hook = (id: number): void => {
  host.eval(`
    local u = __units[${id}]
    local b1 = u.OnMotionVertEventChange
    u.OnMotionVertEventChange = function(self, new, old)
      __diveLog[#__diveLog + 1] = 'vert:' .. tostring(new) .. '<' .. tostring(old)
      if b1 then return b1(self, new, old) end
    end
    local b2 = u.OnLayerChange
    u.OnLayerChange = function(self, new, old)
      __diveLog[#__diveLog + 1] = 'layer:' .. tostring(new) .. '<' .. tostring(old)
      if b2 then return b2(self, new, old) end
    end
  `)
}

console.log('\n== A submarine born in the Sub layer (CUnitMotion ctor, Cfile:964891-964904) ==')
const sub = spawnLuaUnit(host, 'ues0203', { x: 60, y: 0, z: 60 }, 1)
beat(engine)
hook(sub)
{
  const p = posOf(sub)
  check(layerOf(sub) === 'Sub', `it starts in the Sub layer (${layerOf(sub)})`)
  check(Math.abs(p[1]! - 38.5) < 1e-6, `at the water minus Physics.Elevation 1.5 (y ${p[1]!.toFixed(2)})`)
  check(host.eval(`return __units[${sub}].__subElevation`) === -1.5, 'mSubElevation is Physics.Elevation (964899)')
  check(vertOf(sub) === 'Bottom', `the vertical event is Bottom (the label UMVE_Top with names[1], 964895-964903; ${vertOf(sub)})`)
}

console.log('\n== IssueDive: the binding (cfunc_IssueDiveL, Cfile:1008189-1008260) ==')
const frigate = spawnLuaUnit(host, 'ues0103', { x: 80, y: 0, z: 60 }, 1)
beat(engine)
{
  check(errorOf(`IssueDive({ __units[${sub}] }, 1)`).includes('expected 1 args'), 'two arguments are the arity error')
  check(host.eval(`return IssueDive({ __units[${frigate}] }) == nil`) === true && queueLen(frigate) === 0, 'a RULEUMT_Water frigate gets no command and nil (func_ProcessUnitCommand 1006861-1006864)')
  check(host.eval(`return IssueDive({}) == nil`) === true, 'an empty list returns nil (1008247)')
  check(layerOf(frigate) === 'Water' && Math.abs(posOf(frigate)[1]! - 40) < 1e-6, `the frigate floats on the water (${layerOf(frigate)}, y ${posOf(frigate)[1]!.toFixed(1)})`)
}

console.log('\n== Surfacing: Sub -> Water (SetNewTargetLayer 965247-965262, HandleDivingAndSurfacing 971779-971791) ==')
{
  host.eval(`__diveLog = {}`)
  const handle = host.eval(`local h = IssueDive({ __units[${sub}] }) return h ~= nil`) === true
  check(handle, 'IssueDive returns the command handle (1008240-1008244)')
  beat(engine)
  check(isState(sub, 'MovingUp') && log().includes('vert:Up<Bottom'), 'the dispatch sets MovingUp and the "Up" event (965247-965262)')
  check(queueLen(sub) === 0, 'the command is instant: gone after its tick (CommandIsInstant 842857-842872)')
  let ys: number[] = [posOf(sub)[1]!]
  let surfaced = false
  let beats = 0
  for (let i = 0; i < 60 && !surfaced; i++) {
    beat(engine)
    beats++
    ys.push(posOf(sub)[1]!)
    surfaced = layerOf(sub) === 'Water'
  }
  const steps = ys.slice(1).map((y, i) => y - ys[i]!)
  const monotonic = steps.every((d) => d >= -1e-9)
  // The last step is the remainder to 0 (971780-971782); every other one
  // lies between a tenth of the speed and the speed.
  const full = steps.slice(0, -1).filter((d) => d > 1e-9)
  const maxStep = Math.max(...full)
  const minStep = Math.min(...full)
  check(surfaced && Math.abs(posOf(sub)[1]! - 40) < 1e-6, `it reached the water surface in the Water layer (${beats} beats, y ${posOf(sub)[1]!.toFixed(2)})`)
  check(monotonic && maxStep <= 0.1 + 1e-9 && minStep >= 0.01 - 1e-9 && maxStep > 0.05, `the rise is monotonic on the sine ramp, steps in [0.01, 0.1] with the peak above 0.05 (${minStep.toFixed(3)}..${maxStep.toFixed(3)}; DiveSurfaceSpeed 1 * 0.1)`)
  const l = log()
  check(l.includes('layer:Water<Sub') && l.includes('vert:Top<Up') && !isState(sub, 'MovingUp'), 'on arrival OnLayerChange(Water, Sub), MovingUp cleared, the "Top" event (971785-971791)')
  check(l.indexOf('layer:Water<Sub') < l.indexOf('vert:Top<Up'), 'the layer changes before the event (971785 before 971789: unit.lua:2252 tests the layer)')
}

console.log('\n== Diving: Water -> Sub (965268-965272, 971796-971806) ==')
{
  host.eval(`__diveLog = {}`)
  host.eval(`IssueDive({ __units[${sub}] })`)
  beat(engine)
  check(isState(sub, 'MovingDown') && log().includes('vert:Down<Top'), 'the dispatch sets MovingDown and the "Down" event (965268-965272)')
  let dived = false
  let beats = 0
  for (let i = 0; i < 60 && !dived; i++) {
    beat(engine)
    beats++
    dived = layerOf(sub) === 'Sub'
  }
  const l = log()
  check(dived && Math.abs(posOf(sub)[1]! - 38.5) < 1e-6, `it reached its depth in the Sub layer (${beats} beats, y ${posOf(sub)[1]!.toFixed(2)})`)
  check(l.includes('layer:Sub<Water') && l.includes('vert:Bottom<Down') && !isState(sub, 'MovingDown'), 'on arrival OnLayerChange(Sub, Water), MovingDown cleared, the "Bottom" event (971801-971806)')
  // A second dive while diving is idempotent: the target layer comes from
  // the unit's layer, which flips only at the end.
  host.eval(`IssueDive({ __units[${sub}] })`)
  beat(engine)
  host.eval(`IssueDive({ __units[${sub}] })`)
  beat(engine)
  let again = false
  for (let i = 0; i < 60 && !again; i++) {
    beat(engine)
    again = layerOf(sub) === 'Water'
  }
  check(again, 'two dives during the surfacing still end on the surface (the target layer follows the unit\'s layer, 830531-830541)')
  host.eval(`IssueDive({ __units[${sub}] })`)
  for (let i = 0; i < 60 && layerOf(sub) !== 'Sub'; i++) beat(engine)
}

console.log('\n== Shallow water: the depth capped at the seabed + 0.25 (Cfile:971758-971765) ==')
{
  const shallow = spawnLuaUnit(host, 'ues0203', { x: 150, y: 0, z: 60 }, 1)
  beat(engine)
  // Born in 1 m of water the boat is still a Sub-layer spawn at Elevation
  // + water (683106-683111, under the shelf); surface it first, then dive:
  // the depth is capped at the seabed + 0.25 - water = -0.75 (971758-971765).
  host.eval(`IssueDive({ __units[${shallow}] })`)
  for (let i = 0; i < 60 && layerOf(shallow) !== 'Water'; i++) beat(engine)
  const y0 = posOf(shallow)[1]!
  host.eval(`IssueDive({ __units[${shallow}] })`)
  for (let i = 0; i < 60 && layerOf(shallow) !== 'Sub'; i++) beat(engine)
  const y = posOf(shallow)[1]!
  check(Math.abs(y0 - 40) < 1e-6 && layerOf(shallow) === 'Sub' && Math.abs(y - 39.25) < 1e-6, `over the shelf at 39 the boat surfaces to 40 and dives to 39.25, not to 38.5 (y ${y.toFixed(2)}, ${layerOf(shallow)})`)
  host.eval(`__units[${shallow}]:Destroy()`)
  beat(engine)
}

console.log('\n== The queue: IssueDive appends, the user\'s Dive clears (Cfile:1008223, 1265527) ==')
{
  host.eval(`IssueMove({ __units[${sub}] }, { 100, 0, 60 })`)
  host.eval(`IssueDive({ __units[${sub}] })`)
  check(queueLen(sub) === 2, `IssueDive appends behind the move (queue ${queueLen(sub)})`)
  for (let i = 0; i < 5; i++) beat(engine)
  check(queueLen(sub) >= 1 && !isState(sub, 'MovingUp'), 'the move runs first; the dive waits its turn')
  host.eval(`__dispatchDive(${sub}, true)`)
  beat(engine)
  check(queueLen(sub) === 0 && isState(sub, 'MovingUp'), 'the user\'s Dive with clear replaces the queue and surfaces at once')
  host.eval(`__dispatchDive(${frigate}, true)`)
  check(queueLen(frigate) === 0, 'the user dispatch drops a unit that is no SurfacingSub (1006861-1006864)')
  for (let i = 0; i < 60 && layerOf(sub) !== 'Water'; i++) beat(engine)
  const y = posOf(sub)[1]!
  check(layerOf(sub) === 'Water' && Math.abs(y - 40) < 1e-6, `surfaced again (y ${y.toFixed(2)})`)
  host.eval(`IssueMove({ __units[${sub}] }, { 100, 0, 60 })`)
  for (let i = 0; i < 30; i++) beat(engine)
  const q = posOf(sub)
  check(q[0]! > 62 && Math.abs(q[1]! - 40) < 1e-6, `a surfaced boat moves on the water surface (x ${q[0]!.toFixed(1)}, y ${q[1]!.toFixed(2)})`)
}

console.log('\n== The Seraphim destroyer surfaces at birth and switches its turrets (xss0201_script.lua:53-67) ==')
{
  const dest = spawnLuaUnit(host, 'xss0201', { x: 60, y: 0, z: 120 }, 1)
  const turret = (): boolean => host.eval(`local u = __units[${dest}] for _, w in ipairs(u.__weapons) do if w.__bp.Label == 'FrontTurret' then return w.__enabled ~= false end end return nil`) === true
  // A complete spawn runs OnStopBeingBuilt, whose IssueDive({self}) starts
  // the surfacing before the first beat moves it.
  check(layerOf(dest) === 'Sub' && Math.abs(posOf(dest)[1]! - 38) < 1e-6, `born submerged at its Elevation -2 (${layerOf(dest)}, y ${posOf(dest)[1]!.toFixed(2)})`)
  beat(engine)
  check(isState(dest, 'MovingUp') && posOf(dest)[1]! > 38, 'OnStopBeingBuilt issues IssueDive({self}): the boat surfaces (xss0201_script.lua:66)')
  for (let i = 0; i < 60 && layerOf(dest) !== 'Water'; i++) beat(engine)
  check(layerOf(dest) === 'Water' && turret(), 'on "Top" the FrontTurret is enabled (xss0201_script.lua:55-57)')
  host.eval(`IssueDive({ __units[${dest}] })`)
  beat(engine)
  check(!turret(), 'on "Down" the turrets are disabled (58-60)')
}

console.log('\n== What the sim reported ==')
const uniq = [...new Set(warnings.map((w) => w.split('\n')[0]?.slice(0, 120)))]
for (const w of uniq.slice(0, 14)) console.log(`  · ${w}`)
const luaErrors = uniq.filter((w) => w && /Error running lua script|attempt to|dive\.lua|OnMotionVertEventChange|OnLayerChange/i.test(w))
check(luaErrors.length === 0, `no Lua errors in the dive (${luaErrors.length})`)

console.log(failures === 0 ? '\nDIVE PASSED' : `\nDIVE: ${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
