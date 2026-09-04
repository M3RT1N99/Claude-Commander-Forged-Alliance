/**
 * Die Fabrik produziert — über die Original-`FactoryUnit` (defaultunits.lua:422).
 *
 * Geprüft wird, dass die Engine der Fabrik genau das liefert, was sie erwartet,
 * und sonst nichts entscheidet:
 *
 *   __queueFactoryBuild(fabrik, 'uel0101', 2)     Warteschlange (IssueBlueprintCommand)
 *   __factoryTick()                               setzt die naechste Einheit auf
 *     → Baustelle AN der Fabrik (Sim::CreateUnit, beingBuilt = 1)
 *     → fabrik:OnStartBuild(unit, 'FactoryBuild') → FactoryUnit.BuildingState
 *   Beats                                         Fortschritt = BuildRate/BuildTime · Rate · 0.1
 *     → unit:OnStopBeingBuilt(fabrik, 'FactoryBuild')
 *     → fabrik:OnStopBuild(unit, 'FactoryBuild')  → RollOffUnit → IssueMove
 *
 * Die Zahlen kommen aus den Blueprints (uel0101: BuildTime, BuildCostMass), die
 * Reihenfolge aus der Decomp. Nichts davon steht in TypeScript.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-factory.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit, readLuaUnit } from '../src/lua/unitFactory'
import type { LuaUnitState } from '../src/lua/unitFactory'
import { GameFiles } from './gameFiles'
import { queueFactoryBuild } from '../src/sim/build'
import { FLAT_TEST_MAP_SIZE } from '../src/sim/terrain'

/**
 * `__readUnit` hands back the FULL row that `readRow` builds (units.lua:744-814),
 * build fraction included; the exported `LuaUnitState` only declares the subset
 * the renderer consumes. Read the row through the shape the Sim actually sends.
 */



let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const err = (expression: string): string =>
  host.eval(`local ok, e = pcall(function() ${expression} end); return ok and '' or tostring(e)`) as string

const game = await GameFiles.open()
const files = game.luaFiles

const warnings: string[] = []
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})
const engine = installEngine(host)
const readUnit = (id: number): LuaUnitState | null => readLuaUnit(host, id)
setTerrainSource(host, () => 20, FLAT_TEST_MAP_SIZE)
// Blueprint UND Skelett — beides braucht die Sim, bevor die erste Unit entsteht.
for (const id of ['uel0001', 'ueb0101', 'uel0101', 'uel0105']) await game.giveUnit(host, id)

console.log('\n== Fabrik + ACU stehen ==')
// Die ACU liefert der Armee ihren Startvorrat (GiveInitialResources); ohne
// Vorrat baut die Fabrik nichts — das ist keine Testkulisse, das ist das Spiel.
const acu = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
const factory = spawnLuaUnit(host, 'ueb0101', { x: 120, y: 20, z: 120 }, 1)
for (let i = 0; i < 8; i++) beat(engine)
check(acu > 0 && factory > 0, `ACU (${acu}) und Fabrik (${factory}) über die Original-Klassen`)
check(
  host.eval(`return __units[${factory}].BuildingState ~= nil`) === true,
  'Die Fabrik IST eine FactoryUnit (sie hat den BuildingState aus defaultunits.lua)',
)

console.log('\n== Warteschlange: zwei Panzer ==')
check(queueFactoryBuild(host, factory, 'uel0101', 2), '__queueFactoryBuild(uel0101, 2)')
check(
  Number(host.eval(`return table.getn(__units[${factory}].__buildQueue)`)) === 2
    && Number(host.eval(`return __readUnit(${factory}).buildQueue[1].count`)) === 2,
  'two BuildFactory commands (one per unit, Cfile:1265867-1265872), shown as ONE stack { id = uel0101, count = 2 } (construction.lua:1620)',
)

