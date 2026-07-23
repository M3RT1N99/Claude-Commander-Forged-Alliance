/**
 * Software decoder for DXT1/DXT3/DXT5 (BC1/BC2/BC3) to RGBA8.
 * Fallback for platforms without WEBGL_compressed_texture_s3tc
 * (especially mobile GPUs) and for Node tests.
 */

function decodeColorBlock(
  src: Uint8Array,
  o: number,
  colors: Uint8Array,
  dxt1Alpha: boolean,
): boolean {
  const c0 = src[o]! | (src[o + 1]! << 8)
  const c1 = src[o + 2]! | (src[o + 3]! << 8)

  const r0 = ((c0 >> 11) & 0x1f) * 0xff / 0x1f
  const g0 = ((c0 >> 5) & 0x3f) * 0xff / 0x3f
  const b0 = (c0 & 0x1f) * 0xff / 0x1f
  const r1 = ((c1 >> 11) & 0x1f) * 0xff / 0x1f
  const g1 = ((c1 >> 5) & 0x3f) * 0xff / 0x3f
  const b1 = (c1 & 0x1f) * 0xff / 0x1f

  colors[0] = r0
  colors[1] = g0
  colors[2] = b0
  colors[3] = 255
  colors[4] = r1
  colors[5] = g1
  colors[6] = b1
  colors[7] = 255

  const fourColor = !dxt1Alpha || c0 > c1
  if (fourColor) {
    colors[8] = (2 * r0 + r1) / 3
    colors[9] = (2 * g0 + g1) / 3
    colors[10] = (2 * b0 + b1) / 3
    colors[11] = 255
    colors[12] = (r0 + 2 * r1) / 3
    colors[13] = (g0 + 2 * g1) / 3
    colors[14] = (b0 + 2 * b1) / 3
    colors[15] = 255
  } else {
    colors[8] = (r0 + r1) / 2
    colors[9] = (g0 + g1) / 2
    colors[10] = (b0 + b1) / 2
    colors[11] = 255
    colors[12] = 0
    colors[13] = 0
    colors[14] = 0
    colors[15] = 0
  }
  return fourColor
}

/** Decodes the 3-bit alpha indices of a DXT5 alpha block. */
function decodeDxt5Alpha(src: Uint8Array, o: number, out: Uint8Array): void {
  const a0 = src[o]!
  const a1 = src[o + 1]!
  const alphas = new Uint8Array(8)
  alphas[0] = a0
  alphas[1] = a1
  if (a0 > a1) {
    for (let i = 1; i < 7; i++) alphas[i + 1] = ((7 - i) * a0 + i * a1) / 7
  } else {
    for (let i = 1; i < 5; i++) alphas[i + 1] = ((5 - i) * a0 + i * a1) / 5
    alphas[6] = 0
    alphas[7] = 255
  }
  // 48-bit indices, little-endian across 6 bytes.
  let bits = 0
  let bitCount = 0
  let byteIdx = o + 2
  for (let i = 0; i < 16; i++) {
    if (bitCount < 3) {
      bits |= src[byteIdx++]! << bitCount
      bitCount += 8
    }
    out[i] = alphas[bits & 0x7]!
    bits >>= 3
    bitCount -= 3
  }
}

export function decodeDxt(
  src: Uint8Array,
  width: number,
  height: number,
  format: 'DXT1' | 'DXT3' | 'DXT5',
): Uint8Array {
  const out = new Uint8Array(width * height * 4)
  const blocksX = Math.max(1, Math.ceil(width / 4))
  const blocksY = Math.max(1, Math.ceil(height / 4))
  const blockSize = format === 'DXT1' ? 8 : 16
  const colors = new Uint8Array(16)
  const alpha = new Uint8Array(16)

  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      let o = (by * blocksX + bx) * blockSize

      if (format === 'DXT5') {
        decodeDxt5Alpha(src, o, alpha)
        o += 8
      } else if (format === 'DXT3') {
        for (let i = 0; i < 16; i += 2) {
          const b = src[o + (i >> 1)]!
          alpha[i] = (b & 0xf) * 17
          alpha[i + 1] = (b >> 4) * 17
        }
        o += 8
      } else {
        alpha.fill(255)
      }

      decodeColorBlock(src, o, colors, format === 'DXT1')
      const indexBits = src[o + 4]! | (src[o + 5]! << 8) | (src[o + 6]! << 16) | (src[o + 7]! << 24)

      for (let py = 0; py < 4; py++) {
        const y = by * 4 + py
        if (y >= height) break
        for (let px = 0; px < 4; px++) {
          const x = bx * 4 + px
          if (x >= width) continue
          const idx = (indexBits >>> ((py * 4 + px) * 2)) & 0x3
          const dst = (y * width + x) * 4
          out[dst] = colors[idx * 4]!
          out[dst + 1] = colors[idx * 4 + 1]!
          out[dst + 2] = colors[idx * 4 + 2]!
          const a = format === 'DXT1' ? colors[idx * 4 + 3]! : alpha[py * 4 + px]!
          out[dst + 3] = a
        }
      }
    }
  }
  return out
}

/** BGRA8 → RGBA8 (uncompressed DDS). */
export function bgraToRgba(src: Uint8Array): Uint8Array {
  const out = new Uint8Array(src.length)
  for (let i = 0; i < src.length; i += 4) {
    out[i] = src[i + 2]!
    out[i + 1] = src[i + 1]!
    out[i + 2] = src[i]!
    out[i + 3] = src[i + 3]!
  }
  return out
}
