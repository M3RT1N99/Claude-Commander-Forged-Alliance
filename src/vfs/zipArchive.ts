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

    if (entry.method === 0) return raw
    if (entry.method === 8) {
      return inflateSync(raw, { out: new Uint8Array(entry.uncompressedSize) })
    }
    throw new Error(`Zip: Kompressionsmethode ${entry.method} nicht unterstützt (${entry.name})`)
  }
}
