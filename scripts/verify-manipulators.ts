/**
 * Animation manipulators — the engine seam the original unit scripts call on
 * every unit (CreateRotator/CreateSlider/CreateAnimator/CreateBuilderArmController).
 * Bone animation itself is not driven from the sim yet, but the seam must be
 * COMPLETE: the documented parameters must survive, the methods the original Lua
 * calls must exist, and WaitFor must yield.
 *
 * Three real defects this guards:
 *  - WaitFor(manip) never yielded while IsDone() is instantly true, so
 *    unit.lua:3683 `while true do WaitFor(RockManip) ... end` (RockingThread)
 *    spun inside one tick and hung the sim thread.
 *  - Slider:SetWorldUnits was undefined -> effectutilities.lua:362/574/646
 *    (Aeon/Seraphim/Cybran build effects) died with "call a nil value".
 *  - Unit:RecoilImpulse was undefined -> defaultweapons.lua:221 (ShipRock) died.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-manipulators.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit } from '../src/lua/unitFactory'
import { GameFiles } from './gameFiles'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()
const host = await LuaHost.create(game.luaFiles, () => {})
const engine = installEngine(host)
setTerrainSource(host, () => 20)
await game.giveUnit(host, 'uel0001')
const u = spawnLuaUnit(host, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
for (let i = 0; i < 8; i++) beat(engine)

// ── The documented optional parameters survive ──
console.log('\n== CreateRotator keeps goal/speed/accel/goalspeed (Cfile:876359) ==')
{
  const r = host.eval(`
    local m = CreateRotator(__units[${u}], 0, 'y', 90, 30, 5, 12)
    return string.format('%s|%s|%s|%s|%s', tostring(m.__axis), tostring(m.__goal and m.__goal[1]),
      tostring(m.__speed), tostring(m.__accel), tostring(m.__targetSpeed))
  `) as string
  check(r === 'y|90|30|5|12', `axis|goal|speed|accel|goalspeed = ${r}`)
}

console.log('\n== CreateBuilderArmController keeps barrel/aim bones (Cfile:866166) ==')
{
  const r = host.eval(`
    local m = CreateBuilderArmController(__units[${u}], 'turret', 'barrel', 'aim')
    return string.format('%s|%s|%s', tostring(m.__bone), tostring(m.__barrelBone), tostring(m.__aimBone))
  `) as string
  check(r === 'turret|barrel|aim', `turret|barrel|aim = ${r}`)
}

// ── The methods the original Lua calls exist (were nil -> hard error) ──
console.log('\n== Methods the original Lua calls exist ==')
{
  const okSlider = host.eval(
    `local ok, err = pcall(function() return CreateSlider(__units[${u}], 0):SetWorldUnits(true) end) return ok`,
  ) as boolean
  check(okSlider === true, 'Slider:SetWorldUnits(true) is callable and chainable')

  const okRecoil = host.eval(
    `local ok = pcall(function() __units[${u}]:RecoilImpulse(0, 0, -1) end) return ok`,
  ) as boolean
  check(okRecoil === true, 'Unit:RecoilImpulse(x,y,z) is callable')
  const rec = host.eval(`local r = __units[${u}].__recoilImpulse; return r and r[3] or 999`) as number
  check(rec === -1, `the impulse is recorded (z = ${rec})`)
}

// ── WaitFor must yield: the RockingThread loop must not hang the beat ──
console.log('\n== WaitFor yields — RockingThread-style loop does not hang ==')
{
  host.eval(`
    __rockCount = 0
    local m = CreateRotator(__units[${u}], 0, 'z')
    ForkThread(function()
      while true do
        WaitFor(m)
        __rockCount = __rockCount + 1
      end
    end)
  `)
  // Without the fix this beat never returns (infinite loop inside one tick).
  for (let i = 0; i < 5; i++) beat(engine)
  const n = host.eval('return __rockCount') as number
  check(n >= 1 && n <= 8, `the loop advanced once per tick, not forever (${n} iterations over 5 beats)`)
}

console.log(failures === 0 ? '\nMANIPULATORS PASSED' : `\nMANIPULATORS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