// Ein Beat: __factoryTick setzt die erste Einheit auf.
beat(engine)
const tank1 = Number(
  host.eval(`
    for id, u in pairs(__units) do
      if u.__bp and u.__bp.BlueprintId == 'uel0101' then return id end
    end
    return 0
  `),
)
check(tank1 > 0, `Die Fabrik hat den ersten Panzer aufgesetzt (id ${tank1})`)
const t0 = readUnit(tank1)
check(t0 !== null && t0.fraction < 1, `Er ist eine Baustelle (${((t0?.fraction ?? 0) * 100).toFixed(0)} %)`)
// BuildingState (defaultunits.lua:669-670) hangs the site on the factory:
// `unitBuilding:AttachBoneTo(-2, self, bp.Display.BuildAttachBone)` -- the
// site's own origin (-2) on the factory's 'Attachpoint' bone
// (ueb0101_unit.bp:95). From then on the site is wherever that bone is
// (Entity::TaskTick -> CalculateAttachedTransform, Cfile:916175-916190), not
// at the factory's origin.
const attachWorld = host.eval(`
  local f = __units[${factory}]
  local p = __boneWorld(f, 'Attachpoint')
  return p[1] .. ',' .. p[2] .. ',' .. p[3]
`) as string
const [ax, ay, az] = attachWorld.split(',').map(Number) as [number, number, number]
check(
  Math.abs((t0?.x ?? 0) - ax) < 1e-6 && Math.abs((t0?.y ?? 0) - ay) < 1e-6 && Math.abs((t0?.z ?? 0) - az) < 1e-6,
  `it hangs on the factory's Attachpoint (${ax.toFixed(3)}, ${ay.toFixed(3)}, ${az.toFixed(3)}), not at the factory origin`,
)
check(
  host.eval(`return __units[${tank1}]:GetParent() == __units[${factory}]`) === true,
  'GetParent() is the factory while attached (Cfile:932420-932423)',
)
check(
  host.eval(`return __units[${tank1}]:IsUnitState('Attached')`) === true,
  "IsUnitState('Attached') -- Unit::AttachTo sets UNITSTATEMASK_Attached (Cfile:954389)",
)
// The factory's list also carries its ambient-sound entity (unit.lua:2789
// `sndEnt:AttachTo(self, -1)`), so the site is looked up, not assumed alone.
const listing = host.eval(`
  local f = __units[${factory}]
  local out = {}
  for _, c in ipairs(f.__attachedEntities or {}) do
    local tag = c == __units[${tank1}] and 'site' or (c.__isUnit and 'unit' or 'entity')
    table.insert(out, tag .. '@' .. tostring(c.__attachParentBone) .. '/' .. tostring(c.__attachSelfBone))
  end
  return table.concat(out, ' ')
`) as string
const attachBone = Number(host.eval(`return __boneIndex(__units[${factory}], 'Attachpoint') - 1`))
check(
  listing.split(' ').includes(`site@${attachBone}/-2`),
  `the factory lists the site on its Attachpoint bone ${attachBone}, own reference bone -2 (list: ${listing})`,
)
check(
  host.eval(`return __units[${factory}]:GetParent() == __units[${factory}]`) === true,
  'an unattached entity is its own GetParent() (Cfile:932423)',
)
check(
  Number(host.eval(`local q = __readUnit(${factory}).buildQueue return q[1] and q[1].count or 0`)) === 2,
  'Die Warteschlange steht noch auf 2 — die BAUENDE Einheit bleibt gezaehlt ' +
    '(die Engine dekrementiert die BuildFactory-Command erst bei COMPLETION, ' +
    'Cfile:838029), also zeigt die Anzeige die echte Reststueckzahl',
)

