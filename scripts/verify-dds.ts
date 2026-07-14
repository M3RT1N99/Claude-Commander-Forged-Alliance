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
for (let i = 0; i < px.length; i += 4) {
  if (px[i + 3]! > 0) opaque++
  maxChannel = Math.max(maxChannel, px[i]!, px[i + 1]!, px[i + 2]!)
}
check(opaque > 0, `${opaque} von ${px.length / 4} Pixeln sind sichtbar (1-Bit-Alpha)`)
// 5 Bit voll (31) MUSS 255 ergeben. Käme hier 248 heraus, wäre jedes Icon um
// 3 % zu dunkel — die Sorte Fehler, die man nie sieht und nie wieder findet.
check(maxChannel === 255, `hellster Kanal = ${maxChannel} (Bit-Replikation: 31 → 255, nicht 248)`)

await game.close()
console.log(failures === 0 ? '\nDDS BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
