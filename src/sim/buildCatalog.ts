import { bpGet, stripLoc, type BpObject } from '../formats/blueprint'

/**
 * Blueprint-Katalog + Kategorie-Algebra für die Bau-Leiste — 1:1 nach der
 * Original-Logik in lua/ui/game/construction.lua (OnSelection + FormatData).
 *
 * Die Engine-Funktion EntityCategoryGetUnitList(buildableCategories) liefert
 * die baubaren IDs; die Auflösung ist reine Token-Mengen-Algebra gegen die
 * `Categories` jeder Unit:
 *  - `Economy.BuildableCategory` ist eine ODER-Liste von UND-Termen
 *    (Leerzeichen = UND), z. B. "BUILTBYCOMMANDER UEF".
 *  - Tech-Buckets: TECH1/TECH2/TECH3/EXPERIMENTAL minus CONSTRUCTIONSORTDOWN;
 *    CONSTRUCTIONSORTDOWN-Units werden eine Stufe tiefer gezeigt.
 *  - Typ-Gruppen: SORTCONSTRUCTION/ECONOMY/DEFENSE/STRATEGIC/INTEL/OTHER,
 *    exklusiv (erste passende gewinnt), je Gruppe nach BuildIconSortPriority.
 */

export interface CatalogEntry {
  id: string
  categories: ReadonlySet<string>
  /** BuildIconSortPriority (Fallback StrategicIconSortPriority), aufsteigend */
  sortPriority: number
  /** General.Icon → Button-Rahmen (land/air/sea/amph) */
  icon: string
  /** StrategicIconName → Overlay-Icon */
  strategicIcon: string
  /** Physics.MotionType; 'RULEUMT_None' = Gebäude (platziert), sonst mobil */
  motionType: string
  name: string
}

/** Ein Eintrag im gerenderten Bau-Grid (Icon oder Trenner zwischen Gruppen). */
export type BuildItem = { type: 'item'; id: string } | { type: 'spacer' }

export type TechBuckets = { t1: string[]; t2: string[]; t3: string[]; t4: string[] }

const SORT_GROUPS = [
  'SORTCONSTRUCTION',
  'SORTECONOMY',
  'SORTDEFENSE',
  'SORTSTRATEGIC',
  'SORTINTEL',
  'SORTOTHER',
] as const

/** Ein UND-Term matcht, wenn die Unit ALLE seine Tokens in Categories hat. */
function matchesTerm(cats: ReadonlySet<string>, term: string): boolean {
  const tokens = term.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return false
  for (const tok of tokens) if (!cats.has(tok)) return false
  return true
}

/** Liest die Katalog-Felder aus einem geparsten Unit-Blueprint. */
export function catalogEntry(id: string, bp: BpObject): CatalogEntry {
  const rawCats = bpGet(bp, 'Categories')
  const categories = new Set<string>(
    Array.isArray(rawCats) ? rawCats.filter((c): c is string => typeof c === 'string') : [],
  )
  const prio = bpGet(bp, 'BuildIconSortPriority')
  const stratPrio = bpGet(bp, 'StrategicIconSortPriority')
  return {
    id,
    categories,
    sortPriority: typeof prio === 'number' ? prio : typeof stratPrio === 'number' ? stratPrio : 9999,
    icon: typeof bpGet(bp, 'General.Icon') === 'string' ? (bpGet(bp, 'General.Icon') as string) : 'land',
    strategicIcon:
      typeof bpGet(bp, 'StrategicIconName') === 'string'
        ? (bpGet(bp, 'StrategicIconName') as string)
        : '',
    motionType:
      typeof bpGet(bp, 'Physics.MotionType') === 'string'
        ? (bpGet(bp, 'Physics.MotionType') as string)
        : 'RULEUMT_None',
    name: stripLoc(bpGet(bp, 'General.UnitName')) ?? stripLoc(bpGet(bp, 'Description')) ?? id.toUpperCase(),
  }
}

export class BuildCatalog {
  private readonly byId = new Map<string, CatalogEntry>()

  constructor(entries: Iterable<CatalogEntry>) {
    for (const e of entries) this.byId.set(e.id, e)
  }

  get size(): number {
    return this.byId.size
  }

  get(id: string): CatalogEntry | undefined {
    return this.byId.get(id)
  }

  /**
   * EntityCategoryGetUnitList: alle Units, deren Categories mindestens einen
   * der UND-Terme der buildableCategory erfüllen (ODER über die Terme).
   */
  buildableIds(buildableCategory: readonly string[]): string[] {
    const out: string[] = []
    for (const e of this.byId.values()) {
      if (buildableCategory.some((term) => matchesTerm(e.categories, term))) out.push(e.id)
    }
    return out
  }

  /**
   * Verteilt IDs auf Tech-Stufen. TECH1/2/3 → t1/2/3, EXPERIMENTAL → t4;
   * CONSTRUCTIONSORTDOWN-Units eine Stufe tiefer (EXPERIMENTAL→t3, TECH3→t2,
   * TECH2→t1). Reihenfolge innerhalb bleibt Eingabereihenfolge.
   */
  techBuckets(ids: readonly string[]): TechBuckets {
    const b: TechBuckets = { t1: [], t2: [], t3: [], t4: [] }
    for (const id of ids) {
      const e = this.byId.get(id)
      if (!e) continue
      const c = e.categories
      const down = c.has('CONSTRUCTIONSORTDOWN')
      if (c.has('EXPERIMENTAL')) (down ? b.t3 : b.t4).push(id)
      else if (c.has('TECH3')) (down ? b.t2 : b.t3).push(id)
      else if (c.has('TECH2')) (down ? b.t1 : b.t2).push(id)
      else if (c.has('TECH1')) b.t1.push(id)
    }
    return b
  }

  /**
   * FormatData('construction'): gruppiert nach SORT*-Kategorien (exklusiv,
   * erste passende gewinnt; Rest ans Ende), sortiert je Gruppe nach
   * BuildIconSortPriority aufsteigend, fügt Spacer zwischen Gruppen ein.
   */
  formatConstruction(ids: readonly string[]): BuildItem[] {
    const buckets: string[][] = SORT_GROUPS.map(() => [])
    const misc: string[] = []
    for (const id of ids) {
      const e = this.byId.get(id)
      if (!e) continue
      const gi = SORT_GROUPS.findIndex((g) => e.categories.has(g))
      if (gi >= 0) buckets[gi]!.push(id)
      else misc.push(id)
    }
    const byPrio = (a: string, z: string): number =>
      (this.byId.get(a)?.sortPriority ?? 9999) - (this.byId.get(z)?.sortPriority ?? 9999)

    const out: BuildItem[] = []
    for (const bucket of [...buckets, misc]) {
      if (bucket.length === 0) continue
      bucket.sort(byPrio)
      if (out.length > 0) out.push({ type: 'spacer' })
      for (const id of bucket) out.push({ type: 'item', id })
    }
    return out
  }
}