console.log('\n== Der Panzer wird gebaut und rollt vom Hof ==')
const massBefore = engine.economy.army(1).mass
let ticks = 0
while (readUnit(tank1)!.fraction < 1 && ticks < 3000) {
  beat(engine)
  ticks++
}
const t1 = readUnit(tank1)!
check(t1.fraction >= 1, `Panzer fertig nach ${ticks} Beats (${(ticks / 10).toFixed(1)} s)`)
check(t1.health === t1.maxHealth, `Volles Leben: ${t1.health}`)
// FinishBuildThread (defaultunits.lua:540-542): `unitBeingBuilt:DetachFrom(true)`
// and `self:DetachAll(bp.Display.BuildAttachBone)` -- the finished tank is on
// its own again (Unit::DetachFrom clears the Attached bit, Cfile:954404) and
// the factory's attach list is empty.
check(
  host.eval(`return __units[${tank1}]:GetParent() == __units[${tank1}]`) === true,
  'after FinishBuildThread the tank is its own parent again (DetachFrom(true))',
)
check(
  host.eval(`return __units[${tank1}]:IsUnitState('Attached')`) === false,
  'and no longer Attached',
)
check(
  host.eval(`return table.getn(__units[${factory}].__attachedEntities or {}) == 0`) === true,
  'DetachAll(BuildAttachBone) emptied the factory list',
)
// COMPLETION decrements the queue (Cfile:838029: count>1 -> DecreaseCount(1)):
// 2 -> 1 now that the first tank is done, so the second still waits at count 1.
check(
  Number(host.eval(`return table.getn(__units[${factory}].__buildQueue) > 0 and __units[${factory}].__buildQueue[1].count or 0`)) === 1,
  'Nach der Fertigstellung steht die Warteschlange auf 1 (Dekrement bei COMPLETION)',
)
check(engine.economy.army(1).mass < massBefore, `Masse bezahlt: ${massBefore.toFixed(0)} → ${engine.economy.army(1).mass.toFixed(0)}`)

// FactoryUnit.OnStopBuild → RollOffUnit → IssueMove: der Panzer bekommt ein Ziel.
// Das ist der Beweis, dass die ORIGINAL-Lua den Befehl gegeben hat — die Engine
// setzt hier von sich aus keine Bewegung.
check(
  host.eval(`return __units[${tank1}].__goal ~= nil and __units[${tank1}].__goal ~= false`) === true,
  'Er hat ein Bewegungsziel (FactoryUnit.RollOffUnit → IssueMove, defaultunits.lua:571)',
)

// While the finished tank is still leaving the build pad the factory is BUSY
// and its queue is BLOCKED: FinishBuildThread sets SetBusy(true) +
// SetBlockCommandQueue(true) (defaultunits.lua:529-530), RolloffBody holds both
// until IsCommandDone(MoveCommand) reports the unit is clear
// (defaultunits.lua:643-649). Only then may the next unit come into being —
// otherwise it would grow INSIDE the one rolling off.
const countTanks = (): number =>
  Number(
    host.eval(`
      local n = 0
      for _, u in pairs(__units) do
        if u.__bp and u.__bp.BlueprintId == 'uel0101' then n = n + 1 end
      end
      return n
    `),
  )
for (let i = 0; i < 3; i++) beat(engine)
check(
  host.eval(`return __units[${factory}].__busy == true`) === true,
  'the factory is BUSY while the tank rolls off (SetBusy, defaultunits.lua:529)',
)
check(countTanks() === 1, 'and it starts NO second tank during that time')

// Wait for the roll-off: RolloffBody checks every 0.5 s (WaitSeconds), then IdleState.
let rollTicks = 0
while (host.eval(`return __units[${factory}].__busy == true`) === true && rollTicks < 300) {
  beat(engine)
  rollTicks++
}
check(rollTicks < 300, `the tank is clear after ${rollTicks} beats (RolloffBody → IdleState)`)
for (let i = 0; i < 3; i++) beat(engine)
const tanks = countTanks()
check(tanks === 2, `then the factory starts the second tank (${tanks} tanks)`)

