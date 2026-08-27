/**
 * Build-placement validity (the OGrid check that colours the ghost red/green).
 * Verifies src/sim/ogrid.ts against the engine algorithm documented in
 * docs/research/build-placement-binary.md, using a real structure blueprint
 * (uab0101, Aeon T1 land factory: Footprint 5x5, BuildOnLayerCaps.Land, no
 * skirt, FlattenSkirt) and synthetic terrain/water/occupancy contexts.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-ogrid.ts
 */
import { parseBlueprint } from '../src/formats/blueprint'
import { GameFiles } from './gameFiles'
import { LuaHost } from '../src/lua/host'
import { installEngine } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { FLAT_TEST_TERRAIN } from '../src/sim/terrain'
import {
  blueprintPlacement,
  canBuildStructureAt,
  footprintRect,
  skirtRect,
  rectsOverlap,
  packBuildOnLayerCaps,
  OC_LAND,
  OC_WATER,
  type BuildContext,
  type Placement,
  type Rect,
} from '../src/sim/ogrid'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()
const bpBytes = await game.read('units/uab0101/uab0101_unit.bp')
const bp = parseBlueprint(new TextDecoder('utf-8').decode(bpBytes))
const p = blueprintPlacement(bp)

console.log('== blueprintPlacement(uab0101) ==')
check(p.sizeX === 5 && p.sizeZ === 5, `footprint 5x5 (got ${p.sizeX}x${p.sizeZ})`)
check(p.buildOnLayerCaps === OC_LAND, `BuildOnLayerCaps = LAND only (got ${p.buildOnLayerCaps})`)
check(p.flattenSkirt === true, 'FlattenSkirt = true')
check(
  p.skirtSizeX === 8 && p.skirtSizeZ === 8 && p.skirtOffsetX === -1.5 && p.skirtOffsetZ === -1.5,
  `skirt 8x8 offset -1.5 (got ${p.skirtSizeX}x${p.skirtSizeZ} @ ${p.skirtOffsetX})`,
)
check(p.maxGroundVariation === 1.0, `MaxGroundVariation default 1.0 (got ${p.maxGroundVariation})`)
check(p.buildRestriction === 'RULEUBR_None', `unrestricted (got ${p.buildRestriction})`)
check(p.isMobile === false, 'structure is not mobile')

console.log('== footprint / skirt geometry ==')
// Snapped centre for a 5x5 footprint sits at cell+2.5 (COORDS_GridSnap).
const cx = 52.5
const cz = 52.5
const fp = footprintRect(p, cx, cz)
check(
  fp.x0 === 50 && fp.z0 === 50 && fp.x1 === 55 && fp.z1 === 55,
  `footprint rect [50,55]x[50,55] (got [${fp.x0},${fp.x1}]x[${fp.z0},${fp.z1}])`,
)
const sk = skirtRect(p, cx, cz)
// SkirtSize 8, offset -1.5: x0 = 50 - 1.5 = 48.5, x1 = 48.5 + 8 = 56.5.
check(
  sk.x0 === 48.5 && sk.x1 === 56.5 && sk.z0 === 48.5 && sk.z1 === 56.5,
  `offset skirt [48.5,56.5] (got [${sk.x0},${sk.x1}])`,
)
// The footprint (no offset) stays the inner 5x5.
const skNoSkirt = skirtRect({ ...p, skirtSizeX: 0, skirtSizeZ: 0 }, cx, cz)
check(
  skNoSkirt.x0 === 50 && skNoSkirt.x1 === 55,
  'skirt falls back to the footprint span when SkirtSize = 0',
)
check(rectsOverlap({ x0: 54, z0: 54, x1: 60, z1: 60 }, sk), 'overlap detected (corner touch inside)')
check(!rectsOverlap({ x0: 56.5, z0: 56.5, x1: 60, z1: 60 }, sk), 'edge-adjacent rects do NOT overlap')

console.log('== canBuildStructureAt ==')
const flat = (elev: number): BuildContext['heightAt'] => () => elev
const ctx = (over: Partial<BuildContext>): BuildContext => ({
  heightAt: flat(20),
  waterElevation: -10000,
  mapWidth: 256,
  mapHeight: 256,
  structures: [],
  ...over,
})

check(canBuildStructureAt(p, cx, cz, ctx({})) === 'valid', 'flat dry land -> valid (green)')

// Off the map: a footprint whose skirt reaches past the grid edge.
check(
  canBuildStructureAt(p, 254.5, 254.5, ctx({})) === 'invalid',
  'skirt past the map edge -> invalid',
)
// The skirt reaches 1.5 cells past the footprint: near the origin it hangs off
// the map edge (x0 = -1.5) and the engine rejects it (Cfile:709292).
check(
  canBuildStructureAt(p, 2.5, 2.5, ctx({})) === 'invalid',
  'skirt hanging off the map at the origin -> invalid',
)
check(
  canBuildStructureAt(p, 12.5, 12.5, ctx({})) === 'valid',
  'skirt fully on the map -> valid',
)

// Overlapping an existing structure's skirt.
const occupied: Rect = { x0: 52, z0: 52, x1: 57, z1: 57 }
check(
  canBuildStructureAt(p, cx, cz, ctx({ structures: [{ skirt: occupied }] })) === 'invalid',
  'skirt overlaps a placed structure -> invalid',
)
check(
  canBuildStructureAt(p, 62.5, 62.5, ctx({ structures: [{ skirt: occupied }] })) === 'valid',
  'a footprint clear of the placed structure -> valid',
)

