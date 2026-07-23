/**
 * Parser für XACT Wave Banks (.xwb, Magic 'WBND') von SupCom:FA.
 *
 * Layout hex-verifiziert (docs/research/effects-audio.md §4) und gegen ALLE
 * 100 .xwb der Installation gemessen (78 in sounds/ + 22 in sounds/Voice/*):
 * durchgehend dwVersion 43 / dwHeaderVersion 42 (XACT 3.0), Meta-Elementgröße
 * 24, ENTRYNAMES-Segment leer, keine Seek-Tables, CompactFormat 0 — und JEDE
 * der 4349 Waves ist PCM16 (formatTag 0, bitsPerSample-Bit gesetzt).
 *
 *   Header:
 *     0x00  char[4]  'WBND'
 *     0x04  u32      dwVersion        (43)
 *     0x08  u32      dwHeaderVersion  (42)
 *     0x0C  Segment[5] { u32 offset; u32 length; }
 *           [0] BANKDATA  [1] ENTRYMETADATA  [2] SEEKTABLES
 *           [3] ENTRYNAMES (in FA immer leer — Namen kommen aus der .xsb)
 *           [4] ENTRYWAVEDATA
 *
 *   BANKDATA:
 *     +0x00 u32      dwFlags   (0x00080000; | 0x1 = Streaming-Bank, 33 Stück)
 *     +0x04 u32      dwEntryCount
 *     +0x08 char[64] szBankName   — der Name, über den die .xsb auflöst!
 *                    (XAS_Weapons.xwb heißt innen 'XAS_Weapon' — Datei- und
 *                    Bankname dürfen also NICHT gleichgesetzt werden)
 *     +0x48 u32      dwEntryMetaDataElementSize (24)
 *     +0x4C u32      dwEntryNameElementSize     (64, ungenutzt)
 *     +0x50 u32      dwAlignment  (4 in-memory, 2048 Streaming)
 *     +0x54 u32      CompactFormat (0 — Compact-Banks sind nicht implementiert)
 *     +0x58 FILETIME BuildTime
 *
 *   ENTRYMETADATA, 24 Bytes je Wave:
 *     u32 dwFlagsAndDuration   — Flags[3:0] (in FA immer 0), Duration[31:4]
 *                                in SAMPLES (gemessen: Duration * blockAlign
 *                                == PlayRegion.dwLength bei allen 4349 Waves)
 *     u32 Format (MINIWAVEFORMAT): tag[1:0] (0=PCM), channels[4:2],
 *                                samplesPerSec[22:5], blockAlign[30:23],
 *                                bitsPerSample[31] (0=8, 1=16 Bit)
 *     u32 PlayRegion.dwOffset   — relativ zum ENTRYWAVEDATA-Segment
 *     u32 PlayRegion.dwLength
 *     u32 LoopRegion.dwStartSample / u32 LoopRegion.dwTotalSamples
 *                                (in FA überall 0 — Loops steuert die .xsb)
 */

export interface XwbEntry {
  /** Dauer in Samples (dwFlagsAndDuration >> 4). */
  duration: number
  /** MINIWAVEFORMAT tag: 0 = PCM (always 0 in FA). */
  formatTag: number
  channels: number
  sampleRate: number
  blockAlign: number
  bitsPerSample: number
  /** Absolute byte offset of the PCM data in the .xwb file. */
  offset: number
  /** Length of PCM data in bytes. */
  length: number
}

export interface XwbBank {
  /** Internal bank name from BANKDATA — the .xsb references THIS name. */
  bankName: string
  /** dwFlags-Bit 0: Streaming-Bank (Alignment 2048, z. B. Music, *Stream). */
  streaming: boolean
  entries: XwbEntry[]
}

function readCString64(bytes: Uint8Array, offset: number): string {
  let end = offset
  while (end < offset + 64 && bytes[end] !== 0) end++
  return new TextDecoder('ascii').decode(bytes.subarray(offset, end))
}