// === The factory command list and the rally point ===
//
// A FACTORY builder keeps a command list beside the unit's own queue
// (CAiBuilderImpl::mCommands): the commands every product inherits
// (CFactoryBuildTask::InheritCommandsTo, Cfile:818487-818600). The unit
// constructor fills it with the blueprint's initial rally point
// (CAiBuilderImpl::IssueRallyPoint, 751236-751296, called at 950550-950552);
// GetRallyPoint reads the head's target position (980887-980900);
// IssueFactoryRallyPoint appends a Move without clearing (1008356);
// IssueClearFactoryCommands empties the list (RemoveAllUnits) and the builder
// tick puts the initial point back when the list is empty (751444-751445).
console.log('\n== The factory command list: initial rally, GetRallyPoint, clear, append ==')
{
  // The list as 'type|x|z' entries, ';'-joined (a plain string crosses the
  // wasmoon boundary without table conversion questions).
  const fcmds = (id: number): { type: string; x: number; z: number }[] => {
    const raw = host.eval(`
      local out = {}
      for i, c in ipairs(__factoryCommands[${id}] or {}) do
        out[i] = tostring(c.type) .. '|' .. tostring(c.x) .. '|' .. tostring(c.z)
      end
      return table.concat(out, ';')
    `) as string
    if (raw === '') return []
    return raw.split(';').map((e) => {
      const [type, x, z] = e.split('|')
      return { type: type ?? '', x: Number(x), z: Number(z) }
    })
  }
  const initial = fcmds(factory)
  // ueb0101 carries no Economy.InitialRallyX/Z of its own: the struct defaults
  // 0 / 5 apply (RUnitBlueprintEconomy ctor, Cfile:656498-656499); heading 0
  // puts the point 5 in +z (forward) of the factory at 120/120.
  check(
    initial.length === 1 && initial[0]!.type === 'Move'
      && Math.abs(initial[0]!.x - 120) < 1e-6 && Math.abs(initial[0]!.z - 125) < 1e-6,
    `the factory was created with the blueprint's initial rally Move at 120/125 (${JSON.stringify(initial)})`,
  )
  const rp = host.eval(`local p = __units[${factory}]:GetRallyPoint(); return p and (math.floor(p[1]) .. '|' .. math.floor(p[3])) or 'nil'`)
  check(rp === '120|125', `GetRallyPoint answers the head command's target (${rp}) -- Cfile:980887-980900`)
  // A rotated factory turns the offset with its heading (forward = sin/cos).
  const turned = Number(host.eval(`
    local u = CreateUnit('ueb0101', 1, 200, 20, 200, 0, math.sin(math.pi / 4), 0, math.cos(math.pi / 4))
    return u.__id
  `))
  const tl = fcmds(turned)
  check(
    tl.length === 1 && Math.abs(tl[0]!.x - (200 + 5 * Math.sin(Math.PI / 2))) < 1e-4
      && Math.abs(tl[0]!.z - (200 + 5 * Math.cos(Math.PI / 2))) < 1e-4,
    `a factory created with a 90 degree yaw rallies 5 in +x (${tl[0]?.x.toFixed(3)}/${tl[0]?.z.toFixed(3)})`,
  )
  host.eval(`__units[${turned}]:Destroy()`)
  // Append without clearing (the Lua binding passes clear = 0).
  host.eval(`IssueFactoryRallyPoint({ __units[${factory}] }, { 160, 20, 170 })`)
  const two = fcmds(factory)
  check(
    two.length === 2 && two[1]!.x === 160 && two[1]!.z === 170 && two[0]!.z === 125,
    `IssueFactoryRallyPoint APPENDS behind the initial point (${two.length} commands) -- Cfile:1008356`,
  )
  // The clear binding empties the list; the next factory tick restores the
  // initial rally point (CAiBuilderImpl::OnTick, 751444-751445).
  host.eval(`IssueClearFactoryCommands({ __units[${factory}] })`)
  check(fcmds(factory).length === 0, 'IssueClearFactoryCommands empties the list at once (RemoveAllUnits)')
  beat(engine)
  const restored = fcmds(factory)
  check(
    restored.length === 1 && restored[0]!.z === 125,
    `one beat later the builder tick re-issued the initial rally point (${JSON.stringify(restored)})`,
  )
  // aibrain.lua:2114-2115: clear, then rally -- the list holds only the new point.
  host.eval(`IssueClearFactoryCommands({ __units[${factory}] }); IssueFactoryRallyPoint({ __units[${factory}] }, { 160, 20, 170 })`)
  beat(engine)
  const only = fcmds(factory)
  check(only.length === 1 && only[0]!.x === 160 && only[0]!.z === 170, 'clear + rally in one step leaves exactly the new point (no tick in between)')
  check(
    err(`IssueFactoryRallyPoint({ __units[${factory}] })`).includes('expected 2 args, but got 1'),
    'IssueFactoryRallyPoint with one argument is the arg-count error (Cfile:1008311)',
  )
  check(
    err(`IssueClearFactoryCommands({ __units[${factory}] }, 1)`).includes('expected 1 args, but got 2'),
    'IssueClearFactoryCommands with two arguments is the arg-count error (Cfile:1008411)',
  )
  // The player's factory commands: clear = not shift.
  host.eval(`__dispatchFactoryPatrol(${factory}, 180, 180, false)`)
  host.eval(`__dispatchFactoryMove(${factory}, 190, 190, false)`)
  const queued = fcmds(factory)
  check(
    queued.length === 3 && queued[1]!.type === 'Patrol' && queued[2]!.type === 'Move',
    `shift-issued factory commands queue behind the rally point (${queued.map((c) => c.type).join(',')})`,
  )
  host.eval(`__dispatchFactoryMove(${factory}, 160, 170, true)`)
  check(fcmds(factory).length === 1, 'a factory command without shift replaces the whole list (ClearQueue byte)')
  // Non-factories are refused (GetBool1 is false for an engineer / ACU).
  host.eval(`__dispatchFactoryMove(${acu}, 1, 1, true)`)
  check(fcmds(acu).length === 0, 'the ACU (a builder, but no FACTORY) takes no factory command (Cfile:1007660-1007663)')
  // An entity-target command in the list resolves to the target's position
  // (CAiTarget::GetTargetPosGun) -- the Guard the products would inherit.
  host.eval(`__dispatchFactoryGuard(${factory}, ${acu}, false)`)
  const guarded = host.eval(`
    local list = __factoryCommands[${factory}]
    local c = list[#list]
    local x, y, z = __factoryCommandPos(c)
    return c.type .. '|' .. tostring(c.target == ${acu}) .. '|' .. math.floor(x) .. '/' .. math.floor(z) .. '|' .. #list
  `)
  check(guarded === 'Guard|true|100/100|2', `a factory Guard queues with the entity target and resolves to its position (${guarded})`)
  host.eval(`__dispatchFactoryMove(${factory}, 160, 170, true)`)
  const row = host.eval(`
    local r = __readUnit(${factory})
    if not r.fcmds then return 'nil' end
    return #r.fcmds .. '|' .. r.fcmds[1].t .. '|' .. r.fcmds[1].x .. '|' .. r.fcmds[1].y .. '|' .. r.fcmds[1].z
  `)
  check(row === '1|Move|160|20|170', `the unit row carries the list as fcmds with id/type/position for the user side (${row})`)
}

