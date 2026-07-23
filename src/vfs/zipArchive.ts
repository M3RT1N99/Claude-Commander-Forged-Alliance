import { inflateSync } from 'fflate'
import type { RandomAccessFile } from './randomAccess'

/**
 * Zip-Reader mit wahlfreiem Zugriff — SCD-Archive sind normale Zip-Dateien
 * (verifiziert: PK\x03\x04, Einträge überwiegend "Stored", teils "Deflate").
 * Es wird nur das Central Directory gelesen; Einträge werden einzeln bei
 * Bedarf geladen. Damit sind auch 1,3-GB-Archive im Browser kein Problem.
 */
export interface ZipEntry {
  /** Pfad wie im Archiv gespeichert (Forward-Slashes, Original-Casing). */
  name: string
  compressedSize: number
  uncompressedSize: number
  /** 0 = Stored, 8 = Deflate */
  method: number
  localHeaderOffset: number
}

const EOCD_SIG = 0x06054b50
const CDIR_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
/** EOCD: 22 Bytes fix + max. 65535 Bytes Kommentar */
const EOCD_SEARCH_SPAN = 22 + 65535

export class ZipArchive {
  private constructor(
    private readonly file: RandomAccessFile,
    /** Key: Pfad in Kleinbuchstaben (Spiel-Pfade sind case-insensitiv). */
    readonly entries: Map<string, ZipEntry>,
  ) {}

  static async open(file: RandomAccessFile): Promise<ZipArchive> {
    const tailSize = Math.min(file.size, EOCD_SEARCH_SPAN)
    const tail = new DataView(await file.slice(file.size - tailSize, file.size))

    let eocd = -1
    for (let i = tail.byteLength - 22; i >= 0; i--) {
      if (tail.getUint32(i, true) === EOCD_SIG) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new Error('Kein Zip-Archiv (End of Central Directory nicht gefunden)')

    const count = tail.getUint16(eocd + 10, true)
    const cdirSize = tail.getUint32(eocd + 12, true)
    const cdirOffset = tail.getUint32(eocd + 16, true)

    const cdir = new DataView(await file.slice(cdirOffset, cdirOffset + cdirSize))
    const decoder = new TextDecoder('utf-8')
    const entries = new Map<string, ZipEntry>()

    let p = 0
    for (let i = 0; i < count; i++) {
      if (cdir.getUint32(p, true) !== CDIR_SIG) {
        throw new Error(`Zip: Central-Directory-Eintrag ${i} beschädigt`)
      }
      const method = cdir.getUint16(p + 10, true)
      const compressedSize = cdir.getUint32(p + 20, true)
      const uncompressedSize = cdir.getUint32(p + 24, true)
      const nameLen = cdir.getUint16(p + 28, true)
      const extraLen = cdir.getUint16(p + 30, true)
      const commentLen = cdir.getUint16(p + 32, true)
      const localHeaderOffset = cdir.getUint32(p + 42, true)
      const name = decoder.decode(
        new Uint8Array(cdir.buffer, cdir.byteOffset + p + 46, nameLen),
      )
      p += 46 + nameLen + extraLen + commentLen

      if (!name.endsWith('/')) {
        entries.set(name.toLowerCase().replaceAll('\\', '/'), {
          name,
          compressedSize,
          uncompressedSize,
          method,
          localHeaderOffset,
        })
      }
    }

    return new ZipArchive(file, entries)
  }

  /** Case-insensitive Lookup mit normalisierten Slashes. */
  get(path: string): ZipEntry | undefined {
    return this.entries.get(path.toLowerCase().replaceAll('\\', '/'))
  }

  async read(entry: ZipEntry): Promise<Uint8Array> {
    const head = new DataView(
      await this.file.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30),
    )
    if (head.getUint32(0, true) !== LOCAL_SIG) {
      throw new Error(`Zip: Local Header von "${entry.name}" beschädigt`)
    }
    const nameLen = head.getUint16(26, true)
    const extraLen = head.getUint16(28, true)
    const start = entry.localHeaderOffset + 30 + nameLen + extraLen
    const raw = new Uint8Array(await this.file.slice(start, start + entry.compressedSize))
    return this.decompress(entry, raw)
  }

