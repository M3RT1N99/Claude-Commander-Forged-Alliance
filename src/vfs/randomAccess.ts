/**
 * Abstraktion für wahlfreien Lesezugriff auf große Dateien (SCD-Archive bis
 * 1,3 GB), ohne sie komplett in den Speicher zu laden.
 */
export interface RandomAccessFile {
  readonly size: number
  /** Reads [start, end) as ArrayBuffer. */
  slice(start: number, end: number): Promise<ArrayBuffer>
}

/** Random access to a blob/file (File System Access API, <input>). */
export class BlobFile implements RandomAccessFile {
  constructor(private readonly blob: Blob) {}

  get size(): number {
    return this.blob.size
  }

  slice(start: number, end: number): Promise<ArrayBuffer> {
    return this.blob.slice(start, end).arrayBuffer()
  }
}

/** Wahlfreier Zugriff über HTTP-Range-Requests (Dev-Server, LAN-Streaming). */
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
    // Empty slice (e.g. 0-byte zip entry) — no request, otherwise arises
    // an invalid range `bytes=X-(X-1)` that the server rejects.
    if (end <= start) return new ArrayBuffer(0)
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end - 1}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${this.url}`)
    return res.arrayBuffer()
  }
}