console.log('\n== Inheritance: the product drives the roll-off, then every factory command ==')
{
  // Rally Move at 160/170 plus a Patrol behind it; the product must take both.
  host.eval(`__dispatchFactoryPatrol(${factory}, 150, 150, false)`)
  const tank2 = Number(
    host.eval(`
      local newest = 0
      for id, u in pairs(__units) do
        if u.__bp and u.__bp.BlueprintId == 'uel0101' and id > newest then newest = id end
      end
      return newest
    `),
  )
  let t = 0
  while (t < 3000 && readUnit(tank2)!.fraction < 1) {
    beat(engine)
    t++
  }
  // One beat after completion: RollOffUnit issued the roll-off command, the
  // factory commands wait behind it in the queue -- in list order.
  beat(engine)
  const queued = host.eval(`
    local types = {}
    for _, c in ipairs(__orders[${tank2}] or {}) do types[#types + 1] = c.type end
    return table.concat(types, ',') .. '|' .. tostring(__orderActive[${tank2}] ~= nil)
  `)
  check(queued === 'Move,Patrol|true', `roll-off running, rally Move and Patrol queued behind it in order (${queued})`)
  let m = 0
  while (m < 2000 && host.eval(`local a = __orderActive[${tank2}]; return a ~= nil and a.type ~= 'Patrol'`) === true) {
    beat(engine)
    m++
  }
  const end = readLuaUnit(host, tank2)!
  check(
    Math.hypot(end.x - 160, end.z - 170) < 3,
    `it reached the rally point 160/170 before starting the patrol (${end.x.toFixed(1)}/${end.z.toFixed(1)}, after ${m} beats)`,
  )
  // Clean the factory list back to a single rally point for the checks below.
  host.eval(`__dispatchFactoryMove(${factory}, 160, 170, true)`)
}

