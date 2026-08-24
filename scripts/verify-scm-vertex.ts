/**
 * The field order inside the SCM vertex — normal before tangent, not the other
 * way round.
 *
 * Background: the parser read `tangent` at offset 12 and `normal` at offset 24,
 * because the GPG mod SDK documentation says so. The documentation is wrong.
 * The engine's own vertex declaration sits verbatim in ForgedAlliance.exe:
 *
 *   struct VS_MESHSOFTWAREINSTANCED{
 *       float4 Pos : POSITION;
 *       float3 Normal : NORMAL;
 *       float3 Tangent : TANGENT;
 *       float3 Binormal : BINORMAL;
 *       ...
 *
 * Effect of the bug: `normal` received the tangent and `scmTangent` the normal.
 * Both feed unfiltered into the TBN matrix in prop.vert.glsl and
 * buildFaction.vert.glsl, so lighting was wrong on every mesh without anything
 * visibly failing.
 *
 * This checks against the geometry itself, not against documentation: the cross
 * product of the triangle edges must point the same way as the normal field.
 * On top of that, tangent and binormal must be perpendicular to the normal —
 * that separates the three fields unambiguously, because only one of them
 * correlates with the face normal.
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

/** Fraction of triangles whose edge cross product points the same way as `field`. */
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
    if (len < 1e-12) continue // degenerate triangle
    // Average the corner values — vertex normals are interpolated, the face
    // normal is not.
    const fx = (field[i0 * 3]! + field[i1 * 3]! + field[i2 * 3]!) / 3
    const fy = (field[i0 * 3 + 1]! + field[i1 * 3 + 1]! + field[i2 * 3 + 1]!) / 3
    const fz = (field[i0 * 3 + 2]! + field[i1 * 3 + 2]! + field[i2 * 3 + 2]!) / 3
    const dot = (cx / len) * fx + (cy / len) * fy + (cz / len) * fz
    counted++
    if (dot > 0) agree++
  }
  return counted === 0 ? 0 : agree / counted
}

/** Fraction of vertices where `field` is perpendicular to the normal. */
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

// Across all four factions and every size class: T1 tank (465 vertices) up to
// the Monkeylord (10,710), plus a building and a bot.
const UNITS = [
  'units/UEL0201/UEL0201_LOD0.scm',
  'units/UAL0201/UAL0201_LOD0.scm',
  'units/URL0402/URL0402_LOD0.scm',
  'units/XSL0401/XSL0401_LOD0.scm',
  'units/UEB1101/UEB1101_LOD0.scm',
  'units/UEL0301/UEL0301_LOD0.scm',
]

const game = await GameFiles.open()

console.log('\n== SCM vertex layout: normal at offset 12 ==')
for (const path of UNITS) {
  const key = [...game.paths].find((p) => p.toLowerCase() === path.toLowerCase())
  if (!key) {
    check(false, `${path} — not found in the archives`)
    continue
  }
  const m = parseScm(await game.read(key))
  const id = path.split('/')[1]!

  const nAgree = agreementWithWinding(m, m.normals)
  check(
    nAgree > 0.99,
    `${id.padEnd(8)} normals follow the winding: ${(nAgree * 100).toFixed(1)}% (expected >99%)`,
  )

  // Counter-check: tangent and binormal must NOT correlate with the face
  // normal. If they did, the normal field would be at the wrong offset.
  const tAgree = agreementWithWinding(m, m.tangents)
  check(
    tAgree > 0.3 && tAgree < 0.7,
    `${id.padEnd(8)} tangents do not correlate with the winding: ${(tAgree * 100).toFixed(1)}% (expected ~50%)`,
  )

  const tPerp = perpendicularToNormal(m, m.tangents)
  const bPerp = perpendicularToNormal(m, m.binormals)
  check(tPerp > 0.9, `${id.padEnd(8)} tangent perpendicular to normal on ${(tPerp * 100).toFixed(1)}% of vertices`)
  check(bPerp > 0.9, `${id.padEnd(8)} binormal perpendicular to normal on ${(bPerp * 100).toFixed(1)}% of vertices`)
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
