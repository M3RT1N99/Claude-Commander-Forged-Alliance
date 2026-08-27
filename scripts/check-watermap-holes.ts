/**
 * WARUM DER RENDERER DIE GEBACKENE WATERMAP ERSETZT — UND OB DAS NOCH STIMMT.
 *
 * `fitDepthToG` ([unitViewer.ts](../src/viewer/unitViewer.ts)) benutzt den
 * Grünkanal der Watermap NICHT direkt. Es passt eine Gerade `G ≈ a · Tiefe` an
 * und rechnet die Tiefe danach aus der Heightmap — gleicher Verlauf, aber ohne
 * die Löcher, die die DXT-Kompression in die gebackenen Daten schlägt. Fehlt
 * die Anpassung, greift die Konstante `FALLBACK = 1 / 15`.
 *
 * Dieses Skript hat das begründet und drei Dinge ausgegeben, die ein Mensch
 * gelesen hat: die Steigung, das Bestimmtheitsmass und die Lochzahl. Jetzt
 * prüft es die drei Annahmen, auf denen der Renderer steht:
 *
 *   1. **Die Ersetzung ist überhaupt zulässig.** Der Zusammenhang muss linear
 *      sein, sonst ersetzt man eine Textur durch etwas, das anders aussieht.
 *      Gemessen: R² liegt fast überall über 0.93.
 *   2. **`1/15` ist die richtige Konstante.** Die gemessenen Steigungen liegen
 *      eng um 0.0667 = 1/15. Diese Zahl steht sonst nur als Literal im
 *      Renderer; hier wird sie gegen die echten Karten gehalten.
 *   3. **Der DXT-Decoder liefert noch dasselbe.** Die Spieldaten ändern sich
 *      nicht, also sind Lochzahl und Kartenzahl KONSTANT. Weicht die Summe ab,
 *      hat sich der Decoder oder der SCMAP-Leser geändert — auch dann, wenn
 *      sonst niemand hinsieht.
 *
 * Die Ausreisser werden nicht weggemittelt: `scripts/fixtures/watermap-baseline.json`
 * hält fest, WIE VIELE Karten unter der R²-Schwelle liegen (heute genau eine,
 * SCMP_016). Kommt eine dazu, wird der Lauf rot.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/check-watermap-holes.ts
 *   npx tsx --import ./scripts/register-lua.mjs scripts/check-watermap-holes.ts --update
 */
import { readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseScmap } from '../src/formats/scmap'
import { parseDds } from '../src/formats/dds'
import { decodeDxt, bgraToRgba } from '../src/formats/dxt'

const GAME =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

const update = process.argv.includes('--update')
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'watermap-baseline.json')

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

// Die Konstante, die im Renderer steht, wenn keine Anpassung gelingt.
const FALLBACK_STEIGUNG = 1 / 15
const STEIGUNG_BAND = 0.15 // 15 % relativ — so eng liegen die gemessenen Werte
const R2_SCHWELLE = 0.9
const MIN_KARTEN = 20

const dirs = (await readdir(`${GAME}/maps`, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

interface Messung {
  map: string
  a: number
  r2: number
  holes: number
  texel: number
}
const messungen: Messung[] = []

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
  const mip = wm.mips[0]
  if (!mip) continue
  const rgba =
    wm.format === 'BGRA8' ? bgraToRgba(mip.data) : decodeDxt(mip.data, wm.width, wm.height, wm.format)

  const stride = scmap.width + 1
  const heightAt = (x: number, z: number): number =>
    (scmap.heightmap[z * stride + x] ?? 0) * scmap.heightScale

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
      const g = (rgba[(wz * wm.width + wx) * 4 + 1] ?? 0) / 255
      n++
      sx += depth
      sy += g
      sxx += depth * depth
      sxy += depth * g
      // Ein „Loch": tief unter Wasser, aber der Grünkanal sagt fast null —
      // ein DXT-Artefakt, kein echter Messwert.
      if (depth > 2 && g < 0.03) holes++
    }
  }
  if (n < 100) continue

  const a = (n * sxy - sx * sy) / (n * sxx - sx * sx)
  const b = (sy - a * sx) / n
  let ssRes = 0
  let ssTot = 0
  const meanG = sy / n
  for (let wz = 0; wz < wm.height; wz += 2) {
    for (let wx = 0; wx < wm.width; wx += 2) {
      const x = Math.min(scmap.width - 1, Math.floor((wx / wm.width) * scmap.width))
      const z = Math.min(scmap.height - 1, Math.floor((wz / wm.height) * scmap.height))
      const depth = scmap.water.elevation - heightAt(x, z)
      if (depth <= 0.1) continue
      const g = (rgba[(wz * wm.width + wx) * 4 + 1] ?? 0) / 255
      ssRes += (g - (a * depth + b)) ** 2
      ssTot += (g - meanG) ** 2
    }
  }
  messungen.push({ map: dir, a, r2: 1 - ssRes / (ssTot || 1), holes, texel: n })
}

