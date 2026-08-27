/**
 * DER REPLAY-LESER GEGEN ECHTE AUFZEICHNUNGEN.
 *
 * `src/formats/scfareplay.ts` behauptet ein Format, das aus dem Decompilat
 * abgeleitet ist (`VCR_SetupReplaySession` Cfile:1303988-1304227,
 * `CDecoder::DecodeMessage` Cfile:996781-996905, `WriteCommandData`
 * Cfile:999299-999428, `WriteTarget` Cfile:999433-999493, `SCR_FromByteStream`
 * Cfile:598588-598636). Diese Suite prüft die Behauptung an den Replays, die auf
 * diesem Rechner liegen — Partien, die die ORIGINALENGINE aufgezeichnet hat.
 *
 * Der Kern ist nicht „parst ohne Ausnahme". Der Kern ist, dass nichts übrig
 * bleibt:
 *
 *   1. der Rahmenlauf endet **exakt** auf dem Dateiende. Bei einem falschen
 *      Kopf-Layout wäre der Körperbeginn um ein paar Bytes daneben, und dann
 *      trifft der Lauf das Ende praktisch nie;
 *   2. jeder Befehls-Datensatz (0x0C/0x0D) geht **auf das letzte Byte** auf.
 *      Ein Leser, der Reste stillschweigend verwirft, würde ein falsches Layout
 *      genau verdecken;
 *   3. die drei Kopf-Blöcke sind vollständige `SCR_ToByteStream`-Bäume;
 *   4. die Uhr stimmt: jede `VerifyChecksum` nennt einen Beat, der 0 bis 127
 *      hinter der Summe der `Advance`-Deltas liegt — die Ringgröße
 *      `mSimHashes[beat & 0x7F]` (Cfile:1067934). Nicht Gleichheit: gemessen
 *      ist der Versatz meist 0, geht aber bis 47. Das prüft Rahmen UND Takt,
 *      ganz ohne den Digest;
 *   5. die Prüfsummen, die der Lauf findet, sind dieselben, die ein davon
 *      unabhängiger roher Byte-Scan findet.
 *
 * Findet die Suite kein Replay, ist das ein FEHLSCHLAG, kein Übersprung: ein
 * Test, der ohne Daten grün meldet, ist genau die Sorte Lüge, gegen die dieses
 * Netz gebaut wird. Der Ordner lässt sich mit `CFA_REPLAY_DIR` setzen.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-replay.ts
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-replay.ts --update
 */
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import {
  MSGOP,
  MSGOP_VERIFY_CHECKSUM,
  parseReplayHeader,
  readMessages,
  readChecksums,
  readLuaBlob,
  readIssue,
  readAdvance,
  readLuaSimCallback,
  readSetCommandSource,
  type LuaTable,
} from '../src/formats/scfareplay'

const update = process.argv.includes('--update')
const fixture = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'replay-corpus.json')

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const GAME =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

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

/**
 * Die Befehlstypen (`docs/research/command-dispatch-binary.md:13-52`). 0x28 ist
 * die Obergrenze, gegen die `DecodeCommandData` prüft (Cfile:997525-997537) —
 * die Tabelle endet genau davor, was beides bestätigt.
 */
