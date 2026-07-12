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
import { parseSca } from '../src/formats/sca'
import { resolveUnitPaths } from '../src/formats/unitPaths'
import { UnitAnimator } from '../src/anim/animator'
import { Matrix4 } from 'three'
import { parseScmap } from '../src/formats/scmap'
import { SimWorld, type UnitStats } from '../src/sim/simWorld'
import { parseLuaAssignments, bpGet as bpGetPath } from '../src/formats/blueprint'
import { readdir, readFile } from 'node:fs/promises'

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

  console.log('\n== Asset-Auflösung aller Units (Mesh + Albedo) ==')
  const envArc = await ZipArchive.open(await NodeFile.open(`${GAME_DIR}/gamedata/env.scd`))
  const texArc = await ZipArchive.open(await NodeFile.open(`${GAME_DIR}/gamedata/textures.scd`))
  const meshArc = await ZipArchive.open(await NodeFile.open(`${GAME_DIR}/gamedata/meshes.scd`))
  const inAnyArchive = (p: string): boolean =>
    !!(unitsScd.get(p) ?? envArc.get(p) ?? texArc.get(p) ?? meshArc.get(p))
  let resolved = 0
  let noMesh = 0
  const unresolved: string[] = []
  for (const path of bpPaths) {
    const id = path.split('/')[1]!
    try {
      const bp = parseBlueprints(
        new TextDecoder().decode(await unitsScd.read(unitsScd.get(path)!)),
      )[0]!
      const paths = resolveUnitPaths(id, bp, inAnyArchive)
      if (!paths) {
        noMesh++
        continue
      }
      if (inAnyArchive(paths.mesh) && paths.albedo.some(inAnyArchive)) resolved++
      else {
        unresolved.push(
          `${id}: mesh=${inAnyArchive(paths.mesh) ? 'ok' : paths.mesh} albedo=${
            paths.albedo.some(inAnyArchive) ? 'ok' : paths.albedo[0]
          }`,
        )
      }
    } catch {
      unresolved.push(`${id}: bp-Fehler`)
    }
  }
  check(
    unresolved.length <= 2,
    `${resolved} aufgelöst, ${noMesh} bewusst ohne Mesh, ${unresolved.length} unauflösbar`,
  )
  for (const e of unresolved.slice(0, 10)) console.error(`       ${e}`)

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

  console.log('\n== SCA: Skinning-Konvention (Bindpose × restPoseInverse = I) ==')
  const animator = new UnitAnimator(acu)
  let bindErr = 0
  const identity = new Matrix4()
  for (const m of animator.skinMatrices) {
    for (let k = 0; k < 16; k++) {
      bindErr = Math.max(bindErr, Math.abs(m.elements[k]! - identity.elements[k]!))
    }
  }
  check(bindErr < 1e-4, `Bindpose-Skin-Matrizen ≈ Identität (maxErr=${bindErr.toExponential(2)})`)

  const walkAnim = parseSca(await unitsScd.read(unitsScd.get('units/UEL0001/UEL0001_A002.sca')!))
  check(walkAnim.numFrames > 10, `A002: ${walkAnim.numFrames} Frames, ${walkAnim.duration.toFixed(2)}s`)
  check(
    walkAnim.boneNames.length > 0 && walkAnim.boneNames.every((n) => n.length > 0),
    `A002: ${walkAnim.boneNames.length} Bones benannt`,
  )
  animator.setAnimation(walkAnim, acu.bones.map((b) => b.name))
  animator.update(walkAnim.duration * 0.35)
  let movedBones = 0
  let allFinite = true
  for (const m of animator.skinMatrices) {
    let diff = 0
    for (let k = 0; k < 16; k++) {
      if (!Number.isFinite(m.elements[k]!)) allFinite = false
      diff = Math.max(diff, Math.abs(m.elements[k]! - identity.elements[k]!))
    }
    if (diff > 0.01) movedBones++
  }
  check(allFinite, 'Animierte Skin-Matrizen endlich')
  check(movedBones >= 5, `${movedBones} Bones bewegen sich in A002-Pose`)

  console.log('\n== Alle SCA-Animationen in units.scd ==')
  const scaPaths = [...unitsScd.entries.keys()].filter((p) => p.endsWith('.sca'))
  let scaOk = 0
  const scaErrors: string[] = []
  for (const path of scaPaths) {
    try {
      const a = parseSca(await unitsScd.read(unitsScd.get(path)!))
      if (a.numFrames > 0 && a.boneNames.length > 0 && Number.isFinite(a.duration)) scaOk++
      else scaErrors.push(`${path}: frames=${a.numFrames} bones=${a.boneNames.length}`)
    } catch (err) {
      scaErrors.push(`${path}: ${err instanceof Error ? err.message : err}`)
    }
  }
  check(scaOk === scaPaths.length, `${scaOk}/${scaPaths.length} Animationen geparst`)
  for (const e of scaErrors.slice(0, 10)) console.error(`       ${e}`)

  console.log('\n== Sim-Kern: Determinismus & Bewegung ==')
  const testStats: UnitStats = {
    blueprintId: 'test',
    maxSpeed: Math.fround(3.4),
    turnRate: 120,
    acceleration: 3,
    brake: 3,
    arriveRadius: Math.fround(0.6),
    maxHealth: 300,
    massProduction: 0,
    energyProduction: 0,
    massConsumption: 0,
    energyConsumption: 0,
    massStorage: 0,
    energyStorage: 0,
    buildCostMass: 50,
    buildCostEnergy: 250,
    buildTime: 100,
  }
  const runSim = (): number[] => {
    const w = new SimWorld()
    const a = w.spawn(testStats, 10, 10)
    const b = w.spawn(testStats, 20, 15, 1.5)
    w.issueMove(a, 80, 60)
    w.issueMove(b, 15, 70)
    w.issueMove(b, 60, 20, true)
    for (let i = 0; i < 500; i++) {
      w.tick()
      if (i === 100) w.issueMove(a, 30, 90)
    }
    return w.units.flatMap((u) => [u.x, u.z, u.heading, u.speed])
  }
  const run1 = runSim()
  const run2 = runSim()
  check(
    run1.length === run2.length && run1.every((v, i) => Object.is(v, run2[i])),
    'Zwei identische Läufe sind bit-identisch (500 Ticks, 2 Einheiten, Queue)',
  )
  check(run1.every((v) => Number.isFinite(v)), 'Alle Sim-Zustände endlich')

  const wArrive = new SimWorld()
  const mover = wArrive.spawn(testStats, 10, 10)
  wArrive.issueMove(mover, 50, 55)
  for (let i = 0; i < 600; i++) wArrive.tick()
  const arriveDist = Math.hypot(mover.x - 50, mover.z - 55)
  check(
    arriveDist <= testStats.arriveRadius + 0.4 && mover.speed < 0.05,
    `Einheit kommt an (Restdistanz ${arriveDist.toFixed(2)}, v=${mover.speed.toFixed(3)})`,
  )
  const wTurn = new SimWorld()
  const turner = wTurn.spawn(testStats, 10, 10, 0)
  wTurn.issueMove(turner, 10, -40) // 180° hinter der Einheit
  for (let i = 0; i < 300; i++) wTurn.tick()
  check(
    Math.hypot(turner.x - 10, turner.z - -40) < 1,
    '180°-Wende + Ankunft funktioniert',
  )

  // Floating Economy: Bau zieht Kosten kontinuierlich, Health wächst mit
  const wEco = new SimWorld()
  const site = wEco.spawn(testStats, 5, 5)
  site.buildProgress = 0
  site.health = 0
  const armyEco = wEco.army(1)
  const massBefore = armyEco.mass
  for (let i = 0; i < 20; i++) wEco.tick() // 2 s bei BuildRate 10/BuildTime 100 → ~20 %
  check(
    site.buildProgress > 0.15 && site.buildProgress < 0.25,
    `Baufortschritt nach 2 s: ${(site.buildProgress * 100).toFixed(0)} % (erwartet ~20 %)`,
  )
  check(
    Math.abs(massBefore - armyEco.mass - 50 * site.buildProgress) < 1,
    `Mass-Abfluss entspricht Fortschritt (${(massBefore - armyEco.mass).toFixed(1)} von 50)`,
  )
  check(
    Math.abs(site.health - 300 * site.buildProgress) < 1,
    'Health wächst mit Baufortschritt',
  )

  console.log('\n== SCMAP: alle Karten in maps/ ==')
  const envScd = await ZipArchive.open(await NodeFile.open(`${GAME_DIR}/gamedata/env.scd`))
  const texturesScd = await ZipArchive.open(await NodeFile.open(`${GAME_DIR}/gamedata/textures.scd`))
  const mapDirs = (await readdir(`${GAME_DIR}/maps`, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
  let mapOk = 0
  const mapErrors: string[] = []
  const validSizes = new Set([64, 128, 256, 512, 1024, 2048, 4096])
  for (const dir of mapDirs) {
    try {
      const files = await readdir(`${GAME_DIR}/maps/${dir}`)
      const scmapName = files.find((f) => f.toLowerCase().endsWith('.scmap'))
      if (!scmapName) continue
      const scmap = parseScmap(new Uint8Array(await readFile(`${GAME_DIR}/maps/${dir}/${scmapName}`)))
      const problems: string[] = []
      if (!validSizes.has(scmap.width) || !validSizes.has(scmap.height)) {
        problems.push(`Größe ${scmap.width}x${scmap.height}`)
      }
      if (Math.abs(scmap.heightScale - 1 / 128) > 1e-6) {
        problems.push(`heightScale=${scmap.heightScale}`)
      }
      if (!scmap.terrainShader.toLowerCase().includes('terrain')) {
        problems.push(`Shader "${scmap.terrainShader}"`)
      }
      const layers = scmap.strata.filter((s) => s.albedoPath)
      if (layers.length < 2) problems.push(`nur ${layers.length} Texturlagen`)
      for (const s of layers) {
        if (!envScd.get(s.albedoPath.replace(/^\//, '')) && !texturesScd.get(s.albedoPath.replace(/^\//, ''))) {
          problems.push(`Layer fehlt in env/textures.scd: ${s.albedoPath}`)
        }
        if (!(s.albedoScale > 0 && s.albedoScale < 10000)) {
          problems.push(`Layer-Scale ${s.albedoScale}`)
        }
      }
      for (const [label, dds] of [
        ['maskLow', scmap.textureMaskLowDds],
        ['maskHigh', scmap.textureMaskHighDds],
        ['waterMap', scmap.waterMapDds],
      ] as const) {
        if (dds) {
          const img = parseDds(dds)
          if (img.width < 32) problems.push(`${label}: ${img.width}px`)
        } else {
          problems.push(`${label} fehlt`)
        }
      }
      const maxH = scmap.heightmap.reduce((a, b) => Math.max(a, b), 0) * scmap.heightScale
      if (!(maxH >= 0 && maxH < 512)) problems.push(`max. Höhe ${maxH}`)
      if (problems.length === 0) mapOk++
      else mapErrors.push(`${dir}: ${problems.join('; ')}`)
    } catch (err) {
      mapErrors.push(`${dir}: ${err instanceof Error ? err.message : err}`)
    }
  }
  check(mapErrors.length === 0, `${mapOk}/${mapOk + mapErrors.length} Karten geparst und plausibel`)
  for (const e of mapErrors.slice(0, 15)) console.error(`       ${e}`)

  console.log('\n== Scenario-Lua ==')
  const scenText = await readFile(`${GAME_DIR}/maps/SCMP_001/SCMP_001_scenario.lua`, 'utf-8')
  const scen = parseLuaAssignments(scenText)
  check(bpGetPath(scen, 'ScenarioInfo.name') === 'Burial Mounds', `name=${bpGetPath(scen, 'ScenarioInfo.name')}`)
  const scenSize = bpGetPath(scen, 'ScenarioInfo.size')
  check(Array.isArray(scenSize) && scenSize[0] === 1024, `size=${JSON.stringify(scenSize)}`)

  console.log(failures === 0 ? '\nALLE CHECKS BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
