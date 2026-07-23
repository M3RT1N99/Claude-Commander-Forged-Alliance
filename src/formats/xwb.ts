/**
 * Parser for XACT Wave Banks (.xwb, magic 'WBND') from SupCom:FA.
 *
 * Layout hex-verified (docs/research/effects-audio.md §4) and measured against
 * ALL 100 .xwb files in the installation (78 in sounds/ + 22 in sounds/Voice/*):
 * consistently dwVersion 43 / dwHeaderVersion 42 (XACT 3.0), metadata element
 * size 24, empty ENTRYNAMES segment, no seek tables, CompactFormat 0 — and EACH
 * of the 4,349 waves is PCM16 (formatTag 0, bitsPerSample bit set).
 *
 *   Header:
 *     0x00  char[4]  'WBND'
 *     0x04  u32      dwVersion        (43)
 *     0x08  u32      dwHeaderVersion  (42)
 *     0x0C  Segment[5] { u32 offset; u32 length; }
 *           [0] BANKDATA  [1] ENTRYMETADATA  [2] SEEKTABLES
 *           [3] ENTRYNAMES (always empty in FA — names come from the .xsb)
 *           [4] ENTRYWAVEDATA
 *
 *   BANKDATA:
 *     +0x00 u32      dwFlags   (0x00080000; | 0x1 = streaming bank, 33 files)
 *     +0x04 u32      dwEntryCount
 *     +0x08 char[64] szBankName   — the name resolved by the .xsb!
 *                    (XAS_Weapons.xwb is internally named 'XAS_Weapon' — file
 *                    and bank names must therefore NOT be treated as equal)
 *     +0x48 u32      dwEntryMetaDataElementSize (24)
 *     +0x4C u32      dwEntryNameElementSize     (64, ungenutzt)
 *     +0x50 u32      dwAlignment  (4 in-memory, 2048 Streaming)
 *     +0x54 u32      CompactFormat (0 — compact banks are not implemented)
 *     +0x58 FILETIME BuildTime
 *
 *   ENTRYMETADATA, 24 bytes per wave:
 *     u32 dwFlagsAndDuration   — Flags[3:0] (always 0 in FA), Duration[31:4]
 *                                in SAMPLES (gemessen: Duration * blockAlign
 *                                == PlayRegion.dwLength for all 4,349 waves)
 *     u32 Format (MINIWAVEFORMAT): tag[1:0] (0=PCM), channels[4:2],
 *                                samplesPerSec[22:5], blockAlign[30:23],
 *                                bitsPerSample[31] (0=8, 1=16 Bit)
 *     u32 PlayRegion.dwOffset   — relative to the ENTRYWAVEDATA segment
 *     u32 PlayRegion.dwLength
 *     u32 LoopRegion.dwStartSample / u32 LoopRegion.dwTotalSamples
 *                                (always 0 in FA — the .xsb controls loops)
 */

export interface XwbEntry {
  /** Duration in samples (dwFlagsAndDuration >> 4). */
  duration: number
  /** MINIWAVEFORMAT tag: 0 = PCM (always 0 in FA). */
  formatTag: number
  channels: number
  sampleRate: number
  blockAlign: number
  bitsPerSample: number
  /** Absolute byte offset of PCM data in the .xwb file. */
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
  if (magic !== 'WBND') throw new Error(`XWB: invalid magic "${magic}" (expected WBND)`)
  const version = view.getUint32(4, true)
  const headerVersion = view.getUint32(8, true)
  if (version !== 43 || headerVersion !== 42) {
    // All 100 FA banks are 43/42; other versions have different layouts.
    throw new Error(`XWB: version ${version}/${headerVersion} (expected 43/42, XACT 3.0)`)
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
    throw new Error(`XWB ${bankName}: CompactFormat ${compactFormat} — never observed in FA and not implemented`)
  }
  if (metaElemSize < 24) {
    throw new Error(`XWB ${bankName}: EntryMetaDataElementSize ${metaElemSize} < 24`)
  }
  if (metaLength < entryCount * metaElemSize) {
    throw new Error(`XWB ${bankName}: metadata segment too short (${metaLength} B for ${entryCount} entries)`)
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
      throw new Error(`XWB ${bankName}: wave ${i} extends beyond the file (${entry.offset}+${entry.length} > ${bytes.byteLength})`)
    }
    entries.push(entry)
  }

  return { bankName, streaming: (flags & 0x1) !== 0, entries }
}

/**
 * Builds a complete RIFF/WAVE file from a wave entry: a 44-byte header plus
 * raw PCM bytes from the bank. FA needs no codec — all waves are PCM16
 * (measured across all 100 banks).
 */
export function wavFromEntry(bytes: Uint8Array, entry: XwbEntry): Uint8Array {
  if (entry.formatTag !== 0) {
    throw new Error(`XWB: wave has formatTag ${entry.formatTag} — only PCM (0) is supported`)
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
  view.setUint32(16, 16, true) // fmt chunk length
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
