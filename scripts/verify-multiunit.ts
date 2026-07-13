/**
 * Engine: mehrere Units aller Fraktionen spawnen über ihre ECHTE Unit.lua
 * durch die volle Engine (Blueprint-Pipeline + moho + Scheduler + Ökonomie +
 * Motion). Sichert die Blueprint-Default-Sektionen (Intel) und das
 * Scenario-Global ab, ohne die frühere OnCreate-Pfade brachen.
 *
 *   npx tsx scripts/verify-multiunit.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { installMoho } from '../src/lua/moho'
import { installUnitFactory, installBlueprintPipeline, loadUnitBlueprint, spawnLuaUnit, readLuaUnit } from '../src/lua/unitFactory'
import { installSimThreads } from '../src/lua/simThreads'
import { EconomyManager, installEconomy } from '../src/sim/economy'
import { installMotion } from '../src/sim/motion'

class NF implements RandomAccessFile {
  private constructor(private readonly fh: FileHandle, readonly size: number) {}
  static async open(p: string): Promise<NF> { const fh = await open(p, 'r'); return new NF(fh, (await fh.stat()).size) }
  async slice(s: number, e: number): Promise<ArrayBuffer> { const b = Buffer.alloc(e - s); await this.fh.read(b, 0, e - s, s); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
  close(): Promise<void> { return this.fh.close() }
}

const GAME = process.env.CFA_GAME_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

// je Fraktion Kommandeur/Struktur/Mobil abgedeckt
const UNITS: [string, string][] = [
  ['uel0001', 'UEF ACU'],
  ['ueb1101', 'UEF Energiegenerator T1'],
  ['ueb1103', 'UEF Mass-Extraktor T1'],
  ['ueb0101', 'UEF Land-Fabrik T1'],
  ['uel0201', 'UEF Striker (Panzer)'],
  ['url0107', 'Cybran Mantis'],
  ['ual0201', 'Aeon Aurora'],
  ['xsl0101', 'Seraphim Selen'],
]

const openFiles: NF[] = []
const files = new Map<string, Uint8Array>()
for (const a of ['mohodata.scd', 'lua.scd']) {
  const f = await NF.open(`${GAME}/gamedata/${a}`); openFiles.push(f)
  const z = await ZipArchive.open(f)
  for (const [k, e] of z.entries) if (k.endsWith('.lua')) files.set(k, await z.read(e))
}
const uf = await NF.open(`${GAME}/gamedata/units.scd`); openFiles.push(uf)
const uz = await ZipArchive.open(uf)
const bps = new Map<string, Uint8Array>()
for (const [id] of UNITS) {
  files.set(`units/${id}/${id}_script.lua`, await uz.read(uz.get(`units/${id}/${id}_script.lua`)!))
  bps.set(id, await uz.read(uz.get(`units/${id}/${id}_unit.bp`)!))
}

let failures = 0
const check = (ok: boolean, label: string): void => { console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`); if (!ok) failures++ }

const host = await LuaHost.create(files, () => {})
host.loadGlobal('/lua/system/utils.lua')
installMoho(host); installBlueprintPipeline(host); installUnitFactory(host); installSimThreads(host)
installEconomy(host, new EconomyManager()); installMotion(host)
host.installStubTrap(() => {})

console.log('\n== Spawn aller Sandbox-Units über die echte Unit.lua ==')
for (const [id, name] of UNITS) {
  try {
    loadUnitBlueprint(host, id, bps.get(id)!)
    const uid = spawnLuaUnit(host, id, { x: 10, y: 0, z: 10 }, 1)
    const st = readLuaUnit(host, uid)
    check(uid > 0 && st != null && st.maxHealth > 0, `${id} (${name}) — HP ${st?.maxHealth}`)
  } catch (e) {
    check(false, `${id} (${name}) — ${(e as Error).message.slice(0, 70)}`)
  }
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? `\nMULTIUNIT BESTANDEN (${UNITS.length} Units)` : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