const steigungen = messungen.map((m) => m.a).sort((x, y) => x - y)
const median = steigungen[Math.floor(steigungen.length / 2)] ?? 0
const schwach = messungen.filter((m) => m.r2 < R2_SCHWELLE)
const holesGesamt = messungen.reduce((s, m) => s + m.holes, 0)
const schlimmste = [...messungen].sort((x, y) => y.holes - x.holes)[0]

console.log(`\n== ${messungen.length} Karten mit auswertbarem Wasser ==`)
console.log(
  `  Steigung: Median ${median.toFixed(4)}, Spanne ${(steigungen[0] ?? 0).toFixed(4)} … ` +
    `${(steigungen[steigungen.length - 1] ?? 0).toFixed(4)}  (1/15 = ${FALLBACK_STEIGUNG.toFixed(4)})`,
)
console.log(`  Löcher gesamt: ${holesGesamt}, schlimmste Karte ${schlimmste?.map} (${schlimmste?.holes})`)
if (schwach.length > 0) {
  console.log(
    `  unter R² ${R2_SCHWELLE}: ` +
      schwach.map((m) => `${m.map}=${m.r2.toFixed(3)}`).join(', '),
  )
}

check(messungen.length >= MIN_KARTEN, `${messungen.length} auswertbare Karten (mindestens ${MIN_KARTEN})`)
// Das ist die Prüfung der Konstante im Renderer: läge der Median woanders,
// wäre `FALLBACK = 1/15` schlicht der falsche Wert.
check(
  Math.abs(median - FALLBACK_STEIGUNG) / FALLBACK_STEIGUNG < STEIGUNG_BAND,
  `Median-Steigung ${median.toFixed(4)} liegt innerhalb ${(STEIGUNG_BAND * 100).toFixed(0)} % von 1/15 — ` +
    'die Konstante FALLBACK in fitDepthToG ist die richtige',
)

interface Fixture {
  maps: number
  holes: number
  weakR2: string[]
  note: string
}

if (update || !existsSync(fixture)) {
  mkdirSync(dirname(fixture), { recursive: true })
  const f: Fixture = {
    maps: messungen.length,
    holes: holesGesamt,
    weakR2: schwach.map((m) => m.map),
    note:
      'Die Spieldaten ändern sich nicht, also sind diese Zahlen konstant. Weicht '
      + 'etwas ab, hat sich der DXT-Decoder, der SCMAP-Leser oder die '
      + 'Installation geändert — nicht die Karten.',
  }
  writeFileSync(fixture, `${JSON.stringify(f, null, 2)}\n`)
  console.log(`  ${update ? 'Grundlinie NEU GESETZT' : 'Grundlinie angelegt'}`)
} else {
  const f = JSON.parse(readFileSync(fixture, 'utf-8')) as Fixture
  check(messungen.length === f.maps, `${messungen.length} Karten (erwartet ${f.maps})`)
  // Konstante Daten, konstantes Ergebnis: eine Abweichung ist ein Decoder-Fund.
  check(
    holesGesamt === f.holes,
    `${holesGesamt} DXT-Löcher (erwartet ${f.holes})` +
      (holesGesamt !== f.holes ? ' — der Decoder oder der SCMAP-Leser liefert etwas anderes' : ''),
  )
  const neu = schwach.map((m) => m.map).filter((m) => !f.weakR2.includes(m))
  check(
    neu.length === 0,
    neu.length === 0
      ? `keine neue Karte unter R² ${R2_SCHWELLE} (bekannt: ${f.weakR2.join(', ') || 'keine'})`
      : `neu unter R² ${R2_SCHWELLE}: ${neu.join(', ')} — die lineare Ersetzung passt dort nicht mehr`,
  )
}

console.log(failures === 0 ? '\nWATERMAP BESTANDEN' : `\nWATERMAP: ${failures} FEHLER`)
process.exit(failures === 0 ? 0 : 1)
