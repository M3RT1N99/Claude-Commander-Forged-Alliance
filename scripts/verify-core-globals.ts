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
import { FLAT_TEST_MAP_SIZE } from '../src/sim/terrain'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()

// --- The SIM VM ---
const sim = await LuaHost.create(game.luaFiles, () => {})
installEngine(sim)
setTerrainSource(sim, () => 20, FLAT_TEST_MAP_SIZE)

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

// ── DiskFindFiles in the SIM VM ─────────────────────────────────────────────
//
// It used to search only `__bpFiles` and IGNORE the pattern argument entirely
// (blueprints.lua). That is a silent wrong answer, and it had a consequence:
// localization.lua:29 asks for `DiskFindFiles('/loc', '*strings_db.lua')` and
// got blueprint paths or nothing, so /lua/globalinit.lua:14-24 — and with it
// the retail /lua/simInit.lua — could never run. The UI VM had the correct
// implementation all along (src/vfs/glob.ts).
//
// Blueprints deliberately still come from `__bpFiles`: the engine would return
// the whole game directory here, we load blueprints selectively. That deviation
// is named in blueprints.lua; this check pins BOTH halves of it.
console.log('\n== DiskFindFiles (Sim) honours the pattern and sees the real VFS ==')
{
  const loc = Number(sim.eval(`return #DiskFindFiles('/loc', '*strings_db.lua')`))
  check(loc > 0, `/loc '*strings_db.lua' finds ${loc} file(s) — what localization.lua:29 needs`)
  // The pattern really filters: the same directory with a pattern that cannot
  // match must come back empty. Without this the check above would also pass
  // for a reader that ignores the pattern and returns everything it has.
  check(
    Number(sim.eval(`return #DiskFindFiles('/loc', '*_nothing_matches_this.lua')`)) === 0,
    'and a pattern that cannot match returns nothing (the pattern is really applied)',
  )
  check(
    Number(sim.eval(`return #DiskFindFiles('/maps', '*_scenario.lua')`)) > 0,
    `/maps '*_scenario.lua' finds the installed maps`,
  )
  // The blueprint narrowing: `.bp` comes from `__bpFiles`, which is empty here.
  check(
    Number(sim.eval(`return #DiskFindFiles('/units', '*.bp')`)) === 0,
    `'*.bp' still comes from __bpFiles (deliberate — we load blueprints selectively)`,
  )

  // ── And it must be a REAL Lua table ──────────────────────────────────────
  //
  // The bridge is a JS function, and wasmoon hands its array to Lua as a
  // USERDATA proxy, not a table. Measured: `#` and `ipairs` work, but `pairs`
  // tears the VM down ("Cannot read properties of null (reading 'then')"), and
  // the original Lua's `for k,v in t do` — which the transpiler turns into
  // `__foriter(t)` (compat.lua:14-22, table branch tests `type(a)=='table'`) —
  // falls through and CALLS the proxy as an iterator: "self is not a function".
  //
  // That is exactly what killed /schook/lua/simInit.lua, and it would equally
  // kill maputil.lua:106 and helptext.lua:26 in the UI VM — the lobby's map
  // list. `#` alone would not have caught it, which is why the dialect path is
  // asserted here and not just the length.
  check(
    sim.eval(`return type(DiskFindFiles('/loc', '*strings_db.lua'))`) === 'table',
    'das Ergebnis ist eine echte Lua-Tabelle, keine userdata',
  )
  check(
    Number(
      sim.eval(
        `local n = 0 for _ in pairs(DiskFindFiles('/loc', '*strings_db.lua')) do n = n + 1 end return n`,
      ),
    ) === loc,
    'pairs() läuft darüber (auf userdata stürzt die VM ab)',
  )
  check(
    Number(
      sim.eval(
        `local n = 0 for k, v in __foriter(DiskFindFiles('/loc', '*strings_db.lua')) do n = n + 1 end return n`,
      ),
    ) === loc,
    'und der FA-Dialekt-Weg `for k,v in t do` (__foriter) auch — daran starb der schook-Hook',
  )
}

// ── CreatePrefetchSet (scr_CoreInits — both VMs) ────────────────────────────
//
// `Prefetcher = CreatePrefetchSet()` sits at siminit.lua:232, so the retail
// /lua/simInit.lua cannot get past that line without it. Registered at
// Cfile:563841-563853 with the help string "create an empty prefetch set", and
// its metatable carries exactly two methods, Update (Cfile:563891-563897) and
// Reset (Cfile:563950-563956).
console.log('\n== CreatePrefetchSet (siminit.lua:232) ==')
{
  check(sim.eval(`return type(CreatePrefetchSet)`) === 'function', 'existiert in der Sim-VM')
  check(
    sim.eval(`local p = CreatePrefetchSet() return type(p.Update) == 'function' and type(p.Reset) == 'function'`) ===
      true,
    'liefert ein Objekt mit genau Update und Reset',
  )
  // Exactly the call simInit.lua:252 makes, with exactly the table
  // DefaultPrefetchSet() builds — three EMPTY lists, because all three
  // DiskFindFiles loops in it are commented out (siminit.lua:237-247).
  check(
    sim.eval(
      `local p = CreatePrefetchSet()
       local ok = pcall(function() p:Update({ models = {}, anims = {}, d3d_textures = {} }) end)
       return ok`,
    ) === true,
    'Prefetcher:Update(DefaultPrefetchSet()) läuft durch (drei leere Listen)',
  )
  // And it is not a function that swallows anything: a non-table is an error,
  // the way the engine's argument check is.
  check(
    sim.eval(`local p = CreatePrefetchSet() return pcall(function() p:Update('nope') end)`) === false,
    'ein Nicht-Tabellen-Argument wirft',
  )
}

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
    // scr_CoreInits: `CreatePrefetchSet` ist in BEIDEN VMs registriert
    // (Cfile:563845 haengt es an `scr_CoreInits.mForms`).
    'CreatePrefetchSet',
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
