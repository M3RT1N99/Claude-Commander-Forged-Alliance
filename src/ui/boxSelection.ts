/**
 * Drag-box selection — the decision part of `Moho::SelectionDragger::DragRelease`
 * (Cfile:863870). Projection and picking are the renderer's job; WHICH of the
 * projected units end up selected is decided here, exactly as the engine does:
 *
 *  1. Candidates come from the drag volume, filtered to `IsSelectable` and the
 *     focus army (`sub_863F10` -> `sub_863E20`, Cfile:1290182 / 1290158).
 *  2. Per candidate: `IsMobile(u) || !IsUnitState(u, 37)` (Cfile:1290062);
 *     37 = `UNITSTATE_BeingUpgraded` (Cfile:703040) — a structure that is being
 *     upgraded cannot be box-selected.
 *  3. Hit test: the MESH bounding box, its half extents multiplied by
 *     `SelectionMeshScaleX/Y/Z` (REntityBlueprint+292/296/300, default
 *     1.0, Cfile:1290065-1290071), against the drag volume.
 *  4. Priority: `General.SelectionPriority` (RUnitBlueprint+508, default 1,
 *     Cfile:656081), forced to 6 when the unit is under construction AND has
 *     category `LOWSELECTPRIO` (Cfile:1290017-1290027). Hits go into bucket
 *     `max(priority, 1)`; only the FIRST non-empty bucket is selected
 *     (Cfile:1290055-1290075) — the blueprint field says "1 is highest".
 *
 * Shift (`mModifiers & 1`, Cfile:1289882): the original does NOT run the
 * priority stage in that branch — it uses the candidate set directly. If every
 * hit unit is already selected, the hits are REMOVED from the selection
 * (`v5 >= size(a1)` -> `SetSelection(selection \ hits)`, Cfile:1289893-1289930),
 * otherwise they are added.
 */

import { bpGet, type BpObject } from '../formats/blueprint'

/** What box selection needs from a unit blueprint. */
export interface SelectionBpData {
  /**
   * `SelectionMeshScaleX/Y/Z` — multipliers on the MESH bounding box
   * half extents (default 1.0, Cfile:647006-647008). NOT the selection ring
   * size: that is `SelectionSizeX/Z`, a different field (Cfile:1215203).
   */
  meshScale: { x: number; y: number; z: number }
  /** `General.SelectionPriority` — 1 is highest (default 1, Cfile:656081). */
  priority: number
  /** Category `LOWSELECTPRIO` (Cfile:432357). */
  lowSelectPrio: boolean
  /** `Physics.MotionType` != RULEUMT_None — `IUnit::IsMobile` (Cfile:1290062). */
  mobile: boolean
}

/** Read the four blueprint facts box selection runs on. */
export function selectionBpData(bp: BpObject): SelectionBpData {
  const num = (path: string, fallback: number): number => {
    const v = bpGet(bp, path)
    return typeof v === 'number' ? v : fallback
  }
  const cats = bpGet(bp, 'Categories')
  const lowSelectPrio =
    Array.isArray(cats) && cats.some((c) => typeof c === 'string' && c.toUpperCase() === 'LOWSELECTPRIO')
  const motion = bpGet(bp, 'Physics.MotionType')
  return {
    meshScale: {
      x: num('SelectionMeshScaleX', 1),
      y: num('SelectionMeshScaleY', 1),
      z: num('SelectionMeshScaleZ', 1),
    },
    priority: num('General.SelectionPriority', 1),
    lowSelectPrio,
    mobile: typeof motion === 'string' && motion !== 'RULEUMT_None',
  }
}

/** A screen-space axis-aligned rectangle (client pixels). */
export interface ScreenRect {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

/** One unit that survived step 1 and 2, with its projected selection box. */
export interface SelectionCandidate {
  id: number
  /** Projected selection box; `null` when no corner is in front of the camera. */
  screen: ScreenRect | null
  /** `General.SelectionPriority` (1 = highest). */
  priority: number
  /** Category `LOWSELECTPRIO`. */
  lowSelectPrio: boolean
  /** Under construction (`fractionComplete < 1`). */
  beingBuilt: boolean
}

/** Step 4's bucket index: `max(priority, 1)`, 6 for LOWSELECTPRIO under construction. */
export function selectionPriority(c: SelectionCandidate): number {
  if (c.beingBuilt && c.lowSelectPrio) return 6
  return Math.max(1, c.priority)
}

const overlaps = (a: ScreenRect, b: ScreenRect): boolean =>
  a.maxX >= b.minX && a.minX <= b.maxX && a.maxY >= b.minY && a.minY <= b.maxY

/**
 * The units the drag box selects (steps 3 and 4). With `additive` the priority
 * stage is skipped — that is what the original's Shift branch does.
 */
export function boxSelectIds(
  candidates: readonly SelectionCandidate[],
  box: ScreenRect,
  additive: boolean,
): number[] {
  const hits = candidates.filter((c) => c.screen !== null && overlaps(c.screen, box))
  if (hits.length === 0) return []
  if (additive) return hits.map((c) => c.id)
  let best = Infinity
  for (const c of hits) {
    const p = selectionPriority(c)
    if (p < best) best = p
  }
  return hits.filter((c) => selectionPriority(c) === best).map((c) => c.id)
}

/**
 * Merge hits into the running selection. Without Shift the hits ARE the new
 * selection; with Shift they are removed when all of them are already selected
 * and added otherwise.
 */
export function mergeSelection(
  current: readonly number[],
  hits: readonly number[],
  additive: boolean,
): number[] {
  if (!additive) return [...hits]
  const out = new Set(current)
  const allSelected = hits.length > 0 && hits.every((id) => out.has(id))
  for (const id of hits) {
    if (allSelected) out.delete(id)
    else out.add(id)
  }
  return [...out]
}
