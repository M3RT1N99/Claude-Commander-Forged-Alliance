/**
 * DER AUFGABEN-LEDGER — „erledigt" ist eine Aussage, die widerlegt werden kann.
 *
 * Anthropic beschreibt für langlaufende Agents eine maschinenlesbare Feature-
 * Liste, an der nur der Status geändert werden darf ("Effective harnesses for
 * long-running agents"). `specs/<spec>/tasks.md` WAR das bereits — aber als Prosa
 * ohne Prüfung. Genau deshalb konnten in einer einzigen Sitzung vier Tasks als
 * erledigt markiert werden, ohne es zu sein:
 *
 *   T021  abgehakt, obwohl der IssueStop/IssueClearCommands-Split nie gemacht wurde
 *   T010  „Verified by verify-splash-damage.ts" — die Datei enthält kein Wort „shield"
 *   T031  behauptete, combo.lua/orders.lua seien geprüft — sie werden nie instanziiert
 *   T034  „Verified by verify-maui-control-state.ts" — die Datei wurde nie erweitert
 *
 * Alle vier standen hinter einem grünen 53/53-Gate. Dieses Skript macht sie rot.
 *
 * Geprüft wird auf STORY-Ebene (`### USn — …`), nicht je Einzeltask: eine Story
 * besteht aus Implementierungsschritten plus einer Prüf-Task, und die Prüfung
 * gehört der Gruppe.
 *
 *   1. Jede Story mit mindestens einer `[x]`-Task muss eine Prüfung nennen
 *      (`*Verified by*:` oder `check:`) — sonst ist „erledigt" unbelegt.
 *   2. Jede genannte Datei muss existieren.
 *   3. Nennt die Story `asserts:`-Marken, muss JEDE dieser Marken in der
 *      Ausgabe der Suite als bestandener Check auftauchen. Das ist der Teil,
 *      der T010/T031/T034 fängt: die Datei existiert und ist grün, aber sie
 *      prüft die behauptete Sache nicht.
 *
 * Stories, die zwar eine Suite nennen, aber keine `asserts:`-Marke, sind
 * SCHWACH belegt. Ihre Zahl ist gegen eine eingecheckte Obergrenze gedeckelt
 * (`specs/.task-ledger-baseline.json`), damit sie nicht wieder wächst.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-tasks.ts
 */
import { readFileSync, existsSync, readdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)
const specsDir = join(root, 'specs')
const baselinePath = join(specsDir, '.task-ledger-baseline.json')

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

interface Story {
  spec: string
  title: string
  doneTasks: string[]
  openTasks: string[]
  suites: string[]
  asserts: string[]
  /** `check: none — <Grund>`: bewusst ohne laufende Pruefung, mit Begruendung. */
  noneReason: string | null
}

/** Eine tasks.md in Stories zerlegen. Alles vor der ersten `###` gehört zu einer
 *  Pseudo-Story „(Datei-Kopf)", damit auch dort abgehakte Tasks erfasst werden. */
