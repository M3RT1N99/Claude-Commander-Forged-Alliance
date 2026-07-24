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
import { parseBlueprint } from '../src/formats/blueprint'
import {
  boxSelectIds,
  mergeSelection,
  selectionBpData,
  selectionPriority,
  type SelectionCandidate,
} from '../src/ui/boxSelection'
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

await game.close()
console.log(failures === 0 ? '\nSELECTION PASSED' : `\nSELECTION FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
