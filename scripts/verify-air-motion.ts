/**
 * The air motion: CUnitMotion::CalcMoveAir through the original blueprints.
 *
 * A UEF T1 transport (uea0107, a hover flyer) and a UEF interceptor (uea0102,
 * winged) on the flat test map with one ridge. The flyer is a rigid body
 * driven by ComputeAirControl (Cfile:968961-969184): the desired velocity
 * toward the navigator's target becomes a force through KMove and the
 * damping factor, the desired pose a torque through KTurn; the body
 * integrates with dt = 0.1 (969959-969975). The cruise height is
 * Physics.Elevation plus a random offset (GetElevation 967776-967791), the
 * terrain look-ahead lifts the target elevation before a ridge
 * (969629-969673), an idle flyer lands after Air.AutoLandTime
 * (969461-969536, the touchdown 969706-969739) and takes off again with
 * the next order (969748-969753, 969985).
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-air-motion.ts
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
// A flat map at 20 with one ridge at 60 across x in [180, 200).
const ridge = (x: number): number => (x >= 180 && x < 200 ? 60 : 20)
setTerrainSource(host, (x) => ridge(x), FLAT_TEST_MAP_SIZE)
game.loadProjectiles(host)
game.loadProps(host)
await game.giveUnit(host, 'uea0107')
await game.giveUnit(host, 'uea0102')
await game.giveUnit(host, 'uel0201')
await game.giveUnit(host, 'uea0003')
await game.giveUnit(host, 'uaa0107')

const posOf = (id: number): number[] => host.pull<number[]>(`__jsonVal(__units[${id}]:GetPosition())`)
const isState = (id: number, s: string): boolean => host.eval(`return __units[${id}]:IsUnitState('${s}')`) === true
const layerOf = (id: number): string => host.eval(`return __units[${id}].__layer`) as string
const vertOf = (id: number): string => host.eval(`return __units[${id}].__vertEvent or 'Top'`) as string
const horzOf = (id: number): string => host.eval(`return __units[${id}].__horzEvent or 'Stopped'`) as string
const speedOf = (id: number): number => Number(host.eval(`local b = __units[${id}].__air.body.vel return math.sqrt(b[1]*b[1]+b[3]*b[3])`))
const queueLen = (id: number): number => Number(host.eval(`local n = __orderActive[${id}] and 1 or 0 return n + #(__orders[${id}] or {})`))
const upX = (id: number): number => Number(host.eval(`local o = __units[${id}].__orient local w,x,y,z = o[4],o[1],o[2],o[3] return 2*(x*y - w*z)`))

console.log('\n== The body from the blueprint (CUnitMotion ctor, Cfile:964840-964854) ==')
{
  const t = spawnLuaUnit(host, 'uea0107', { x: 60, y: 20, z: 60 }, 1)
  beat(engine)
  // The Air defaults of the ctor (656086-656129) beside the .bp's own values.
  check(host.eval(`return __units[${t}].__bp.Air.KTurn`) === 1, 'uea0107 Air.KTurn = 1 from the .bp')
  check(host.eval(`return __units[${t}].__bp.Air.TurnSpeed`) === 1, 'Air.TurnSpeed is the ctor default 1.0 (656089)')
  check(host.eval(`return __units[${t}].__bp.Air.SustainedTurnThreshold`) === 10, 'Air.SustainedTurnThreshold is the ctor default 10.0 (656095)')
  check(host.eval(`return __units[${t}].__bp.Air.TransportHoverHeight`) === 3, 'Air.TransportHoverHeight = 3 from the .bp')
  check(host.eval(`return __bpDefaults.AverageDensity`) === 0.49 && host.eval(`return __bpDefaults.SizeY`) === 1, 'the entity defaults AverageDensity 0.49 and Size 1 (646969-646973)')
  const inertia = host.pull<number[]>(`(function() local b = __units[${t}].__bp return __jsonVal({ b.InertiaTensorX, b.InertiaTensorY, b.InertiaTensorZ, b.SizeX, b.SizeY, b.SizeZ }) end)()`)
  const [ix, iy, iz, sx, sy, sz] = inertia as [number, number, number, number, number, number]
  check(Math.abs(ix - (sz * sz + sy * sy) / 12) < 1e-6 && Math.abs(iy - (sz * sz + sx * sx) / 12) < 1e-6 && Math.abs(iz - (sy * sy + sx * sx) / 12) < 1e-6,
    `the inertia tensor is the box's (647192-647199): ${ix.toFixed(3)}, ${iy.toFixed(3)}, ${iz.toFixed(3)}`)
  const body = host.pull<{ mass: number; inv: number[] }>(`(function() local b = __units[${t}].__air.body return __jsonVal({ mass = b.mass, inv = b.invInertia }) end)()`)
  const density = Number(host.eval(`return __units[${t}].__bp.AverageDensity`))
  check(Math.abs(body.mass - density * sx * sy * sz) < 1e-6, `mass = AverageDensity (${density}) * SizeX * SizeY * SizeZ (${body.mass.toFixed(3)})`)
  check(Math.abs(body.inv[0]! - 1 / (ix * body.mass)) < 1e-6, 'the inverse inertia is 1 / (tensor * mass)')
  // GetElevation: Physics.Elevation plus the random offset within +-1.
  const p = posOf(t)
  check(Math.abs(p[1]! - 30) <= 1.0001, `the flyer spawned at surface + Elevation (10) and holds it (y ${p[1]!.toFixed(2)})`)
  const rnd = Number(host.eval(`return __units[${t}].__air.randomElevation`))
  // A POD draws no offset (964919-964939); every other flyer one in
  // +-SimConVar_RandomElevationOffset (1.0).
  const pod = spawnLuaUnit(host, 'uea0003', { x: 90, y: 20, z: 60 }, 1)
  beat(engine)
  const podRnd = Number(host.eval(`return __units[${pod}].__air.randomElevation`))
  check(Math.abs(rnd) <= 1 && rnd !== 0 && podRnd === 0, `the random cruise offset lies in +-SimConVar_RandomElevationOffset (${rnd.toFixed(3)}); a POD (uea0003) draws none (${podRnd})`)
  host.eval(`__units[${t}]:Destroy()`)
  host.eval(`__units[${pod}]:Destroy()`)
  beat(engine)
}

console.log('\n== A move: the controller flies the transport to its target ==')
const transport = spawnLuaUnit(host, 'uea0107', { x: 60, y: 20, z: 120 }, 1)
beat(engine)
{
  host.eval(`IssueMove({ __units[${transport}] }, { 120, 20, 120 })`)
  let arrived = false
  let maxSpeed = 0
  let sawTop = false
  let minY = 1e9
  let maxY = -1e9
  let sawOrient = false
  let beats = 0
  for (let i = 0; i < 300 && !arrived; i++) {
    beat(engine)
    beats++
    const s = speedOf(transport)
    if (s > maxSpeed) maxSpeed = s
    if (horzOf(transport) === 'TopSpeed') sawTop = true
    const p = posOf(transport)
    if (p[1]! < minY) minY = p[1]!
    if (p[1]! > maxY) maxY = p[1]!
    if (!sawOrient) {
      // The row the worker ships (units.lua readRow / __readAllUnitsJson):
      // a unit quaternion (x, y, z, w) for a flyer.
      const rows = JSON.parse(host.eval(`return __readAllUnitsJson()`) as string) as Array<{ id: number; orient?: number[] }>
      const q = rows.find((r) => r.id === transport)?.orient
      if (q && q.length === 4 && Math.abs(Math.hypot(q[0]!, q[1]!, q[2]!, q[3]!) - 1) < 1e-3) sawOrient = true
    }
    arrived = queueLen(transport) === 0
  }
  const p = posOf(transport)
  check(arrived, `the move order completed (${beats} beats)`)
  check(Math.abs(p[0]! - 120) < 3 && Math.abs(p[2]! - 120) < 3, `the transport is at its target (${p.map((v) => v.toFixed(1)).join(',')})`)
  check(maxSpeed > 8 && maxSpeed <= 10.5, `it flew near Air.MaxAirspeed 10 m/s (peak ${maxSpeed.toFixed(2)} m/s)`)
  check(sawTop, 'the horizontal event reached TopSpeed on the way (969841-969844)')
  check(horzOf(transport) === 'Stopped' || horzOf(transport) === 'Stopping', `it is ${horzOf(transport)} at the target (969848-969855)`)
  check(minY > 26 && maxY < 34, `it kept its cruise height on the way (y ${minY.toFixed(1)}..${maxY.toFixed(1)})`)
  check(layerOf(transport) === 'Air', 'it stays in the Air layer (969985)')
  check(sawOrient, 'the JSON row carries the full pose of the flyer as a unit quaternion')
  // The names table (Cfile:421838) makes level flight "Top" (the label
  // UMVE_Bottom is the value 0); a landed flyer is "Bottom" (unit.lua:2216
  // plays "Landed" on it).
  check(vertOf(transport) === 'Top', `the vertical event is Top in level flight (${vertOf(transport)})`)
}

console.log('\n== AutoLandTime: the idle transport lands, the next order lifts it ==')
{
  // uea0107: Air.AutoLandTime = 1 -- ten ticks after the target the landing
  // spot is prepared (969461-969512), MovingDown, then the touchdown puts
  // it on the Land layer with the Top event (969706-969739).
  let landed = false
  let sawDown = false
  for (let i = 0; i < 200 && !landed; i++) {
    beat(engine)
    if (isState(transport, 'MovingDown') || vertOf(transport) === 'Down') sawDown = true
    landed = vertOf(transport) === 'Bottom' && layerOf(transport) === 'Land'
  }
  const p = posOf(transport)
  check(sawDown, 'MovingDown / the Down event on the way to the ground (969573, 969831)')
  check(landed, `the transport landed: Top event, Land layer (${vertOf(transport)}, ${layerOf(transport)})`)
  check(Math.abs(p[1]! - 20) < 0.6, `it rests on the terrain (y ${p[1]!.toFixed(2)})`)
  check(speedOf(transport) < 0.01, 'its velocity is zero on the ground (969735-969738)')
  // Take-off: a new target clears the landing, MovingUp and the Up event
  // (SetTarget 965164-965170, 969748-969753, 969877), the Air layer again.
  host.eval(`IssueMove({ __units[${transport}] }, { 60, 20, 120 })`)
  let sawUp = false
  let airborne = false
  for (let i = 0; i < 60 && !airborne; i++) {
    beat(engine)
    if (vertOf(transport) === 'Up' || isState(transport, 'MovingUp')) sawUp = true
    const q = posOf(transport)
    airborne = layerOf(transport) === 'Air' && q[1]! > 24
  }
  check(sawUp, 'MovingUp / the Up event on take-off')
  check(airborne, `it is airborne again (y ${posOf(transport)[1]!.toFixed(1)}, ${layerOf(transport)})`)
  let done = false
  for (let i = 0; i < 300 && !done; i++) {
    beat(engine)
    done = queueLen(transport) === 0
  }
  check(done && Math.abs(posOf(transport)[0]! - 60) < 3, 'the second move completes back at the start')
}

console.log('\n== A body with a collision offset lands on its point (sub_698350, Cfile:941347-941443) ==')
{
  // uaa0107: CollisionOffsetY = -2, AutoLandTime = 1, Elevation = 8. The
  // collision point is the entity's position, a lever arm away from the
  // body's centre; the landing puts that point on the ground.
  const aeon = spawnLuaUnit(host, 'uaa0107', { x: 60, y: 20, z: 200 }, 1)
  let landed = false
  let beats = 0
  for (let i = 0; i < 150 && !landed; i++) {
    beat(engine)
    beats++
    landed = layerOf(aeon) === 'Land'
  }
  for (let i = 0; i < 5; i++) beat(engine)
  const p = posOf(aeon)
  const v = Number(host.eval(`local b = __units[${aeon}].__air.body.vel return math.sqrt(b[1]*b[1]+b[2]*b[2]+b[3]*b[3])`))
  check(landed && Math.abs(p[1]! - 20) < 0.5, `the offset body landed on the Land layer with its point on the ground (y ${p[1]!.toFixed(2)}, ${beats} beats)`)
  check(Number.isFinite(p[0]!) && Number.isFinite(p[2]!) && v < 0.05, `it rests there (|v| ${v.toFixed(3)} m/s)`)
  host.eval(`__units[${aeon}]:Destroy()`)
  beat(engine)
}

console.log('\n== The ground collision of a body with a collision offset (sub_698350, Cfile:941347-941443) ==')
{
  // uaa0107 (CollisionOffsetY = -2): the collision point is a lever arm
  // r = -R(offset) from the body's centre. A level body moving at (8, -3, 0)
  // with the angular impulse L and its point 0.1 under the ground at 20:
  // the point's velocity vp = v + w x r (w = I^-1 L for the level body),
  // then impulse' = (L + m * (r x (-vp/2))) * 0.9, v' = (v - vp/2) * 0.9,
  // and the body lifted by the penetration (941397-941442).
  type Probe = { mass: number; offset: number[]; inv: number[]; hit: boolean; pos: number[]; vel2: number[]; impulse2: number[] }
  const aeon = spawnLuaUnit(host, 'uaa0107', { x: 60, y: 20, z: 200 }, 1)
  beat(engine)
  const v0 = [8, -3, 0]
  const L0 = [0.2, 0.1, -0.3]
  const r0 = host.pull<Probe>(`(function()
    local u = __units[${aeon}]
    local st = u.__air
    local b = st.body
    st.curElevation = 0.5
    b.orient = { 1, 0, 0, 0 }
    b.vel = { ${v0.join(', ')} }
    b.impulse = { ${L0.join(', ')} }
    b.pos = { 60, 20 - 0.1 + b.offset[2], 200 }
    local hit = __airGroundCollision(u, st)
    return __jsonVal({ mass = b.mass, offset = b.offset, inv = b.invInertia, hit = hit, pos = b.pos, vel2 = b.vel, impulse2 = b.impulse })
  end)()`)
  const cross = (a: number[], b: number[]): number[] => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!]
  const norm = (a: number[]): number => Math.hypot(a[0]!, a[1]!, a[2]!)
  const r = r0.offset.map((c) => -c)
  const w = [0, 1, 2].map((k) => r0.inv[k]! * L0[k]!)
  const wr = cross(w, r)
  const vp = [0, 1, 2].map((k) => v0[k]! + wr[k]!)
  const lin = vp.map((c) => -c * 0.5)
  const expImpulse = cross(r, lin).map((c, k) => (L0[k]! + r0.mass * c) * 0.9)
  const expVel = [0, 1, 2].map((k) => (v0[k]! + lin[k]!) * 0.9)
  const dI = norm([0, 1, 2].map((k) => r0.impulse2[k]! - expImpulse[k]!))
  const dV = norm([0, 1, 2].map((k) => r0.vel2[k]! - expVel[k]!))
  check(r0.hit && Math.abs(r0.offset[1]! + 2) < 1e-6 && norm(wr) > 0.01, `the point collides; its lever arm r = (${r.map((c) => c.toFixed(2)).join(', ')}) turns the spin into ${norm(wr).toFixed(3)} m/s of point velocity`)
  check(dI < 1e-4 && dV < 1e-4, `the impulse took r x (-m vp/2) and the velocity -vp/2, both damped by 0.9 (errors ${dI.toExponential(1)}, ${dV.toExponential(1)})`)
  check(Math.abs(r0.pos[1]! - (20 + r0.offset[1]!)) < 1e-6, `the body was lifted by the penetration: the point on the ground (y ${r0.pos[1]!.toFixed(3)})`)
  host.eval(`__units[${aeon}]:Destroy()`)
  beat(engine)
}

console.log('\n== The winged interceptor banks into its turn (CalcWingedOrientation, Cfile:968384-968648) ==')
{
  const jet = spawnLuaUnit(host, 'uea0102', { x: 60, y: 20, z: 60 }, 1)
  beat(engine)
  check(host.eval(`return __units[${jet}].__bp.Air.Winged`) === true, 'uea0102 is Winged')
  // A target off to the side: the up axis leans (BankFactor 2) while the
  // desired heading differs from the forward.
  host.eval(`IssueMove({ __units[${jet}] }, { 140, 20, 60 })`)
  let maxBank = 0
  let arrived = false
  let minAbove = 1e9
  for (let i = 0; i < 300 && !arrived; i++) {
    beat(engine)
    const b = Math.abs(upX(jet))
    if (b > maxBank) maxBank = b
    const p = posOf(jet)
    const above = p[1]! - ridge(p[0]!)
    if (above < minAbove) minAbove = above
    arrived = queueLen(jet) === 0
  }
  check(maxBank > 0.1, `the interceptor banked in the turn (|up.x| peak ${maxBank.toFixed(3)})`)
  check(arrived, 'the interceptor reached its target')
  check(minAbove > 2, `it never touched the ground (min ${minAbove.toFixed(1)} above)`)
  host.eval(`__units[${jet}]:Destroy()`)
  beat(engine)
}

console.log('\n== The terrain look-ahead lifts the flight before the ridge (STIMap::LookAheadForMaxTerrain, Cfile:859169-859220) ==')
{
  const jet = spawnLuaUnit(host, 'uea0102', { x: 100, y: 20, z: 150 }, 1)
  beat(engine)
  host.eval(`IssueMove({ __units[${jet}] }, { 240, 20, 150 })`)
  let arrived = false
  let minClearance = 1e9
  let targetBeforeRidge = 0
  for (let i = 0; i < 400 && !arrived; i++) {
    beat(engine)
    const p = posOf(jet)
    const clearance = p[1]! - ridge(p[0]!)
    if (clearance < minClearance) minClearance = clearance
    // The look-ahead's smoothed ground (mTargetElevation, 969660-969677)
    // while the jet is still over the flat: the flown height there depends
    // on the unseeded random cruise offset and sits right at the ridge top.
    if (p[0]! >= 168 && p[0]! < 180) {
      const te = Number(host.eval(`return __units[${jet}].__air.targetElevation`))
      if (te > targetBeforeRidge) targetBeforeRidge = te
    }
    arrived = queueLen(jet) === 0
  }
  check(arrived, 'the flight over the ridge completed')
  check(targetBeforeRidge > 40, `the look-ahead raised the target elevation before the ridge (${targetBeforeRidge.toFixed(1)} at x 168-180; flat 20, ridge top 60)`)
  check(minClearance > 0, `it cleared the ridge (min clearance ${minClearance.toFixed(1)})`)
  host.eval(`__units[${jet}]:Destroy()`)
  beat(engine)
}

console.log('\n== A loaded transport hovers at TransportHoverHeight (ShouldHoverInsteadOfLand, Cfile:967749-967775) ==')
{
  const tank = spawnLuaUnit(host, 'uel0201', { x: 100, y: 20, z: 220 }, 1)
  const carrier = spawnLuaUnit(host, 'uea0107', { x: 70, y: 20, z: 220 }, 1)
  beat(engine)
  host.eval(`IssueTransportLoad({ __units[${tank}] }, __units[${carrier}])`)
  let loaded = false
  for (let i = 0; i < 500 && !loaded; i++) {
    beat(engine)
    loaded = host.eval(`return __units[${tank}].__transportedBy == ${carrier}`) === true
  }
  check(loaded, 'the tank boarded through the flight to the passengers (a Land-layer goal, 853121)')
  let hover = false
  for (let i = 0; i < 60 && !hover; i++) {
    beat(engine)
    hover = vertOf(carrier) === 'Hover'
  }
  const p = posOf(carrier)
  check(hover, `the loaded transport hovers instead of landing (${vertOf(carrier)})`)
  check(Math.abs(p[1]! - 23) < 1.5, `at TransportHoverHeight 3 above the ground (y ${p[1]!.toFixed(2)})`)
  // The engine's cache: mTransportLoadFactor is computed on the transport's
  // first tick, before any cargo, and only the Unit ctor and AttachTo /
  // DetachFrom of the attached unit itself reset the field (949682, 954392,
  // 954415) -- a loaded transport keeps the 1 of its first tick.
  check(host.eval(`return __transportLoadFactor(__units[${carrier}]) == 1`) === true, 'CalcTransportLoadFactor keeps the cached 1 of the first tick under cargo (952491-952512, 949682)')
  host.eval(`__units[${carrier}].__transportLoadFactor = -1`)
  check(host.eval(`return __transportLoadFactor(__units[${carrier}]) > 1`) === true, 'reset to -1 it recomputes (cargo mass + own mass) / own mass > 1 (952497-952512)')
}

console.log('\n== A dead flyer falls (CalcMoveAir 969888-969949) ==')
{
  const jet = spawnLuaUnit(host, 'uea0102', { x: 60, y: 20, z: 40 }, 1)
  beat(engine)
  host.eval(`
    __airLog = {}
    local u = __units[${jet}]
    local base = u.OnImpact
    u.OnImpact = function(self, with) __airLog[#__airLog+1] = 'impact:' .. tostring(with) if base then return base(self, with) end end
    local b2 = u.OnMotionStateChange
    u.OnMotionStateChange = function(self, new, old) __airLog[#__airLog+1] = 'motion:' .. tostring(new) if b2 then return b2(self, new, old) end end
  `)
  const y0 = posOf(jet)[1]!
  // AirUnit.OnKilled (defaultunits.lua:1505-1526) rolls
  // DestroyNoFallRandomChance (1394, 0.5): below it the body is left to the
  // engine's fall and the ground's OnImpact forks the death thread; above it
  // MobileUnit.OnKilled forks the death thread at once and the unit is
  // destroyed in the air. The original's own knob makes the fall certain.
  host.eval(`__units[${jet}].DestroyNoFallRandomChance = 1`)
  host.eval(`__units[${jet}]:Kill()`)
  let crashed = false
  let minY = y0
  for (let i = 0; i < 80 && !crashed; i++) {
    beat(engine)
    // The death thread destroys the wreck body after a while: sample only
    // while the unit exists.
    const y = Number(host.eval(`local u = __units[${jet}] return (u and u.__pos and u.__pos[2]) or -1`))
    if (y >= 0 && y < minY) minY = y
    crashed = host.eval(`local u = __units[${jet}] return u ~= nil and u.__motionState == 'Crashed'`) === true
    if (host.eval(`return __units[${jet}] == nil`) === true) break
  }
  const log = host.pull<unknown>(`__jsonVal(__airLog)`)
  const entries = Array.isArray(log) ? (log as string[]) : []
  check(minY < y0 - 2, `the killed flyer lost height (from ${y0.toFixed(1)} to ${minY.toFixed(1)})`)
  check(entries.includes('motion:Ballistic'), `UMS_Ballistic on death (${entries.join(',')})`)
  check(entries.some((e) => e.startsWith('impact:Terrain')) && entries.includes('motion:Crashed'), `OnImpact("Terrain") and UMS_Crashed on the ground (${entries.join(',')})`)
}

console.log('\n== What the sim reported ==')
const uniq = [...new Set(warnings.map((w) => w.split('\n')[0]?.slice(0, 120)))]
for (const w of uniq.slice(0, 14)) console.log(`  · ${w}`)
const luaErrors = uniq.filter((w) => w && /Error running lua script|attempt to|air\.lua|OnMotion|OnLayerChange/i.test(w))
check(luaErrors.length === 0, `no Lua errors in the air motion (${luaErrors.length})`)

console.log(failures === 0 ? '\nAIR MOTION PASSED' : `\nAIR MOTION: ${failures} FAILURES`)
await game.close()
process.exit(failures === 0 ? 0 : 1)
