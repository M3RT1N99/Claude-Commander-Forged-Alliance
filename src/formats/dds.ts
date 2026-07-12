/**
 * DDS-Container-Parser (DirectDraw Surface). FA-Unit-Texturen sind DXT5 mit
 * voller Mip-Kette (verifiziert an UEL0001), Env/UI teils DXT1 oder
 * unkomprimiert A8R8G8B8.
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
}

const DDS_MAGIC = 0x20534444 // 'DDS '
const DDPF_FOURCC = 0x4

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

export function parseDds(data: Uint8Array): DdsImage {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint32(0, true) !== DDS_MAGIC) throw new Error('DDS: falsches Magic')

  const height = view.getUint32(12, true)
  const width = view.getUint32(16, true)
  const mipmapCount = Math.max(1, view.getUint32(28, true))
  const pfFlags = view.getUint32(80, true)

  let format: DdsFormat
  if (pfFlags & DDPF_FOURCC) {
    const cc = fourCc(view, 84)
    if (cc !== 'DXT1' && cc !== 'DXT3' && cc !== 'DXT5') {
      throw new Error(`DDS: FourCC "${cc}" nicht unterstützt`)
    }
    format = cc
  } else {
    const bits = view.getUint32(88, true)
    if (bits !== 32) throw new Error(`DDS: ${bits}-bit unkomprimiert nicht unterstützt`)
    format = 'BGRA8'
  }

  const mips: DdsMip[] = []
  let offset = 128
  let w = width
  let h = height
  for (let i = 0; i < mipmapCount; i++) {
    const size = mipSize(format, w, h)
    if (offset + size > data.byteLength) break
    mips.push({ data: data.subarray(offset, offset + size), width: w, height: h })
    offset += size
    w = Math.max(1, w >> 1)
    h = Math.max(1, h >> 1)
  }
  if (mips.length === 0) throw new Error('DDS: keine Mip-Daten')

  return { width, height, format, mips }
}
