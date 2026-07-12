/**
 * Bestimmt numerisch die Zeilen-Orientierung der in SCMAP eingebetteten
 * Bilder relativ zur Heightmap: Korrelation Watermap-G (Wassertiefe) mit
 * der höhenbasierten Tiefe (elevation - h), normal vs. vertikal gespiegelt.
 */
import { readFile } from 'node:fs/promises'
import { parseScmap } from '../src/formats/scmap'
import { parseDds } from '../src/formats/dds'
import { decodeDxt, bgraToRgba } from '../src/formats/dxt'

const GAME =
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

function correlation(a: number[], b: number[]): number {
  const n = a.length
  const ma = a.reduce((x, y) => x + y, 0) / n
  const mb = b.reduce((x, y) => x + y, 0) / n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    cov += (a[i]! - ma) * (b[i]! - mb)
    va += (a[i]! - ma) ** 2
    vb += (b[i]! - mb) ** 2
  }
  return cov / Math.sqrt(va * vb || 1)
}

for (const map of ['SCMP_001', 'SCMP_007', 'SCMP_037']) {
  const scmap = parseScmap(new Uint8Array(await readFile(`${GAME}/maps/${map}/${map}.scmap`)))
  const wm = parseDds(scmap.waterMapDds!)
  const mip = wm.mips[0]!
  const rgba =
    wm.format === 'BGRA8' ? bgraToRgba(mip.data) : decodeDxt(mip.data, wm.width, wm.height, wm.format)

  const stride = scmap.width + 1
  const heightAt = (x: number, z: number): number =>
    scmap.heightmap[z * stride + x]! * scmap.heightScale

  const expected: number[] = []
  const gNormal: number[] = []
  const gFlipped: number[] = []
  const step = Math.max(1, Math.floor(scmap.width / 64))
  for (let z = 2; z < scmap.height - 2; z += step) {
    for (let x = 2; x < scmap.width - 2; x += step) {
      expected.push(Math.max(0, scmap.water.elevation - heightAt(x, z)))
      const wx = Math.min(wm.width - 1, Math.floor((x / scmap.width) * wm.width))
      const wzN = Math.min(wm.height - 1, Math.floor((z / scmap.height) * wm.height))
      const wzF = wm.height - 1 - wzN
      gNormal.push(rgba[(wzN * wm.width + wx) * 4 + 1]!)
      gFlipped.push(rgba[(wzF * wm.width + wx) * 4 + 1]!)
    }
  }
  console.log(
    `${map}: watermap ${wm.width}x${wm.height} ${wm.format} — ` +
      `corr(normal)=${correlation(expected, gNormal).toFixed(3)}  ` +
      `corr(gespiegelt)=${correlation(expected, gFlipped).toFixed(3)}`,
  )
}
