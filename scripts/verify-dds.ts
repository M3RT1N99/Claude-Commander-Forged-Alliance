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

console.log(`\n== ${ddsPaths.length} DDS-Dateien aus allen Archiven ==`)

const byFormat = new Map<string, number>()
const errors: { path: string; msg: string }[] = []
for (const p of ddsPaths) {
  try {
    const img = parseDds(await game.read(p))
    byFormat.set(img.format, (byFormat.get(img.format) ?? 0) + 1)
    // Die Mip-Kette muss zu den Maßen passen — sonst zeigt der Renderer Müll.
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
check(errors.length === 0, `keine einzige DDS-Datei scheitert (${errors.length} Fehler)`)
for (const e of errors.slice(0, 5)) console.log(`      ${e.path}: ${e.msg}`)

console.log('\n== A1R5G5B5 → BGRA8: die Aufweitung stimmt ==')
// Ein strategisches Icon: 16 Bit, A=0x8000, R=0x7c00, G=0x03e0, B=0x001f.
const iconPath = 'textures/ui/common/game/strategicicons/icon_bomber1_antinavy_over.dds'
check(game.exists(iconPath), `Testdatei vorhanden: ${iconPath}`)
const icon = parseDds(await game.read(iconPath))
check(icon.format === 'BGRA8', `wird als BGRA8 geliefert (war 16-bit A1R5G5B5)`)

const px = icon.mips[0]!.data
let opaque = 0
let maxChannel = 0
let maxAlpha = 0
for (let i = 0; i < px.length; i += 4) {
  if (px[i + 3]! > 0) opaque++
  maxChannel = Math.max(maxChannel, px[i]!, px[i + 1]!, px[i + 2]!)
  maxAlpha = Math.max(maxAlpha, px[i + 3]!)
}
check(opaque > 0, `${opaque} von ${px.length / 4} Pixeln sind sichtbar (1-Bit-Alpha)`)
// 5 Bit voll (31) MUSS 255 ergeben. Käme hier 248 heraus, wäre jedes Icon um
// 3 % zu dunkel — die Sorte Fehler, die man nie sieht und nie wieder findet.
check(maxChannel === 255, `hellster Kanal = ${maxChannel} (Bit-Replikation: 31 → 255, nicht 248)`)
// The 1-bit alpha of an opaque pixel MUST expand to fully opaque 255, not 128:
// a negative low-bit shift for bits < 4 made every strategic icon render at
// half opacity. Uniform scale round(v*255/(2^bits-1)) fixes 1..3-bit channels.
check(maxAlpha === 255, `1-bit alpha of an opaque pixel = ${maxAlpha} (must be 255, not 128)`)

// --- Cubemaps (EnvCube_*/SkyCube_*): 6 faces, each with its mip chain ------
// They back the mesh.fx environmentSampler (Moho::MeshEnvironment, default
// /textures/environment/defaultenvcube.dds, Cfile:1189598).
console.log('\n== DDS-Cubemaps: 6 Faces je Datei ==')
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
  check(cubes >= 80 && bad === 0, `${cubes} Cubemaps geparst, ${bad} fehlerhaft (erwartet: 86 im Spiel)`)

  const envPath = 'textures/environment/defaultenvcube.dds'
  check(game.exists(envPath), `Engine-Default vorhanden: ${envPath} (Cfile:1189598)`)
  const env = parseDds(await game.read(envPath))
  check(
    env.cubeFaces !== null && env.cubeFaces.length === 6 && env.format === 'DXT1',
    `DefaultEnvCube: 6 Faces, ${env.width}×${env.height} ${env.format}`,
  )
  // A 2D texture must NOT come back as a cube.
  const flat = parseDds(await game.read(iconPath))
  check(flat.cubeFaces === null, 'eine 2D-Textur bleibt 2D (cubeFaces = null)')
}

await game.close()
console.log(failures === 0 ? '\nDDS BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
