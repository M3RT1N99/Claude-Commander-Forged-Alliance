import { inflateSync } from 'fflate'
import type { RandomAccessFile } from './randomAccess'

/**
 * ZIP reader with random access — SCD archives are regular ZIP files
 * (verified: PK\x03\x04, entries mostly "Stored", partly "Deflate"). Only the
 * central directory is read; entries are loaded individually on demand. This
 * makes even 1.3 GB archives unproblematic in the browser.
 */
export interface ZipEntry {
  /** Path as stored in the archive (forward slashes, original casing). */
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
/** EOCD: 22 fixed bytes + at most 65,535 bytes of comment. */
const EOCD_SEARCH_SPAN = 22 + 65535

export class ZipArchive {
  private constructor(
    private readonly file: RandomAccessFile,
    /** Key: lowercase path (game paths are case-insensitive). */
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
    if (eocd < 0) throw new Error('Not a ZIP archive (End of Central Directory not found)')

    const count = tail.getUint16(eocd + 10, true)
    const cdirSize = tail.getUint32(eocd + 12, true)
    const cdirOffset = tail.getUint32(eocd + 16, true)

    const cdir = new DataView(await file.slice(cdirOffset, cdirOffset + cdirSize))
    const decoder = new TextDecoder('utf-8')
    const entries = new Map<string, ZipEntry>()

    let p = 0
    for (let i = 0; i < count; i++) {
      if (cdir.getUint32(p, true) !== CDIR_SIG) {
        throw new Error(`ZIP: central-directory entry ${i} is corrupted`)
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

  /** Case-insensitive lookup with normalized slashes. */
  get(path: string): ZipEntry | undefined {
    return this.entries.get(path.toLowerCase().replaceAll('\\', '/'))
  }

  async read(entry: ZipEntry): Promise<Uint8Array> {
    const head = new DataView(
      await this.file.slice(entry.localHeaderOffset, entry.localHeaderOffset + 30),
    )
    if (head.getUint32(0, true) !== LOCAL_SIG) {
      throw new Error(`ZIP: local header for "${entry.name}" is corrupted`)
    }
    const nameLen = head.getUint16(26, true)
    const extraLen = head.getUint16(28, true)
    const start = entry.localHeaderOffset + 30 + nameLen + extraLen
    const raw = new Uint8Array(await this.file.slice(start, start + entry.compressedSize))
    return this.decompress(entry, raw)
  }

  /**
   * Read many entries at once.
   *
   * `read()` costs TWO archive accesses per file (local header, then data). UI
   * boot needs ~1,500 Lua files and ~7,000 texture dimensions — read
   * individually, that is ~17,000 accesses and just as many HTTP requests.
   *
   * Two measured levers:
   *
   *  1. **Combine adjacent entries.** In lua.scd, files are contiguous
   *     (median gap 0 bytes) — 369 files fit in 2 accesses. In units.scd,
   *     however, blueprints are a median 1.1 MB apart (models and animations
   *     lie between them); do NOT combine them there or the entire archive is
   *     read. That is exactly what `maxGap` is for — without a limit, 10 MB of
   *     payload became 1,350 MB of reads.
   *  2. **Read blocks IN PARALLEL.** Each access has latency (HTTP:
   *     request/response). Sequential reads wait for all of them one by one.
   */
  async readMany(
    entries: ZipEntry[],
    { maxGap = 64 * 1024, maxChunk = 8 * 1024 * 1024, parallel = 8 } = {},
  ): Promise<Map<ZipEntry, Uint8Array>> {
    const out = new Map<ZipEntry, Uint8Array>()
    if (entries.length === 0) return out

    // Sort by position — only then can neighbors be combined.
    const sorted = [...entries].sort((a, b) => a.localHeaderOffset - b.localHeaderOffset)
    // Upper bound of the data end: 30-byte fixed header + name + extra field.
    // The extra field is never large here, so a generous allowance is sufficient.
    const endOf = (e: ZipEntry): number =>
      Math.min(this.file.size, e.localHeaderOffset + 30 + e.name.length + 4096 + e.compressedSize)

    // Form blocks: combine adjacent entries; a jump over maxGap ends the block.
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
          throw new Error(`ZIP: local header for "${e.name}" is corrupted`)
        }
        const start = p + 30 + view.getUint16(p + 26, true) + view.getUint16(p + 28, true)
        out.set(e, this.decompress(e, buf.subarray(start, start + e.compressedSize)))
      }
    }

    // Keep up to `parallel` blocks in flight at once.
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
    throw new Error(`ZIP: compression method ${entry.method} is not supported (${entry.name})`)
  }
}
