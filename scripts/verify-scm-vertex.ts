/**
 * Die Feldreihenfolge im SCM-Vertex — Normale vor Tangente, nicht umgekehrt.
 *
 * Anlass: der Parser las `tangent` bei Offset 12 und `normal` bei Offset 24,
 * weil die GPG-Mod-SDK-Doku das so beschreibt. Die Doku ist falsch. Die
 * Vertex-Deklaration der Engine liegt wörtlich in ForgedAlliance.exe:
 *
 *   struct VS_MESHSOFTWAREINSTANCED{
 *       float4 Pos : POSITION;
 *       float3 Normal : NORMAL;
 *       float3 Tangent : TANGENT;
 *       float3 Binormal : BINORMAL;
 *       ...
 *
 * Folge des Fehlers: `normal` bekam die Tangente, `scmTangent` die Normale.
 * Beide landen ungefiltert in der TBN-Matrix von prop.vert.glsl und
 * buildFaction.vert.glsl — die Beleuchtung war also auf allen Meshes falsch,
 * ohne dass etwas sichtbar abstürzt.
 *
 * Geprüft wird gegen die Geometrie selbst, nicht gegen eine Doku: das
 * Kreuzprodukt der Dreieckskanten muss in dieselbe Richtung zeigen wie das
 * Normalenfeld. Zusätzlich müssen Tangente und Binormale senkrecht auf der
 * Normalen stehen — das trennt die drei Felder eindeutig voneinander, weil
 * nur eines davon mit der Flächennormalen korreliert.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-scm-vertex.ts
 */
import { GameFiles } from './gameFiles'
import { parseScm, type ScmModel } from '../src/formats/scm'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

/** Anteil der Dreiecke, deren Kanten-Kreuzprodukt mit `field` gleichgerichtet ist. */
function agreementWithWinding(m: ScmModel, field: Float32Array, maxTris = 4000): number {
  const triCount = Math.min(maxTris, Math.floor(m.indices.length / 3))
  let agree = 0
  let counted = 0
  for (let t = 0; t < triCount; t++) {
    const i0 = m.indices[t * 3]!
    const i1 = m.indices[t * 3 + 1]!
    const i2 = m.indices[t * 3 + 2]!
    const ax = m.positions[i1 * 3]! - m.positions[i0 * 3]!
    const ay = m.positions[i1 * 3 + 1]! - m.positions[i0 * 3 + 1]!
    const az = m.positions[i1 * 3 + 2]! - m.positions[i0 * 3 + 2]!
    const bx = m.positions[i2 * 3]! - m.positions[i0 * 3]!
    const by = m.positions[i2 * 3 + 1]! - m.positions[i0 * 3 + 1]!
    const bz = m.positions[i2 * 3 + 2]! - m.positions[i0 * 3 + 2]!
    const cx = ay * bz - az * by
    const cy = az * bx - ax * bz
    const cz = ax * by - ay * bx
    const len = Math.hypot(cx, cy, cz)
    if (len < 1e-12) continue // entartetes Dreieck
    // Gemittelte Eckwerte — Vertexnormalen sind interpoliert, die Flächennormale nicht.
    const fx = (field[i0 * 3]! + field[i1 * 3]! + field[i2 * 3]!) / 3
    const fy = (field[i0 * 3 + 1]! + field[i1 * 3 + 1]! + field[i2 * 3 + 1]!) / 3
    const fz = (field[i0 * 3 + 2]! + field[i1 * 3 + 2]! + field[i2 * 3 + 2]!) / 3
    const dot = (cx / len) * fx + (cy / len) * fy + (cz / len) * fz
    counted++
    if (dot > 0) agree++
  }
  return counted === 0 ? 0 : agree / counted
}

/** Anteil der Vertices, bei denen `field` senkrecht auf der Normalen steht. */
function perpendicularToNormal(m: ScmModel, field: Float32Array): number {
  let perp = 0
  let counted = 0
  for (let i = 0; i < m.vertexCount; i++) {
    const nx = m.normals[i * 3]!
    const ny = m.normals[i * 3 + 1]!
    const nz = m.normals[i * 3 + 2]!
    const fx = field[i * 3]!
    const fy = field[i * 3 + 1]!
    const fz = field[i * 3 + 2]!
    const ln = Math.hypot(nx, ny, nz)
    const lf = Math.hypot(fx, fy, fz)
    if (ln < 1e-6 || lf < 1e-6) continue
    counted++
    if (Math.abs((nx * fx + ny * fy + nz * fz) / (ln * lf)) < 0.25) perp++
  }
  return counted === 0 ? 0 : perp / counted
}

// Quer durch alle vier Fraktionen und alle Größenklassen: T1-Panzer (465
// Vertices) bis Monkeylord (10710), dazu ein Gebäude und ein Bot.
const UNITS = [
  'units/UEL0201/UEL0201_LOD0.scm',
  'units/UAL0201/UAL0201_LOD0.scm',
  'units/URL0402/URL0402_LOD0.scm',
  'units/XSL0401/XSL0401_LOD0.scm',
  'units/UEB1101/UEB1101_LOD0.scm',
  'units/UEL0301/UEL0301_LOD0.scm',
]

const game = await GameFiles.open()

console.log('\n== SCM-Vertexlayout: Normale bei Offset 12 ==')
for (const path of UNITS) {
  const key = [...game.paths].find((p) => p.toLowerCase() === path.toLowerCase())
  if (!key) {
    check(false, `${path} — nicht im Archiv gefunden`)
    continue
  }
  const m = parseScm(await game.read(key))
  const id = path.split('/')[1]!

  const nAgree = agreementWithWinding(m, m.normals)
  check(
    nAgree > 0.99,
    `${id.padEnd(8)} normals folgen dem Winding: ${(nAgree * 100).toFixed(1)}% (erwartet >99%)`,
  )

  // Gegenprobe: Tangente und Binormale dürfen NICHT mit der Flächennormalen
  // korrelieren. Täten sie es, läge das Normalenfeld am falschen Offset.
  const tAgree = agreementWithWinding(m, m.tangents)
  check(
    tAgree > 0.3 && tAgree < 0.7,
    `${id.padEnd(8)} tangents korrelieren nicht mit dem Winding: ${(tAgree * 100).toFixed(1)}% (erwartet ~50%)`,
  )

  const tPerp = perpendicularToNormal(m, m.tangents)
  const bPerp = perpendicularToNormal(m, m.binormals)
  check(tPerp > 0.9, `${id.padEnd(8)} tangent ⟂ normal bei ${(tPerp * 100).toFixed(1)}% der Vertices`)
  check(bPerp > 0.9, `${id.padEnd(8)} binormal ⟂ normal bei ${(bPerp * 100).toFixed(1)}% der Vertices`)
}

console.log(failures === 0 ? '\nAlle Prüfungen bestanden.' : `\n${failures} Prüfung(en) fehlgeschlagen.`)
process.exit(failures === 0 ? 0 : 1)
