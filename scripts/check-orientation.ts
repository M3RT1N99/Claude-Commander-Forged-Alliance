/**
 * DIE ZEILENORIENTIERUNG DER SCMAP-BILDER — GEPRÜFT, NICHT ANGENOMMEN.
 *
 * Ein in eine `.scmap` eingebettetes DDS hat keine Angabe darüber, ob seine
 * Zeile 0 der Heightmap-Zeile 0 entspricht oder der letzten. Falsch geraten
 * heisst: die Karte sieht richtig aus, bis man an einer Küste steht.
 *
 * Das Kriterium kommt aus den Daten selbst: der Grünkanal der Watermap IST die
 * Wassertiefe, und die Tiefe lässt sich aus der Heightmap ausrechnen
 * (`water.elevation - height`). Stimmt die Orientierung, korrelieren die
 * beiden nahezu perfekt; stimmt sie nicht, verschwindet die Korrelation.
 *
 * Das Skript hat diese Frage ursprünglich BEANTWORTET und drei Zahlenpaare
 * ausgegeben, die ein Mensch gelesen hat. Die Antwort steckt seitdem als
 * Annahme im Renderer: [`fitDepthToG`](../src/viewer/unitViewer.ts) bildet
 * `wz` direkt auf `z` ab, also OHNE Spiegelung.
 *
 * Jetzt prüft es diese Annahme, und zwar über alle Karten der Installation
 * statt über drei. Zwei Dinge machen es zu einer echten Prüfung:
 *
 *   * Karten OHNE auswertbares Wasser werden übersprungen und gezählt, nicht
 *     als Erfolg verbucht. SCMP_007 liefert `corr=0.000` gegen `corr=0.000` —
 *     das ist keine Bestätigung, das ist eine Nichtaussage, und ohne diese
 *     Trennung hätte sie als „bestanden" gezählt.
 *   * Es braucht eine Mindestzahl auswertbarer Karten. Ein Lauf, der nichts
 *     auswerten konnte, ist ein Fehlschlag.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/check-orientation.ts
 */
import { readFile, readdir } from 'node:fs/promises'
import { parseScmap } from '../src/formats/scmap'
import { parseDds } from '../src/formats/dds'
import { decodeDxt, bgraToRgba } from '../src/formats/dxt'

const GAME =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

function correlation(a: number[], b: number[]): number {
  const n = a.length
  if (n === 0) return 0
  const ma = a.reduce((x, y) => x + y, 0) / n
  const mb = b.reduce((x, y) => x + y, 0) / n
  let cov = 0
  let va = 0
  let vb = 0
  for (let i = 0; i < n; i++) {
    const da = (a[i] ?? 0) - ma
    const db = (b[i] ?? 0) - mb
    cov += da * db
    va += da * da
    vb += db * db
  }
  return cov / Math.sqrt(va * vb || 1)
}

// Wieviel Wasser eine Karte haben muss, damit ihre Korrelation etwas bedeutet.
const MIN_NASSE_PUNKTE = 100
const MIN_TIEFE_SPANNE = 1.0 // Weltmeter zwischen flachster und tiefster Stelle
// Auf JEDER auswertbaren Karte muss die ungespiegelte Lesung passen …
const NORMAL_MIN = 0.9
// … und sie darf nie schlechter sein als die gespiegelte.
//
// Eine feste Obergrenze für die gespiegelte Korrelation wäre FALSCH, und zwar
// nachgemessen: auf vertikal symmetrischen Karten korreliert auch die
// gespiegelte Lesung hoch (SCMP_002: normal=1.000, gespiegelt=0.984). Das
// widerlegt die Annahme nicht — dort kann die Messung nur nicht unterscheiden.
// Die Unterscheidbarkeit ist deshalb eine Eigenschaft der SUITE: es müssen
// genug Karten dabei sein, auf denen die beiden Lesungen weit auseinander
// liegen. Ohne diese Forderung wäre der Lauf grün, selbst wenn die Watermap
// gar nichts mehr mit der Heightmap zu tun hätte.
const MIN_ABSTAND = 0.3
const MIN_UNTERSCHEIDENDE = 5
// Ein Lauf, der nichts auswerten konnte, darf nicht grün melden.
const MIN_AUSWERTBAR = 5

const maps = (await readdir(`${GAME}/maps`, { withFileTypes: true }))
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort()

