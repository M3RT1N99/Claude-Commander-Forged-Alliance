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

/** A unit visible to the same-type selection: its id, blueprint, army, in-view. */
export interface SameTypeUnit {
  id: number
  bpId: string
  army: number
  inView: boolean
}

/**
 * Same-blueprint selection — every focus-army unit of the SAME blueprint as the
 * clicked one (HandleDoubleClickSelection, Cfile:865E20; Ctrl-click same-type,
 * Cfile:1291547-1291681). Both the double-click and the Ctrl-click path REPLACE
 * the selection with the same-type set (the engine's Ctrl branch builds a fresh
 * set and calls SetSelection(v37), Cfile:1291573-1291591) — Ctrl-click does NOT
 * add to the current selection.
 *
 *   'replace' — double-click / Ctrl-click: the same-type set becomes the whole
 *               selection.
 *   'toggle'  — Ctrl-Shift-click: a CONDITIONAL toggle keyed on the clicked unit
 *               (Cfile:1291596-1291635). If the clicked unit is already selected,
 *               REMOVE the same-type set; otherwise ADD it. `clickedSelected`
 *               carries that state.
 *
 * `clickedBpId` is null when the click missed a focus-army unit (replace then
 * clears, toggle leaves the selection unchanged).
 *
 * NOTE: the engine's Ctrl-click collects same-type units from the whole spatial
 * DB (map-wide, focus army, not being built, not dead — Cfile:1291641-1291684),
 * while the double-click is limited to on-screen units. We approximate both with
 * the caller's in-view candidate set; a map-wide Ctrl-click is a deliberate,
 * documented reduction (selecting off-screen units the player can't see).
 */
export function sameTypeIds(
  clickedBpId: string | null,
  focusArmy: number,
  candidates: readonly SameTypeUnit[],
  current: readonly number[],
  mode: 'replace' | 'toggle',
  clickedSelected = false,
): number[] {
  if (clickedBpId === null) return mode === 'replace' ? [] : [...current]
  const sameType = candidates
    .filter((u) => u.army === focusArmy && u.bpId === clickedBpId && u.inView)
    .map((u) => u.id)
  if (mode === 'replace') return sameType
  // Ctrl+Shift toggle: the clicked unit's current selected state decides the
  // direction for the ENTIRE same-type set (Cfile:1291604-1291635).
  const out = new Set(current)
  for (const id of sameType) {
    if (clickedSelected) out.delete(id)
    else out.add(id)
  }
  return [...out]
}
