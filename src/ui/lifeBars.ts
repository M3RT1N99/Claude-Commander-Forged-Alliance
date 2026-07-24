/**
 * The unit bars — `CWldSession::RenderStrategicIcons` collects them
 * (Cfile:1284551-1284575) and `sub_85CD40` (Cfile:1285245-1285580) draws them,
 * FX `primbatcher`, technique `TLifeBar` (Cfile:1285015-1285016).
 *
 * Everything here is the engine's arithmetic; the DOM layer only places what
 * this module computes.
 *
 * SIZE (Cfile:1285308-1285323) — screen pixels, from world sizes:
 *   D    = dot(cam.mViewport.d[2], (pos,1))          world width of ONE pixel
 *   barW = (LifeBarSize   > 0 ? LifeBarSize   : ui_LifebarWidth ) / D
 *   barH = (LifeBarHeight > 0 ? LifeBarHeight : ui_lifebarHeight) / D
 *
 * PLACE (Cfile:1285325-1285347) — the anchor is the unit's POSITION, not its
 * mesh box: the view-space Y is lowered by (LifeBarOffset + ui_LifebarOffset)
 * before projecting, then the result is floored and the bar centred on it.
 *
 * ROWS (Cfile:1285452-1285578) — up to three, 2 px apart, each a black
 * background quad with the fill inset by one pixel:
 *   background: [left, left+barW] x [rowTop, rowTop+barH]        0xFF000000
 *   fill:       [left+1, left + frac*(barW-1)] x [rowTop+1, rowTop + max(barH-1, 2)]
 *
 * There is NO segmentation: one background, one fill per row.
 */

/** ConVar defaults from the decompilation (Cfile:421747-421777). */
export const LIFEBAR_CONVARS = {
  /** ui_LifebarWidth — 1.5 ogrids */
  width: 1.5,
  /** ui_lifebarHeight — 0.125 ogrids */
  height: 0.125,
  /** ui_LifebarOffset — 0.1 ogrids, added to the blueprint's LifeBarOffset */
  offset: 0.1,
  /** ui_LifebarLOD — 200: bars vanish beyond this zoom */
  lod: 200,
  /** ui_LifeBarGoodCutoff / ui_LifeBarBadCutoff */
  goodCutoff: 0.75,
  badCutoff: 0.25,
  /** ui_LifeBarGoodColor / MedColor / BadColor */
  good: '#00ff00',
  med: '#ffff00',
  bad: '#ff0000',
  /** ui_ShieldBarColor */
  shield: '#00c3f7',
  /** ui_ProgressBarColor */
  progress: '#ff9900',
  /** ui_FuelBarColor */
  fuel: '#f4ec4d',
  /** ui_FuelWarningColor */
  fuelWarning: '#ff0000',
  /** ui_FuelEmptyBlinkRate */
  fuelBlinkRate: 0.1,
} as const

/** One bar row: a fraction and a colour. */
export interface BarRow {
  fraction: number
  color: string
}

/** What the bars need to know about a unit. */
export interface BarUnit {
  health: number
  maxHealth: number
  /** mUnitVarDat.mShieldRatio — 0 when the unit has no shield. */
  shieldRatio: number
  /** mUnitVarDat.mFuelRatio — DEFAULT -1 (no fuel), not 0 (Cfile:772265). */
  fuelRatio: number
  /** mUnitVarDat.mWorkProgress — what the unit is building/upgrading. */
  workProgress: number
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)

/** The health colour (Cfile:1285354-1285363) — strictly greater comparisons. */
export function healthColor(fraction: number): string {
  if (fraction > LIFEBAR_CONVARS.goodCutoff) return LIFEBAR_CONVARS.good
  if (fraction > LIFEBAR_CONVARS.badCutoff) return LIFEBAR_CONVARS.med
  return LIFEBAR_CONVARS.bad
}

/**
 * The rows of one unit, top to bottom (Cfile:1285364-1285442).
 *
 * Row 1 is always health. Row 2 is the SHIELD if there is one, otherwise fuel
 * or work progress — whichever is larger. Row 3 exists only when row 2 was the
 * shield, and then carries whichever of the two row 2 did not.
 *
 * @param blinkPhase `fmod((tick + interp) * ui_FuelEmptyBlinkRate, 1)` — an
 *   empty tank blinks (Cfile:1285384-1285392).
 */
export function barRows(u: BarUnit, blinkPhase = 0): BarRow[] {
  const rows: BarRow[] = []
  const health = u.maxHealth > 0 ? clamp01(u.health / u.maxHealth) : 0
  rows.push({ fraction: health, color: healthColor(health) })

  const fuelRow = (): BarRow => {
    // An empty tank (-1 < fuel <= 0) blinks and is drawn FULL in the warning
    // colour (Cfile:1285384-1285392 / 1285408-1285421).
    if (u.fuelRatio <= 0) {
      return blinkPhase > 0.5
        ? { fraction: 1, color: LIFEBAR_CONVARS.fuelWarning }
        : { fraction: 0, color: LIFEBAR_CONVARS.fuel }
    }
    return { fraction: clamp01(u.fuelRatio), color: LIFEBAR_CONVARS.fuel }
  }
  const progressRow = (): BarRow => ({
    fraction: clamp01(u.workProgress),
    color: LIFEBAR_CONVARS.progress,
  })

  if (u.shieldRatio > 0) {
    rows.push({ fraction: clamp01(u.shieldRatio), color: LIFEBAR_CONVARS.shield })
    // Row 3: work progress when there is no fuel at all, else the fuel bar.
    rows.push(u.fuelRatio <= -1 ? progressRow() : fuelRow())
  } else if (u.fuelRatio > u.workProgress) {
    rows.push(fuelRow())
  } else {
    rows.push(progressRow())
  }

  // A row below the first is only drawn when its value is > 0
  // (Cfile:1285460/1285482).
  const out = [rows[0]!]
  for (const r of rows.slice(1)) {
    if (r.fraction > 0) out.push(r)
    else break
  }
  return out
}

/** Geometry of one row in screen pixels. */
export interface BarGeometry {
  left: number
  top: number
  width: number
  height: number
  fillLeft: number
  fillTop: number
  fillWidth: number
  fillHeight: number
}

/**
 * Place row `index` (Cfile:1285344-1285347, 1285452-1285453, 1285504-1285515).
 *
 * @param screenX projected, floored X of the anchor
 * @param screenY projected, floored Y of the anchor
 */
export function barGeometry(
  screenX: number,
  screenY: number,
  barW: number,
  barH: number,
  index: number,
  fraction: number,
): BarGeometry {
  const left = screenX - barW * 0.5
  const top = screenY - barH * 0.5 + index * (barH + 2)
  return {
    left,
    top,
    width: barW,
    height: barH,
    fillLeft: left + 1,
    fillTop: top + 1,
    fillWidth: Math.max(0, fraction * (barW - 1)),
    fillHeight: Math.max(barH - 1, 2),
  }
}

/** Bar width and height in pixels (Cfile:1285313-1285323). */
export function barSize(
  ogridsPerPixel: number,
  lifeBarSize: number,
  lifeBarHeight: number,
): { width: number; height: number } {
  if (!(ogridsPerPixel > 0)) return { width: 0, height: 0 }
  const w = (lifeBarSize > 0 ? lifeBarSize : LIFEBAR_CONVARS.width) / ogridsPerPixel
  const h = (lifeBarHeight > 0 ? lifeBarHeight : LIFEBAR_CONVARS.height) / ogridsPerPixel
  return { width: w, height: h }
}
