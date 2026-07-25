/**
 * Drag-box selection — `Moho::SelectionDragger::DragRelease` (Cfile:863870).
 *
 * Until now there was NO multi-select at all: every drag longer than 5 px ended
 * without a selection, the green rectangle was decoration. This suite runs the
 * decision part (src/ui/boxSelection.ts) against REAL blueprint data:
 * SelectionPriority, SelectionMeshScale and the categories come from the
 * player's units.scd, not from a mock.
 *
 *   npx tsx scripts/verify-selection.ts
 */
import { parseBlueprint, parseLuaAssignments, bpGet } from '../src/formats/blueprint'
import {
  boxSelectIds,
  mergeSelection,
  sameTypeIds,
  selectionBpData,
  selectionPriority,
  type SameTypeUnit,
  type SelectionCandidate,
} from '../src/ui/boxSelection'
import {
  SELECT_PARAM_DEFAULTS,
  bracketThickness,
  createBracketGeometry,
  updateBracketGeometry,
} from '../src/ui/selectionBrackets'
import { GameFiles } from './gameFiles'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()
const bpOf = async (id: string) =>
  parseBlueprint(new TextDecoder('utf-8').decode(await game.read(`units/${id}/${id}_unit.bp`)))

// ── The blueprint facts, straight from the archive ──
console.log('\n== Blueprint data (units.scd) ==')
const tank = selectionBpData(await bpOf('uel0201')) // T1 Land Bot
const engineer = selectionBpData(await bpOf('uel0105')) // T1 Engineer
const factory = selectionBpData(await bpOf('ueb0101')) // T1 Land Factory
const acu = selectionBpData(await bpOf('uel0001')) // ACU
const naval = selectionBpData(await bpOf('ueb0103')) // T1 Naval Factory (SelectionMeshScale 0.3/0.4)

check(tank.priority === 1, `uel0201 has no SelectionPriority -> default 1 (${tank.priority})`)
check(engineer.priority === 3, `uel0105 SelectionPriority = 3 (${engineer.priority})`)
check(factory.priority === 5, `ueb0101 SelectionPriority = 5 (${factory.priority})`)
check(acu.priority === 3, `uel0001 SelectionPriority = 3 (${acu.priority})`)
check(
  naval.meshScale.x === 0.3 && naval.meshScale.z === 0.4,
  `ueb0103 SelectionMeshScaleX/Z = 0.3/0.4 (${naval.meshScale.x}/${naval.meshScale.z})`,
)
check(naval.meshScale.y === 1, `ueb0103 has no SelectionMeshScaleY -> 1.0 (${naval.meshScale.y})`)
check(tank.meshScale.x === 1 && tank.meshScale.y === 1, 'missing SelectionMeshScale defaults to 1.0 (Cfile:647006)')
check(tank.mobile && !factory.mobile, 'IsMobile: bot yes, factory no (Physics.MotionType)')
check(!tank.lowSelectPrio && !factory.lowSelectPrio, 'no FA unit carries LOWSELECTPRIO')

// ── Step 4: only the best bucket ──
console.log('\n== Only the highest priority survives (Cfile:1290055-1290075) ==')
const box = { minX: 0, maxX: 100, minY: 0, maxY: 100 }
const inBox = { minX: 10, maxX: 20, minY: 10, maxY: 20 }
const outside = { minX: 500, maxX: 520, minY: 10, maxY: 20 }
const cand = (id: number, d: { priority: number; lowSelectPrio: boolean }, screen = inBox): SelectionCandidate => ({
  id,
  screen,
  priority: d.priority,
  lowSelectPrio: d.lowSelectPrio,
  beingBuilt: false,
})
{
  const ids = boxSelectIds([cand(1, tank), cand(2, engineer), cand(3, factory)], box, false)
  check(ids.length === 1 && ids[0] === 1, `bot(1) + engineer(3) + factory(5) -> only the bot (${ids})`)
}
{
  const ids = boxSelectIds([cand(2, engineer), cand(3, factory), cand(4, acu)], box, false)
  check(ids.length === 2 && ids.includes(2) && ids.includes(4), `engineer + ACU are both priority 3 (${ids})`)
}
{
  const ids = boxSelectIds([cand(3, factory), cand(5, factory)], box, false)
  check(ids.length === 2, `same priority -> the whole bucket (${ids})`)
}