// === Queue edited mid-build: completion drains the task's OWN command ===
//
// The engine decrements the specific command the CFactoryBuildTask was built
// from (DecreaseCount(1, v18), Cfile:838029), NOT a positional head. Reorder the
// queue while a unit builds and the completing unit must still drain ITS item.
console.log('\n== Queue edited mid-build: the right item is drained ==')
for (let i = 0; i < 40 && host.eval(`return __units[${factory}].__busy == true`) === true; i++) beat(engine)
queueFactoryBuild(host, factory, 'uel0101', 2)
beat(engine) // __factoryTick spawns the first tank from the (only) stack
const midTank = Number(
  host.eval(`
    local newest = 0
    for id, u in pairs(__units) do
      if u.__bp and u.__bp.BlueprintId == 'uel0101' and (u.__fraction or 1) < 1 and id > newest then newest = id end
    end
    return newest
  `),
)
check(midTank > 0, `a tank is building from the stack (id ${midTank})`)
// Slip a foreign command in FRONT of the building one — now q[1] is NOT the
// command the running task was built from. (A command with a count above 1
// is what the AI's IssueBuildFactory makes; the panel's commands carry 1.)
host.eval(`table.insert(__units[${factory}].__buildQueue, 1, { id = 'ZZFOREIGN', count = 5 })`)
let mb = 0
while (readUnit(midTank)!.fraction < 1 && mb < 3000) {
  beat(engine)
  mb++
}
check(readUnit(midTank)!.fraction >= 1, `the tank finished (${mb} beats)`)
check(
  Number(host.eval(`return __units[${factory}].__buildQueue[1].count`)) === 5,
  'the foreign command at q[1] is UNTOUCHED (completion drained its own command by identity, not q[1])',
)
check(
  Number(
    host.eval(`
      local n = 0
      for _, it in ipairs(__units[${factory}].__buildQueue) do
        if it.id == 'uel0101' then n = n + it.count end
      end
      return n
    `),
  ) === 1,
  'of the two tank commands it WAS building from, one is left (the completed one removed itself, Cfile:838029)',
)
host.eval(`
  local q = __units[${factory}].__buildQueue
  for i = table.getn(q), 1, -1 do if q[i].id == 'ZZFOREIGN' then table.remove(q, i) end end
`)

/**
 * Units a factory produced, counted by position: the engine spawns them AT the
 * factory (__factoryTick uses f.__pos), which this suite already relies on
 * above ("Er entsteht AN der Fabrik"). Counting by position rather than by some
 * builder back-reference keeps the check falsifiable — there is no
 * builder id on a spawned unit, so a field-based count would silently be 0.
 */
const producedNear = (x: number, z: number): number =>
  Number(
    host.eval(`
      local n = 0
      for _, u in pairs(__units) do
        if u.__bp and u.__bp.BlueprintId == 'uel0101' then
          local p = u.__pos or { 0, 0, 0 }
          local dx, dz = p[1] - ${x}, p[3] - ${z}
          if dx * dx + dz * dz < 400 then n = n + 1 end
        end
      end
      return n
    `),
  )

console.log('\n== Control: an untouched factory DOES produce (the counter works) ==')
{
  const okFactory = spawnLuaUnit(host, 'ueb0101', { x: 260, y: 0, z: 260 }, 1)
  queueFactoryBuild(host, okFactory, 'uel0101', 3)
  check(producedNear(260, 260) === 0, 'nothing there before the first beat')
  beat(engine)
  check(producedNear(260, 260) === 1, `the control factory started a unit (${producedNear(260, 260)})`)
}

