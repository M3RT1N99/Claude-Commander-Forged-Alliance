/**
 * Abstraction for random read access to large files (SCD archives up to
 * 1.3 GB) without loading them entirely into memory.
 */
export interface RandomAccessFile {
  readonly size: number
  /** Reads [start, end) as an ArrayBuffer. */
  slice(start: number, end: number): Promise<ArrayBuffer>
}

/** Random access to a Blob/File (File System Access API, <input>). */
export class BlobFile implements RandomAccessFile {
  constructor(private readonly blob: Blob) {}

  get size(): number {
    return this.blob.size
  }

  slice(start: number, end: number): Promise<ArrayBuffer> {
    return this.blob.slice(start, end).arrayBuffer()
  }
}

/** Random access through HTTP range requests (dev server, LAN streaming). */
export class HttpRangeFile implements RandomAccessFile {
  private constructor(
    private readonly url: string,
    readonly size: number,
  ) {}

  static async open(url: string, knownSize?: number): Promise<HttpRangeFile> {
    if (knownSize !== undefined) return new HttpRangeFile(url, knownSize)
    const res = await fetch(url, { method: 'HEAD' })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return new HttpRangeFile(url, Number(res.headers.get('content-length') ?? 0))
  }

  async slice(start: number, end: number): Promise<ArrayBuffer> {
    // Empty slice (e.g. a zero-byte ZIP entry) — no request, otherwise an
    // invalid `bytes=X-(X-1)` range would be rejected by the server.
    if (end <= start) return new ArrayBuffer(0)
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end - 1}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${this.url}`)
    return res.arrayBuffer()
  }
}