console.log('\n== Hit test and camera ==')
{
  const ids = boxSelectIds([cand(1, tank, outside), cand(2, engineer)], box, false)
  check(ids.length === 1 && ids[0] === 2, `outside the rectangle is not selected — even at priority 1 (${ids})`)
}
{
  const ids = boxSelectIds([{ ...cand(1, tank), screen: null }], box, false)
  check(ids.length === 0, 'behind the camera (no projected corner) is not selected')
}
{
  const touching = { minX: 100, maxX: 140, minY: 100, maxY: 140 }
  const ids = boxSelectIds([cand(1, tank, touching)], box, false)
  check(ids.length === 1, 'touching the rectangle edge counts as a hit')
}

console.log('\n== LOWSELECTPRIO under construction -> 6 (Cfile:1290017-1290027) ==')
{
  const low = { id: 9, screen: inBox, priority: 1, lowSelectPrio: true, beingBuilt: true }
  check(selectionPriority(low) === 6, `under construction + LOWSELECTPRIO -> 6 (${selectionPriority(low)})`)
  check(
    selectionPriority({ ...low, beingBuilt: false }) === 1,
    'finished: the blueprint priority counts again',
  )
  const ids = boxSelectIds([low, cand(3, factory)], box, false)
  check(ids.length === 1 && ids[0] === 3, `bucket 6 loses against the factory's 5 (${ids})`)
}

// ── Shift (Cfile:1289882-1289946) ──
console.log('\n== Shift: add, and deselect when everything is already selected ==')
{
  const ids = boxSelectIds([cand(1, tank), cand(3, factory)], box, true)
  check(ids.length === 2, `Shift skips the priority stage — bot AND factory (${ids})`)
}
check(mergeSelection([], [1, 2], false).join() === '1,2', 'without Shift the hits ARE the selection')
check(mergeSelection([7], [1, 2], false).join() === '1,2', 'without Shift the old selection is dropped')
check(mergeSelection([7], [1, 2], true).sort().join() === '1,2,7', 'Shift adds')
check(mergeSelection([1, 2, 7], [1, 2], true).join() === '7', 'Shift removes when all hits are already selected')
check(mergeSelection([1, 7], [1, 2], true).sort().join() === '1,2,7', 'partially selected -> adds (not removes)')
check(mergeSelection([1, 7], [], true).sort().join() === '1,7', 'empty drag with Shift keeps the selection')
check(mergeSelection([1, 7], [], false).length === 0, 'empty drag without Shift clears the selection')

