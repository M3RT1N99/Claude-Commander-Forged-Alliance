/**
 * Der Ladepfad: das VFS liest, was gebraucht wird — und nicht das Archiv leer.
 *
 * `ZipArchive.read()` kostet pro Datei ZWEI Zugriffe (Local Header, dann Daten).
 * Beim Boot sind das ~17.000 Zugriffe; über HTTP ebenso viele Requests, und der
 * Start dauerte damit 18 Sekunden. `readMany()` fasst BENACHBARTE Einträge zu
 * einem Zugriff zusammen.
 *
 * Die Grenze `maxGap` ist der ganze Trick, und sie ist an echten Daten gemessen:
 *
 *   lua.scd    369 Lua-Dateien, Median-Lücke 0 Byte      → 2 Zugriffe
 *   units.scd  568 Blueprints,  Median-Lücke 1,1 MB      → keine Zusammenfassung
 *                               (dazwischen liegen Modelle und Animationen)
 *
 * Ohne diese Grenze wurden aus 10 MB Nutzlast 1350 MB Leserei — die Spanne vom
 * ersten bis zum letzten Blueprint ist über ein Gigabyte.
 *
 * Der Test prüft beides: dass readMany dasselbe liefert wie read() (Byte für
 * Byte), und dass es dabei nicht mehr als das Nötige liest.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-vfs-loading.ts
 */
import { open, readdir, type FileHandle } from 'node:fs/promises'
import { ZipArchive, type ZipEntry } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'

/** Zählt mit, wie viel wirklich gelesen wird. */
class CountingFile implements RandomAccessFile {
  reads = 0
  bytes = 0
  private constructor(
    private readonly fh: FileHandle,
    readonly size: number,
  ) {}
  static async open(p: string): Promise<CountingFile> {
    const fh = await open(p, 'r')
    return new CountingFile(fh, (await fh.stat()).size)
  }
  async slice(s: number, e: number): Promise<ArrayBuffer> {
    if (e <= s) return new ArrayBuffer(0)
    this.reads++
    this.bytes += e - s
    const b = Buffer.alloc(e - s)
    await this.fh.read(b, 0, e - s, s)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  }
  close(): Promise<void> {
    return this.fh.close()
  }
}

const GAME =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const open2 = async (archive: string): Promise<[CountingFile, ZipArchive]> => {
  const f = await CountingFile.open(`${GAME}/gamedata/${archive}`)
  return [f, await ZipArchive.open(f)]
}

console.log('\n== lua.scd: die Dateien liegen am Stück — also EIN Zugriff für viele ==')
{
  const [f, zip] = await open2('lua.scd')
  const luas = [...zip.entries.values()].filter((e) => e.name.toLowerCase().endsWith('.lua'))
  const payload = luas.reduce((n, e) => n + e.compressedSize, 0)

  f.reads = 0
  f.bytes = 0
  const many = await zip.readMany(luas)
  const readsMany = f.reads
  const bytesMany = f.bytes

  check(many.size === luas.length, `${many.size} von ${luas.length} Lua-Dateien gelesen`)
  check(readsMany < 20, `${readsMany} Archiv-Zugriffe statt ${luas.length * 2} (read() einzeln)`)
  // Etwas Verschnitt ist erlaubt (Header, kleine Lücken) — aber kein Vielfaches.
  check(
    bytesMany < payload * 1.3,
    `${(bytesMany / 1048576).toFixed(1)} MB gelesen für ${(payload / 1048576).toFixed(1)} MB Nutzlast`,
  )

  // Byte für Byte dasselbe wie der Einzelweg.
  const sample = luas.slice(0, 40)
  let same = 0
  for (const e of sample) {
    const a = await zip.read(e)
    const b = many.get(e)!
    if (b.length === a.length && b.every((v, i) => v === a[i])) same++
  }
  check(same === sample.length, `${same}/${sample.length} Stichproben Byte für Byte identisch mit read()`)
  await f.close()
}

console.log('\n== units.scd: die Blueprints liegen WEIT auseinander — nicht das Archiv leerlesen ==')
{
  const [f, zip] = await open2('units.scd')
  const bps = [...zip.entries.entries()]
    .filter(([k]) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(k))
    .map(([, e]) => e)
  const payload = bps.reduce((n, e) => n + e.compressedSize, 0)
  const sorted = [...bps].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset)
  const span =
    sorted[sorted.length - 1]!.localHeaderOffset - sorted[0]!.localHeaderOffset

  f.reads = 0
  f.bytes = 0
  const many = await zip.readMany(bps)

  check(many.size === bps.length, `${many.size} Blueprints gelesen (Nutzlast ${(payload / 1048576).toFixed(1)} MB)`)
  check(
    span > 500 * 1048576,
    `sie sind über ${(span / 1048576).toFixed(0)} MB verstreut (Modelle/Animationen dazwischen)`,
  )
  // DER Punkt: nicht die ganze Spanne lesen. Ohne maxGap waren es 1350 MB.
  check(
    f.bytes < 50 * 1048576,
    `${(f.bytes / 1048576).toFixed(1)} MB gelesen — nicht die ${(span / 1048576).toFixed(0)} MB dazwischen`,
  )
  await f.close()
}

console.log('\n== Ein einzelner Eintrag geht weiterhin einzeln ==')
{
  const [f, zip] = await open2('mohodata.scd')
  const one = [...zip.entries.values()][0]!
  const many = await zip.readMany([one])
  const single = await zip.read(one)
  const b = many.get(one)!
  check(b.length === single.length && b.every((v, i) => v === single[i]), `${one.name} identisch`)
  await f.close()
}

const archives = (await readdir(`${GAME}/gamedata`)).filter((n) => n.toLowerCase().endsWith('.scd'))
console.log(`\n(${archives.length} Archive im Spielverzeichnis)`)
console.log(failures === 0 ? '\nVFS-LADEN BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
