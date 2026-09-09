/**
 * The transport: load and unload, through the original Lua.
 *
 * A UEF T1 transport (uea0107) and two T1 tanks (uel0201). `IssueTransportLoad`
 * hands the transport and the tanks ONE command (cfunc_IssueTransportLoadL,
 * Cfile:1011850-1011985); the dispatcher builds CUnitLoadUnits on the
 * transport and CUnitCallTransport on every tank (DispatchTask 830700-830866
 * with the one-off case labels). The transport flies to the tanks and marks
 * itself TransportLoading, the tanks walk to their pickup cells, beam up over
 * ten ticks (CUnitCallTransport::TaskTick 822991-823249) and hang on the
 * attach bones (CAiTransportImpl::TransportAttachUnit 803719-803744 ->
 * OnTransportAttach). `IssueTransportUnload` moves the transport to the point
 * and drops them (CUnitUnloadUnits::TaskTick 853499-853809 ->
 * TransportDetachUnit 803748-803863 -> DetachFrom without skipBallistic ->
 * UMS_Ballistic, CalcMoveBallistic 970009-970420).
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-transport.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit } from '../src/lua/unitFactory'
import { GameFiles } from './gameFiles'
import { FLAT_TEST_MAP_SIZE } from '../src/sim/terrain'
import { rightClickTransport, rightClickWithTransport, type SelectedUnit, type TransportHoverInfo } from '../src/ui/worldCommands'

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
await game.giveUnit(host, 'uea0107')
await game.giveUnit(host, 'uel0201')
await game.giveUnit(host, 'uel0303')
await game.giveUnit(host, 'uel0001')

const errOf = (expression: string): string =>
  host.eval(`local ok, e = pcall(function() ${expression} end); return ok and '' or tostring(e)`) as string
const queue = (id: number): { type: string; target?: number; x?: number; z?: number; cmdId?: number }[] =>
  host.pull(`(function() local out = {} local a = __orderActive[${id}] if a then out[#out+1] = a end for _, c in ipairs(__orders[${id}] or {}) do out[#out+1] = c end local parts = {} for i, c in ipairs(out) do parts[i] = string.format('{"type":%q,"target":%s,"x":%s,"z":%s,"cmdId":%s}', c.type, tostring(c.target or 'null'), tostring(c.x or 'null'), tostring(c.z or 'null'), tostring(c.cmdId or 'null')) end return '[' .. table.concat(parts, ',') .. ']' end)()`)
const posOf = (id: number): number[] => host.pull<number[]>(`__jsonVal(__units[${id}]:GetPosition())`)
// GetParent returns the entity ITSELF when unattached (Cfile:932423) -> 0 here.
const parentOf = (id: number): number => Number(host.eval(`local u = __units[${id}] local p = u:GetParent() return (p and p ~= u and p.__id) or 0`))
const isState = (id: number, s: string): boolean => host.eval(`return __units[${id}]:IsUnitState('${s}')`) === true
const cargoOf = (id: number): number => Number(host.eval(`return table.getn(__units[${id}]:GetCargo())`))
// The callback log as a list (an empty Lua table serializes as an object).
const tpLog = (): string[] => {
  const v = host.pull<unknown>(`__jsonVal(__tpLog)`)
  return Array.isArray(v) ? (v as string[]) : []
}

console.log('\n== The transport component: attach points from the skeleton (SetUpAttachPoints, Cfile:801771-801976) ==')
{
  const transport = spawnLuaUnit(host, 'uea0107', { x: 500, y: 20, z: 500 }, 1)
  const tank = spawnLuaUnit(host, 'uel0201', { x: 520, y: 20, z: 500 }, 1)
  beat(engine)
  // A unit owns a CAiTransportImpl when RULEUCC_Transport is in its command
  // caps or it is a PODSTAGINGPLATFORM (Unit ctor, Cfile:950494-950512).
  check(host.eval(`return __transportOf(__units[${tank}]) == nil`) === true, 'a tank has no transport component')
  const counts = host.pull<{ attachpoints: number; class1: number; class2: number; class3: number; class4: number; generic: number; launch: number }>(
    `(function() local t = __transportOf(__units[${transport}]) return string.format('{"attachpoints":%d,"class1":%d,"class2":%d,"class3":%d,"class4":%d,"generic":%d,"launch":%d}', t.attachpoints, #t.class1, #t.class2, #t.class3, #t.class4, #t.generic, #t.launch) end)()`,
  )
  // uea0107 bones: 6x *_Attachpoint_sml_*, Attachpoint_Med_01/03,
  // Attachpoint_Lrg_02 (strstr on the names; ClassGenericUpTo default 0,
  // Cfile:655688, so every class keeps its own list).
  check(counts.attachpoints === 9, `9 attach points counted (${counts.attachpoints})`)
  check(counts.class1 === 6 && counts.class2 === 2 && counts.class3 === 1 && counts.class4 === 0 && counts.generic === 0,
    `6 small, 2 medium, 1 large, none generic (${JSON.stringify(counts)})`)
  // A bone that matches no name goes into no list (LABEL_57, Cfile:801961-
  // 801963); only a "Launchpoint" bone reaches the launch list, and uea0107
  // has none.
  check(counts.launch === 0, `no bone of uea0107 is a launch point (${counts.launch})`)
  check(host.eval(`local t = __transportOf(__units[${transport}]) return #t.class1 + #t.class2 + #t.class3 + #t.class4 + #t.classS + #t.generic + #t.launch`) === 9, 'the 23 other bones (engines, legs, exhausts) are in no list')
  // TransportHasSpaceFor (Cfile:803523-803605): a class-1 tank takes one
  // small point; a class-3 Titan (uel0303) needs Class3AttachSize = 4 small
  // points around a large one; storage is a carrier thing (StorageSlots 0).
  check(host.eval(`return __units[${transport}]:TransportHasSpaceFor(__units[${tank}])`) === true, 'TransportHasSpaceFor: a T1 tank fits')
  const titan = spawnLuaUnit(host, 'uel0303', { x: 530, y: 20, z: 500 }, 1)
  check(host.eval(`return __units[${transport}]:TransportHasSpaceFor(__units[${titan}])`) === true, 'TransportHasSpaceFor: a class-3 Titan fits (4 small points near the large one)')
  check(host.eval(`return __units[${transport}]:TransportHasAvailableStorage()`) === false, 'TransportHasAvailableStorage is false without StorageSlots')
  // TransportCanCarryUnit (Cfile:803349-803428): an air unit never, a
  // commander only on a CANTRANSPORTCOMMANDER transport (uea0107 is one).
  const acu = spawnLuaUnit(host, 'uel0001', { x: 540, y: 20, z: 500 }, 1)
  check(host.eval(`return __transportCanCarryUnit(__transportOf(__units[${transport}]), __units[${acu}])`) === true, 'TransportCanCarryUnit: the ACU on a CANTRANSPORTCOMMANDER transport')
  const other = spawnLuaUnit(host, 'uea0107', { x: 560, y: 20, z: 500 }, 1)
  check(host.eval(`return __transportCanCarryUnit(__transportOf(__units[${transport}]), __units[${other}])`) === false, 'TransportCanCarryUnit: never an air unit')
  // The bindings refuse a unit without the component (Cfile:972310, 804858).
  const e1 = errOf(`__units[${tank}]:GetCargo()`)
  check(e1.includes('Unit:GetCargo only valid for transport units'), `GetCargo on a tank: ${e1.split('\n')[0]}`)
  const e2 = errOf(`__units[${tank}]:TransportDetachAllUnits(false)`)
  check(e2.includes('Unit:TransportDetachAllUnits can only be called for transports'), `TransportDetachAllUnits on a tank: ${e2.split('\n')[0]}`)
  check(host.eval(`return table.getn(__units[${transport}]:GetCargo())`) === 0, 'an empty transport has no cargo')
  for (const id of [transport, tank, titan, acu, other]) host.eval(`__units[${id}]:Destroy()`)
  beat(engine)
}

console.log('\n== IssueTransportLoad: one command for the transport and its passengers ==')
const transport = spawnLuaUnit(host, 'uea0107', { x: 600, y: 20, z: 600 }, 1)
const tankA = spawnLuaUnit(host, 'uel0201', { x: 640, y: 20, z: 600 }, 1)
const tankB = spawnLuaUnit(host, 'uel0201', { x: 640, y: 20, z: 606 }, 1)
beat(engine)
{
  // Instrument the original callbacks: unit.lua:3434 OnTransportAttach plays
  // the Load sound and marks the weapons; :3446 OnTransportDetach the reverse.
  host.eval(`
    __tpLog = {}
    local t = __units[${transport}]
    local base = t.OnTransportAttach
    t.OnTransportAttach = function(self, bone, unit) __tpLog[#__tpLog+1] = 'attach:' .. tostring(bone) .. ':' .. tostring(unit.__id) return base(self, bone, unit) end
    local baseD = t.OnTransportDetach
    t.OnTransportDetach = function(self, bone, unit) __tpLog[#__tpLog+1] = 'detach:' .. tostring(bone) .. ':' .. tostring(unit.__id) return baseD(self, bone, unit) end
    local baseO = t.OnTransportOrdered
    t.OnTransportOrdered = function(self) __tpLog[#__tpLog+1] = 'ordered' return baseO(self) end
    local baseS = t.OnStartTransportLoading
    t.OnStartTransportLoading = function(self) __tpLog[#__tpLog+1] = 'startLoading' return baseS(self) end
    local baseE = t.OnStopTransportLoading
    t.OnStopTransportLoading = function(self) __tpLog[#__tpLog+1] = 'stopLoading' return baseE(self) end
    for _, id in ipairs({ ${tankA}, ${tankB} }) do
      local u = __units[id]
      local b1 = u.OnStartTransportBeamUp
      u.OnStartTransportBeamUp = function(self, tr, bone) __tpLog[#__tpLog+1] = 'beamUp:' .. tostring(self.__id) .. ':' .. tostring(bone) return b1(self, tr, bone) end
      local b2 = u.OnStopTransportBeamUp
      u.OnStopTransportBeamUp = function(self) __tpLog[#__tpLog+1] = 'beamStop:' .. tostring(self.__id) return b2(self) end
      local b3 = u.OnMotionStateChange
      u.OnMotionStateChange = function(self, new, old) __tpLog[#__tpLog+1] = 'motion:' .. tostring(self.__id) .. ':' .. tostring(new) if b3 then return b3(self, new, old) end end
    end
  `)
  check(host.eval(`return select('#', IssueTransportLoad({ __units[${tankA}], __units[${tankB}] }, __units[${transport}]))`) === 0, 'IssueTransportLoad returns nothing')
  const qt = queue(transport)
  const qa = queue(tankA)
  const qb = queue(tankB)
  check(qt.length === 1 && qt[0]!.type === 'TransportLoad' && qt[0]!.target === transport, `the transport got the TransportLoadUnits command targeting itself (${JSON.stringify(qt)})`)
  check(qa.length === 1 && qa[0]!.type === 'TransportLoad' && qa[0]!.target === transport, `tank A got the same command targeting the transport (${JSON.stringify(qa)})`)
  check(qb.length === 1 && qa[0]!.cmdId === qb[0]!.cmdId && qt[0]!.cmdId === qa[0]!.cmdId, 'all three share ONE command (the sync gate of both tasks, Cfile:823117 / 853060)')
  // CUnitLoadUnits ctor (Cfile:852368-852377): the TransportLoading state and
  // OnStartTransportLoading at once.
  check(isState(transport, 'TransportLoading'), 'the transport is TransportLoading from the first beat')
  const log0 = tpLog()
  check(log0.includes('startLoading'), `OnStartTransportLoading fired (${log0.join(',')})`)
  let attached = 0
  let sawWaiting = false
  let sawTeleporting = false
  for (let t = 0; t < 400 && attached < 2; t++) {
    beat(engine)
    if (isState(tankA, 'WaitingForTransport')) sawWaiting = true
    if (isState(tankA, 'Teleporting')) sawTeleporting = true
    attached = (parentOf(tankA) === transport ? 1 : 0) + (parentOf(tankB) === transport ? 1 : 0)
  }
  check(attached === 2, `both tanks hang on the transport after the load (${attached})`)
  check(sawWaiting, 'a passenger was WaitingForTransport on the way (Cfile:823128)')
  check(sawTeleporting, 'a passenger was Teleporting during the beam-up (UNITSTATEMASK_Teleporting, Cfile:823214)')
  const log = tpLog()
  check(log.includes('ordered'), `OnTransportOrdered fired on the air transport (Cfile:853109)`)
  check(log.some((l) => l.startsWith('beamUp:' + tankA + ':')) && log.some((l) => l === 'beamStop:' + tankA), `the beam-up callbacks ran for tank A (${log.filter((l) => l.startsWith('beam')).join(',')})`)
  const attaches = log.filter((l) => l.startsWith('attach:'))
  check(attaches.length === 2 && attaches.every((l) => /attachpoint/i.test(l)), `OnTransportAttach(boneName, unit) twice, on attach bones (${attaches.join(',')})`)
  check(cargoOf(transport) === 2, `GetCargo lists both passengers (${cargoOf(transport)})`)
  check(isState(tankA, 'Attached') && host.eval(`return __units[${tankA}].__transportedBy == ${transport}`) === true, 'tank A is Attached with mTransportedBy = the transport')
  // unit.lua:3436 MarkWeaponsOnTransport -> weapon.lua:472 SetOnTransport:
  // uel0201 has no CanFireFromTransport, so its gun is disabled on board.
  check(host.eval(`return __units[${tankA}]:GetWeapon(1).WeaponDisabledOnTransport == true`) === true, 'the passenger gun is disabled on board (weapon.lua:481)')
  check(host.eval(`return __units[${tankA}]:GetWeapon(1):GetOnTransport()`) === true, 'Weapon:GetOnTransport is true')
  // The passenger follows its bone: above the transport's base, not on the
  // ground (CalculateAttachedTransform, bones.lua).
  const pa = posOf(tankA)
  const pt = posOf(transport)
  check(Math.abs(pa[0]! - pt[0]!) < 6 && Math.abs(pa[2]! - pt[2]!) < 6, `tank A rides with the transport (${pa.map((v) => v.toFixed(1)).join(',')} vs ${pt.map((v) => v.toFixed(1)).join(',')})`)
  let cleared = false
  for (let t = 0; t < 40 && !cleared; t++) {
    beat(engine)
    cleared = !isState(transport, 'TransportLoading') && queue(transport).length === 0
  }
  check(cleared, 'the load task ended: TransportLoading cleared, the command popped')
  const log2 = tpLog()
  check(log2.includes('stopLoading'), 'OnStopTransportLoading fired at the end (Cfile:852399)')
  check(queue(tankA).length === 0 && queue(tankB).length === 0, 'the passengers\' commands completed with the attach')
}

console.log('\n== IssueTransportUnload: the drop and the ballistic fall ==')
{
  const dropX = 700
  const dropZ = 620
  host.eval(`__tpLog = {}`)
  check(host.eval(`return select('#', IssueTransportUnload({ __units[${transport}] }, { ${dropX}, 20, ${dropZ} }))`) === 0, 'IssueTransportUnload returns nothing')
  const q = queue(transport)
  check(q.length === 1 && q[0]!.type === 'TransportUnload' && q[0]!.x === dropX && q[0]!.z === dropZ, `the transport got the unload command to the point (${JSON.stringify(q)})`)
  check(isState(transport, 'TransportUnloading'), 'the transport is TransportUnloading (bit 0x200, Cfile:853328)')
  let landed = 0
  let sawBallistic = false
  for (let t = 0; t < 400 && landed < 2; t++) {
    beat(engine)
    if (host.eval(`return __units[${tankA}].__motionState == 'Ballistic'`) === true) sawBallistic = true
    landed = [tankA, tankB].filter((id) => parentOf(id) === 0 && host.eval(`return __units[${id}].__motionState ~= 'Ballistic' and __units[${id}].__layer == 'Land'`) === true).length
  }
  check(landed === 2, `both tanks are back on the ground in the Land layer (${landed})`)
  check(sawBallistic, 'a dropped tank passed through UMS_Ballistic (NotifyDetached, Cfile:965830-965848)')
  const log = tpLog()
  const detaches = log.filter((l) => l.startsWith('detach:'))
  check(detaches.length === 2, `OnTransportDetach(boneName, unit) twice (${detaches.join(',')})`)
  check(log.includes('motion:' + tankA + ':Ballistic') && log.includes('motion:' + tankA + ':None'), `OnMotionStateChange Ballistic then None on tank A (${log.filter((l) => l.startsWith('motion:' + tankA)).join(',')})`)
  const pa = posOf(tankA)
  const pt = posOf(transport)
  check(Math.abs(pa[1]! - 20) < 0.01, `tank A landed on the terrain (y ${pa[1]!.toFixed(2)})`)
  check(Math.abs(pt[0]! - dropX) < 3 && Math.abs(pt[2]! - dropZ) < 3, `the transport unloaded at the point (${pt.map((v) => v.toFixed(1)).join(',')})`)
  check(Math.abs(pa[0]! - dropX) < 8 && Math.abs(pa[2]! - dropZ) < 8, `tank A fell out near the drop point (${pa.map((v) => v.toFixed(1)).join(',')})`)
  check(cargoOf(transport) === 0 && host.eval(`return __units[${tankA}].__transportedBy == false`) === true, 'the cargo is empty and mTransportedBy released')
  check(host.eval(`return __units[${tankA}]:GetWeapon(1).WeaponDisabledOnTransport == false`) === true, 'the passenger gun is enabled again (unit.lua:3448)')
  check(!isState(tankA, 'Attached'), 'the Attached bit is cleared')
  let done = false
  for (let t = 0; t < 20 && !done; t++) {
    beat(engine)
    done = queue(transport).length === 0 && !isState(transport, 'TransportUnloading')
  }
  check(done, 'the unload command completed and TransportUnloading cleared')
  // An empty transport ignores an unload (no loaded units -> no task,
  // Cfile:830960-830966): the command is done at once.
  host.eval(`IssueTransportUnload({ __units[${transport}] }, { 720, 20, 620 })`)
  check(queue(transport).length === 0, 'an unload on an empty transport queues no task')
}

console.log('\n== The errors of the bindings ==')
{
  const e1 = errOf(`IssueTransportLoad({ __units[${tankA}] })`)
  check(e1.includes('expected 2 args, but got 1'), `IssueTransportLoad with one argument: ${e1.split('\n')[0]}`)
  const e2 = errOf(`IssueTransportLoad({}, __units[${transport}])`)
  check(e2.includes("IssueTransportLoad: Couldn't find any units to load."), `no units: ${e2.split('\n')[0]}`)
  const e3 = errOf(`IssueTransportLoad({ __units[${tankA}] }, 5)`)
  check(e3 !== '', `a number is no transport: ${e3.split('\n')[0]}`)
  const e4 = errOf(`IssueTransportUnload({ __units[${transport}] }, 'x')`)
  check(e4.includes('Invalid target set in IssueTransportUnload; expected an entity or a Vec3 but got a string'), `a string is no unload target: ${e4.split('\n')[0]}`)
  // An attached unit cannot be loaded again (Cfile:1011903-1011907).
  host.eval(`__units[${tankB}]:AttachBoneTo(-1, __units[${tankA}], -1)`)
  const e5 = errOf(`IssueTransportLoad({ __units[${tankB}] }, __units[${transport}])`)
  check(e5.includes('IssueTransportLoad: One or more units are already attached to something.'), `an attached unit: ${e5.split('\n')[0]}`)
  // DetachFrom on a LIVE non-flying unit is the ballistic drop now, not an
  // error: the tank falls off the other tank and lands (the earlier gap).
  const e6 = errOf(`__units[${tankB}]:DetachFrom()`)
  check(e6 === '', `DetachFrom without skipBallistic on a live tank is accepted (${e6.split('\n')[0]})`)
  let fell = false
  for (let t = 0; t < 30 && !fell; t++) {
    beat(engine)
    fell = host.eval(`return __units[${tankB}].__motionState == 'None' and __units[${tankB}].__layer == 'Land' and __units[${tankB}]:GetParent() == __units[${tankB}]`) === true
  }
  check(fell, 'the tank landed on its own (CalcMoveBallistic)')
}

console.log('\n== The user side: TransportReverseLoadUnits and the right-click predicates ==')
{
  // A transport right-clicking a unit issues TransportReverseLoadUnits with
  // the unit as target (HandleEvent, Cfile:1241600-1241617); the sim keeps
  // the closest transport with space plus the target (sub_6EF660,
  // Cfile:1006333-1006500) and both get the command.
  const far = spawnLuaUnit(host, 'uea0107', { x: 760, y: 20, z: 700 }, 1)
  beat(engine)
  host.eval(`__dispatchTransportReverseLoad({ ${far}, ${transport} }, ${tankA}, true)`)
  const qt = queue(transport)
  const qf = queue(far)
  const qa = queue(tankA)
  check(qt.length === 1 && qt[0]!.type === 'TransportReverseLoad' && qt[0]!.target === tankA, `the closer transport got the reverse load (${JSON.stringify(qt)})`)
  check(qf.length === 0, 'the farther transport got nothing')
  check(qa.length === 1 && qa[0]!.type === 'TransportReverseLoad' && qa[0]!.cmdId === qt[0]!.cmdId, `the target tank shares the command (${JSON.stringify(qa)})`)
  let attached = false
  for (let t = 0; t < 400 && !attached; t++) {
    beat(engine)
    attached = parentOf(tankA) === transport
  }
  check(attached, 'the tank ends up on the transport')
  // The passenger's command: the UI's CallTransport adds the transport to the
  // set (Cfile:1241826-1241836); the dispatch function does the same.
  host.eval(`__dispatchTransportLoad({ ${tankB} }, ${transport}, true)`)
  const qb = queue(tankB)
  const qt2 = queue(transport)
  check(qb.length === 1 && qb[0]!.type === 'TransportLoad' && qt2.length >= 1 && qt2[qt2.length - 1]!.type === 'TransportLoad', `CallTransport queues the load on the tank AND the transport (${JSON.stringify(qb)} / ${JSON.stringify(qt2)})`)
  let attachedB = false
  for (let t = 0; t < 400 && !attachedB; t++) {
    beat(engine)
    attachedB = parentOf(tankB) === transport
  }
  check(attachedB, 'the second tank boards through the call')
  check(cargoOf(transport) === 2, `the cargo is two again (${cargoOf(transport)})`)
  // The right-click predicates (func_RightClickWithTransport 1238669-1238853,
  // func_RightClickTransport 1238854-1239027).
  const sel = (o: Partial<SelectedUnit>): SelectedUnit => ({
    id: 1, army: 1, canMove: true, canRepair: false, canAttack: true, canAttackGround: true, canGuard: true,
    canReclaim: false, canCapture: false, canOvercharge: false, isFactory: false, isMobile: true, canTransport: false, canCallTransport: true,
    isCommand: false, isTransportation: false, isTransportFocus: false, canTransportCommander: false,
    isTeleportation: false, canFly: false, isExperimental: false, isAttached: false, ...o,
  })
  const hover = (o: Partial<TransportHoverInfo>): TransportHoverInfo => ({
    canCallTransport: true, isTransportation: true, isTeleportation: false, isFerryBeacon: false,
    isAirStaging: false, isExperimental: false, isCommand: false, canTransportCommander: false, canFly: true,
    layer: 'Air', ...o,
  })
  check(rightClickWithTransport([sel({})], hover({})) === true, 'a tank clicking a transport calls it')
  check(rightClickWithTransport([sel({ isCommand: true })], hover({})) === false, 'a commander is refused by a plain transport')
  check(rightClickWithTransport([sel({ isCommand: true })], hover({ canTransportCommander: true })) === true, 'a commander boards a CANTRANSPORTCOMMANDER transport')
  check(rightClickWithTransport([sel({})], hover({ layer: 'Seabed' })) === false, 'a transport on the seabed is not called')
  check(rightClickWithTransport([sel({ isAttached: true })], hover({})) === false, 'a unit already attached calls nothing')
  check(rightClickTransport([sel({ isTransportation: true, isTransportFocus: true, canTransport: true })], hover({ canFly: false, canCallTransport: true })) === true, 'a transport clicking a land unit loads it')
  check(rightClickTransport([sel({ isTransportation: true, isTransportFocus: true })], hover({ canFly: true })) === false, 'a flyer is not a load target')
  check(rightClickTransport([sel({ isTransportation: true, isTransportFocus: true })], hover({ canFly: false, isExperimental: true })) === false, 'an experimental is not a load target')
  check(rightClickTransport([sel({ isTransportation: true, isTransportFocus: true })], hover({ canFly: false, isCommand: true })) === false, 'a commander needs CANTRANSPORTCOMMANDER')
  check(rightClickTransport([sel({ isTransportation: true, isTransportFocus: true, canTransportCommander: true })], hover({ canFly: false, isCommand: true })) === true, 'the CANTRANSPORTCOMMANDER transport loads the commander')
  check(rightClickTransport([sel({ isFerryBeacon: true, isTransportFocus: true })], hover({ canFly: false })) === true, 'a selected ferry beacon takes a land unit like a transport (Cfile:1238972-1238991)')
}

console.log('\n== TransportDetachAllUnits: the transport dies with its cargo ==')
{
  // uea0107_script.lua:63 OnKilled -> TransportDetachAllUnits(true): every
  // passenger rolls the 99 % death (Cfile:803925-803960).
  const before = cargoOf(transport)
  check(before === 2, `two passengers aboard (${before})`)
  host.eval(`__units[${transport}]:TransportDetachAllUnits(false)`)
  beat(engine)
  check(cargoOf(transport) === 0, 'TransportDetachAllUnits(false) releases every passenger')
  let landed = 0
  for (let t = 0; t < 40 && landed < 2; t++) {
    beat(engine)
    landed = [tankA, tankB].filter((id) => host.eval(`return __units[${id}].__motionState == 'None' and __units[${id}].__layer == 'Land'`) === true).length
  }
  check(landed === 2, `both dropped tanks landed (${landed})`)
}

console.log('\n== What the sim reported ==')
const uniq = [...new Set(warnings.map((w) => w.split('\n')[0]?.slice(0, 120)))]
for (const w of uniq.slice(0, 14)) console.log(`  · ${w}`)
const luaErrors = uniq.filter((w) => w && /Error running lua script|attempt to|OnTransport|Transport/i.test(w))
check(luaErrors.length === 0, `no Lua errors in the transport callbacks (${luaErrors.length})`)

console.log(failures === 0 ? '\nTRANSPORT PASSED' : `\nTRANSPORT: ${failures} FAILURES`)
await game.close()
process.exit(failures === 0 ? 0 : 1)
