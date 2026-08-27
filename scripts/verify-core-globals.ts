/**
 * Core math and string globals (scr_CoreInits => BOTH VMs). These were simply
 * absent — the original Lua that calls them threw "access to nonexistent
 * global". Each is checked against the decompiled behaviour, and each is proven
 * present in BOTH the sim and the UI VM (that is what scr_CoreInits means).
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-core-globals.ts
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

// --- The SIM VM ---
const sim = await LuaHost.create(game.luaFiles, () => {})
installEngine(sim)
setTerrainSource(sim, () => 20)

console.log('\n== Path helpers (Moho::FILE_*) ==')
// Dirname (Cfile:444657-444750): a path with NO dot after the last slash is
// returned whole; only when a dot follows is it cut before the slash.
check(sim.eval(`return Dirname('/mods/foo/bar.lua')`) === '/mods/foo', "Dirname('/mods/foo/bar.lua') -> /mods/foo")
check(sim.eval(`return Dirname('/mods/foo')`) === '/mods/foo', "Dirname('/mods/foo') -> /mods/foo (no dot)")
check(sim.eval(`return Dirname('/mods/foo/')`) === '/mods/foo', 'a trailing slash is trimmed')
check(sim.eval(`return Dirname('bar.lua')`) === '', "no slash -> '' (Cfile:444706)")
check(sim.eval(`return Dirname([[a\\b\\c.txt]])`) === 'a/b', 'backslashes normalise to /')

// Basename (Cfile:444986-445066): last component, optionally without extension.
check(sim.eval(`return Basename('/mods/foo/bar.lua', false)`) === 'bar.lua', 'Basename keeps the extension by default')
check(sim.eval(`return Basename('/mods/foo/bar.lua', true)`) === 'bar', 'Basename(..., true) cuts the LAST dot')
check(sim.eval(`return Basename('a.b.c', true)`) === 'a.b', "'a.b.c' -> 'a.b' (last dot only)")
check(sim.eval(`return Basename([[a\\b\\c]], true)`) === 'c', 'backslash counts as a separator')

console.log('\n== STR_GetTokens (0-based!) / STR_xtoi / STR_itox ==')
// The engine writes the tokens 0-based (SetString(t, i++), i = 0, Cfile:599300).
check(
  sim.eval(`local t = STR_GetTokens('a b  c', ' ') return tostring(t[0])..','..tostring(t[1])..','..tostring(t[2])`) ===
    'a,b,c',
  'STR_GetTokens is 0-based and drops empty tokens',
)
check(sim.eval(`return STR_GetTokens('a b c', ' ')[1]`) === 'b', 'so index 1 is the SECOND token, not the first')
check(sim.eval(`return STR_xtoi('FF')`) === 255, "STR_xtoi('FF') = 255")
check(sim.eval(`return STR_xtoi('1a')`) === 26, "STR_xtoi('1a') = 26 (case-insensitive)")
check(sim.eval(`return STR_xtoi('10zz')`) === 16, 'stops at the first non-hex char (Cfile:1453770)')
check(sim.eval(`return STR_itox(255)`) === 'FF', 'STR_itox(255) = FF (uppercase, no prefix)')
check(sim.eval(`return STR_itox(-1)`) === 'FFFFFFFF', "STR_itox(-1) = FFFFFFFF (two's complement)")

console.log('\n== Rect / PointVector: named fields, no array part ==')
check(
  sim.eval(`local r = Rect(1, 2, 3, 4) return r.x0..','..r.y0..','..r.x1..','..r.y1..'|'..tostring(r[1])`) ===
    '1,2,3,4|nil',
  'Rect has x0/y0/x1/y1 and NO array part (Cfile:597236)',
)
check(
  sim.eval(`local p = PointVector(1,2,3,4,5,6) return p.px..p.py..p.pz..p.vx..p.vy..p.vz..'|'..tostring(p[1])`) ===
    '123456|nil',
  'PointVector has px..vz and no array part (Cfile:597070)',
)

console.log('\n== VDot / VPerpDot / MATH_IRound ==')
check(sim.eval(`return VDot({1,2,3}, {4,5,6})`) === 32, 'VDot = 1*4+2*5+3*6 = 32')
check(sim.eval(`return VDot({x=1,y=0,z=0}, {x=1,y=0,z=0})`) === 1, 'VDot reads field access too')
// The native vector metatable aliases x/y/z to slots 1/2/3 in BOTH directions
// (Cfile:596930-596959). Separate named copies silently diverge after a write.
check(
  sim.eval(`local v = Vector(1,2,3); v.x = 9; v[2] = 8; return v[1]..','..v.y`) === '9,8',
  'Vector named and indexed components are the same storage',
)
check(
  sim.eval(`local v = VAdd(Vector(1,2,3), Vector(4,5,6)); v.z = 12; return v.x..','..v[3]`) === '5,12',
  'vector results carry the native component-alias metatable',
)
check(
  sim.eval(`local ok = pcall(function() return Vector(1,2,3).foo end); return ok`) === false,
  'the native vector metatable rejects fields other than x/y/z',
)
check(
  sim.eval(`
    local okMissing = pcall(function() Vector(1, 2) end)
    local okExtra = pcall(function() Vector(1, 2, 3, 4) end)
    local okType = pcall(function() Vector(1, '2', 3) end)
    return not okMissing and not okExtra and not okType
  `) === true,
  'Vector requires exactly three numeric arguments',
)
check(
  sim.eval(`
    local okMissing = pcall(function() Vector2(1) end)
    local okExtra = pcall(function() Vector2(1, 2, 3) end)
    local okType = pcall(function() Vector2({}, 2) end)
    return not okMissing and not okExtra and not okType
  `) === true,
  'Vector2 requires exactly two numeric arguments',
)
// VPerpDot = a.x*b.z - b.x*a.z (Y ignored, Cfile:598096).
check(sim.eval(`return VPerpDot({1,9,0}, {0,9,1})`) === 1, 'VPerpDot({1,_,0},{0,_,1}) = 1 (Y ignored)')
// Round half to EVEN (Cfile disasm 0x4D2005).
check(sim.eval(`return MATH_IRound(2.5)`) === 2, 'MATH_IRound(2.5) = 2 (half to even)')
check(sim.eval(`return MATH_IRound(3.5)`) === 4, 'MATH_IRound(3.5) = 4')
check(sim.eval(`return MATH_IRound(2.4)`) === 2, 'MATH_IRound(2.4) = 2')
check(sim.eval(`return MATH_IRound(-2.5)`) === -2, 'MATH_IRound(-2.5) = -2')
check(sim.eval(`return MATH_Lerp(0.5, 0, 10, 20)`) == null, 'MATH_Lerp with four args returns nil')
check(
  sim.eval(`
    local okShort = pcall(function() MATH_Lerp(0.5, 0) end)
    local okLong = pcall(function() MATH_Lerp(0.5, 0, 1, 0, 10, 20) end)
    local okType = pcall(function() MATH_Lerp('0.5', 0, 10) end)
    return not okShort and not okLong and not okType
  `) === true,
  'MATH_Lerp rejects invalid counts and non-number overload arguments',
)

console.log('\n== Quaternions (order {x,y,z,w}) ==')
// EulerToQuaternion(0,0,0) = identity {0,0,0,1}.
check(
  sim.eval(`
    local q = EulerToQuaternion(0,0,0)
    return (q[1]==0 and q[2]==0 and q[3]==0 and q[4]==1) and 'ok' or 'bad'
  `) === 'ok',
  'EulerToQuaternion(0,0,0) = identity {0,0,0,1}',
)
// A yaw of pi about Y: {0, sin(pi/2), 0, cos(pi/2)} = {0,1,0,~0}.
check(
  sim.eval(`
    local q = EulerToQuaternion(0, 0, math.pi)
    return (math.abs(q[1]) < 1e-6 and math.abs(q[2]-1) < 1e-6 and math.abs(q[3]) < 1e-6 and math.abs(q[4]) < 1e-6) and 'ok' or 'bad'
  `) === 'ok',
  'yaw of pi -> {0,1,0,0}',
)
// A pitch-only quarter turn exposes the first-component multiply order in
// func_EulerToQuaternion (Cfile:617610-617643):
// {sin(pi/4), 0, 0, cos(pi/4)}.
check(
  sim.eval(`
    local q = EulerToQuaternion(0, math.pi / 2, 0)
    local h = math.sqrt(0.5)
    return (math.abs(q[1]-h) < 1e-6 and math.abs(q[2]) < 1e-6 and
      math.abs(q[3]) < 1e-6 and math.abs(q[4]-h) < 1e-6 and q.x == q[1]) and 'ok' or 'bad'
  `) === 'ok',
  'pitch of pi/2 -> {sqrt(1/2),0,0,sqrt(1/2)} with vector aliases',
)
// OrientFromDir of a zero vector is identity (Cfile:641747).
check(
  sim.eval(`local q = OrientFromDir({0,0,0}) return q[1]..q[2]..q[3]..q[4]`) === '0001',
  'OrientFromDir({0,0,0}) = identity',
)
// OrientFromDir produces a UNIT quaternion for a real direction.
check(
  sim.eval(`
    local q = OrientFromDir({1, 0, 1})
    local l = math.sqrt(q[1]*q[1]+q[2]*q[2]+q[3]*q[3]+q[4]*q[4])
    return math.abs(l - 1) < 1e-5 and 'unit' or tostring(l)
  `) === 'unit',
  'OrientFromDir returns a unit quaternion',
)
// MinLerp at alpha 0 is L, at alpha 1 is R (both unit).
check(
  sim.eval(`local q = MinLerp(0, {0,0,0,1}, {0,1,0,0}) return q[4]`) === 1,
  'MinLerp(0, L, R) = L',
)
check(
  sim.eval(`
    local q = MinSlerp(0.5, {0,0,0,1}, {0,1,0,0})
    local l = math.sqrt(q[1]*q[1]+q[2]*q[2]+q[3]*q[3]+q[4]*q[4])
    return math.abs(l-1) < 1e-5 and 'unit' or tostring(l)
  `) === 'unit',
  'MinSlerp stays on the unit sphere',
)

console.log('\n== GetVersion ==')
check(sim.eval(`return GetVersion()`) === '1.5.3764', 'the Sim VM reports the real FA engine version 1.5.3764')

sim.close()

// --- The UI VM: the same globals must exist (scr_CoreInits => both) ---
console.log('\n== The UI VM has them too (scr_CoreInits) ==')
{
  const files = new Map<string, Uint8Array>()
  const allPaths = new Set<string>()
  for (const [k, v] of game.luaFiles) {
    if (k.endsWith('.lua')) {
      files.set(k, v)
      allPaths.add(k.toLowerCase())
    }
  }
  const ui = await LuaHost.create(files, () => {})
  installUiEngine(ui, {
    exists: (p: string) => allPaths.has(p),
    find: (dir: string, pattern: string) => findFiles(allPaths, dir, pattern),
    textureSize: () => null,
    stringAdvance: () => 0,
    fontMetrics: () => [0, 0],
  })
  for (const name of [
    'Dirname',
    'Basename',
    'STR_GetTokens',
    'STR_xtoi',
    'STR_itox',
    'Rect',
    'PointVector',
    'VDot',
    'VPerpDot',
    'MATH_IRound',
    'EulerToQuaternion',
    'OrientFromDir',
    'MinLerp',
    'MinSlerp',
    'GetVersion',
  ]) {
    check(ui.eval(`return type(${name})`) === 'function', `${name} is callable in the UI VM`)
  }
  // The UI VM's GetVersion uses the host value (this reimplementation's build).
  check(ui.eval(`return Dirname('/a/b.lua')`) === '/a', 'and they behave the same (Dirname)')
  ui.close()
}

await game.close()
console.log(failures === 0 ? '\nCORE GLOBALS PASSED' : `\nCORE GLOBALS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
