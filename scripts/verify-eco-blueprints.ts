/**
 * Verifiziert die Economy-Werte der Original-Blueprints gegen bekannte
 * Sollwerte (aus units.scd extrahiert, docs/research/sim-core.md) UND prüft,
 * dass statsFromBlueprint sie korrekt in die Sim-Statistik überträgt.
 * Verhindert stille Drift zwischen Blueprint, Recherche und Sim.
 *
 *   npx tsx scripts/verify-eco-blueprints.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { parseBlueprint, bpGet, type BpObject } from '../src/formats/blueprint'
import { statsFromBlueprint } from '../src/sim/simWorld'

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

/** Bekannte Sollwerte je Unit (Economy.<Feld>), live gegen die .bp geprüft. */
const EXPECTED: Record<string, Record<string, number>> = {
  // UEF ACU
  uel0001: {
    BuildRate: 10,
    BuildTime: 60000,
    BuildCostEnergy: 5000000,
    BuildCostMass: 18000,
    StorageEnergy: 4000,
    StorageMass: 650,
    ProductionPerSecondMass: 1,
    ProductionPerSecondEnergy: 20,
    MaxBuildDistance: 10,
  },
  // Mass-Extraktor T1
  ueb1103: {
    BuildRate: 10,
    BuildTime: 60,
    BuildCostEnergy: 360,
    BuildCostMass: 36,
    ProductionPerSecondMass: 2,
    MaintenanceConsumptionPerSecondEnergy: 2,
  },
  // Energiegenerator T1
  ueb1101: {
    BuildTime: 125,
    BuildCostEnergy: 750,
    BuildCostMass: 75,
    ProductionPerSecondEnergy: 20,
  },
}

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const file = await NodeFile.open(`${GAME}/gamedata/units.scd`)
const zip = await ZipArchive.open(file)
const dec = new TextDecoder('latin1')

async function loadBp(id: string): Promise<BpObject> {
  const entry = zip.get(`units/${id}/${id}_unit.bp`)
  if (!entry) throw new Error(`units/${id}/${id}_unit.bp nicht in units.scd`)
  return parseBlueprint(dec.decode(await zip.read(entry)))
}

for (const [id, expected] of Object.entries(EXPECTED)) {
  console.log(`\n== ${id.toUpperCase()}: Original-Blueprint-Economy ==`)
  const bp = await loadBp(id)
  for (const [field, want] of Object.entries(expected)) {
    const got = bpGet(bp, `Economy.${field}`)
    check(got === want, `Economy.${field} = ${JSON.stringify(got)} (erwartet ${want})`)
  }

  // statsFromBlueprint muss die Blueprint-Werte 1:1 in die Sim übertragen
  const s = statsFromBlueprint(id, bp)
  const mapping: [string, number, number][] = [
    ['massProduction', s.massProduction, expected.ProductionPerSecondMass ?? 0],
    ['energyProduction', s.energyProduction, expected.ProductionPerSecondEnergy ?? 0],
    ['massConsumption', s.massConsumption, expected.MaintenanceConsumptionPerSecondMass ?? 0],
    ['energyConsumption', s.energyConsumption, expected.MaintenanceConsumptionPerSecondEnergy ?? 0],
    ['massStorage', s.massStorage, expected.StorageMass ?? 0],
    ['energyStorage', s.energyStorage, expected.StorageEnergy ?? 0],
    ['buildCostMass', s.buildCostMass, expected.BuildCostMass ?? 0],
    ['buildCostEnergy', s.buildCostEnergy, expected.BuildCostEnergy ?? 0],
    ['buildTime', s.buildTime, expected.BuildTime ?? 1],
  ]
  for (const [name, got, want] of mapping) {
    check(got === want, `statsFromBlueprint.${name} = ${got} (erwartet ${want})`)
  }
}

await file.close()
console.log(failures === 0 ? '\nECO-BLUEPRINTS BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
