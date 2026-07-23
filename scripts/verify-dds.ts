/**
 * Der DDS-Parser gegen JEDE DDS-Datei des Spiels.
 *
 * Anlass: die strategischen Icons (1134 Dateien) sind A1R5G5B5 — 16 Bit
 * unkomprimiert. Der Parser lehnte sie ab, und der Fehler landete als
 * unbehandelte Exception im Browser. Statt „das eine Format nachrüsten" wird
 * hier gezählt, was WIRKLICH vorkommt, und jede Datei einmal geparst.
 *
 * Geprüft wird zusätzlich die Aufweitung nach BGRA8 an einem bekannten Pixel:
 * A1R5G5B5 hat pro Kanal 5 Bit, und 31 muss 255 werden (Bit-Replikation), nicht
 * 248 — sonst sind alle Icons dauerhaft zu dunkel.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-dds.ts
 */
import { GameFiles } from './gameFiles'
import { parseDds } from '../src/formats/dds'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()
const ddsPaths = [...game.paths].filter((p) => p.endsWith('.dds'))

console.log(`\n== ${ddsPaths.length} DDS files from all archives ==`)

const byFormat = new Map<string, number>()
const errors: { path: string; msg: string }[] = []
for (const p of ddsPaths) {
  try {
    const img = parseDds(await game.read(p))
    byFormat.set(img.format, (byFormat.get(img.format) ?? 0) + 1)
    // The mip chain must match the dimensions — otherwise the renderer will show garbage.
    const first = img.mips[0]!
    if (first.width !== img.width || first.height !== img.height) {
      errors.push({ path: p, msg: `Mip 0 misst ${first.width}×${first.height}, Header sagt ${img.width}×${img.height}` })
    }
    if (img.format === 'BGRA8' && first.data.length !== first.width * first.height * 4) {
      errors.push({ path: p, msg: `BGRA8-Mip hat ${first.data.length} Bytes, erwartet ${first.width * first.height * 4}` })
    }
  } catch (err) {
    errors.push({ path: p, msg: err instanceof Error ? err.message : String(err) })
  }
}

for (const [f, n] of [...byFormat].sort((a, b) => b[1] - a[1])) {
  console.log(`  · ${String(n).padStart(6)} × ${f}`)
}
check(errors.length === 0, `not a single DDS file fails (${errors.length} error)`)
for (const e of errors.slice(0, 5)) console.log(`      ${e.path}: ${e.msg}`)

console.log('\n== A1R5G5B5 → BGRA8: the expansion is correct ==')
// A strategic icon: 16 bits, A=0x8000, R=0x7c00, G=0x03e0, B=0x001f.
const iconPath = 'textures/ui/common/game/strategicicons/icon_bomber1_antinavy_over.dds'
check(game.exists(iconPath), `Testdatei vorhanden: ${iconPath}`)
const icon = parseDds(await game.read(iconPath))
check(icon.format === 'BGRA8', `is delivered as BGRA8 (was 16-bit A1R5G5B5)`)

const px = icon.mips[0]!.data
let opaque = 0
let maxChannel = 0
for (let i = 0; i < px.length; i += 4) {
  if (px[i + 3]! > 0) opaque++
  maxChannel = Math.max(maxChannel, px[i]!, px[i + 1]!, px[i + 2]!)
}
check(opaque > 0, `${opaque} of ${px.length / 4} pixels are visible (1-bit alpha)`)
// 5 bits full (31) MUST equal 255. If 248 came out here, every icon would be gone
// 3% too dark — the kind of mistake you never see and never find again.
check(maxChannel === 255, `brightest channel = ${maxChannel} (bit replication: 31 → 255, not 248)`)

// --- Cubemaps (EnvCube_*/SkyCube_*): 6 faces, each with its mip chain ------
// They back the mesh.fx environmentSampler (Moho::MeshEnvironment, default
// /textures/environment/defaultenvcube.dds, Cfile:1189598).
console.log('\n== DDS cubemaps: 6 faces per file ==')
{
  let cubes = 0
  let bad = 0
  for (const p of ddsPaths) {
    const img = await (async () => {
      try {
        return parseDds(await game.read(p))
      } catch {
        return null
      }
    })()
    if (!img?.cubeFaces) continue
    cubes++
    if (img.cubeFaces.length !== 6) bad++
    for (const face of img.cubeFaces) {
      const m0 = face[0]!
      if (m0.width !== img.width || m0.height !== img.height) bad++
    }
  }
  check(cubes >= 80 && bad === 0, `${cubes} Cubemaps parsed, ${bad} incorrect (expected: 86 in game)`)

  const envPath = 'textures/environment/defaultenvcube.dds'
  check(game.exists(envPath), `Engine-Default vorhanden: ${envPath} (Cfile:1189598)`)
  const env = parseDds(await game.read(envPath))
  check(
    env.cubeFaces !== null && env.cubeFaces.length === 6 && env.format === 'DXT1',
    `DefaultEnvCube: 6 Faces, ${env.width}×${env.height} ${env.format}`,
  )
  // A 2D texture must NOT come back as a cube.
  const flat = parseDds(await game.read(iconPath))
  check(flat.cubeFaces === null, 'a 2D texture remains 2D (cubeFaces = null)')
}

await game.close()
console.log(failures === 0 ? '\nDDS BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
