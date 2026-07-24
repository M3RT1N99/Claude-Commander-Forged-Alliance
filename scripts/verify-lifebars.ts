/**
 * The unit bars — `sub_85CD40` (Cfile:1285245-1285580), technique `TLifeBar`.
 *
 * What was wrong before this suite existed: the bars sat one metre ABOVE the
 * unit with an invented width, used the thresholds 0.6/0.3 with invented
 * colours, drew the unit's OWN build fraction as a second bar, and had neither
 * a shield nor a fuel bar. The engine does none of that:
 *
 *   - the anchor is the unit's POSITION, lowered by
 *     (LifeBarOffset + ui_LifebarOffset) in view space (Cfile:1285331)
 *   - the size is LifeBarSize/LifeBarHeight in OGRIDS, divided by the world
 *     width of one pixel (Cfile:1285313-1285323)
 *   - the thresholds are 0.75/0.25 with 0xFF00FF00 / 0xFFFFFF00 / 0xFFFF0000
 *     (Cfile:1285354-1285363, ConVars Cfile:421769-421773)
 *   - row 2 is the SHIELD, else fuel or mWorkProgress — the progress of what
 *     the unit is BUILDING, never its own mFractionComplete (Cfile:1285364)
 *
 *   npx tsx scripts/verify-lifebars.ts
 */
import { parseBlueprint, bpGet } from '../src/formats/blueprint'
import { LIFEBAR_CONVARS, barGeometry, barRows, barSize, healthColor } from '../src/ui/lifeBars'
import { GameFiles } from './gameFiles'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()

console.log('\n== Blueprint bar fields (units.scd) ==')
{
  const bp = parseBlueprint(
    new TextDecoder('utf-8').decode(await game.read('units/uel0001/uel0001_unit.bp')),
  )
  // The engine's own defaults (Cfile:646995-646998) apply where a blueprint is
  // silent; a unit always renders bars (Cfile:655716).
  const size = bpGet(bp, 'LifeBarSize')
  const height = bpGet(bp, 'LifeBarHeight')
  const offset = bpGet(bp, 'LifeBarOffset')
  console.log(`  · uel0001: LifeBarSize=${size} LifeBarHeight=${height} LifeBarOffset=${offset}`)
  check(
    size === undefined || typeof size === 'number',
    'LifeBarSize is a number or absent (then ui_LifebarWidth = 1.5)',
  )
  check(bpGet(bp, 'Display.HideLifebars') !== true, 'the ACU does not hide its bars')
}

console.log('\n== Size: ogrids / pixel (Cfile:1285313-1285323) ==')
{
  // One pixel spans 0.05 ogrids -> a 1.5 ogrid bar is 30 px wide.
  const s = barSize(0.05, 0, 0)
  check(Math.abs(s.width - 30) < 1e-9, `no LifeBarSize -> ui_LifebarWidth 1.5 / 0.05 = ${s.width} px`)
  check(Math.abs(s.height - 2.5) < 1e-9, `no LifeBarHeight -> 0.125 / 0.05 = ${s.height} px`)
  const s2 = barSize(0.05, 3, 0.25)
  check(Math.abs(s2.width - 60) < 1e-9, `LifeBarSize 3 -> ${s2.width} px`)
  check(Math.abs(s2.height - 5) < 1e-9, `LifeBarHeight 0.25 -> ${s2.height} px`)
  // Zoomed out the bar shrinks: one pixel now spans 0.5 ogrids.
  check(Math.abs(barSize(0.5, 0, 0).width - 3) < 1e-9, 'zoomed out the same bar is 3 px')
}

console.log('\n== Colours and thresholds (Cfile:1285354-1285363) ==')
{
  check(healthColor(0.76) === '#00ff00', 'above 0.75 -> ui_LifeBarGoodColor 0xFF00FF00')
  check(healthColor(0.75) === '#ffff00', 'exactly 0.75 is NOT good (strictly greater)')
  check(healthColor(0.26) === '#ffff00', 'above 0.25 -> ui_LifeBarMedColor 0xFFFFFF00')
  check(healthColor(0.25) === '#ff0000', 'exactly 0.25 -> ui_LifeBarBadColor 0xFFFF0000')
  check(LIFEBAR_CONVARS.lod === 200, 'ui_LifebarLOD = 200 (Cfile:421758)')
}

