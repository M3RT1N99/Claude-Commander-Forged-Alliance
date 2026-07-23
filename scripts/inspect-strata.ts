/**
 * Diagnose: CPU-Emulation des Terrain-Shaders für eine Karte — lädt alle
 * Strata-Texturen, prüft Parse-Status/Durchschnittsfarben und rechnet das
 * Splat-Blending + Licht an Beispielpunkten nach.
 *   npx tsx scripts/inspect-strata.ts [MAP]
 */
import { readFile, open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { parseScmap } from '../src/formats/scmap'
import { parseDds, type DdsImage } from '../src/formats/dds'
import { decodeDxt, bgraToRgba } from '../src/formats/dxt'

class NodeFile implements RandomAccessFile {
  private constructor(
    private readonly fh: FileHandle,
    readonly size: number,
  ) {}
  static async open(p: string): Promise<NodeFile> {
    const fh = await open(p, 'r')
    return new NodeFile(fh, (await fh.stat()).size)
  }
  async slice(s: number, e: number): Promise<ArrayBuffer> {
    const b = Buffer.alloc(e - s)
    await this.fh.read(b, 0, e - s, s)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  }
}

const GAME =
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'
const MAP = process.argv[2] ?? 'SCMP_001'

const scmap = parseScmap(new Uint8Array(await readFile(`${GAME}/maps/${MAP}/${MAP}.scmap`)))
const L = scmap.lighting
console.log(
  `Lighting: mult=${L.lightingMultiplier} sun=[${L.sunColor.map((v) => v.toFixed(2))}] ` +
    `amb=[${L.sunAmbience.map((v) => v.toFixed(2))}] shadowFill=[${L.shadowFillColor.map((v) => v.toFixed(2))}] ` +
    `sunDir=[${L.sunDirection.map((v) => v.toFixed(2))}]`,
)

const env = await ZipArchive.open(await NodeFile.open(`${GAME}/gamedata/env.scd`))
const tex = await ZipArchive.open(await NodeFile.open(`${GAME}/gamedata/textures.scd`))

interface Layer {
  rgba: Uint8Array | null
  w: number
  h: number
  scale: number
  avg: [number, number, number, number]
}

function toRgba(dds: DdsImage): { rgba: Uint8Array; w: number; h: number } {
  const mip = dds.mips[Math.min(2, dds.mips.length - 1)]!
  const rgba =
    dds.format === 'BGRA8'
      ? bgraToRgba(mip.data)
      : decodeDxt(mip.data, mip.width, mip.height, dds.format)
  return { rgba, w: mip.width, h: mip.height }
}

function avgColor(rgba: Uint8Array): [number, number, number, number] {
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  const n = rgba.length / 4
  for (let i = 0; i < rgba.length; i += 4) {
    r += rgba[i]!
    g += rgba[i + 1]!
    b += rgba[i + 2]!
    a += rgba[i + 3]!
  }
  return [r / n, g / n, b / n, a / n]
}

const layers: Layer[] = []
for (let i = 0; i < 10; i++) {
  const s = scmap.strata[i]!
  const label = i === 0 ? 'lower ' : i === 9 ? 'upper ' : `strat${i - 1}`
  if (!s.albedoPath) {
    console.log(`${label}: (leer)`)
    layers.push({ rgba: null, w: 0, h: 0, scale: s.albedoScale || 4, avg: [0, 0, 0, 0] })
    continue
  }
  const p = s.albedoPath.replace(/^\//, '')
  const entry = env.get(p) ?? tex.get(p)
  if (!entry) {
    console.log(`${label}: MISSING in the archive! ${s.albedoPath}`)
    layers.push({ rgba: null, w: 0, h: 0, scale: s.albedoScale || 4, avg: [0, 0, 0, 0] })
    continue
  }
  try {
    const dds = parseDds(await (env.get(p) ? env.read(entry) : tex.read(entry)))
    const { rgba, w, h } = toRgba(dds)
    const avg = avgColor(rgba)
    console.log(
      `${label}: ${dds.format} ${dds.width}px scale=${s.albedoScale} ` +
        `avgRGBA=(${avg.map((v) => v.toFixed(0)).join(',')})  ${s.albedoPath}`,
    )
    layers.push({ rgba, w, h, scale: s.albedoScale || 4, avg })
  } catch (err) {
    console.log(`${label}: PARSE ERROR ${err instanceof Error ? err.message : err} ${s.albedoPath}`)
    layers.push({ rgba: null, w: 0, h: 0, scale: s.albedoScale || 4, avg: [0, 0, 0, 0] })
  }
}

// Masken dekodieren
const maskLow = toRgba(parseDds(scmap.textureMaskLowDds!))
const maskHigh = toRgba(parseDds(scmap.textureMaskHighDds!))

function sampleRgba(
  img: { rgba: Uint8Array; w: number; h: number },
  u: number,
  v: number,
): [number, number, number, number] {
  const x = Math.min(img.w - 1, Math.max(0, Math.floor(u * img.w)))
  const y = Math.min(img.h - 1, Math.max(0, Math.floor(v * img.h)))
  const i = (y * img.w + x) * 4
  return [img.rgba[i]!, img.rgba[i + 1]!, img.rgba[i + 2]!, img.rgba[i + 3]!]
}

function sampleLayerWorld(l: Layer, wx: number, wz: number): [number, number, number, number] {
  if (!l.rgba) return [0, 0, 0, 255]
  const u = (wx / l.scale) % 1
  const v = (wz / l.scale) % 1
  return sampleRgba({ rgba: l.rgba, w: l.w, h: l.h }, u < 0 ? u + 1 : u, v < 0 ? v + 1 : v)
}

const stride = scmap.width + 1
const heightAt = (x: number, z: number): number =>
  scmap.heightmap[Math.floor(z) * stride + Math.floor(x)]! * scmap.heightScale

console.log('\nPunkt-Emulation (Shader-Nachrechnung):')
for (const [label, wx, wz] of [
  ['Land NW-Quadrant', 256, 256],
  ['Land SO-Quadrant', 768, 768],
  ['Strand', 210, 350],
  ['Wasser Mitte', 512, 512],
] as const) {
  const u = wx / scmap.width
  const v = wz / scmap.height
  const m0raw = sampleRgba(maskLow, u, v)
  const m1raw = sampleRgba(maskHigh, u, v)
  const m0 = m0raw.map((c) => Math.min(1, Math.max(0, (c / 255) * 2 - 1)))
  const m1 = m1raw.map((c) => Math.min(1, Math.max(0, (c / 255) * 2 - 1)))

  let rgb = sampleLayerWorld(layers[0]!, wx, wz).slice(0, 3) as unknown as number[]
  let alpha = sampleLayerWorld(layers[0]!, wx, wz)[3]
  for (let s = 0; s < 8; s++) {
    const m = s < 4 ? m0[s]! : m1[s - 4]!
    if (m === 0) continue
    const c = sampleLayerWorld(layers[s + 1]!, wx, wz)
    rgb = rgb.map((x, i) => x + (c[i]! - x) * m)
    alpha = alpha! + (c[3]! - alpha!) * m
  }
  const upper = sampleLayerWorld(layers[9]!, wx, wz)
  const ua = upper[3]! / 255
  rgb = rgb.map((x, i) => x + (upper[i]! - x) * ua)

  const h = heightAt(wx, wz)
  // flaches Terrain: NdotL = sunDirection.y
  const ndotl = Math.max(0, L.sunDirection[1])
  const light = L.sunColor.map(
    (sc, i) =>
      L.lightingMultiplier * (sc * ndotl + L.sunAmbience[i]!) +
      L.shadowFillColor[i]! * (1 - (sc * ndotl + L.sunAmbience[i]!)),
  )
  const lit = rgb.map((x, i) => (x / 255) * light[i]! * 255)
  console.log(
    `${label} (${wx},${wz}) h=${h.toFixed(1)}: m0=[${m0.map((x) => x.toFixed(2))}] ` +
      `m1=[${m1.map((x) => x.toFixed(2))}] albedo=(${rgb.map((x) => x.toFixed(0))}) ` +
      `lit=(${lit.map((x) => x.toFixed(0))})`,
  )
}
