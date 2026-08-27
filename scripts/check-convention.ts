/**
 * DIE SCM-KONVENTION IST EINE ANNAHME IM CODE — HIER WIRD SIE GEPRÜFT.
 *
 * Zwei Dinge an einem SCM-Knochen sind nicht selbsterklärend:
 *
 *   * ist `restPoseInverse` spalten- oder zeilenweise abgelegt, und
 *   * steht die Rotation als `[w,x,y,z]` oder `[x,y,z,w]`?
 *
 * Das Kriterium ist hart und stammt aus der Sache selbst: die Bindepose mal
 * ihrer Inversen muss die Einheitsmatrix ergeben. `bindWorld(bone) *
 * restPoseInverse(bone) == I` gilt genau für die richtige Kombination.
 *
 * Dieses Skript hat die Konvention ursprünglich ERMITTELT und die vier
 * Kombinationen nur ausgegeben — ein Mensch hat die Zahlen gelesen und
 * entschieden. Seitdem steht die Antwort als Annahme im Code
 * ([scm.ts:24-26](../src/formats/scm.ts): „column-major as in D3D",
 * Quaternion `w,x,y,z`) und wird ungeprüft benutzt
 * ([animator.ts:61](../src/anim/animator.ts): `fromArray` OHNE Transponieren).
 *
 * Damit ist es kein Erkundungswerkzeug mehr, sondern ein Wächter. Es prüft:
 *
 *   1. genau EINE der vier Kombinationen liefert die Einheitsmatrix,
 *   2. es ist die, die der Code annimmt (`wxyz` + `colMajor`), und
 *   3. die drei anderen liegen deutlich daneben.
 *
 * Punkt 3 ist der Teil, der das Ganze zu einer Prüfung macht: ohne ihn würde
 * die Suite auch dann grün melden, wenn die Daten gar nicht mehr
 * unterscheidbar wären.
 *
 * Ändert jemand die Feldversätze oder die Rotationsreihenfolge in `scm.ts`,
 * geht das hier rot — und zwar an der Ursache, nicht drei Schichten später an
 * einer verdrehten Animation.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/check-convention.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { parseScm } from '../src/formats/scm'

class NodeFile implements RandomAccessFile {
  private constructor(
    private readonly fh: FileHandle,
    readonly size: number,
  ) {}
  static async open(path: string): Promise<NodeFile> {
    const fh = await open(path, 'r')
    return new NodeFile(fh, (await fh.stat()).size)
  }
  async slice(start: number, end: number): Promise<ArrayBuffer> {
    const buf = Buffer.alloc(end - start)
    await this.fh.read(buf, 0, end - start, start)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }
  close(): Promise<void> {
    return this.fh.close()
  }
}

const GAME =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

type QuatOrder = 'wxyz' | 'xyzw'
type MatOrder = 'colMajor' | 'rowMajor'

/** Grösster Abstand von der Einheitsmatrix über alle Knochen eines Modells. */
function maxIdentityError(
  bones: ReturnType<typeof parseScm>['bones'],
  quatOrder: QuatOrder,
  matOrder: MatOrder,
): number {
  const worlds: Matrix4[] = []
  let maxErr = 0
  for (const b of bones) {
    const [r0, r1, r2, r3] = b.rotation
    const q =
      quatOrder === 'wxyz'
        ? new Quaternion(r1, r2, r3, r0) // gespeichert w,x,y,z
        : new Quaternion(r0, r1, r2, r3) // gespeichert x,y,z,w
    const local = new Matrix4().compose(new Vector3(...b.position), q, new Vector3(1, 1, 1))
    const parent = worlds[b.parent]
    const world = b.parent >= 0 && parent ? new Matrix4().multiplyMatrices(parent, local) : local
    worlds.push(world)

    const inv = new Matrix4().fromArray(b.restPoseInverse)
    if (matOrder === 'rowMajor') inv.transpose()
    const e = new Matrix4().multiplyMatrices(world, inv).elements
    for (let k = 0; k < 16; k++) {
      maxErr = Math.max(maxErr, Math.abs((e[k] ?? 0) - (k % 5 === 0 ? 1 : 0)))
    }
  }
  return maxErr
}