console.log(`\n== ${maps.length} Karten in der Installation ==`)

let auswertbar = 0
let unterscheidende = 0
let ohneWasser = 0
let ungelesen = 0
const schlechteste: { map: string; normal: number; flip: number }[] = []

for (const map of maps) {
  let scmap
  try {
    scmap = parseScmap(new Uint8Array(await readFile(`${GAME}/maps/${map}/${map}.scmap`)))
  } catch {
    ungelesen++
    continue
  }
  if (!scmap.water.hasWater || !scmap.waterMapDds) {
    ohneWasser++
    continue
  }

  let wm
  try {
    wm = parseDds(scmap.waterMapDds)
  } catch {
    ungelesen++
    continue
  }
  const mip = wm.mips[0]
  if (!mip) {
    ungelesen++
    continue
  }
  const rgba =
    wm.format === 'BGRA8' ? bgraToRgba(mip.data) : decodeDxt(mip.data, wm.width, wm.height, wm.format)

  const stride = scmap.width + 1
  const tiefe: number[] = []
  const gNormal: number[] = []
  const gFlipped: number[] = []
  const step = Math.max(1, Math.floor(scmap.width / 64))
  for (let z = 2; z < scmap.height - 2; z += step) {
    for (let x = 2; x < scmap.width - 2; x += step) {
      const h = (scmap.heightmap[z * stride + x] ?? 0) * scmap.heightScale
      const d = scmap.water.elevation - h
      if (d <= 0.1) continue // Land: der Grünkanal sagt dort nichts über Tiefe
      const wx = Math.min(wm.width - 1, Math.floor((x / scmap.width) * wm.width))
      const wzN = Math.min(wm.height - 1, Math.floor((z / scmap.height) * wm.height))
      const wzF = wm.height - 1 - wzN
      tiefe.push(d)
      gNormal.push(rgba[(wzN * wm.width + wx) * 4 + 1] ?? 0)
      gFlipped.push(rgba[(wzF * wm.width + wx) * 4 + 1] ?? 0)
    }
  }

  const spanne = tiefe.length > 0 ? Math.max(...tiefe) - Math.min(...tiefe) : 0
  if (tiefe.length < MIN_NASSE_PUNKTE || spanne < MIN_TIEFE_SPANNE) {
    // Zu wenig oder zu gleichförmiges Wasser: die Korrelation wäre eine Zahl
    // ohne Aussage. Übersprungen und gezählt — NICHT als Erfolg verbucht.
    ohneWasser++
    continue
  }

  const normal = correlation(tiefe, gNormal)
  const flip = correlation(tiefe, gFlipped)
  auswertbar++
  if (normal < NORMAL_MIN || flip > normal) schlechteste.push({ map, normal, flip })
  if (normal - flip >= MIN_ABSTAND) unterscheidende++
}

console.log(
  `  ${auswertbar} auswertbar · ${unterscheidende} davon unterscheidend · ` +
    `${ohneWasser} ohne (genug) Wasser · ${ungelesen} nicht lesbar`,
)

check(
  auswertbar >= MIN_AUSWERTBAR,
  `mindestens ${MIN_AUSWERTBAR} Karten mit auswertbarem Wasser (${auswertbar})`,
)
check(
  schlechteste.length === 0,
  schlechteste.length === 0
    ? `auf allen ${auswertbar} Karten: corr(normal) ≥ ${NORMAL_MIN} und nie schlechter als gespiegelt — ` +
        'die Watermap liegt zeilengleich zur Heightmap, so wie fitDepthToG sie liest'
    : `${schlechteste.length} Karte(n) widersprechen der Annahme: ` +
      schlechteste
        .slice(0, 5)
        .map((s) => `${s.map} normal=${s.normal.toFixed(3)} gespiegelt=${s.flip.toFixed(3)}`)
        .join(', '),
)
check(
  unterscheidende >= MIN_UNTERSCHEIDENDE,
  `${unterscheidende} Karten trennen die beiden Lesungen um ≥ ${MIN_ABSTAND} ` +
    `(mindestens ${MIN_UNTERSCHEIDENDE}) — die Messung kann wirklich unterscheiden`,
)

console.log(
  failures === 0 ? '\nZEILENORIENTIERUNG BESTÄTIGT' : `\nZEILENORIENTIERUNG: ${failures} FEHLER`,
)
process.exit(failures === 0 ? 0 : 1)
