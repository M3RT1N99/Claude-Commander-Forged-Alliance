import { bpGet, type BpValue } from '../formats/blueprint'

/**
 * Build-placement validity — a faithful reimplementation of the engine's
 * occupancy / placement check (`COGrid` + `func_LocationIsFree` + `OCCUPY_Check`,
 * see docs/research/build-placement-binary.md). This is engine CALCULATION, not
 * game logic: the original C++ decides whether a structure may sit at a snapped
 * cell, and the player's red/green ghost uses the very same query
 * (`CAiBrain::CanBuildStructureAt` -> `func_LocationIsFree`, Cfile:726373 /
 * 1044976).
 *
 * The check needs only map data the world already has: the heightfield (for the
 * elevation range under the footprint), the water elevation, the map cell bounds
 * and the set of placed structures (their skirt rects). No value is invented —
 * every step cites the binary.
 *
 * Two parts are honestly reduced, NOT guessed:
 *  - The `FlattenSkirt` edge-flatness variant (OCCUPY_CheckEdgeFlatness,
 *    Cfile:708955) samples a perimeter ring one cell outside the skirt and
 *    compares each side to a rounded centre reference `v44`; the decompiled
 *    register aliasing on that reference is ambiguous, so we use the unambiguous
 *    area-flatness spread (all skirt cells, Cfile:709124) for both cases. It is
 *    exact for `FlattenSkirt == false` and a slightly stricter, well-defined
 *    proxy otherwise.
 *  - `Physics.BuildRestriction` (mass / hydrocarbon deposit requirement,
 *    Cfile:709320) needs deposit markers the sim does not load yet; such
 *    buildings return `'unknown'` (the ghost stays mono-coloured) rather than a
 *    misleading green/red.
 */

// EOccupancyCaps layer bits (from the func_LocationIsFree masks,
// Cfile:1045494/1045526): LAND|SEABED|SUB = 7 = "terrain", WATER = 8.
export const OC_LAND = 1
export const OC_SEABED = 2
export const OC_SUB = 4
export const OC_WATER = 8
export const OC_AIR = 0x10
export const OC_TERRAIN = OC_LAND | OC_SEABED | OC_SUB // 7

/** Default flatness tolerance — RUnitBlueprint ctor mMaxGroundVariation = 1.0 (Cfile:656138). */
const DEFAULT_MAX_GROUND_VARIATION = 1.0

export interface Rect {
  x0: number
  z0: number
  x1: number
  z1: number
}

/** Everything the placement check reads from a blueprint, extracted once. */
export interface Placement {
  sizeX: number
  sizeZ: number
  skirtSizeX: number
  skirtSizeZ: number
  skirtOffsetX: number
  skirtOffsetZ: number
  /** Physics.BuildOnLayerCaps packed to the OC_* bits. */
  buildOnLayerCaps: number
  /** Physics.MaxGroundVariation (default 1.0). */
  maxGroundVariation: number
  flattenSkirt: boolean
  /** Footprint.MinWaterDepth (default 0). */
  minWaterDepth: number
  /** Physics.BuildRestriction ('RULEUBR_None' when unrestricted). */
  buildRestriction: string
  isMobile: boolean
}

export interface PlacedStructure {
  /** The structure's skirt rect in world units (GetSkirtRect). */
  skirt: Rect
}

export interface BuildContext {
  /** Terrain elevation at an integer cell corner (raw heightfield sample). */
  heightAt: (x: number, z: number) => number
  /** Water surface elevation, or -10000 when the map has no water (Cfile:709312). */
  waterElevation: number
  /** Map size in CELLS (heightfield width/height, = samples - 1). */
  mapWidth: number
  mapHeight: number
  /** Placed immobile units whose skirts block new placement. */
  structures: PlacedStructure[]
}

export type Validity = 'valid' | 'invalid' | 'unknown'

/** Physics.BuildOnLayerCaps table -> packed OC_* bitmask (Cfile:709300 consumer). */
export function packBuildOnLayerCaps(caps: unknown): number {
  const t = (caps ?? {}) as Record<string, unknown>
  let bits = 0
  if (t['LAYER_Land']) bits |= OC_LAND
  if (t['LAYER_Seabed']) bits |= OC_SEABED
  if (t['LAYER_Sub']) bits |= OC_SUB
  if (t['LAYER_Water']) bits |= OC_WATER
  if (t['LAYER_Air']) bits |= OC_AIR
  return bits
}

/** Read the placement fields from a blueprint (Footprint + Physics). */
export function blueprintPlacement(bp: BpValue | undefined): Placement {
  const num = (path: string, dflt: number): number => {
    const v = bpGet(bp, path)
    return typeof v === 'number' ? v : dflt
  }
  const restriction = bpGet(bp, 'Physics.BuildRestriction')
  const motion = bpGet(bp, 'Physics.MotionType')
  return {
    sizeX: num('Footprint.SizeX', 1),
    sizeZ: num('Footprint.SizeZ', 1),
    skirtSizeX: num('Physics.SkirtSizeX', 0),
    skirtSizeZ: num('Physics.SkirtSizeZ', 0),
    skirtOffsetX: num('Physics.SkirtOffsetX', 0),
    skirtOffsetZ: num('Physics.SkirtOffsetZ', 0),
    buildOnLayerCaps: packBuildOnLayerCaps(bpGet(bp, 'Physics.BuildOnLayerCaps')),
    maxGroundVariation: num('Physics.MaxGroundVariation', DEFAULT_MAX_GROUND_VARIATION),
    flattenSkirt: bpGet(bp, 'Physics.FlattenSkirt') === true,
    minWaterDepth: num('Footprint.MinWaterDepth', 0),
    buildRestriction: typeof restriction === 'string' ? restriction : 'RULEUBR_None',
    // A structure has no ground/naval/air motion; anything that moves takes the
    // mobile occupancy path (Cfile:709257 !IsMobile), which we do not model here.
    isMobile: typeof motion === 'string' && motion !== 'RULEUMT_None',
  }
}