// === The selection MARKER: four bracket quads, not a ring ===
//
// func_DrawSelectionBrackets (Cfile:1215114-1215433) draws exactly four
// textured quads on the corners of the selection box — the engine has no ring
// asset at all. The green circle drawn before was invented.
console.log('\n== Selection brackets (Cfile:1215114-1215433) ==')
{
  for (const tex of [
    'textures/ui/common/game/selection/selection_brackets_player.dds',
    'textures/ui/common/game/selection/selection_brackets_player_highlighted.dds',
    'textures/ui/common/game/selection/selection_brackets_enemy.dds',
    'textures/ui/common/game/selection/selection_brackets_neutral.dds',
    'textures/ui/common/game/selection/selection.dds',
  ]) {
    check(game.exists(tex), `${tex.split('/').pop()} exists in the archives`)
  }
  check(
    !game.exists('textures/ui/common/game/selection/selection_ring.dds'),
    'and there is NO ring texture — the brackets are the whole marker',
  )

  // renderselectparams.lua carries all six values (Cfile:1214972-1215091).
  const params = parseLuaAssignments(
    new TextDecoder('utf-8').decode(await game.read('lua/renderselectparams.lua')),
  )
  const p = (k: string): unknown => bpGet(params, `RenderSelectParams.${k}`)
  check(p('ren_SelectionSizeFudge') === 1.85, `ren_SelectionSizeFudge = ${p('ren_SelectionSizeFudge')}`)
  check(p('ren_SelectionHeightFudge') === 0.12, `ren_SelectionHeightFudge = ${p('ren_SelectionHeightFudge')}`)
  check(p('ren_UnitSelectionScale') === 0.75, `ren_UnitSelectionScale = ${p('ren_UnitSelectionScale')}`)
  check(p('ren_SelectBracketSize') === 0.2, `ren_SelectBracketSize = ${p('ren_SelectBracketSize')}`)
  check(
    p('ren_SelectBracketMinPixelSize') === 3,
    `ren_SelectBracketMinPixelSize = ${p('ren_SelectBracketMinPixelSize')}`,
  )
  check(p('ren_SelectColor') === 0xffffffff, `ren_SelectColor = ${p('ren_SelectColor')}`)

  const ext = { x: 2, z: 3, ox: 0, oy: 0, oz: 0, thickness: 0 }
  // No blueprint thickness -> ren_SelectBracketSize; S = max(halfX, halfZ) = 3.
  // Close to the camera one pixel is small, so the minimum never bites.
  check(
    Math.abs(bracketThickness(ext, 0.01, SELECT_PARAM_DEFAULTS) - 0.6) < 1e-9,
    `t*S = 0.2 * 3 = ${bracketThickness(ext, 0.01, SELECT_PARAM_DEFAULTS)}`,
  )
  // Zoomed far out one pixel is 1 ogrid: (3*0.2)/1 = 0.6 px < 3 px, so the
  // engine grows the bracket to exactly 3 pixels (Cfile:1215269-1215270).
  check(
    Math.abs(bracketThickness(ext, 1, SELECT_PARAM_DEFAULTS) - 3) < 1e-9,
    `far away it grows to ren_SelectBracketMinPixelSize (${bracketThickness(ext, 1, SELECT_PARAM_DEFAULTS)} world units = 3 px)`,
  )
  check(
    Math.abs(bracketThickness({ ...ext, thickness: 0.26 }, 0.01, SELECT_PARAM_DEFAULTS) - 0.78) < 1e-9,
    'Display.SelectionThickness wins over the ConVar (Cfile:1215259-1215263)',
  )

  // Geometry: 4 quads = 16 vertices, each a square of half edge t*S centred ON
  // its corner (Cfile:1215281-1215293).
  const geo = createBracketGeometry()
  updateBracketGeometry(geo, 100, 20, 200, 0, ext, 0.6, SELECT_PARAM_DEFAULTS)
  const pos = geo.getAttribute('position')
  check(pos.count === 16, `${pos.count} vertices (4 quads)`)
  check(
    Math.abs(pos.getY(0) - (20 + 0.12)) < 1e-4,
    `they sit at unitY + ren_SelectionHeightFudge (${pos.getY(0)})`,
  )
  // First quad = corner (-halfX, -halfZ) = (98, 197), first vertex = corner - t*S.
  check(
    Math.abs(pos.getX(0) - (100 - 2 - 0.6)) < 1e-4 && Math.abs(pos.getZ(0) - (200 - 3 - 0.6)) < 1e-4,
    `quad 1 sits on the -X/-Z corner (${pos.getX(0)}/${pos.getZ(0)})`,
  )
  // Quad 3 covers the +X/+Z corner: its first vertex is corner-(t,t), its
  // third corner+(t,t) — the square is CENTRED on the corner (Cfile:1215281).
  check(
    Math.abs(pos.getX(8) - (100 + 2 - 0.6)) < 1e-4 && Math.abs(pos.getZ(8) - (200 + 3 - 0.6)) < 1e-4,
    `quad 3 starts one thickness before the +X/+Z corner (${pos.getX(8)}/${pos.getZ(8)})`,
  )
  check(
    Math.abs(pos.getX(10) - (100 + 2 + 0.6)) < 1e-4 && Math.abs(pos.getZ(10) - (200 + 3 + 0.6)) < 1e-4,
    `and ends one thickness behind it (${pos.getX(10)}/${pos.getZ(10)})`,
  )
  // UVs: -X -> smaller u, -Z -> smaller v (Cfile:1215297-1215405).
  const uv = geo.getAttribute('uv')
  check(
    uv.getX(0) === 0 && uv.getY(0) === 0 && uv.getX(4) === 0.5 && uv.getY(8) === 0.5,
    'each quad takes its own quadrant of the bracket texture',
  )
}


