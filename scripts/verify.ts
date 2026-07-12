/**
 * Parser-Verifikation gegen die echte Spielinstallation (Node, read-only):
 *   npx tsx scripts/verify.ts [Pfad-zur-Installation]
 *
 * Testet ZipArchive, parseScm, parseBlueprints und parseDds/decodeDxt gegen
 * ALLE Unit-Blueprints und -Meshes in units.scd.
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { parseScm } from '../src/formats/scm'
import { parseBlueprints, bpGet } from '../src/formats/blueprint'
import { parseDds } from '../src/formats/dds'
import { decodeDxt } from '../src/formats/dxt'

const GAME_DIR =
  process.argv[2] ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

class NodeFile implements RandomAccessFile {
  private constructor(
    private readonly fh: FileHandle,
    readonly size: number,
  ) {}

  static async open(path: string): Promise<NodeFile> {
    const fh = await open(path, 'r')
    const st = await fh.stat()
    return new NodeFile(fh, st.size)
  }

  async slice(start: number, end: number): Promise<ArrayBuffer> {
    const buf = Buffer.alloc(end - start)
    await this.fh.read(buf, 0, end - start, start)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
  }
}

let failures = 0

function check(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  OK   ${label}`)
  } else {
    failures++
    console.error(`  FAIL ${label}`)
  }
}

async function main(): Promise<void> {
  console.log(`Spielverzeichnis: ${GAME_DIR}\n`)

  console.log('== ZipArchive: units.scd ==')
  const unitsScd = await ZipArchive.open(await NodeFile.open(`${GAME_DIR}/gamedata/units.scd`))
  check(unitsScd.entries.size > 5000, `${unitsScd.entries.size} Einträge`)

  console.log('\n== SCM: UEL0001_LOD0 (Referenzwerte aus Datei-Header) ==')
  const acuEntry = unitsScd.get('units/UEL0001/UEL0001_LOD0.scm')
  check(!!acuEntry, 'Eintrag vorhanden')
  const acu = parseScm(await unitsScd.read(acuEntry!))
  check(acu.vertexCount === 5807, `vertexCount=${acu.vertexCount} (erwartet 5807)`)
  check(acu.indices.length === 10458, `indices=${acu.indices.length} (erwartet 10458)`)
  check(acu.bones.length === 29, `bones=${acu.bones.length} (erwartet 29)`)
  check(acu.weightedBoneCount === 19, `weightedBones=${acu.weightedBoneCount} (erwartet 19)`)
  check(
    acu.bones.some((b) => b.name === 'Torso') && acu.bones[0]?.name === 'UEL0001',
    `Bone-Namen: [${acu.bones.slice(0, 4).map((b) => b.name).join(', ')}…]`,
  )
  const maxIndex = acu.indices.reduce((a, b) => Math.max(a, b), 0)
  check(maxIndex < acu.vertexCount, `max. Index ${maxIndex} < vertexCount`)
  const finite = acu.positions.every((v) => Number.isFinite(v) && Math.abs(v) < 1000)
  check(finite, 'Positionen endlich und plausibel')
  const normLen = Math.hypot(acu.normals[0]!, acu.normals[1]!, acu.normals[2]!)
  check(Math.abs(normLen - 1) < 0.1, `Normale[0] Länge ≈ 1 (${normLen.toFixed(3)})`)

  console.log('\n== Blueprint: UEL0001_unit.bp ==')
  const bpText = new TextDecoder().decode(
    await unitsScd.read(unitsScd.get('units/UEL0001/UEL0001_unit.bp')!),
  )
  const bp = parseBlueprints(bpText)[0]!
  check(bp.__type === 'UnitBlueprint', `__type=${bp.__type}`)
  check(bpGet(bp, 'General.FactionName') === 'UEF', `FactionName=${bpGet(bp, 'General.FactionName')}`)
  check(typeof bpGet(bp, 'Defense.MaxHealth') === 'number', `MaxHealth=${bpGet(bp, 'Defense.MaxHealth')}`)
  check(typeof bpGet(bp, 'Economy.BuildCostMass') === 'number', `BuildCostMass=${bpGet(bp, 'Economy.BuildCostMass')}`)
  const targetBones = bpGet(bp, 'AI.TargetBones')
  check(Array.isArray(targetBones) && targetBones.includes('Head'), 'AI.TargetBones enthält "Head"')

  console.log('\n== DDS: UEL0001_Albedo ==')
  const dds = parseDds(await unitsScd.read(unitsScd.get('units/UEL0001/UEL0001_Albedo.dds')!))
  check(dds.width === 1024 && dds.height === 1024, `${dds.width}x${dds.height}`)
  check(dds.format === 'DXT5', `format=${dds.format}`)
  check(dds.mips.length === 11, `${dds.mips.length} Mips (erwartet 11)`)
  const smallMip = dds.mips[dds.mips.length - 1]!
  const rgba = decodeDxt(smallMip.data, smallMip.width, smallMip.height, 'DXT5')
  check(rgba.length === smallMip.width * smallMip.height * 4, 'DXT5-Dekodierung liefert RGBA')
  const mid = dds.mips[4]!
  const midRgba = decodeDxt(mid.data, mid.width, mid.height, 'DXT5')
  const avg = midRgba.filter((_, i) => i % 4 !== 3).reduce((a, b) => a + b, 0) / (midRgba.length * 0.75)
  check(avg > 10 && avg < 245, `Mip4 mittlere Helligkeit ${avg.toFixed(0)} (plausibel)`)

  console.log('\n== Alle Unit-Blueprints in units.scd ==')
  const bpPaths = [...unitsScd.entries.keys()].filter((p) => /_unit\.bp$/.test(p))
  let bpOk = 0
  const bpErrors: string[] = []
  for (const path of bpPaths) {
    try {
      const parsed = parseBlueprints(
        new TextDecoder().decode(await unitsScd.read(unitsScd.get(path)!)),
      )
      if (parsed[0]?.__type === 'UnitBlueprint') bpOk++
      else bpErrors.push(`${path}: __type=${parsed[0]?.__type}`)
    } catch (err) {
      bpErrors.push(`${path}: ${err instanceof Error ? err.message : err}`)
    }
  }
  check(bpOk === bpPaths.length, `${bpOk}/${bpPaths.length} Blueprints geparst`)
  for (const e of bpErrors.slice(0, 10)) console.error(`       ${e}`)

  console.log('\n== Alle LOD0-Meshes in units.scd ==')
  const scmPaths = [...unitsScd.entries.keys()].filter((p) => /_lod0\.scm$/.test(p))
  let scmOk = 0
  const scmErrors: string[] = []
  for (const path of scmPaths) {
    try {
      const m = parseScm(await unitsScd.read(unitsScd.get(path)!))
      const max = m.indices.reduce((a, b) => Math.max(a, b), 0)
      if (m.vertexCount > 0 && max < m.vertexCount) scmOk++
      else scmErrors.push(`${path}: verts=${m.vertexCount} maxIdx=${max}`)
    } catch (err) {
      scmErrors.push(`${path}: ${err instanceof Error ? err.message : err}`)
    }
  }
  check(scmOk === scmPaths.length, `${scmOk}/${scmPaths.length} Meshes geparst`)
  for (const e of scmErrors.slice(0, 10)) console.error(`       ${e}`)

  console.log(failures === 0 ? '\nALLE CHECKS BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
