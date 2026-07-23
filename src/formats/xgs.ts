/**
 * XACT GlobalSettings (SupCom.xgs, magic 'XGSF', formatVersion 42 — the
 * XACT 2.9 engine format; FA loads the file as pGlobalSettingsBuffer,
 * Cfile:602820-602856, and hands it to IXACTEngine::Initialize,
 * Cfile:603332). Layout byte-verified against the real file (2666 bytes,
 * 39 categories, 22 variables); field semantics follow MonoGame/FAudio
 * where the layout matches.
 *
 * Header (offsets verified):
 *   0x00 'XGSF' | 0x04 u16 toolVersion | 0x06 u16 formatVersion (=42)
 *   0x13 u16 numCategories | 0x15 u16 numVariables
 *   0x21 u32 categoriesOffset (numCats x 10 B)
 *   0x25 u32 variablesOffset  (numVars x 13 B)
 *   0x39 u32 catNamesOffset   (null-terminated, in category-index order)
 *   0x3D u32 varNamesOffset
 *
 * Category struct (10 B): u8 instanceLimit, u16 fadeInMs, u16 fadeOutMs,
 * u8 instanceFlags, s16 parent (-1 = root), u8 volume, u8 visibility.
 *
 * The volume byte is a logarithmic dB encoding (37 of 39 bytes decode to
 * integer dB with the FAudio fit): dB = (3969*log10(byte/28240)+8715)/100,
 * amplitude = 10^(dB/20). Examples: 0xFF=+6 dB, 0xB4=0 dB, 0x87=-5 dB.
 */

export interface XgsCategory {
  name: string
  instanceLimit: number
  fadeInMs: number
  fadeOutMs: number
  instanceFlags: number
  /** Parent category index, -1 for the root ('Global'). */
  parent: number
  volumeDb: number
  /** Authored amplitude 10^(dB/20) — the base gain of the category node. */
  volumeLinear: number
  visibility: number
}

export interface XgsVariable {
  name: string
  flags: number
  initial: number
  min: number
  max: number
}

export interface XgsData {
  categories: XgsCategory[]
  variables: XgsVariable[]
}

/** XACT volume byte -> dB (FAudio fit; 37/39 SupCom.xgs bytes land on
 *  integer dB). Shared with the xsb effect-variation volume range. */
export function xactVolumeByteToDb(volumeByte: number): number {
  return (3969 * Math.log10(volumeByte / 28240) + 8715) / 100
}

export function parseXgs(bytes: Uint8Array): XgsData {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const u8 = (o: number): number => v.getUint8(o)
  const u16 = (o: number): number => v.getUint16(o, true)
  const s16 = (o: number): number => v.getInt16(o, true)
  const u32 = (o: number): number => v.getUint32(o, true)
  const f32 = (o: number): number => v.getFloat32(o, true)

  const magic = new TextDecoder('ascii').decode(bytes.subarray(0, 4))
  if (magic !== 'XGSF') throw new Error(`XGS: magic "${magic}" (expected XGSF)`)
  const formatVersion = u16(0x06)
  if (formatVersion !== 42) throw new Error(`XGS: formatVersion ${formatVersion} (expected 42)`)

  const numCats = u16(0x13)
  const numVars = u16(0x15)
  const catsOff = u32(0x21)
  const varsOff = u32(0x25)
  const catNamesOff = u32(0x39)
  const varNamesOff = u32(0x3d)

  // Struct sizes must match the offset deltas — fail hard instead of guessing.
  if (numCats > 0 && (varsOff - catsOff) / numCats !== 10) {
    throw new Error(`XGS: category struct is ${(varsOff - catsOff) / numCats} B (expected 10)`)
  }

  const readNames = (off: number, count: number): string[] => {
    const names: string[] = []
    let p = off
    for (let i = 0; i < count; i++) {
      const start = p
      while (p < bytes.length && bytes[p] !== 0) p++
      names.push(new TextDecoder('ascii').decode(bytes.subarray(start, p)))
      p++
    }
    return names
  }
  const catNames = readNames(catNamesOff, numCats)
  const varNames = readNames(varNamesOff, numVars)

  const categories: XgsCategory[] = []
  for (let i = 0; i < numCats; i++) {
    const o = catsOff + i * 10
    const volumeByte = u8(o + 8)
    // FAudio volume-byte fit (verified: 37/39 bytes land on integer dB).
    const volumeDb = xactVolumeByteToDb(volumeByte)
    categories.push({
      name: catNames[i]!,
      instanceLimit: u8(o),
      fadeInMs: u16(o + 1),
      fadeOutMs: u16(o + 3),
      instanceFlags: u8(o + 5),
      parent: s16(o + 6),
      volumeDb,
      volumeLinear: Math.pow(10, volumeDb / 20),
      visibility: u8(o + 9),
    })
  }

  const variables: XgsVariable[] = []
  for (let i = 0; i < numVars; i++) {
    const o = varsOff + i * 13
    variables.push({
      name: varNames[i]!,
      flags: u8(o),
      initial: f32(o + 1),
      min: f32(o + 5),
      max: f32(o + 9),
    })
  }

  return { categories, variables }
}
