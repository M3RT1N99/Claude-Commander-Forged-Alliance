/**
 * Ein zweiter Eintrag mit demselben Namen in derselben Lua-Tabelle gewinnt —
 * und der erste ist tot, ohne dass irgendetwas meckert.
 *
 * Das ist kein hypothetischer Fehler. `moho.lua` hatte am Ende der
 * `aibrain`-Tabelle zwei alte Attrappen stehen:
 *
 *     GetThreatAtPosition = function(self, pos, rings, enemy, threatType) return 0 end,
 *     AssignThreatAtPosition = function(self, pos, threat, decay, threatType) end,
 *
 * Weiter oben in DERSELBEN Tabelle standen inzwischen die echten Rümpfe. Die
 * Attrappen gewannen, die Bedrohungskarte blieb leer, und keine Suite konnte es
 * sehen: beide Aufrufe „funktionierten" ja, sie taten nur nichts. Gefunden
 * wurde es erst, weil eine Zelle nach einem Schreibvorgang 0 blieb.
 *
 * Die Prüfung ist bewusst stur und rein textlich: sie liest die Tabellenblöcke
 * von `local <name> = {` bzw. `local <name> = withNoops(NAMES, {` bis zur
 * schließenden Klammer und meldet jeden Schlüssel, der darin zweimal auf der
 * ersten Ebene steht. Ein Lua-Parser wäre genauer, aber diese Form ist die, in
 * der die Datei geschrieben ist — und die Prüfung soll die echte Datei prüfen,
 * nicht eine gedachte.
 *
 *   npx tsx scripts/check-shadowed-methods.ts
 */
import { readdir, readFile } from 'node:fs/promises'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const VERZEICHNIS = 'src/engine-lua'
const dateien = (await readdir(VERZEICHNIS)).filter((f) => f.endsWith('.lua')).sort()

console.log(`== Doppelte Schlüssel in Tabellenliteralen (${dateien.length} Dateien) ==`)

interface Fund {
  datei: string
  tabelle: string
  name: string
  zeilen: number[]
}
const funde: Fund[] = []
let tabellen = 0
let schluessel = 0

for (const datei of dateien) {
  const zeilen = (await readFile(`${VERZEICHNIS}/${datei}`, 'utf-8')).replace(/\r\n/g, '\n').split('\n')
  let tabelle: string | null = null
  let gesehen = new Map<string, number[]>()
  for (const [index, zeile] of zeilen.entries()) {
    const nr = index + 1
    const beginn = /^local (\w+) = (?:withNoops\(\w+, )?\{\s*$/.exec(zeile)
    if (beginn) {
      tabelle = beginn[1] ?? null
      gesehen = new Map()
      tabellen++
      continue
    }
    if (tabelle !== null && /^\}\)?\s*$/.test(zeile)) {
      for (const [name, nrs] of gesehen) {
        if (nrs.length > 1) funde.push({ datei, tabelle, name, zeilen: nrs })
      }
      tabelle = null
      continue
    }
    if (tabelle === null) continue
    // Erste Ebene der Tabelle: genau zwei Leerzeichen Einrückung.
    const eintrag = /^ {2}([A-Za-z_]\w*) = /.exec(zeile)
    if (!eintrag) continue
    const name = eintrag[1] as string
    schluessel++
    const bisher = gesehen.get(name)
    if (bisher) bisher.push(nr)
    else gesehen.set(name, [nr])
  }
}

console.log(`  ${tabellen} Tabellenblöcke, ${schluessel} Schlüssel auf erster Ebene`)
// Findet die Prüfung gar keine Tabellen, prüft sie nichts — und wäre damit
// immer grün. Genau der Fall, vor dem CLAUDE.md warnt.
check(tabellen > 20, `genug Tabellen gefunden, um überhaupt etwas zu prüfen (${tabellen})`)
check(schluessel > 500, `und genug Schlüssel darin (${schluessel})`)

for (const f of funde) {
  console.log(`  FAIL ${f.datei}: Tabelle \`${f.tabelle}\` hat \`${f.name}\` in den Zeilen ${f.zeilen.join(', ')}`)
  console.log('       Der letzte gewinnt; alle früheren sind toter Code.')
}
check(funde.length === 0, `kein Schlüssel wird still überschrieben (${funde.length} Funde)`)

console.log(failures === 0 ? '\nKEINE VERDECKTEN METHODEN' : `\nVERDECKTE METHODEN: ${failures} FEHLER`)
process.exit(failures === 0 ? 0 : 1)
