/**
 * Runtime UserUnit state that must come from the sim, not from immutable
 * blueprints or optimistic UI writes:
 *
 *   - current layer / numeric GetIsSubmerged tri-state;
 *   - script-bit mask and ToggleScriptBit(curState) filtering;
 *   - mutable command-cap mask used by GetUnitCommandData;
 *   - CreateUnit2's degree heading and occupancy-validated starting layer.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-user-unit-state.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { installUiEngine } from '../src/lua/uiEngine'
import { findFiles } from '../src/vfs/glob'
import { GameFiles } from './gameFiles'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()

console.log('\n== CreateUnit2 layer and heading ==')
const sim = await LuaHost.create(game.luaFiles, () => {})
installEngine(sim)
setTerrainSource(sim, () => 20)
await game.giveUnit(sim, 'uea0101')
await game.giveUnit(sim, 'ues0103')
await game.giveUnit(sim, 'ues0203')
const created = Number(
  sim.eval(`
    local u = CreateUnit2('uea0101', 1, 'Air', 100, 100, 90)
    return u:GetEntityId()
  `),
)
check(
  sim.eval(`return __units[${created}]:GetCurrentLayer()`) === 'Air',
  'an air unit starts in and reports the Air layer',
)
check(
  Math.abs(Number(sim.eval(`return __units[${created}].__heading`)) - Math.PI / 2) < 1e-6,
  'CreateUnit2 converts its degree heading to runtime radians',
)

console.log('\n== COORDS layer parsing and starting-layer fallback ==')
const layers = String(
  sim.eval(`
    __setWaterLevel(40)
    local explicitSurface = CreateUnit2('ues0203', 1, 'wAtEr', 110, 100, 0)
    local prefixed = CreateUnit2('ues0203', 1, 'LAYER_Water', 120, 100, 0)
    local unknown = CreateUnit2('ues0203', 1, 'not-a-layer', 130, 100, 0)
    local wetShip = CreateUnit2('ues0103', 1, 'not-a-layer', 140, 100, 0)
    __setWaterLevel(nil)
    local dryShip = CreateUnit2('ues0103', 1, 'Water', 150, 100, 0)
    local unsupported = CreateUnit2('uea0101', 1, 'Land', 160, 100, 0)
    return table.concat({
      explicitSurface:GetCurrentLayer(),
      prefixed:GetCurrentLayer(),
      unknown:GetCurrentLayer(),
      wetShip:GetCurrentLayer(),
      dryShip:GetCurrentLayer(),
      unsupported:GetCurrentLayer(),
    }, ',')
  `),
)
check(
  layers === 'Water,Sub,Sub,Water,Land,Air',
  `case-insensitive exact names, no LAYER_ alias, and terrain/cap fallback (${layers})`,
)
const row = JSON.parse(String(sim.eval('return __readAllUnitsJson()'))) as {
  id: number
  layer: string
  scriptBits: number
  toggleCaps: number
  autoMode: boolean
  autoSurfaceMode: boolean
}[]
const createdRow = row.find((u) => u.id === created)
check(createdRow?.layer === 'Air', 'unit snapshot serializes the current layer')
check(createdRow?.scriptBits === 0, 'unit snapshot serializes the authoritative script-bit mask')
check(typeof createdRow?.toggleCaps === 'number', 'unit snapshot serializes the runtime toggle-cap mask')
check(createdRow?.autoMode === false, 'unit snapshot serializes auto-build mode')
check(createdRow?.autoSurfaceMode === false, 'unit snapshot serializes auto-surface mode')
check(
  sim.eval(`
    local u = __units[${created}]
    u.__autoOn, u.__autoOff = 0, 0
    u.OnAutoModeOn = function(self) self.__autoOn = self.__autoOn + 1 end
    u.OnAutoModeOff = function(self) self.__autoOff = self.__autoOff + 1 end
    u:SetAutoMode(true)
    u:SetAutoMode(false)
    return not u.__autoMode and u.__autoOn == 1 and u.__autoOff == 1
  `) === true,
  'Unit:SetAutoMode stores the flag and dispatches both native callbacks',
)
check(
  sim.eval(`
    local u = {
      __bp = { General = {
        CommandCaps = { RULEUCC_Attack = true },
        ToggleCaps = { RULEUTC_ShieldToggle = true },
      } },
    }
    __ensureCommandCapMask(u)
    local nativeQuirk = u:TestCommandCaps('RULEUCC_Move')
      and not u:TestCommandCaps('RULEUCC_Attack')
    u:AddToggleCap('RULEUTC_CloakToggle')
    local added = __ensureToggleCapMask(u) == 0x101
    u:RemoveToggleCap('RULEUTC_ShieldToggle')
    local removed = __ensureToggleCapMask(u) == 0x100
    u:RestoreToggleCaps()
    return nativeQuirk and added and removed and __ensureToggleCapMask(u) == 1
  `) === true,
  'toggle-cap mutations and the native TestCommandCaps blueprint quirk match the engine',
)

console.log('\n== UserUnit runtime masks and layer fold ==')
const ui = await LuaHost.create(game.luaFiles, () => {})
installUiEngine(ui, {
  exists: (p) => game.paths.has(p),
  find: (dir, pattern) => findFiles(game.paths, dir, pattern),
  textureSize: () => null,
  stringAdvance: () => 0,
  fontMetrics: () => [0, 0],
})
ui.eval(`
  __blueprints.testunit = {
    BlueprintId = 'testunit',
    General = {
      CommandCaps = { RULEUCC_Move = true, RULEUCC_Stop = true },
      ToggleCaps = { RULEUTC_ShieldToggle = true },
    },
    Economy = {},
  }
  -- caps=Attack only; layers Land/Sub; script bit 0 on/off.
  __uiSetUnit(1, 'testunit', 1, 0, 0, 0, 100, 100, 0, true, 0, 0, 0x4, false, 0, 1, false, 'Land', 1, 1, true, true)
  __uiSetUnit(2, 'testunit', 1, 0, 0, 0, 100, 100, 0, true, 0, 0, 0x1, false, 0, 1, false, 'Sub', 0, 1, false, false)
`)

check(
  ui.eval(`
    local orders = GetUnitCommandData({ __uiUnits[1] })
    local foundAttack, foundMove = false, false
    for _, cap in ipairs(orders) do
      if cap == 'RULEUCC_Attack' then foundAttack = true end
      if cap == 'RULEUCC_Move' then foundMove = true end
    end
    return foundAttack and not foundMove
  `) === true,
  'GetUnitCommandData uses the runtime cap mask, not blueprint CommandCaps',
)
ui.eval(`__uiUnits[1].__commandCapMask = 0x800000`)
check(
  ui.eval(`
    local orders = GetUnitCommandData({ __uiUnits[1] })
    for _, cap in ipairs(orders) do
      if cap == 'RULEUCC_Script' then return false end
    end
    return table.getn(orders) == 0
  `) === true,
  'GetUnitCommandData mirrors the native 0..22 result loop and omits bit-23 Script',
)
ui.eval(`__uiUnits[1].__commandCapMask = 0x4`)
ui.eval(`__uiUnits[1].__toggleCapMask = 0`)
check(
  ui.eval(`
    local _, toggles = GetUnitCommandData({ __uiUnits[1] })
    for _, cap in ipairs(toggles) do
      if cap == 'RULEUTC_ShieldToggle' then return false end
    end
    return true
  `) === true,
  'GetUnitCommandData and toggle eligibility use the runtime toggle-cap mask',
)
ui.eval(`__uiUnits[1].__toggleCapMask = 1`)
check(ui.eval(`return GetIsSubmerged({ __uiUnits[1] })`) === 1, 'surfaced selection returns +1')
check(ui.eval(`return GetIsSubmerged({ __uiUnits[2] })`) === -1, 'submerged selection returns -1')
check(ui.eval(`return GetIsSubmerged({ __uiUnits[1], __uiUnits[2] })`) === 0, 'mixed selection returns 0')
check(ui.eval(`return GetIsSubmerged({})`) === 0, 'empty selection returns 0')
check(ui.eval(`return GetIsAutoMode({ __uiUnits[1] })`) === true, 'single enabled auto mode returns true')
check(
  ui.eval(`return GetIsAutoMode({ __uiUnits[1], __uiUnits[2] })`) === false,
  'mixed auto mode uses ALL semantics',
)
check(
  ui.eval(`return GetIsAutoSurfaceMode({ __uiUnits[1], __uiUnits[2] })`) === false,
  'mixed auto-surface mode uses ALL semantics',
)
check(
  ui.eval(`return GetIsAutoMode({}) and GetIsAutoSurfaceMode({})`) === true,
  'both auto-mode getters are vacuously true for an empty list',
)

const calls: { name: string; ids: number[]; value: unknown }[] = []
ui.setGlobal('__uiSimCommand', (name: string, ids: number[], value: unknown) => {
  calls.push({ name, ids: [...ids], value })
})
ui.eval(`ToggleScriptBit({ __uiUnits[1], __uiUnits[2] }, 0, true)`)
ui.eval(`ToggleScriptBit({ __uiUnits[1], __uiUnits[2] }, 0, false)`)
ui.eval(`SetAutoMode({ __uiUnits[1], __uiUnits[2] }, false)`)
ui.eval(`SetAutoSurfaceMode({ __uiUnits[1], __uiUnits[2] }, true)`)
check(
  calls.length >= 2 &&
    calls[0].name === 'ToggleScriptBit' &&
    calls[0].ids.join(',') === '1' &&
    calls[0].value === 0,
  'curState=true sends only the unit whose mirrored bit is currently set',
)
check(
  calls[1]?.ids.join(',') === '2' && calls[1]?.value === 0,
  'curState=false sends only the unit whose mirrored bit is currently clear',
)
check(
  ui.eval(`return __uiUnits[1].scriptBits == 1 and __uiUnits[2].scriptBits == 0`) === true,
  'ToggleScriptBit does not invent an optimistic mirror state',
)
check(
  calls[2]?.name === 'SetAutoMode' &&
    calls[2]?.ids.join(',') === '1,2' &&
    calls[2]?.value === false &&
    calls[3]?.name === 'SetAutoSurfaceMode' &&
    calls[3]?.ids.join(',') === '1,2' &&
    calls[3]?.value === true,
  'auto-mode setters send boolean ProcessInfo requests for every live unit',
)
check(
  ui.eval(`return __uiUnits[1].autoMode and not __uiUnits[2].autoMode`) === true,
  'auto-mode setters leave the mirrored state authoritative until the next beat',
)

sim.close()
ui.close()
await game.close()

console.log(failures === 0 ? '\nUSER-UNIT STATE PASSED' : `\nUSER-UNIT STATE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