console.log('\n== The panel edits the queue: newest command first, the running one last ==')
// The queue is one BuildFactory command per unit (IssueBlueprintCommand loops
// ISSUE_Command, Cfile:1265867-1265872); the panel shows consecutive
// same-blueprint commands as one stack (sub_835DF0, 1256786-1256813).
// DecreaseBuildCountInQueue walks the stack's commands from the NEWEST
// backwards (1257350-1257390); a command decreased to 0 leaves the queue
// (CUnitCommand::DecreaseCount 1007719-1007775) and, when it was the head,
// the dispatcher interrupts the running CFactoryBuildTask through its
// destructor (746664-746706, 818337-818390): OnFailedToBuild on the factory,
// OnFailedToBeBuilt on the site (unit.lua:1632 destroys it), OnStopBuild.
// IncreaseBuildCountInQueue issues fresh commands at the back
// (1351091-1351112).
{
  const editFactory = spawnLuaUnit(host, 'ueb0101', { x: 380, y: 0, z: 380 }, 1)
  queueFactoryBuild(host, editFactory, 'uel0101', 2)
  queueFactoryBuild(host, editFactory, 'uel0105', 1)
  queueFactoryBuild(host, editFactory, 'uel0101', 1)
  const display = (): string =>
    host.eval(`
      local out = {}
      for i, g in ipairs(__readUnit(${editFactory}).buildQueue) do out[i] = g.id .. 'x' .. g.count end
      return table.concat(out, ',')
    `) as string
  check(
    Number(host.eval(`return table.getn(__units[${editFactory}].__buildQueue)`)) === 4 && display() === 'uel0101x2,uel0105x1,uel0101x1',
    `four commands, three stacks for the panel -- only CONSECUTIVE same-blueprint commands merge (${display()})`,
  )
  // The first tank starts; let it gather some progress.
  let editTank = 0
  for (let i = 0; i < 40 && editTank === 0; i++) {
    beat(engine)
    editTank = Number(
      host.eval(`
        for tid, task in pairs(__buildTasks) do
          if task.builder == ${editFactory} and task.started then return task.target end
        end
        return 0
      `),
    )
  }
  for (let i = 0; i < 20; i++) beat(engine)
  const progressBefore = readUnit(editTank)?.fraction ?? -1
  check(editTank > 0 && progressBefore > 0, `the first tank (${editTank}) is building (${progressBefore.toFixed(3)})`)
  // Decrease the first stack by one: the NEWEST of its two commands goes, the
  // running head stays and keeps building.
  host.eval(`__adjustFactoryQueue(${editFactory}, 1, -1)`)
  beat(engine)
  check(
    display() === 'uel0101x1,uel0105x1,uel0101x1' && (readUnit(editTank)?.fraction ?? 0) > progressBefore,
    `decreasing the stack removes its newest command; the running build continues (${display()}, ${readUnit(editTank)?.fraction.toFixed(3)})`,
  )
  // Increase the LAST stack by two: two fresh commands at the back, merged
  // into that stack by the display.
  host.eval(`__adjustFactoryQueue(${editFactory}, 3, 2)`)
  check(display() === 'uel0101x1,uel0105x1,uel0101x3', `increasing appends fresh commands at the back (${display()})`)
  // Increase the FIRST stack: the fresh commands still go to the back, where
  // the last stack (same blueprint) absorbs them.
  host.eval(`__adjustFactoryQueue(${editFactory}, 1, 1)`)
  check(display() === 'uel0101x1,uel0105x1,uel0101x4', `an increase on an earlier stack lands at the back too (${display()})`)
  // Decrease the first stack once more: now its only command is the RUNNING
  // one -- the build is interrupted the destructor way.
  host.eval(`__adjustFactoryQueue(${editFactory}, 1, -1)`)
  const afterAbort = host.eval(`
    local f = __units[${editFactory}]
    local t = __units[${editTank}]
    local running = false
    for _, task in pairs(__buildTasks) do if task.builder == ${editFactory} then running = true end end
    -- Destroy is deferred to the end of the beat (Entity::Destroy queues,
    -- Cfile:916089): the site is destroy-queued at once, gone after a beat.
    return tostring(f.FactoryBuildFailed) .. '|' .. tostring(t == nil or t.__destroyQueued == true) .. '|' .. tostring(f.__workProgress or 0) .. '|' .. tostring(running)
  `)
  check(
    afterAbort === 'true|true|0|false',
    `removing the running head interrupts the build: FactoryBuildFailed, the site destroyed (unit.lua:1632), work progress 0, no task (${afterAbort})`,
  )
  beat(engine)
  check(host.eval(`return __units[${editTank}] == nil`) === true, 'one beat later the site is deleted (the deletion queue ran)')
  check(display() === 'uel0105x1,uel0101x4', `the queue lost the head only (${display()})`)
  // The next tick dispatches the new head (746591-746594): the engineer starts.
  let nextTarget = 0
  for (let i = 0; i < 40 && nextTarget === 0; i++) {
    beat(engine)
    nextTarget = Number(
      host.eval(`
        for _, task in pairs(__buildTasks) do
          if task.builder == ${editFactory} and task.started then return task.target end
        end
        return 0
      `),
    )
  }
  const nextBp = host.eval(`local u = __units[${nextTarget}]; return u and u.__bp and u.__bp.BlueprintId or 'none'`)
  check(nextBp === 'uel0105', `the new head (the engineer) starts on the next tick (${nextBp})`)
  host.eval(`__dispatchStop(${editFactory})`)
}

