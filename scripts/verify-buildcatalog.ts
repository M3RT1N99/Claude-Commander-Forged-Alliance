/**
 * Verifiziert den Blueprint-Katalog + die Kategorie-Algebra (src/sim/
 * buildCatalog.ts) gegen die echten Original-Blueprints in units.scd:
 * baubare Liste der UEF-ACU, Tech-Buckets und Typ-Gruppierung/Sortierung.
 *
 *   npx tsx scripts/verify-buildcatalog.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { parseBlueprint, bpGet } from '../src/formats/blueprint'
import { BuildCatalog, catalogEntry, type CatalogEntry } from '../src/sim/buildCatalog'

class NodeFile implements RandomAccessFile {
  private constructor(private readonly fh: FileHandle, readonly size: number) {}
  static async open(p: string): Promise<NodeFile> {
    const fh = await open(p, 'r'); return new NodeFile(fh, (await fh.stat()).size)
  }
  async slice(s: number, e: number): Promise<ArrayBuffer> {
    const b = Buffer.alloc(e - s); await this.fh.read(b, 0, e - s, s)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  }
  close(): Promise<void> { return this.fh.close() }
}

const GAME =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const file = await NodeFile.open(`${GAME}/gamedata/units.scd`)
const zip = await ZipArchive.open(file)
const dec = new TextDecoder('latin1')

// Katalog aus ALLEN Unit-Blueprints bauen
const entries: CatalogEntry[] = []
const buildableOf = new Map<string, string[]>()
const t0 = Date.now()
for (const [key, entry] of zip.entries) {
  const m = /^units\/([^/]+)\/\1_unit\.bp$/i.exec(key)
  if (!m) continue
  const id = m[1]!.toLowerCase()
  const bp = parseBlueprint(dec.decode(await zip.read(entry)))
  entries.push(catalogEntry(id, bp))
  if (id === 'uel0001' || id === 'ueb0101') {
    const bc = bpGet(bp, 'Economy.BuildableCategory')
    buildableOf.set(id, Array.isArray(bc) ? bc.filter((x): x is string => typeof x === 'string') : [])
  }
}
const catalog = new BuildCatalog(entries)

console.log(`\n== Katalog: ${catalog.size} Units in ${Date.now() - t0} ms ==`)
check(catalog.size > 500, `Katalog gefüllt (${catalog.size} Units)`)

console.log('\n== UEF-ACU (uel0001) baubare Liste ==')
const acuBuildable = buildableOf.get('uel0001') ?? []
check(acuBuildable.length === 3, `BuildableCategory hat 3 Terme: ${JSON.stringify(acuBuildable)}`)
const ids = new Set(catalog.buildableIds(acuBuildable))
check(ids.has('ueb1103'), 'baut Mass-Extraktor T1 (ueb1103)')
check(ids.has('ueb1101'), 'baut Energiegenerator T1 (ueb1101)')
check(ids.has('ueb0101'), 'baut Land-Fabrik T1 (ueb0101)')
check(ids.has('ueb1201'), 'baut Energiegenerator T2 (ueb1201, via BUILTBYTIER2COMMANDER)')
check(!ids.has('urb1101'), 'baut KEINEN Cybran-Generator (Fraktion UEF gefiltert)')
check(!ids.has('ueb0201'), 'baut KEINE T2-Fabrik direkt (nur per Fabrik-Upgrade)')

console.log('\n== Tech-Buckets (ACU) ==')
const buckets = catalog.techBuckets([...ids])
check(buckets.t1.includes('ueb1103') && buckets.t1.includes('ueb0101'), 'T1-Strukturen im t1-Bucket')
check(buckets.t2.includes('ueb1201'), 'T2-Generator im t2-Bucket')

console.log('\n== CONSTRUCTIONSORTDOWN via T1-Fabrik (ueb0101) ==')
const facBuildable = buildableOf.get('ueb0101') ?? []
const facIds = catalog.buildableIds(facBuildable)
const facBuckets = catalog.techBuckets(facIds)
const sortdowns = facIds.filter((id) => catalog.get(id)?.categories.has('CONSTRUCTIONSORTDOWN'))
check(sortdowns.length > 0, `Fabrik baut ${sortdowns.length} CONSTRUCTIONSORTDOWN-Unit(s): ${sortdowns.join(', ')}`)
const t2Sortdown = sortdowns.find((id) => catalog.get(id)?.categories.has('TECH2'))
check(!!t2Sortdown && facBuckets.t1.includes(t2Sortdown), `TECH2-Sortdown (${t2Sortdown}) im t1-Bucket`)
check(!!t2Sortdown && !facBuckets.t2.includes(t2Sortdown), `TECH2-Sortdown NICHT im t2-Bucket`)

console.log('\n== Typ-Gruppierung + Sortierung (t1) ==')
const items = catalog.formatConstruction(buckets.t1)
const order = items.filter((i): i is { type: 'item'; id: string } => i.type === 'item').map((i) => i.id)
const idx = (id: string): number => order.indexOf(id)
check(order.length > 0, `t1 gerendert: ${order.length} Items`)
check(idx('ueb0101') >= 0 && idx('ueb0101') < idx('ueb1103'), 'Fabrik (SORTCONSTRUCTION) vor Ökonomie')
check(idx('ueb1103') < idx('ueb1101'), 'Mass (prio 40) vor Power (prio 70) in SORTECONOMY')
check(items.some((i) => i.type === 'spacer'), 'Spacer zwischen Gruppen vorhanden')

await file.close()
console.log(failures === 0 ? '\nBUILDCATALOG BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