export function parseXwb(bytes: Uint8Array): XwbBank {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const magic = new TextDecoder('ascii').decode(bytes.subarray(0, 4))
  if (magic !== 'WBND') throw new Error(`XWB: falsches Magic "${magic}" (erwartet WBND)`)
  const version = view.getUint32(4, true)
  const headerVersion = view.getUint32(8, true)
  if (version !== 43 || headerVersion !== 42) {
    // All 100 FA banks are 43/42; other versions have different layouts.
    throw new Error(`XWB: Version ${version}/${headerVersion} (expected 43/42, XACT 3.0)`)
  }

  // Segmenttabelle: 5 × {offset, length}
  const segOffset = (i: number): number => view.getUint32(0x0c + i * 8, true)
  const segLength = (i: number): number => view.getUint32(0x10 + i * 8, true)
  const bankData = segOffset(0)
  const metaOffset = segOffset(1)
  const metaLength = segLength(1)
  const waveDataOffset = segOffset(4)

  const flags = view.getUint32(bankData, true)
  const entryCount = view.getUint32(bankData + 4, true)
  const bankName = readCString64(bytes, bankData + 8)
  const metaElemSize = view.getUint32(bankData + 0x48, true)
  const compactFormat = view.getUint32(bankData + 0x54, true)
  if (compactFormat !== 0) {
    throw new Error(`XWB ${bankName}: CompactFormat ${compactFormat} — never observed in FA, not implemented`)
  }
  if (metaElemSize < 24) {
    throw new Error(`XWB ${bankName}: EntryMetaDataElementSize ${metaElemSize} < 24`)
  }
  if (metaLength < entryCount * metaElemSize) {
    throw new Error(`XWB ${bankName}: Metadata segment too short (${metaLength} B for ${entryCount} entries)`)
  }

  const entries: XwbEntry[] = []
  for (let i = 0; i < entryCount; i++) {
    const o = metaOffset + i * metaElemSize
    const flagsAndDuration = view.getUint32(o, true)
    const format = view.getUint32(o + 4, true)
    const playOffset = view.getUint32(o + 8, true)
    const playLength = view.getUint32(o + 12, true)

    const entry: XwbEntry = {
      duration: flagsAndDuration >>> 4,
      formatTag: format & 0x3,
      channels: (format >>> 2) & 0x7,
      sampleRate: (format >>> 5) & 0x3ffff,
      blockAlign: (format >>> 23) & 0xff,
      bitsPerSample: format >>> 31 ? 16 : 8,
      offset: waveDataOffset + playOffset,
      length: playLength,
    }
    if (entry.offset + entry.length > bytes.byteLength) {
      throw new Error(`XWB ${bankName}: Wave ${i} sticks out of the file (${entry.offset}+${entry.length} > ${bytes.byteLength})`)
    }
    entries.push(entry)
  }

  return { bankName, streaming: (flags & 0x1) !== 0, entries }
}

/**
 * Baut aus einem Wave-Eintrag eine fertige RIFF/WAVE-Datei: 44-Byte-Header
 * plus die rohen PCM-Bytes aus der Bank. FA braucht keinen Codec — alle
 * Waves sind PCM16 (gemessen über alle 100 Banks).
 */
export function wavFromEntry(bytes: Uint8Array, entry: XwbEntry): Uint8Array {
  if (entry.formatTag !== 0) {
    throw new Error(`XWB: Wave has formatTag ${entry.formatTag} — only PCM (0) is supported`)
  }
  const byteRate = entry.sampleRate * entry.blockAlign
  const out = new Uint8Array(44 + entry.length)
  const view = new DataView(out.buffer)
  const ascii = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + entry.length, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt-Chunk-Länge
  view.setUint16(20, 1, true) // wFormatTag = PCM
  view.setUint16(22, entry.channels, true)
  view.setUint32(24, entry.sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, entry.blockAlign, true)
  view.setUint16(34, entry.bitsPerSample, true)
  ascii(36, 'data')
  view.setUint32(40, entry.length, true)
  out.set(bytes.subarray(entry.offset, entry.offset + entry.length), 44)
  return out
}
