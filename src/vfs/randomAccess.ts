/**
 * Abstraktion für wahlfreien Lesezugriff auf große Dateien (SCD-Archive bis
 * 1,3 GB), ohne sie komplett in den Speicher zu laden.
 */
export interface RandomAccessFile {
  readonly size: number
  /** Liest [start, end) als ArrayBuffer. */
  slice(start: number, end: number): Promise<ArrayBuffer>
}

/** Wahlfreier Zugriff auf ein Blob/File (File System Access API, <input>). */
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
    if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`)
    return new HttpRangeFile(url, Number(res.headers.get('content-length') ?? 0))
  }

  async slice(start: number, end: number): Promise<ArrayBuffer> {
    const res = await fetch(this.url, {
      headers: { Range: `bytes=${start}-${end - 1}` },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} für ${this.url}`)
    return res.arrayBuffer()
  }
}
