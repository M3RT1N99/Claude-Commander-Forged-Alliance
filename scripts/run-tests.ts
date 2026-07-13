/**
 * Führt alle verify-*.ts nacheinander aus und fasst Bestanden/Fehlgeschlagen
 * zusammen. Die meisten Tests lesen die Original-Spieldateien; setze
 * CFA_GAME_DIR, falls das Spiel nicht im Steam-Standardpfad liegt.
 *
 *   npm test            # alle Verify-Suiten
 *   npm test economy    # nur Suiten, deren Name "economy" enthält
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = dirname(here)
const filter = process.argv[2] ?? ''

const suites = readdirSync(here)
  .filter((f) => f.startsWith('verify') && f.endsWith('.ts'))
  .filter((f) => f.includes(filter))
  .sort()

if (suites.length === 0) {
  console.error(`Keine Verify-Suite passt zu "${filter}".`)
  process.exit(1)
}

const results: { suite: string; ok: boolean }[] = []
for (const suite of suites) {
  console.log(`\n── ${suite} ${'─'.repeat(Math.max(0, 60 - suite.length))}`)
  // Relativer Pfad + cwd auf die Projektwurzel — der Absolutpfad enthält
  // Leerzeichen und würde mit shell:true zerbrechen.
  const r = spawnSync('npx', ['tsx', `scripts/${suite}`], {
    stdio: 'inherit',
    shell: true,
    cwd: projectRoot,
  })
  results.push({ suite, ok: r.status === 0 })
}

console.log(`\n${'='.repeat(64)}\nZusammenfassung:`)
for (const { suite, ok } of results) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${suite}`)
const failed = results.filter((r) => !r.ok)
console.log(failed.length === 0 ? `\nALLE ${results.length} SUITEN BESTANDEN` : `\n${failed.length}/${results.length} SUITEN FEHLGESCHLAGEN`)
process.exit(failed.length === 0 ? 0 : 1)