  /**
   * Viele Einträge auf einmal.
   *
   * `read()` kostet pro Datei ZWEI Zugriffe aufs Archiv (Local Header, dann
   * Daten). Der UI-Boot braucht ~1500 Lua-Dateien und ~7000 Texturmaße — einzeln
   * gelesen sind das ~17.000 Zugriffe, und über HTTP ebenso viele Requests.
   *
   * Zwei Hebel, beide gemessen:
   *
   *  1. **Benachbarte Einträge zusammenfassen.** In lua.scd liegen die Dateien
   *     lückenlos hintereinander (Median-Lücke 0 Byte) — 369 Dateien passen in
   *     2 Zugriffe. In units.scd dagegen liegen die Blueprints im Median 1,1 MB
   *     auseinander (Modelle und Animationen dazwischen); dort wird NICHT
   *     zusammengefasst, sonst liest man das Archiv leer. Genau dafür ist
   *     `maxGap` da — ohne Grenze wurden aus 10 MB Nutzlast 1350 MB Leserei.
   *  2. **Die Blöcke NEBENEINANDER lesen.** Jeder Zugriff hat Latenz (HTTP:
   *     Request/Response). Sequentiell wartet man sie alle nacheinander ab.
   */
  async readMany(
    entries: ZipEntry[],
    { maxGap = 64 * 1024, maxChunk = 8 * 1024 * 1024, parallel = 8 } = {},
  ): Promise<Map<ZipEntry, Uint8Array>> {
    const out = new Map<ZipEntry, Uint8Array>()
    if (entries.length === 0) return out

    // Nach Position sortieren — nur so lassen sich Nachbarn zusammenfassen.
    const sorted = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset)
    // Obergrenze des Datenendes: 30 Byte fester Header + Name + Extra-Feld. Das
    // Extra-Feld ist hier nie groß, ein großzügiger Aufschlag reicht als Schranke.
    const endOf = (e: ZipEntry): number =>
      Math.min(this.file.size, e.localHeaderOffset + 30 + e.name.length + 4096 + e.compressedSize)

    // Blöcke bilden: benachbarte Einträge zusammen, ein Sprung über maxGap
    // beendet den Block.
    const blocks: { lo: number; hi: number; from: number; to: number }[] = []
    let i = 0
    while (i < sorted.length) {
      const lo = sorted[i]!.localHeaderOffset
      let hi = endOf(sorted[i]!)
      let j = i + 1
      while (j < sorted.length) {
        const next = sorted[j]!
        if (next.localHeaderOffset - hi > maxGap) break
        if (endOf(next) - lo > maxChunk) break
        hi = Math.max(hi, endOf(next))
        j++
      }
      blocks.push({ lo, hi, from: i, to: j })
      i = j
    }

    const readBlock = async (b: (typeof blocks)[number]): Promise<void> => {
      const buf = new Uint8Array(await this.file.slice(b.lo, b.hi))
      const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
      for (let k = b.from; k < b.to; k++) {
        const e = sorted[k]!
        const p = e.localHeaderOffset - b.lo
        if (view.getUint32(p, true) !== LOCAL_SIG) {
          throw new Error(`Zip: Local Header von "${e.name}" beschädigt`)
        }
        const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true)
        out.set(e, this.decompress(e, buf.subarray(start, start + e.compressedSize)))
      }
    }

    // Bis zu `parallel` Blöcke gleichzeitig in der Luft.
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(parallel, blocks.length) }, async () => {
        while (next < blocks.length) {
          await readBlock(blocks[next++]!)
        }
      }),
    )
    return out
  }

  private decompress(entry: ZipEntry, raw: Uint8Array): Uint8Array {
    if (entry.method === 0) return raw
    if (entry.method === 8) {
      return inflateSync(raw, { out: new Uint8Array(entry.uncompressedSize) })
    }
    throw new Error(`Zip: Kompressionsmethode ${entry.method} nicht unterstützt (${entry.name})`)
  }
}
