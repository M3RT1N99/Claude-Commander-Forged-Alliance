/**
 * DDS-Container-Parser (DirectDraw Surface).
 *
 * Welche Formate im Spiel wirklich vorkommen, ist gezählt (14 307 DDS-Dateien
 * in allen Archiven, siehe scripts/verify-dds.ts):
 *
 *   10 109  DXT5            Units, Effekte
 *    1 250  DXT3
 *    1 242  DXT1
 *    1 134  A1R5G5B5 (16)   **die strategischen Icons**
 *      533  A8R8G8B8 (32)
 *       36  R8G8B8   (24)   Decals
 *        3  A8 / L8  (8)    Lookup-Texturen
 *
 * Die unkomprimierten Varianten werden beim Parsen in BGRA8 aufgeweitet — dann
 * sehen alle Konsumenten (Renderer, DataURL, HUD) genau ein unkomprimiertes
 * Format. Nichts wird geraten: die Kanal-Masken stehen im Header.
 */

export type DdsFormat = 'DXT1' | 'DXT3' | 'DXT5' | 'BGRA8'

export interface DdsMip {
  data: Uint8Array
  width: number
  height: number
}

export interface DdsImage {
  width: number
  height: number
  format: DdsFormat
  mips: DdsMip[]
  /**
   * Cubemap faces (+X,-X,+Y,-Y,+Z,-Z), each with its full mip chain —
   * present when caps2 carries DDSCAPS2_CUBEMAP (86 cubemaps in the game,
   * the EnvCube/SkyCube files in textures.scd). `mips` mirrors the first
   * face so 2D consumers keep working.
   */
  cubeFaces: DdsMip[][] | null
}

const DDS_MAGIC = 0x20534444 // 'DDS '
const DDPF_FOURCC = 0x4
const DDSCAPS2_CUBEMAP = 0x200

function fourCc(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  )
}

export function blockBytes(format: DdsFormat): number {
  return format === 'DXT1' ? 8 : 16
}

function mipSize(format: DdsFormat, width: number, height: number): number {
  if (format === 'BGRA8') return width * height * 4
  return Math.max(1, Math.ceil(width / 4)) * Math.max(1, Math.ceil(height / 4)) * blockBytes(format)
}

/** Die Kanal-Beschreibung eines unkomprimierten DDS (aus dem Pixelformat-Block). */
interface RawLayout {
  bytesPerPixel: number
  rMask: number
  gMask: number
  bMask: number
  aMask: number
}

/**
 * Einen unkomprimierten Mip nach BGRA8 aufweiten — die Reihenfolge, die
 * `bgraToRgba` erwartet.
 *
 * Die Masken kommen aus dem Header; die 5-Bit-Kanäle der 16-Bit-Formate werden
 * mit `(v << 3) | (v >> 2)` auf 8 Bit gestreckt (Standard-Bit-Replikation, so
 * dass 31 → 255 wird und nicht 248).
 */
function expandToBgra(src: Uint8Array, count: number, layout: RawLayout): Uint8Array {
  const { bytesPerPixel, rMask, gMask, bMask, aMask } = layout
  const out = new Uint8Array(count * 4)

  const shiftOf = (mask: number): number => {
    if (mask === 0) return 0
    let s = 0
    while (((mask >>> s) & 1) === 0) s++
    return s
  }
  const widthOf = (mask: number): number => {
    let bits = 0
    for (let m = mask >>> shiftOf(mask); m & 1; m >>>= 1) bits++
    return bits
  }
  const chan = (mask: number) => ({ shift: shiftOf(mask), bits: widthOf(mask) })
  const R = chan(rMask)
  const G = chan(gMask)
  const B = chan(bMask)
  const A = chan(aMask)

  const scale = (value: number, bits: number): number => {
    if (bits === 8) return value
    if (bits === 0) return 0
    // Bit-Replikation: die oberen Bits werden in die unteren wiederholt.
    return (value << (8 - bits)) | (value >> (2 * bits - 8))
  }

  for (let i = 0; i < count; i++) {
    const o = i * bytesPerPixel
    let px = 0
    for (let b = 0; b < bytesPerPixel; b++) px |= src[o + b]! << (8 * b) // little-endian
    const d = i * 4
    out[d + 0] = bMask ? scale((px & bMask) >>> B.shift, B.bits) : 255
    out[d + 1] = gMask ? scale((px & gMask) >>> G.shift, G.bits) : 255
    out[d + 2] = rMask ? scale((px & rMask) >>> R.shift, R.bits) : 255
    out[d + 3] = aMask ? scale((px >>> A.shift) & ((1 << A.bits) - 1), A.bits) : 255
  }
  return out
}

