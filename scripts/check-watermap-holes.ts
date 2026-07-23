/**
 * Diagnose: "holes" in Watermaps (G≈0 mitten im Tiefwasser, DXT-Artefakte)
 * + lineare Regression G ≈ a·(elevation−h) + b je Karte, um zu prüfen, ob
 * eine höhenbasierte Tiefe die gebackenen Daten treu ersetzen kann.
 */
import { readFile, readdir } from 'node:fs/promises'
import { parseScmap } from '../src/formats/scmap'
import { parseDds } from '../src/formats/dds'
import { decodeDxt, bgraToRgba } from '../src/formats/dxt'

const GAME =
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

const dirs = (await readdir(`${GAME}/maps`, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

let worst: { map: string; holes: number } | null = null

for (const dir of dirs) {
  let scmap
  try {
    const files = await readdir(`${GAME}/maps/${dir}`)
    const name = files.find((f) => f.toLowerCase().endsWith('.scmap'))
    if (!name) continue
    scmap = parseScmap(new Uint8Array(await readFile(`${GAME}/maps/${dir}/${name}`)))
  } catch {
    continue
  }
  if (!scmap.water.hasWater || !scmap.waterMapDds) continue

  const wm = parseDds(scmap.waterMapDds)
  const mip = wm.mips[0]!
  const rgba =
    wm.format === 'BGRA8'
      ? bgraToRgba(mip.data)
      : decodeDxt(mip.data, wm.width, wm.height, wm.format)

  const stride = scmap.width + 1
  const heightAt = (x: number, z: number): number =>
    scmap.heightmap[z * stride + x]! * scmap.heightScale

  // Regression G ≈ a·depth + b über Unterwasser-Texel + Lochzählung
  let n = 0
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  let holes = 0
  for (let wz = 0; wz < wm.height; wz++) {
    for (let wx = 0; wx < wm.width; wx++) {
      const x = Math.min(scmap.width - 1, Math.floor((wx / wm.width) * scmap.width))
      const z = Math.min(scmap.height - 1, Math.floor((wz / wm.height) * scmap.height))
      const depth = scmap.water.elevation - heightAt(x, z)
      if (depth <= 0.1) continue
      const g = rgba[(wz * wm.width + wx) * 4 + 1]! / 255
      n++
      sx += depth
      sy += g
      sxx += depth * depth
      sxy += depth * g
      if (depth > 2 && g < 0.03) holes++
    }
  }
  if (n < 100) continue
  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx)
  const b = (sy - a * sx) / n
  // R² berechnen
  let ssRes = 0
  let ssTot = 0
  const meanG = sy / n
  for (let wz = 0; wz < wm.height; wz += 2) {
    for (let wx = 0; wx < wm.width; wx += 2) {
      const x = Math.min(scmap.width - 1, Math.floor((wx / wm.width) * scmap.width))
      const z = Math.min(scmap.height - 1, Math.floor((wz / wm.height) * scmap.height))
      const depth = scmap.water.elevation - heightAt(x, z)
      if (depth <= 0.1) continue
      const g = rgba[(wz * wm.width + wx) * 4 + 1]! / 255
      ssRes += (g - (a * depth + b)) ** 2
      ssTot += (g - meanG) ** 2
    }
  }
  const r2 = 1 - ssRes / (ssTot || 1)
  const holePct = ((holes / n) * 100).toFixed(2)
  if (holes > 0 || r2 < 0.95) {
    console.log(
      `${dir}: G ≈ ${a.toFixed(4)}·depth + ${b.toFixed(3)}  R²=${r2.toFixed(3)}  ` +
        `Holes: ${holes} (${holePct}% of underwater Texels)`,
    )
  }
  if (!worst || holes > worst.holes) worst = { map: dir, holes }
}

console.log(`\nWorst card: ${worst?.map} (${worst?.holes} holes)`)