// Steep terrain: >1.0 elevation spread over the footprint drops LAND (flatness).
const bumpy: BuildContext['heightAt'] = (x, _z) => 20 + (x % 2) * 3 // 3 m ripples
check(
  canBuildStructureAt(p, cx, cz, ctx({ heightAt: bumpy })) === 'invalid',
  'terrain varying > MaxGroundVariation -> invalid (too steep)',
)

// Water: a land-only building cannot sit where the ground is submerged.
check(
  canBuildStructureAt(p, cx, cz, ctx({ waterElevation: 25 })) === 'invalid',
  'land building under water -> invalid',
)

// A naval building (BuildOnLayerCaps = Water) is the mirror image.
const naval: Placement = {
  ...p,
  buildOnLayerCaps: packBuildOnLayerCaps({ LAYER_Water: true }),
  minWaterDepth: 1.0,
}
check(canBuildStructureAt(naval, cx, cz, ctx({})) === 'invalid', 'naval building on dry land -> invalid')
check(
  canBuildStructureAt(naval, cx, cz, ctx({ waterElevation: 25, heightAt: flat(20) })) === 'valid',
  'naval building in deep enough water -> valid',
)

// Buildings we cannot judge faithfully stay 'unknown' (mono ghost).
check(
  canBuildStructureAt({ ...p, isMobile: true }, cx, cz, ctx({})) === 'unknown',
  'mobile unit -> unknown (different occupancy path)',
)
check(
  canBuildStructureAt(
    { ...p, buildRestriction: 'RULEUBR_OnMassDeposit' },
    cx,
    cz,
    ctx({}),
  ) === 'unknown',
  'deposit-restricted building -> unknown (no markers loaded)',
)

// --- The two blueprint readers must agree -----------------------------------
//
// docs/STATUS.md records that the blueprint is read twice: by the TS parser and
// by the real LoadBlueprints() pipeline. That is only safe while the TS side
// stays a pure projection. `blueprintPlacement` is the one place where it does
// derive engine semantics (Footprint defaults, BuildOnLayerCaps), so the two
// derivations are compared here over EVERY structure blueprint in the game.
//
// The snap in worldCommands.ts:352 reads the Lua footprint while the ghost's
// validity in main.ts:622 reads the TS one — a disagreement decides whether a
// build order is issued at all, so it has to be a test failure, not a surprise.
console.log('\n== TS placement vs. the real LoadBlueprints() pipeline (all structures) ==')
{
  const host = await LuaHost.create(game.luaFiles, () => {})
  installEngine(host)
  setTerrainSource(host, FLAT_TEST_TERRAIN)

  const bpPaths = [...game.luaFiles.keys()].filter(
    (p) => p.startsWith('units/') && p.endsWith('_unit.bp'),
  )
  const list = bpPaths.map((p) => `'/${p}'`).join(',')
  host.eval(`__bpFiles = { ${list} }; LoadBlueprints()`)

  // One row per registered unit: id|SizeX|SizeZ|caps|isStructure. Integers go
  // through %d — %g would round the bitmask (see the caps-mask regression).
  const rows = String(
    host.eval(`
      local out = {}
      for id, bp in pairs(__registered.Unit) do
        local c, caps = bp.Physics.BuildOnLayerCaps, 0
        if c.LAYER_Land then caps = caps + 1 end
        if c.LAYER_Seabed then caps = caps + 2 end
        if c.LAYER_Sub then caps = caps + 4 end
        if c.LAYER_Water then caps = caps + 8 end
        if c.LAYER_Air then caps = caps + 16 end
        out[#out + 1] = string.format('%s|%d|%d|%d|%s', id,
          bp.Footprint.SizeX, bp.Footprint.SizeZ, caps,
          tostring(bp.Physics.MotionType == 'RULEUMT_None'))
      end
      return table.concat(out, ';')
    `),
  )

  const dec = new TextDecoder('utf-8')
  let compared = 0
  const mismatches: string[] = []
  for (const row of rows.split(';')) {
    if (!row) continue
    const [id, sx, sz, caps, structure] = row.split('|')
    if (structure !== 'true') continue // placement only applies to structures
    const raw = game.luaFiles.get(`units/${id}/${id}_unit.bp`)
    if (!raw) continue
    const ts = blueprintPlacement(parseBlueprint(dec.decode(raw)))
    compared++
    if (ts.sizeX !== Number(sx) || ts.sizeZ !== Number(sz)) {
      mismatches.push(
        `${id}: footprint TS ${ts.sizeX}x${ts.sizeZ} vs. Lua ${sx}x${sz}`,
      )
    } else if (ts.buildOnLayerCaps !== Number(caps)) {
      mismatches.push(
        `${id}: BuildOnLayerCaps TS 0x${ts.buildOnLayerCaps.toString(16)} vs. Lua 0x${Number(caps).toString(16)}`,
      )
    }
  }
  check(compared > 300, `${compared} structure blueprints compared (expected > 300)`)
  check(
    mismatches.length === 0,
    mismatches.length === 0
      ? 'every structure: TS placement == Lua pipeline (Footprint + BuildOnLayerCaps)'
      : `${mismatches.length} blueprint(s) disagree: ${mismatches.slice(0, 5).join(', ')}`,
  )
  host.close()
}

await game.close()
console.log(failures === 0 ? '\nOGRID BESTANDEN' : `\nOGRID FEHLGESCHLAGEN (${failures})`)
process.exit(failures === 0 ? 0 : 1)