console.log('\n== Stop clears the production queue (it IS the command queue) ==')
// The queue entries are UNITCOMMAND_BuildFactory commands inside
// mUnit->mCommandQueue (Cfile:838000-838062); ClearCommandQueue removes every
// command without exception (Cfile:1005371-1005399), and the UI's Stop button
// arrives as ISSUE_Command(..., clear = 1) (Cfile:1255059-1255063).
{
  const stopFactory = spawnLuaUnit(host, 'ueb0101', { x: 300, y: 0, z: 300 }, 1)
  queueFactoryBuild(host, stopFactory, 'uel0101', 3)
  check(
    Number(host.eval(`return table.getn(__units[${stopFactory}].__buildQueue or {})`)) === 3,
    'the factory has three queued commands before Stop (one per unit, Cfile:1265867-1265872)',
  )
  host.eval(`__dispatchStop(${stopFactory})`)
  check(
    host.eval(`return __units[${stopFactory}].__buildQueue == nil`) === true,
    'Stop wipes the production queue',
  )
  for (let i = 0; i < 3; i++) beat(engine)
  check(producedNear(300, 300) === 0, `and no unit is started afterwards (${producedNear(300, 300)})`)
}

console.log('\n== A killed factory produces nothing during its DeathThread ==')
// The engine's dispatch gate is !IsBeingBuilt && !IsDead && !Attached &&
// !BlockCommandQueue (IAiCommandDispatchImpl::TaskTick, Cfile:746583-746586).
// Death is not instant: DeathThread runs for several beats (unit.lua:1200-1241)
// before Destroy(), and the original destroys what the factory was building
// (defaultunits.lua:683-688, unit.lua:1259-1263).
{
  const deadFactory = spawnLuaUnit(host, 'ueb0101', { x: 340, y: 0, z: 340 }, 1)
  queueFactoryBuild(host, deadFactory, 'uel0101', 3)
  host.eval(`__units[${deadFactory}]:Kill()`)
  check(host.eval(`return __units[${deadFactory}].__dead == true`) === true, 'the factory is dead')
  // It still HAS its queue — the engine does not wipe it on death, it simply
  // stops dispatching from it (the DeathThread then destroys the unit).
  check(
    Number(host.eval(`return table.getn(__units[${deadFactory}].__buildQueue or {})`)) > 0,
    'its queue is still there (death does not clear it, it stops dispatch)',
  )
  for (let i = 0; i < 5; i++) beat(engine)
  check(
    producedNear(340, 340) === 0,
    `it starts no unit while dying (${producedNear(340, 340)})`,
  )
}

const badWarnings = warnings.filter((w) => !/effectutilities|Emitter|Animator|Sound/i.test(w))
if (badWarnings.length > 0) {
  console.log(`\n  (${badWarnings.length} WARN aus der Sim, erste 3:)`)
  for (const w of badWarnings.slice(0, 3)) console.log(`    ${w.slice(0, 140)}`)
}

host.close()
await game.close()
console.log(failures === 0 ? '\nFABRIK BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