function parseTasks(specName: string, text: string): Story[] {
  const lines = text.replace(/\r/g, '').split('\n')
  const stories: Story[] = []
  let cur: Story = { spec: specName, title: '(file header)', doneTasks: [], openTasks: [], suites: [], asserts: [], noneReason: null }
  const push = (): void => {
    if (cur.doneTasks.length || cur.openTasks.length) stories.push(cur)
  }
  for (const line of lines) {
    const head = /^#{2,3}\s+(.*\S)\s*$/.exec(line)
    if (head) {
      push()
      cur = { spec: specName, title: head[1]!, doneTasks: [], openTasks: [], suites: [], asserts: [], noneReason: null }
      continue
    }
    const task = /^- \[([ x])\]\s+(T\d+)/.exec(line)
    if (task) {
      if (task[1] === 'x') cur.doneTasks.push(task[2]!)
      else cur.openTasks.push(task[2]!)
    }
    // Suiten-Nennungen: `*Verified by*: ...` oder `check: ...`
    if (/\*Verified by\*|(^|\s)check:/i.test(line)) {
      // `check-*.ts` zählt seit T023 mit: die vier waren Diagnosen, jetzt sind
      // sie Gates und laufen in `npm test`.
      for (const m of line.matchAll(/(?:scripts\/)?((?:verify|check)-[A-Za-z0-9-]+\.ts)/g)) {
        if (!cur.suites.includes(m[1]!)) cur.suites.push(m[1]!)
      }
    }
    const none = /^\s*check:\s*none\s*[—-]+\s*(.+?)\s*$/i.exec(line)
    if (none) cur.noneReason = none[1]!
    const a = /^\s*asserts:\s*(.+?)\s*$/.exec(line)
    if (a) cur.asserts.push(a[1]!.replace(/^["']|["']$/g, ''))
  }
  push()
  return stories
}

const specDirs = existsSync(specsDir)
  ? readdirSync(specsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  : []

const stories: Story[] = []
for (const s of specDirs) {
  const p = join(specsDir, s, 'tasks.md')
  if (existsSync(p)) stories.push(...parseTasks(s, readFileSync(p, 'utf-8')))
}

console.log(`\n== Aufgaben-Ledger: ${stories.length} Stories aus ${specDirs.length} Specs ==`)

// ── 1+2: jede erledigte Story nennt eine EXISTIERENDE Prüfung ───────────────
const doneStories = stories.filter((s) => s.doneTasks.length > 0)
console.log(`\n== Jede erledigte Story nennt eine Prüfung, und die Datei existiert ==`)
const weak: Story[] = []
const byConstruction: Story[] = []
for (const s of doneStories) {
  const id = `${s.spec} · ${s.title}`
  if (s.suites.length === 0) {
    // `check: none — <Grund>` ist zulaessig, aber sichtbar: es sagt aus, dass
    // diese Story per Konstruktion nicht laufend geprueft werden kann.
    if (s.noneReason) {
      console.log(`  ohne laufende Prüfung: ${id} — ${s.noneReason}`)
      byConstruction.push(s)
      continue
    }
    check(false, `${id}: ${s.doneTasks.length} Task(s) abgehakt, aber KEINE Prüfung genannt (${s.doneTasks.join(', ')})`)
    continue
  }
  for (const suite of s.suites) {
    check(existsSync(join(here, suite)), `${id}: nennt ${suite}`)
  }
  if (s.asserts.length === 0) weak.push(s)
}

// ── 3: die genannten Marken müssen in der Suite-Ausgabe wirklich vorkommen ──
//
// Eine Story darf mehrere Suiten nennen; die Marke muss in IRGENDEINER davon
// als bestandener Check auftauchen. Früher zählte nur `suites[0]`, was eine
// Story mit vier Gates stillschweigend auf das erste reduzierte.
//
// Die Suiten laufen LAZY und werden zwischengespeichert: steht die schnelle
// vorn, werden die langsamen gar nicht erst gestartet.
const ausgabe = new Map<string, string>()
const laufen = (suite: string): string => {
  const da = ausgabe.get(suite)
  if (da !== undefined) return da
  let out = ''
  try {
    out = execFileSync(
      'npx',
      ['tsx', '--import', './scripts/register-lua.mjs', `scripts/${suite}`],
      { cwd: root, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], shell: true },
    )
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string }
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`
    check(false, `${suite}: Suite läuft nicht durch — eine abgehakte Story stützt sich darauf`)
  }
  ausgabe.set(suite, out)
  return out
}

const mitMarken = doneStories.filter((s) => s.asserts.length > 0 && s.suites.length > 0)
if (mitMarken.length > 0) {
  console.log(`\n== Die behaupteten Prüfungen kommen in der Suite wirklich vor ==`)
  for (const story of mitMarken) {
    for (const label of story.asserts) {
      // Die Marke muss als BESTANDENER Check auftauchen, nicht irgendwo im Text.
      let treffer: string | null = null
      for (const suite of story.suites) {
        if (laufen(suite).split('\n').some((l) => l.includes('OK') && l.includes(label))) {
          treffer = suite
          break
        }
      }
      check(
        treffer !== null,
        treffer !== null
          ? `${treffer} enthält „${label}" (${story.title})`
          : `KEINE der Suiten ${story.suites.join(', ')} enthält „${label}" (${story.title})`,
      )
    }
  }
}

// ── Schwach belegte Stories deckeln, damit sie nicht wieder wachsen ─────────
console.log(`\n== Schwach belegte Stories (Suite genannt, aber keine asserts:-Marke) ==`)
const baseline = existsSync(baselinePath)
  ? (JSON.parse(readFileSync(baselinePath, 'utf-8')) as { maxWeakStories: number })
  : null
if (!baseline) {
  writeFileSync(baselinePath, `${JSON.stringify({ maxWeakStories: weak.length }, null, 2)}\n`)
  console.log(`  Baseline angelegt: ${weak.length} (specs/.task-ledger-baseline.json)`)
} else {
  for (const s of weak) console.log(`  · ${s.spec} · ${s.title}`)
  check(
    weak.length <= baseline.maxWeakStories,
    `${weak.length} schwach belegt (Obergrenze ${baseline.maxWeakStories}) — eine neue Story ohne asserts: ist nicht zulässig`,
  )
  if (weak.length < baseline.maxWeakStories) {
    console.log(`  (Die Obergrenze darf auf ${weak.length} gesenkt werden.)`)
  }
}

console.log(failures === 0 ? '\nAUFGABEN-LEDGER BESTANDEN' : `\nAUFGABEN-LEDGER: ${failures} FEHLER`)
process.exit(failures === 0 ? 0 : 1)