const CMD = [
  '?0', 'Stop', 'Move', 'Dive', 'FormMove', 'BuildSiloTactical', 'BuildSiloNuke',
  'BuildFactory', 'BuildMobile', 'BuildAssist', 'Attack', 'FormAttack', 'Nuke',
  'Tactical', 'Teleport', 'Guard', 'Patrol', 'Ferry', 'FormPatrol', 'Reclaim',
  'Repair', 'Capture', 'TransportLoadUnits', 'TransportReverseLoadUnits',
  'TransportUnloadUnits', 'TransportUnloadSpecificUnits', 'DetachFromTransport',
  'Upgrade', 'Script', 'AssistCommander', 'KillSelf', 'DestroySelf', 'Sacrifice',
  'Pause', 'OverCharge', 'AggressiveMove', 'FormAggressiveMove', 'AssistMove',
  'SpecialAction', 'Dock',
]

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
let gesamtIssues = 0
const versionen = new Set<string>()
const cmdHist = new Map<number, number>()
const cbHist = new Map<string, number>()
const einspeisbar: string[] = []

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

  // ── Die drei Kopf-Blöcke sind Lua-Bäume, kein Text ────────────────────────
  //
  // Sie wurden zuerst mit `TextDecoder('latin1')` gelesen. Das war falsch, und
  // zwar messbar: Node bildet `latin1` auf **windows-1252** ab, Byte 0x80 wird
  // U+20AC — und 0x80 ist das dritte Byte des Floats 1.0, der in jedem dieser
  // Blöcke vorkommt. Vollständiges Dekodieren beweist, dass sie jetzt roh sind.
  let bloeckeOk = true
  let blockFehler = ''
  let mods: LuaTable | null = null
  try {
    const m = readLuaBlob(head.gameMods, 'mGameMods')
    mods = m !== null && typeof m === 'object' ? (m as LuaTable) : null
    readLuaBlob(head.scenarioInfo, 'mScenarioInfo')
    for (let i = 0; i < head.armies.length; i++) {
      const a = head.armies[i]
      if (a && a.info.length > 0) readLuaBlob(a.info, `armies[${i}].info`)
    }
  } catch (err) {
    bloeckeOk = false
    blockFehler = (err as Error).message
  }
  check(
    bloeckeOk,
    `mGameMods + mScenarioInfo + ${head.armies.length}× armies[].info sind vollständige ` +
      `SCR_ToByteStream-Bäume${blockFehler ? ` — ${blockFehler}` : ''}`,
  )

  // ── Rahmenlauf, Nutzlasten, Uhr ───────────────────────────────────────────
  let n = 0
  let letzte = ''
  const opHist = new Map<number, number>()
  let lauf: string | null = null
  let beat = 0
  let issues = 0
  let advanceNichtEins = 0
  let uhrFehler = 0
  let maxVersatz = 0
  let ersterIssueBeat = -1
  try {
    for (const m of readMessages(bytes, head.bodyOffset)) {
      n++
      letzte = m.name
      opHist.set(m.op, (opHist.get(m.op) ?? 0) + 1)
      if (m.op >= MSGOP.length) {
        lauf = `Opcode 0x${m.op.toString(16)} bei ${m.offset} liegt über 0x17`
        break
      }
      switch (m.op) {
        case 0x00: {
          const d = readAdvance(m.payload)
          // Der Wert ist ein DELTA (Cfile:680549-680568). Ob die Sim für ein
          // Delta > 1 wirklich mehrere Beats rechnet, ist UNBEKANNT
          // (Sim::AdvanceBeat, Cfile:1076363-1076688, macht genau einen).
          // Deshalb wird jedes Delta ≠ 1 GEZÄHLT statt stillschweigend addiert.
          if (d !== 1) advanceNichtEins++
          beat += d
          break
        }
        case 0x01:
          readSetCommandSource(m.payload)
          break
        case MSGOP_VERIFY_CHECKSUM: {
          // Die einzige absolute Beat-Nummer im Strom — das Lineal.
          //
          // Sie ist NICHT immer gleich der Summe der Advance-Deltas. Gemessen
          // über alle neun Replays: der Versatz ist meist 0, geht aber bis 47.
          // Das passt zum 128er-Ring `mSimHashes[beat & 0x7F]` (Cfile:1067934):
          // verschickt wird der Beat, den die Sync-Anfrage nennt, und der darf
          // hinterherhinken — aber nur innerhalb des Rings.
          //
          // Die prüfbare Aussage ist deshalb die SCHRANKE, nicht die Gleichheit:
          // 0 <= Versatz < 128. Eine Prüfsumme für einen Beat, den der Strom
          // noch nicht erreicht hat, wäre unmöglich; einer, der weiter als der
          // Ring zurückliegt, ebenfalls. Verrutscht der Rahmen, sprengt der
          // Versatz beide Grenzen sofort.
          const pv = new DataView(m.payload.buffer, m.payload.byteOffset, m.payload.byteLength)
          const versatz = beat - pv.getUint32(16, true)
          if (versatz < 0 || versatz >= 128) uhrFehler++
          if (versatz > maxVersatz) maxVersatz = versatz
          break
        }
        case 0x0c:
        case 0x0d: {
          const iss = readIssue(m.payload)
          issues++
          if (ersterIssueBeat < 0) ersterIssueBeat = beat
          cmdHist.set(iss.data.commandType, (cmdHist.get(iss.data.commandType) ?? 0) + 1)
          break
        }
        case 0x16: {
          const cb = readLuaSimCallback(m.payload)
          cbHist.set(cb.name, (cbHist.get(cb.name) ?? 0) + 1)
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    lauf = (err as Error).message
  }
  check(lauf === null, `Rahmenlauf bis zum Dateiende: ${n} Nachrichten${lauf ? ` — ${lauf}` : ''}`)
  gesamtNachrichten += n
  gesamtIssues += issues
  console.log(`  letzte Nachricht: ${letzte}`)
  const top = [...opHist.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([op, c]) => `${MSGOP[op] ?? op}×${c}`)
  console.log(`  häufigste: ${top.join(', ')}`)

  if (lauf !== null) continue

  console.log(
    `  ${issues} Befehls-Datensätze (0x0C/0x0D) gehen auf das letzte Byte auf` +
      (ersterIssueBeat >= 0 ? `, erster bei Beat ${ersterIssueBeat}` : ''),
  )
  check(advanceNichtEins === 0, `jedes Advance-Delta ist 1 (${advanceNichtEins} andere)`)
  check(
    uhrFehler === 0,
    `die Uhr stimmt: jede Prüfsumme liegt 0..127 Beats hinter der Summe der ` +
      `Advance-Deltas (grösster Versatz ${maxVersatz}, ${uhrFehler} ausserhalb)`,
  )

  // ── Prüfsummen über den Lauf, gegen einen unabhängigen Byte-Scan ─────────
  const sums = readChecksums(bytes, head)
  gesamtPruefsummen += sums.length
  check(sums.length > 0, `${sums.length} VerifyChecksum-Nachrichten (Opcode 3)`)

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

  // ── Einspeisbar? ──────────────────────────────────────────────────────────
  //
  // Ein Replay taugt nur dann als Vergleich gegen die Originalengine, wenn
  // dieselbe Lua läuft. Trägt es Mods, deren Lua unsere Sim-Skripte ersetzt,
  // misst jede Abweichung den Mod, nicht unsere Engine.
  const modFrei = mods !== null && Object.keys(mods).length === 0
  const ordner = head.mapPath.replace(/^\/maps\//, '').split('/')[0] ?? ''
  const karteDa = ordner !== '' && existsSync(join(GAME, 'maps', ordner))
  const tauglich = modFrei && karteDa && issues > 0
  if (tauglich) einspeisbar.push(name)
  console.log(
    `  einspeisbar: ${tauglich ? 'JA' : 'nein'} ` +
      `(mod-frei ${modFrei ? 'ja' : 'nein'} · Karte installiert ${karteDa ? 'ja' : 'nein'} · ` +
      `${issues} Befehle)`,
  )
}

console.log(`\n== Zusammen ==`)
console.log(
  `  ${files.length} Replays, ${gesamtNachrichten} Nachrichten, ` +
    `${gesamtPruefsummen} Prüfsummen, ${gesamtIssues} Befehls-Datensätze`,
)
console.log(`  Versionen: ${[...versionen].join(' · ')}`)

const cmdSort = [...cmdHist.entries()].sort((a, b) => b[1] - a[1])
console.log(`\n  Befehlstypen (${cmdSort.length} verschiedene):`)
for (const [t, c] of cmdSort) {
  console.log(`    ${(CMD[t] ?? `0x${t.toString(16)}`).padEnd(28)} ${String(c).padStart(5)}`)
}
const cbSort = [...cbHist.entries()].sort((a, b) => b[1] - a[1])
if (cbSort.length > 0) {
  console.log(`\n  LuaSimCallbacks (${cbSort.length} verschiedene):`)
  for (const [k, c] of cbSort) console.log(`    ${k.padEnd(28)} ${String(c).padStart(5)}`)
}

console.log(`\n  Einspeisbar (mod-frei, Karte installiert, Befehle vorhanden): ${einspeisbar.length}`)
for (const e of einspeisbar) console.log(`    ${e}`)
if (einspeisbar.length === 0) {
  console.log(
    '    KEINES. Ein Replay taugt nur als Vergleich gegen die Originalengine,\n' +
      '    wenn dieselbe Lua läuft — die vorhandenen tragen Mods, deren Lua unsere\n' +
      '    Sim-Skripte ersetzt. Was fehlt, ist EINE Partie ohne Mods auf einer\n' +
      '    installierten Karte. Das ist keine Codeänderung, das ist ein Spielstart.',
  )
}

interface Fixture {
  minFeedable: number
  issues: number
  note: string
}

if (update || !existsSync(fixture)) {
  mkdirSync(dirname(fixture), { recursive: true })
  const f: Fixture = {
    minFeedable: einspeisbar.length,
    issues: gesamtIssues,
    note:
      'Sperrklinke, keine Zielvorgabe: die Zahl der einspeisbaren Replays darf '
      + 'steigen, nie fallen. Ist sie 0, ist das ein FUND, kein Fehler — dann '
      + 'fehlt eine mod-freie Aufzeichnung. Sobald eine da ist, mit --update '
      + 'nachziehen. `issues` deckelt gleichzeitig den Decoder: liest er weniger '
      + 'Befehls-Datensätze als vorher, hat er verloren.',
  }
  writeFileSync(fixture, `${JSON.stringify(f, null, 2)}\n`)
  console.log(`\n  ${update ? 'Sperrklinke NEU GESETZT' : 'Sperrklinke angelegt'}`)
} else {
  const f = JSON.parse(readFileSync(fixture, 'utf-8')) as Fixture
  check(
    einspeisbar.length >= f.minFeedable,
    `${einspeisbar.length} einspeisbare Replays (Sperrklinke ${f.minFeedable})`,
  )
  check(
    gesamtIssues >= f.issues,
    `${gesamtIssues} Befehls-Datensätze gelesen (Sperrklinke ${f.issues})` +
      (gesamtIssues < f.issues ? ' — es sind WENIGER als vorher, der Decoder hat verloren' : ''),
  )
}

console.log(
  failures === 0 ? '\nREPLAY-FORMAT BESTÄTIGT' : `\nREPLAY-FORMAT: ${failures} FEHLER`,
)
process.exit(failures === 0 ? 0 : 1)