// Mehr als ein Modell: eine Konvention, die nur an der ACU aufgeht, ist keine.
// Kommandant, Panzer, Ingenieur, Fabrik, Flugzeug — unterschiedliche Skelette,
// unterschiedliche Tiefe der Knochenhierarchie.
const MODELLE = [
  'units/UEL0001/UEL0001_LOD0.scm',
  'units/UEL0201/UEL0201_LOD0.scm',
  'units/UEL0101/UEL0101_LOD0.scm',
  'units/UEB0101/UEB0101_LOD0.scm',
  'units/UEA0101/UEA0101_LOD0.scm',
]

// Die Kombination, die der Code annimmt: scm.ts:24 („column-major as in D3D")
// und scm.ts:26 (Quaternion w,x,y,z); animator.ts:61 lädt mit `fromArray` und
// transponiert NICHT — das ist `colMajor`.
const ERWARTET: { quat: QuatOrder; mat: MatOrder } = { quat: 'wxyz', mat: 'colMajor' }
const TOLERANZ = 1e-3 // float32-Rundung über eine tiefe Knochenkette
const UNTERSCHEIDBAR = 0.1 // so weit müssen die falschen Kombinationen daneben liegen

const file = await NodeFile.open(`${GAME}/gamedata/units.scd`)
const zip = await ZipArchive.open(file)

let geprueft = 0
for (const pfad of MODELLE) {
  const entry = zip.get(pfad)
  if (!entry) {
    check(false, `${pfad} fehlt im Archiv`)
    continue
  }
  const scm = parseScm(await zip.read(entry))
  const name = pfad.split('/')[1] ?? pfad

  const ergebnis: { quat: QuatOrder; mat: MatOrder; err: number }[] = []
  for (const quat of ['wxyz', 'xyzw'] as const) {
    for (const mat of ['colMajor', 'rowMajor'] as const) {
      ergebnis.push({ quat, mat, err: maxIdentityError(scm.bones, quat, mat) })
    }
  }
  ergebnis.sort((a, b) => a.err - b.err)
  const beste = ergebnis[0]
  const zweite = ergebnis[1]
  if (!beste || !zweite) {
    check(false, `${name}: keine Ergebnisse`)
    continue
  }

  console.log(
    `\n== ${name} (${scm.bones.length} Knochen) ==\n  ` +
      ergebnis.map((e) => `${e.quat}/${e.mat}=${e.err.toExponential(2)}`).join('  '),
  )
  check(
    beste.err < TOLERANZ,
    `${name}: beste Kombination trifft die Einheitsmatrix (${beste.err.toExponential(2)} < ${TOLERANZ})`,
  )
  check(
    beste.quat === ERWARTET.quat && beste.mat === ERWARTET.mat,
    `${name}: es ist ${ERWARTET.quat}/${ERWARTET.mat} — die Annahme in scm.ts:24-26 (gemessen: ${beste.quat}/${beste.mat})`,
  )
  // Ohne diese Zeile wäre die Prüfung wertlos: sie meldete auch dann Erfolg,
  // wenn alle vier Kombinationen gleich gut (oder gleich schlecht) wären.
  check(
    zweite.err > UNTERSCHEIDBAR,
    `${name}: die zweitbeste liegt deutlich daneben (${zweite.err.toExponential(2)} > ${UNTERSCHEIDBAR}) — die Messung unterscheidet wirklich`,
  )
  geprueft++
}

await file.close()

console.log('')
check(geprueft === MODELLE.length, `alle ${MODELLE.length} Modelle geprüft (${geprueft})`)
console.log(
  failures === 0 ? '\nSCM-KONVENTION BESTÄTIGT' : `\nSCM-KONVENTION: ${failures} FEHLER`,
)
process.exit(failures === 0 ? 0 : 1)
