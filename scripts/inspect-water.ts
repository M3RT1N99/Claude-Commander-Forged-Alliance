/** Diagnosis: WaterRamp pixels + water parameters of a card (debug tool). */
import { readFile, open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { parseScmap } from '../src/formats/scmap'
import { parseDds } from '../src/formats/dds'
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
  process.argv[3] ?? 'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'
const MAP = process.argv[2] ?? 'SCMP_037'

const scmap = parseScmap(new Uint8Array(await readFile(`${GAME}/maps/${MAP}/${MAP}.scmap`)))
console.log('water:', JSON.stringify(scmap.water))
console.log(
  'lighting: mult',
  scmap.lighting.lightingMultiplier,
  'sun',
  scmap.lighting.sunColor,
  'ambience',
  scmap.lighting.sunAmbience,
)

const tex = await ZipArchive.open(await NodeFile.open(`${GAME}/gamedata/textures.scd`))
const rampPath = scmap.water.texPathWaterRamp.replace(/^\//, '')
const entry = tex.get(rampPath)
console.log('ramp entry:', rampPath, '->', entry?.name)
if (entry) {
  const dds = parseDds(await tex.read(entry))
  console.log('ramp:', dds.width, 'x', dds.height, dds.format)
  const mip = dds.mips[0]!
  const rgba =
    dds.format === 'BGRA8'
      ? bgraToRgba(mip.data)
      : decodeDxt(mip.data, dds.width, dds.height, dds.format)
  for (const fx of [0, 0.1, 0.25, 0.5, 0.75, 1]) {
    const x = Math.min(dds.width - 1, Math.round(fx * (dds.width - 1)))
    const i = x * 4
    console.log(`ramp(${fx}): rgba(${rgba[i]},${rgba[i + 1]},${rgba[i + 2]},${rgba[i + 3]})`)
  }
}

const stride = scmap.width + 1
let min = 1e9
let max = -1e9
for (let z = 180; z < 210; z++) {
  for (let x = 110; x < 140; x++) {
    const h = scmap.heightmap[z * stride + x]! * scmap.heightScale
    min = Math.min(min, h)
    max = Math.max(max, h)
  }
}
console.log('Terrain around spawn: min', min.toFixed(2), 'max', max.toFixed(2))
