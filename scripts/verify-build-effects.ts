/**
 * Build effects — the original `effectutilities.lua` running end to end for all
 * four factions. It calls engine bindings on every build; a single missing one
 * kills the whole ForkThread and the construction is silently effect-less.
 *
 * Three such holes this suite guards:
 *
 *  - `CreateUnit` (Cfile:980268, help text Cfile:980258) and `IssueGuard`
 *    (Cfile:1008933) were missing, so effectutilities.lua:436 SpawnBuildBots
 *    died with "attempt to call a nil value (global 'CreateUnit')" — Cybran
 *    engineers built with NO visible effect at all.
 *  - `BeenDestroyed` on manipulators (Cfile:879376 answers `opt == 0`) was
 *    missing, so effectutilities.lua:664 (the Seraphim factory build effect)
 *    died at ~80 % and never removed its build base.
 *  - `Entity:SetScale` took one argument; the engine takes 2 OR 4
 *    (Cfile:935305) and effectutilities.lua:100 scales the build cube per axis
 *    with the building's footprint.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-build-effects.ts
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

/**
 * One build, one fresh sim: builder spawns, construction site is created,
 * the build task runs for `beats` beats. Returns what the ORIGINAL effect
 * code produced.
 */
async function build(
  builderId: string,
  targetId: string,
  extra: string[],
  beats = 30,
): Promise<{ emitters: number; projectiles: number; scales: number[][]; bots: number; warn: string[] }> {
  const warn: string[] = []
  const host = await LuaHost.create(game.luaFiles, (level, msg) => {
    if (level === 'WARN') warn.push(msg)
  })
  const engine = installEngine(host)
  setTerrainSource(host, () => 20)
  // The build effects ARE projectile blueprints (/effects/entities/**) — the
  // browser loads them with LoadBlueprints(), here they come from the archive.
  game.loadProjectiles(host)
  for (const id of [builderId, targetId, ...extra]) await game.giveUnit(host, id)
  const builder = spawnLuaUnit(host, builderId, { x: 100, y: 20, z: 100 }, 1)
  for (let i = 0; i < 8; i++) beat(engine)
  const site = Number(
    host.eval(
      `return __spawnBuildSite('/units/${targetId}/${targetId}_script.lua', '${targetId}', ` +
        `106, 20, 100, 1, ${builder}, 'MobileBuild')`,
    ),
  )
  host.eval(`__issueBuildTask(${builder}, ${site}, 'MobileBuild')`)
  for (let i = 0; i < beats; i++) beat(engine)
  const emitters = Number(host.eval('local n=0 for _ in pairs(__emitters or {}) do n=n+1 end return n'))
  const projectiles = Number(host.eval('local n=0 for _ in pairs(__projectiles or {}) do n=n+1 end return n'))
  const scales = JSON.parse(
    host.eval(`
      local parts = {}
      for _, p in pairs(__projectiles or {}) do
        local s = p.__scale or { 0, 0, 0 }
        parts[#parts + 1] = string.format('[%.4f,%.4f,%.4f]', s[1], s[2], s[3])
      end
      return '[' .. table.concat(parts, ',') .. ']'
    `) as string,
  ) as number[][]
  const bots = Number(
    host.eval(`
      local n = 0
      for _, u in pairs(__units) do if u.__bp and u.__bp.BlueprintId == 'ura0001' then n = n + 1 end end
      return n
    `),
  )
  host.close()
  return { emitters, projectiles, scales, bots, warn }
}

const relevant = (w: string[]): string[] =>
  w.filter((m) => /effectutilities|nil value|attempt to|CreateUnit|IssueGuard|BeenDestroyed|SetScale/i.test(m))

console.log('\n== UEF: build cube + beams (effectutilities.lua:99 CreateBuildCubeThread) ==')
{
  const r = await build('uel0001', 'ueb1101', [])
  check(r.emitters > 0, `${r.emitters} emitters`)
  check(r.projectiles > 0, `${r.projectiles} effect projectiles (the build cube and its slices)`)
  // effectutilities.lua:100 -> proj:SetScale(x * 1.05, y * 0.2, z * 1.05): the
  // axes MUST differ, otherwise the cube has lost the building's footprint.
  const anisotropic = r.scales.some((s) => {
    // The Lua above formats every scale as three numbers; a row that is not
    // three numbers is no evidence of a per-axis scale, so it does not count.
    const [x, y, z] = s
    if (x === undefined || y === undefined || z === undefined) return false
    return Math.abs(x - y) > 1e-3 || Math.abs(z - y) > 1e-3
  })
  check(anisotropic, `The build cube keeps its per-axis scale (${JSON.stringify(r.scales.slice(0, 2))})`)
  check(relevant(r.warn).length === 0, `No effect errors (${relevant(r.warn).slice(0, 1)})`)
}

console.log('\n== Aeon ==')
{
  const r = await build('ual0001', 'uab1101', [])
  check(r.emitters > 0, `${r.emitters} emitters`)
  check(relevant(r.warn).length === 0, `No effect errors (${relevant(r.warn).slice(0, 1)})`)
}

console.log('\n== Cybran: build bots via CreateUnit + IssueGuard ==')
{
  const r = await build('url0001', 'urb1101', ['ura0001'])
  check(r.bots > 0, `${r.bots} build bots (ura0001) — effectutilities.lua:436 CreateUnit`)
  check(r.emitters > 0, `${r.emitters} emitters (they were 0: the thread died at CreateUnit)`)
  check(relevant(r.warn).length === 0, `No effect errors (${relevant(r.warn).slice(0, 1)})`)
}

console.log('\n== Seraphim factory: the slider survives to the end (BeenDestroyed) ==')
{
  const r = await build('xsb0101', 'xsl0101', [], 60)
  check(r.emitters > 0, `${r.emitters} emitters`)
  check(
    relevant(r.warn).length === 0,
    `No effect errors — it used to die at effectutilities.lua:664 (${relevant(r.warn).slice(0, 1)})`,
  )
}

console.log('\n== The build bots are guarded onto the site (IssueGuard, Cfile:1008933) ==')
{
  // Same run as above, but check the order that IssueGuard placed.
  const warn: string[] = []
  const host = await LuaHost.create(game.luaFiles, (level, msg) => {
    if (level === 'WARN') warn.push(msg)
  })
  const engine = installEngine(host)
  setTerrainSource(host, () => 20)
  game.loadProjectiles(host)
  for (const id of ['url0001', 'urb1101', 'ura0001']) await game.giveUnit(host, id)
  const acu = spawnLuaUnit(host, 'url0001', { x: 100, y: 20, z: 100 }, 1)
  for (let i = 0; i < 8; i++) beat(engine)
  const site = Number(
    host.eval(
      `return __spawnBuildSite('/units/urb1101/urb1101_script.lua', 'urb1101', 106, 20, 100, 1, ${acu}, 'MobileBuild')`,
    ),
  )
  host.eval(`__issueBuildTask(${acu}, ${site}, 'MobileBuild')`)
  for (let i = 0; i < 30; i++) beat(engine)
  const guarding = Number(
    host.eval(`
      local n = 0
      for id, u in pairs(__units) do
        if u.__bp and u.__bp.BlueprintId == 'ura0001' and __guardOrders[id] then n = n + 1 end
      end
      return n
    `),
  )
  check(guarding > 0, `${guarding} bots carry a Guard order on the site`)
  host.close()
}

await game.close()
console.log(failures === 0 ? '\nBUILD EFFECTS PASSED' : `\nBUILD EFFECTS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
