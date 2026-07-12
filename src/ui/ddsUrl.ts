import { parseDds } from '../formats/dds'
import { bgraToRgba, decodeDxt } from '../formats/dxt'

/**
 * Dekodiert eine DDS-Textur zu einer PNG-Data-URL für die HTML-UI
 * (Original-Icons/-Buttons im HUD). Ergebnisse werden gecacht.
 */
const cache = new Map<string, string>()

export function ddsToDataUrl(key: string, data: Uint8Array): string {
  const cached = cache.get(key)
  if (cached) return cached

  const dds = parseDds(data)
  const mip = dds.mips[0]!
  const rgba =
    dds.format === 'BGRA8'
      ? bgraToRgba(mip.data)
      : decodeDxt(mip.data, mip.width, mip.height, dds.format)

  const canvas = document.createElement('canvas')
  canvas.width = mip.width
  canvas.height = mip.height
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(mip.width, mip.height)
  img.data.set(rgba)
  ctx.putImageData(img, 0, 0)

  const url = canvas.toDataURL()
  cache.set(key, url)
  return url
}
