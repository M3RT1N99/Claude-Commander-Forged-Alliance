/**
 * LÖST DER ECHTE LADER JEDE EINHEIT AUF? — MIT SPERRKLINKE.
 *
 * Ob eine Einheit im Spiel sichtbar wird, entscheidet
 * [`resolveUnitPaths`](../src/formats/unitPaths.ts): aus dem Blueprint kommt
 * `Display.MeshBlueprint`, daraus der Mesh-Pfad, daraus die Texturen — mit
 * Sonderfällen für `<none>`, für `Display.PlaceholderMeshName` (Kampagne) und
 * für LOD-Overrides. Findet der Lader nichts, steht die Einheit unsichtbar da.
 *
 * Dieses Skript war eine Diagnose mit einer EIGENEN Kopie dieser Logik, und die
 * Kopie war der eigentliche Fehler: sie prüfte `<id>_lod0.scm` und
 * `<id>_albedo.dds` von Hand. Damit konnte sie fröhlich grün melden, während
 * der echte Lader danebenlag — oder umgekehrt. CLAUDE.md nennt genau das:
 * es gibt EINE massgebliche Darstellung, alles andere ist Projektion, und wenn
 * zwei Leser sich widersprechen, ist die Prüfung fehlgeschlagen.
 *
 * Jetzt ruft es den echten Lader über jedes Unit-Blueprint der Installation.
 *
 * Das Ergebnis ist KEIN „alle Einheiten lösen auf" — das wäre falsch: manche
 * Blueprints sind Hüllen ohne Modell, und `Display.MeshBlueprint = '<none>'`
 * ist eine gültige Antwort. Deshalb eine SPERRKLINKE: die eingecheckte Zahl in
 * `scripts/fixtures/unit-assets-baseline.json` darf steigen, aber nie fallen.
 * Wer den Lader kaputt macht, sieht es sofort; wer ihn verbessert, zieht die
 * Zahl mit demselben Commit nach.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/check-unit-assets.ts
 *   npx tsx --import ./scripts/register-lua.mjs scripts/check-unit-assets.ts --update
 */
import { open, type FileHandle } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { parseBlueprints, type BpObject } from '../src/formats/blueprint'
import { resolveUnitPaths } from '../src/formats/unitPaths'

class NodeFile implements RandomAccessFile {
  private constructor(
    private readonly fh: FileHandle,
    readonly size: number,
  ) {}
  static async open(p: string): Promise<NodeFile> {
    const fh = await open(p, 'r')
    return new NodeFile(fh, (await fh.stat()).size)
  }
  async slice(s: number, e: number): Promise<ArrayBuffer> {
    const b = Buffer.alloc(e - s)
    await this.fh.read(b, 0, e - s, s)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  }
  close(): Promise<void> {
    return this.fh.close()
  }
}

const GAME =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

const update = process.argv.includes('--update')
const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'unit-assets-baseline.json',
)

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const unitsFile = await NodeFile.open(`${GAME}/gamedata/units.scd`)
const texFile = await NodeFile.open(`${GAME}/gamedata/textures.scd`)
const units = await ZipArchive.open(unitsFile)
const textures = await ZipArchive.open(texFile)
const exists = (p: string): boolean => !!(units.get(p) ?? textures.get(p))

const bpPaths = [...units.entries.keys()]
  .filter((p) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(p))
  .sort()

console.log(`\n== ${bpPaths.length} Unit-Blueprints ==`)

let aufgeloest = 0
let ohneModell = 0 // MeshBlueprint '<none>' — eine gueltige Antwort, kein Fehler
let mitAlbedo = 0
let unlesbar = 0
const fehlend: string[] = []

for (const path of bpPaths) {
  const id = path.split('/')[1]
  const entry = units.get(path)
  if (!id || !entry) {
    unlesbar++
    continue
  }
  let bp: BpObject | undefined
  try {
    bp = parseBlueprints(new TextDecoder().decode(await units.read(entry)))[0]
  } catch {
    unlesbar++
    continue
  }
  if (!bp) {
    unlesbar++
    continue
  }

  const paths = resolveUnitPaths(id, bp, exists)
  if (!paths) {
    // Der Lader unterscheidet selbst: '<none>' heisst „diese Einheit hat kein
    // Modell", alles andere heisst „gefunden habe ich keins". Nur das Zweite
    // ist ein Fund.
    if (bp.Display && (bp.Display as BpObject).MeshBlueprint === '<none>') ohneModell++
    else fehlend.push(id)
    continue
  }
  aufgeloest++
  // `albedo` ist eine LISTE von Kandidatenpfaden (unitPaths.ts:19) — der Lader
  // nimmt den ersten, den es gibt.
  if (paths.albedo.some(exists)) mitAlbedo++
}

await unitsFile.close()
await texFile.close()

console.log(
  `  ${aufgeloest} aufgelöst · ${mitAlbedo} davon mit Albedo · ` +
    `${ohneModell} bewusst ohne Modell ('<none>') · ${fehlend.length} ohne Fund · ${unlesbar} unlesbar`,
)
if (fehlend.length > 0) {
  console.log(`  ohne Fund: ${fehlend.slice(0, 15).join(', ')}${fehlend.length > 15 ? ' …' : ''}`)
}

interface Fixture {
  resolved: number
  withAlbedo: number
  total: number
  note: string
}

// Eine leere Installation darf nie als „bestanden" durchgehen.
check(bpPaths.length > 500, `${bpPaths.length} Blueprints gelesen (mehr als 500 erwartet)`)
check(unlesbar === 0, `kein unlesbares Blueprint (${unlesbar})`)

if (update || !existsSync(fixture)) {
  mkdirSync(dirname(fixture), { recursive: true })
  const f: Fixture = {
    resolved: aufgeloest,
    withAlbedo: mitAlbedo,
    total: bpPaths.length,
    note:
      'Sperrklinke über den ECHTEN Lader (resolveUnitPaths). Die Zahlen dürfen '
      + 'steigen, nie fallen. Steigen sie, mit --update und im selben Commit '
      + 'nachziehen, der die Verbesserung bringt.',
  }
  writeFileSync(fixture, `${JSON.stringify(f, null, 2)}\n`)
  console.log(`  ${update ? 'Sperrklinke NEU GESETZT' : 'Sperrklinke angelegt'}`)
} else {
  const f = JSON.parse(readFileSync(fixture, 'utf-8')) as Fixture
  check(
    aufgeloest >= f.resolved,
    `${aufgeloest} Einheiten lösen auf (Sperrklinke ${f.resolved})` +
      (aufgeloest < f.resolved ? ' — der Lader findet WENIGER als vorher' : ''),
  )
  check(
    mitAlbedo >= f.withAlbedo,
    `${mitAlbedo} davon mit vorhandener Albedo (Sperrklinke ${f.withAlbedo})` +
      (mitAlbedo < f.withAlbedo ? ' — es sind WENIGER als vorher' : ''),
  )
  if (aufgeloest > f.resolved || mitAlbedo > f.withAlbedo) {
    console.log(
      `  besser als die Sperrklinke (${f.resolved}/${f.withAlbedo}) — mit --update nachziehen`,
    )
  }
}

console.log(failures === 0 ? '\nUNIT-ASSETS BESTANDEN' : `\nUNIT-ASSETS: ${failures} FEHLER`)
process.exit(failures === 0 ? 0 : 1)