/**
 * The top-left occupied cell of a footprint centred at (cx, cz).
 * `xLower = (int)(cx - SizeX*0.5)` — truncation, matching COORDS_GridSnap and
 * GetSkirtRect (Cfile:656012-656014). `cx`/`cz` are the snapped centre.
 */
function topLeftCell(p: Placement, cx: number, cz: number): { x: number; z: number } {
  return {
    x: Math.trunc(cx - p.sizeX * 0.5),
    z: Math.trunc(cz - p.sizeZ * 0.5),
  }
}

/** Integer footprint rect (Cfile:1045001-1045010): [xLower, xLower+SizeX]. */
export function footprintRect(p: Placement, cx: number, cz: number): Rect {
  const tl = topLeftCell(p, cx, cz)
  return { x0: tl.x, z0: tl.z, x1: tl.x + p.sizeX, z1: tl.z + p.sizeZ }
}

/**
 * Skirt rect in world units (GetSkirtRect, Cfile:656013-656042). With no skirt
 * (SkirtSize == 0) it is the footprint span; otherwise the offset skirt box.
 */
export function skirtRect(p: Placement, cx: number, cz: number): Rect {
  const tl = topLeftCell(p, cx, cz)
  const x0 = p.skirtSizeX === 0 ? tl.x : tl.x + p.skirtOffsetX
  const x1 = p.skirtSizeX === 0 ? tl.x + p.sizeX : x0 + p.skirtSizeX
  const z0 = p.skirtSizeZ === 0 ? tl.z : tl.z + p.skirtOffsetZ
  const z1 = p.skirtSizeZ === 0 ? tl.z + p.sizeZ : z0 + p.skirtSizeZ
  return { x0, z0, x1, z1 }
}

/** Half-open rect overlap (Rect2f::Overlaps, Cfile:726527). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.z0 < b.z1 && a.z1 > b.z0
}

const clampInt = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/**
 * Min/max terrain elevation over the skirt cells (OCCUPY_CheckAreaFlatness,
 * Cfile:709148-709190): iterate every cell in the truncated skirt rect,
 * clamped to the map, and track the range. Feeds both the flatness test and the
 * water-layer gating.
 */
function elevationRange(skirt: Rect, ctx: BuildContext): { min: number; max: number } {
  const x0 = Math.trunc(skirt.x0)
  const x1 = Math.trunc(skirt.x1)
  const z0 = Math.trunc(skirt.z0)
  const z1 = Math.trunc(skirt.z1)
  let min = Infinity
  let max = -Infinity
  for (let x = x0; x <= x1; x++) {
    for (let z = z0; z <= z1; z++) {
      const e = ctx.heightAt(clampInt(x, 0, ctx.mapWidth), clampInt(z, 0, ctx.mapHeight))
      if (e < min) min = e
      if (e > max) max = e
    }
  }
  return { min, max }
}

/**
 * OCCUPY_Check for a structure (Cfile:709255-709360): returns the allowed layer
 * bitmask, or 0 when the location is unbuildable (out of bounds, or every layer
 * gated out). Does NOT include structure-vs-structure overlap (that is the
 * caller's job, matching func_LocationIsFree).
 */
function occupyCheck(p: Placement, cx: number, cz: number, ctx: BuildContext): number {
  const skirt = skirtRect(p, cx, cz)
  // Round to int cells: floor x0/z0, ceil x1/z1 (Cfile:709274-709295).
  const rx0 = Math.floor(skirt.x0)
  const rz0 = Math.floor(skirt.z0)
  const rx1 = Math.ceil(skirt.x1)
  const rz1 = Math.ceil(skirt.z1)
  // Map-bounds: out of the playable grid is not buildable (Cfile:709292-709298).
  if (rx0 < 0 || rz0 < 0 || rx1 > ctx.mapWidth || rz1 > ctx.mapHeight) return 0

  let caps = p.buildOnLayerCaps
  const { min, max } = elevationRange(skirt, ctx)
  // Flatness: too much variation drops LAND + SEABED (Cfile:709304-709308).
  if (!(p.maxGroundVariation >= max - min)) caps &= ~(OC_LAND | OC_SEABED)
  // Water-layer gating (Cfile:709313-709316).
  const water = ctx.waterElevation
  if (water > min) caps &= ~OC_LAND // lowest point submerged -> no land
  if (max > water - p.minWaterDepth) caps &= ~(OC_SEABED | OC_SUB | OC_WATER) // too shallow
  return caps
}

/**
 * func_LocationIsFree for a structure (Cfile:1044976): OCCUPY_Check, then reject
 * if the skirt overlaps any placed structure's skirt. Structure footprints are
 * a subset of their skirts, so the skirt-overlap sweep already subsumes the
 * terrain/water grid-occupancy step (Cfile:1045035) for structure-vs-structure.
 */
export function canBuildStructureAt(
  p: Placement,
  cx: number,
  cz: number,
  ctx: BuildContext,
): Validity {
  // Deposit-restricted buildings need markers we do not load; mobile units take
  // a different occupancy path. Do not fake a verdict.
  if (p.isMobile) return 'unknown'
  if (p.buildRestriction && p.buildRestriction !== 'RULEUBR_None') return 'unknown'

  if (occupyCheck(p, cx, cz, ctx) === 0) return 'invalid'

  const skirt = skirtRect(p, cx, cz)
  for (const s of ctx.structures) {
    if (rectsOverlap(skirt, s.skirt)) return 'invalid'
  }
  return 'valid'
}