export function parseDds(data: Uint8Array): DdsImage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint32(0, true) !== DDS_MAGIC) throw new Error('DDS: falsches Magic')

  const height = view.getUint32(12, true)
  const width = view.getUint32(16, true)
  const mipmapCount = Math.max(1, view.getUint32(28, true))
  const pfFlags = view.getUint32(80, true)

  let format: DdsFormat
  let raw: RawLayout | null = null
  if (pfFlags & DDPF_FOURCC) {
    const cc = fourCc(view, 84)
    if (cc !== 'DXT1' && cc !== 'DXT3' && cc !== 'DXT5') {
      throw new Error(`DDS: FourCC "${cc}" nicht unterstützt`)
    }
    format = cc
  } else {
    // Unkomprimiert: Bit-Tiefe und Kanal-Masken stehen im Header (Offset 88-104).
    // Alles, was im Spiel vorkommt (32/24/16/8 Bit), wird nach BGRA8 aufgeweitet.
    const bits = view.getUint32(88, true)
    if (bits !== 8 && bits !== 16 && bits !== 24 && bits !== 32) {
      throw new Error(`DDS: ${bits}-bit unkomprimiert nicht unterstützt`)
    }
    format = 'BGRA8'
    raw = {
      bytesPerPixel: bits / 8,
      rMask: view.getUint32(92, true),
      gMask: view.getUint32(96, true),
      bMask: view.getUint32(100, true),
      aMask: view.getUint32(104, true),
    }
  }

  // Read one mip chain starting at `offset`; returns the mips and chain end.
  const readChain = (offset: number): { mips: DdsMip[]; end: number } => {
    const mips: DdsMip[] = []
    let w = width
    let h = height
    for (let i = 0; i < mipmapCount; i++) {
      const pixels = w * h
      const size = raw ? pixels * raw.bytesPerPixel : mipSize(format, w, h)
      if (offset + size > data.byteLength) break
      const slice = data.subarray(offset, offset + size)
      // 32-Bit-BGRA liegt schon richtig; alles andere wird aufgeweitet.
      const bytes = raw && raw.bytesPerPixel !== 4 ? expandToBgra(slice, pixels, raw) : slice
      mips.push({ data: bytes, width: w, height: h })
      offset += size
      w = Math.max(1, w >> 1)
      h = Math.max(1, h >> 1)
    }
    return { mips, end: offset }
  }

  const caps2 = view.getUint32(112, true)
  if (caps2 & DDSCAPS2_CUBEMAP) {
    // Cubemap: 6 faces back to back, each with its full mip chain
    // (D3D order +X,-X,+Y,-Y,+Z,-Z).
    const cubeFaces: DdsMip[][] = []
    let offset = 128
    for (let f = 0; f < 6; f++) {
      const { mips, end } = readChain(offset)
      if (mips.length === 0) throw new Error(`DDS: cubemap face ${f} has no mip data`)
      cubeFaces.push(mips)
      offset = end
    }
    return { width, height, format, mips: cubeFaces[0]!, cubeFaces }
  }

  const { mips } = readChain(128)
  if (mips.length === 0) throw new Error('DDS: keine Mip-Daten')

  return { width, height, format, mips, cubeFaces: null }
}
