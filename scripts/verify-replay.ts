/**
 * DER REPLAY-LESER GEGEN ECHTE AUFZEICHNUNGEN.
 *
 * `src/formats/scfareplay.ts` behauptet ein Format, das vollständig aus dem
 * Decompilat abgeleitet ist (`VCR_SetupReplaySession` Cfile:1303988-1304227,
 * `CDecoder::DecodeMessage` Cfile:996781-996905). Diese Suite prüft die
 * Behauptung an den Replays, die auf diesem Rechner liegen — Partien, die die
 * ORIGINALENGINE aufgezeichnet hat.
 *
 * Der Kern ist nicht „parst ohne Ausnahme". Der Kern ist:
 *
 *   1. der Rahmenlauf endet **exakt** auf dem Dateiende — kein Rest, kein
 *      Überlauf. Bei einem falschen Kopf-Layout wäre der Körperbeginn um ein
 *      paar Bytes daneben, und dann trifft der Lauf das Ende praktisch nie;
 *   2. jeder Opcode liegt in 0x00-0x17 (die 24 Fälle der `switch`);
 *   3. die Prüfsummen, die der LAUF findet, sind Stück für Stück dieselben, die
 *      ein davon unabhängiger Byte-Scan nach `03 17 00` findet. Zwei Verfahren,
 *      die sich nicht kennen, müssen dasselbe Ergebnis liefern.
 *
 * Findet die Suite kein Replay, ist das ein FEHLSCHLAG, kein Übersprung: ein
 * Test, der ohne Daten grün meldet, ist genau die Sorte Lüge, gegen die dieses
 * Netz gebaut wird. Der Ordner lässt sich mit `CFA_REPLAY_DIR` setzen.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-replay.ts
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  MSGOP,
  MSGOP_VERIFY_CHECKSUM,
  parseReplayHeader,
  readMessages,
  readChecksums,
} from '../src/formats/scfareplay'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const dir =
  process.env.CFA_REPLAY_DIR ??
  join(
    homedir(),
    'Documents',
    'My Games',
    'Gas Powered Games',
    'Supreme Commander Forged Alliance',
    'replays',
  )

const collect = (d: string, out: string[] = []): string[] => {
  if (!existsSync(d)) return out
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    if (statSync(p).isDirectory()) collect(p, out)
    else if (e.toLowerCase().endsWith('.scfareplay')) out.push(p)
  }
  return out
}

const files = collect(dir).sort()
console.log(`\n== Aufzeichnungen ==`)
console.log(`  Ordner: ${dir}`)
check(files.length > 0, `${files.length} Replay(s) gefunden (0 = Fehlschlag, nicht Übersprung)`)
if (files.length === 0) {
  console.log(
    '\nOhne Aufzeichnung ist nichts zu prüfen. Der Ordner lässt sich über\n' +
      'CFA_REPLAY_DIR setzen; jede im Spiel gefahrene Partie legt dort eine an.',
  )
  process.exit(1)
}

let gesamtNachrichten = 0
let gesamtPruefsummen = 0
const versionen = new Set<string>()

for (const f of files) {
  const name = f.slice(dir.length + 1)
  const bytes = new Uint8Array(readFileSync(f))
  console.log(`\n== ${name} (${bytes.length} Byte) ==`)

  let head
  try {
    head = parseReplayHeader(bytes)
  } catch (err) {
    check(false, `Kopf lesbar — ${(err as Error).message}`)
    continue
  }
  versionen.add(head.version)
  console.log(
    `  ${head.version} · ${head.mapPath} · ${head.armies.length} Armeen · ` +
      `${head.sources.length} Quelle(n) · Seed ${head.seed}`,
  )
  // Der Kartenpfad ist das erste, was ein verrutschter Kopf zerstört. Er zeigt
  // auf die .scmap (sesInfo->mMapName, Cfile:1304256), nicht auf das
  // Szenario-Skript — hier stand zuerst '.lua', und alle neun Replays haben das
  // widerlegt.
  check(
    head.mapPath.startsWith('/maps/') && head.mapPath.endsWith('.scmap'),
    `Kartenpfad plausibel (${head.mapPath.slice(0, 60)})`,
  )
  check(head.armies.length > 0, `${head.armies.length} Armee(n) im Kopf`)
  // Die Lua-Bloecke sind Quelltext, kein Binaermuell — ein falsches Layout faellt
  // hier sofort auf.
  check(
    head.scenarioInfo.includes('scenario') || head.scenarioInfo.includes('map'),
    'mScenarioInfo enthält Lua-Quelltext',
  )

  // 1) Der Rahmenlauf muss exakt auf dem Dateiende landen.
  let n = 0
  let letzte = ''
  const opHist = new Map<number, number>()
  let lauf: string | null = null
  try {
    for (const m of readMessages(bytes, head.bodyOffset)) {
      n++
      letzte = m.name
      opHist.set(m.op, (opHist.get(m.op) ?? 0) + 1)
      if (m.op >= MSGOP.length) {
        lauf = `Opcode 0x${m.op.toString(16)} bei ${m.offset} liegt über 0x17`
        break
      }
    }
  } catch (err) {
    lauf = (err as Error).message
  }
  check(lauf === null, `Rahmenlauf bis zum Dateiende: ${n} Nachrichten${lauf ? ` — ${lauf}` : ''}`)
  gesamtNachrichten += n
  // Eine vollständige Partie endet mit EndGame; ein Absturz oder ein Abbruch
  // mitten im Spiel nicht — deshalb nur berichten, nicht prüfen.
  console.log(`  letzte Nachricht: ${letzte}`)
  const top = [...opHist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([op, c]) => `${MSGOP[op] ?? op}×${c}`)
  console.log(`  häufigste: ${top.join(', ')}`)

  if (lauf !== null) continue

  // 2) Prüfsummen über den Lauf …
  const sums = readChecksums(bytes, head)
  gesamtPruefsummen += sums.length
  check(sums.length > 0, `${sums.length} VerifyChecksum-Nachrichten (Opcode 3)`)

  // 3) … gegen einen völlig unabhängigen Byte-Scan.
  //
  // Ein Prüfsummen-Datensatz ist immer `03 17 00` + 16 + 4 (Rahmen aus
  // DecodeMessage, Nutzlast aus DecodeVerifyChecksum). Der Scan kennt den Kopf
  // nicht und läuft nicht in Rahmen — er sieht nur Bytes. Stimmen beide
  // Verfahren überein, ist das Format kein Zufallstreffer.
  //
  // Der Scan kann von sich aus MEHR finden (dieselben drei Bytes können in einer
  // Nutzlast stehen), deshalb ist die Richtung: jeder Fund des Laufs muss auch
  // ein Fund des Scans sein.
  const scan = new Set<number>()
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let i = 0; i + 23 <= bytes.length; i++) {
    if (
      dv.getUint8(i) === MSGOP_VERIFY_CHECKSUM &&
      dv.getUint8(i + 1) === 0x17 &&
      dv.getUint8(i + 2) === 0x00
    ) {
      // Nutzlast beginnt bei +3, der Beat sind ihre Bytes 16..19 — also +19.
      scan.add(dv.getUint32(i + 19, true))
    }
  }
  const fehlend = sums.filter((s) => !scan.has(s.beat)).length
  check(
    fehlend === 0,
    `alle ${sums.length} Prüfsummen des Laufs findet auch der rohe Byte-Scan ` +
      `(${scan.size} Kandidaten)${fehlend ? `, ${fehlend} fehlen` : ''}`,
  )

  // 4) Beats streng aufsteigend, Digest nie leer.
  const beats = sums.map((s2) => s2.beat)
  let auf = true
  for (let i = 1; i < beats.length; i++) if ((beats[i] ?? 0) <= (beats[i - 1] ?? 0)) auf = false
  check(auf, `Beats streng aufsteigend (${beats[0]} … ${beats[beats.length - 1]})`)
  check(
    sums.every((s) => s.md5.length === 32 && !/^0{32}$/.test(s.md5)),
    'jeder Digest ist 16 Byte und nicht null',
  )
  // Der Abstand ist eine MESSUNG, keine Cfile-Tatsache: die Sendestelle
  // (Cfile:1067922-1067937) verschickt den Beat, den die Sync-Anfrage nennt, aus
  // dem 128er-Ring `mSimHashes[beat & 0x7F]`. Welche Kadenz die Anfrage wählt,
  // ist nicht nachverfolgt. Deshalb wird der Abstand berichtet und nur auf
  // Gleichmäßigkeit geprüft — nicht auf den Wert 50.
  if (beats.length > 2) {
    const d = new Set<number>()
    for (let i = 1; i < beats.length; i++) d.add((beats[i] ?? 0) - (beats[i - 1] ?? 0))
    const abst = [...d].sort((a, b) => a - b)
    check(d.size === 1, `gleichmäßiger Abstand: ${abst.join(', ')} Beats`)
    console.log(`  ${beats.length} Prüfsummen, ${beats[beats.length - 1]} Beats Spielzeit`)
  }
}

console.log(`\n== Zusammen ==`)
console.log(`  ${files.length} Replays, ${gesamtNachrichten} Nachrichten, ${gesamtPruefsummen} Prüfsummen`)
console.log(`  Versionen: ${[...versionen].join(' · ')}`)
console.log(
  failures === 0 ? '\nREPLAY-FORMAT BESTÄTIGT' : `\nREPLAY-FORMAT: ${failures} FEHLER`,
)
process.exit(failures === 0 ? 0 : 1)