// === Double-click / Ctrl-click: same-type selection ===
//
// Double-click selects every focus-army unit of the same blueprint in view
// (HandleDoubleClickSelection, Cfile:865E20); Ctrl-click adds them,
// Ctrl-Shift-click removes them (Cfile:1291547-1291681). Enemy units and
// off-screen units are excluded.
console.log('\n== Same-type selection (double-click / Ctrl-click) ==')
{
  // Three army-1 bots (two in view, one off-screen), one army-1 tank in view,
  // one army-2 bot in view. Clicking a bot picks blueprint 'bot'.
  const units: SameTypeUnit[] = [
    { id: 1, bpId: 'bot', army: 1, inView: true },
    { id: 2, bpId: 'bot', army: 1, inView: true },
    { id: 3, bpId: 'bot', army: 1, inView: false }, // off-screen
    { id: 4, bpId: 'tank', army: 1, inView: true },
    { id: 5, bpId: 'bot', army: 2, inView: true }, // enemy
  ]
  // Double-click a bot -> all IN-VIEW army-1 bots (1, 2), not 3 (off-screen),
  // not 4 (tank), not 5 (enemy).
  {
    const ids = sameTypeIds('bot', 1, units, [], 'replace')
    check(ids.sort().join() === '1,2', `double-click a bot selects the in-view own bots (${ids})`)
  }
  // Ctrl-click a bot while a tank is selected -> REPLACE with the bots (the
  // engine's Ctrl branch builds a fresh set, Cfile:1291573-1291591), NOT add.
  {
    const ids = sameTypeIds('bot', 1, units, [4], 'replace').sort()
    check(ids.join() === '1,2', `Ctrl-click replaces the selection with the same-type set (${ids})`)
  }
  // Ctrl-Shift-click a bot that is ALREADY selected -> remove the bots, keep the
  // tank (conditional toggle, clickedSelected=true, Cfile:1291604-1291635).
  {
    const ids = sameTypeIds('bot', 1, units, [1, 2, 4], 'toggle', true).sort()
    check(ids.join() === '4', `Ctrl-Shift-click removes the same-type set when the clicked unit is selected (${ids})`)
  }
  // Ctrl-Shift-click a bot that is NOT selected -> add the bots to the tank.
  {
    const ids = sameTypeIds('bot', 1, units, [4], 'toggle', false).sort()
    check(ids.join() === '1,2,4', `Ctrl-Shift-click adds the same-type set when the clicked unit is not selected (${ids})`)
  }
  // A click that missed a focus-army unit: replace clears, toggle keeps.
  {
    check(sameTypeIds(null, 1, units, [4], 'replace').length === 0, 'a missed double-click clears the selection')
    check(sameTypeIds(null, 1, units, [4], 'toggle').join() === '4', 'a missed Ctrl-click leaves the selection')
  }
  // The enemy bot (id 5, army 2) is never picked as the clicked unit and never
  // joins a same-type set.
  {
    const ids = sameTypeIds('bot', 1, units, [], 'replace')
    check(!ids.includes(5), 'the enemy bot is never selected (focus-army filter)')
  }
}

await game.close()
console.log(failures === 0 ? '\nSELECTION PASSED' : `\nSELECTION FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