console.log('\n== The rows (Cfile:1285364-1285442) ==')
{
  const base = { health: 100, maxHealth: 100, shieldRatio: 0, fuelRatio: -1, workProgress: 0 }
  let rows = barRows(base)
  check(rows.length === 1, `a plain unit has ONE row (${rows.length})`)
  check(rows[0]!.color === '#00ff00' && rows[0]!.fraction === 1, 'full health, green')

  rows = barRows({ ...base, health: 50 })
  check(rows[0]!.fraction === 0.5 && rows[0]!.color === '#ffff00', 'half health -> yellow')

  // A factory building something: row 2 is its WORK PROGRESS, in orange.
  rows = barRows({ ...base, workProgress: 0.4 })
  check(rows.length === 2, 'a builder gets a second row')
  check(
    rows[1]!.color === '#ff9900' && Math.abs(rows[1]!.fraction - 0.4) < 1e-9,
    `work progress in ui_ProgressBarColor (${rows[1]!.color})`,
  )

  // A shield always takes row 2 (Cfile:1285364).
  rows = barRows({ ...base, shieldRatio: 0.8, workProgress: 0.4 })
  check(rows[1]!.color === '#00c3f7', `the shield wins row 2 (${rows[1]!.color})`)
  check(rows.length === 3 && rows[2]!.color === '#ff9900', 'the work progress moves to row 3')

  // Fuel beats work progress when it is larger (Cfile:1285396).
  rows = barRows({ ...base, fuelRatio: 0.9, workProgress: 0.2 })
  check(rows[1]!.color === '#f4ec4d', `fuel in ui_FuelBarColor (${rows[1]!.color})`)
  rows = barRows({ ...base, fuelRatio: 0.1, workProgress: 0.5 })
  check(rows[1]!.color === '#ff9900', 'less fuel than progress -> the progress is drawn')

  // An empty tank blinks FULL in the warning colour (Cfile:1285384-1285392).
  rows = barRows({ ...base, fuelRatio: 0, workProgress: -1 }, 0.9)
  check(
    rows[1]?.color === '#ff0000' && rows[1]?.fraction === 1,
    'empty fuel blinks full red',
  )
  rows = barRows({ ...base, fuelRatio: 0, workProgress: -1 }, 0.1)
  check(rows.length === 1, 'and is invisible in the other half of the blink')

  // The unit's OWN build fraction is never a bar.
  rows = barRows({ ...base, health: 30 })
  check(rows.length === 1, 'a construction site shows only its health row')
}

console.log('\n== Geometry of a row (Cfile:1285452-1285515) ==')
{
  const g = barGeometry(500, 300, 30, 4, 0, 0.5)
  check(g.left === 485 && g.top === 298, `row 1 is centred on the anchor (${g.left}/${g.top})`)
  check(g.width === 30 && g.height === 4, 'background = the full bar')
  check(g.fillLeft === 486 && g.fillTop === 299, 'the fill is inset by one pixel')
  check(Math.abs(g.fillWidth - 14.5) < 1e-9, `fill width = frac * (barW - 1) = ${g.fillWidth}`)
  check(g.fillHeight === 3, `fill height = max(barH - 1, 2) = ${g.fillHeight}`)
  const g2 = barGeometry(500, 300, 30, 4, 1, 1)
  check(g2.top === 298 + 4 + 2, `row 2 sits barH + 2 lower (${g2.top})`)
  // A very thin bar keeps a two pixel fill (Cfile:1285512-1285515).
  check(barGeometry(0, 0, 10, 2, 0, 1).fillHeight === 2, 'a thin bar keeps a 2 px fill')
}

await game.close()
console.log(failures === 0 ? '\nLIFEBARS PASSED' : `\nLIFEBARS FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
