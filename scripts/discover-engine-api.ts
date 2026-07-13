/**
 * Welche Engine-API ruft die Original-Lua wirklich auf, die wir noch nicht haben?
 *
 * Der Stub-Trap laeuft hier — und NUR hier — als Rekorder: er faengt Zugriffe auf
 * fehlende Globals ab, damit die Original-Lua weiterlaeuft und wir die komplette
 * Liste sehen statt nur den ersten Fehler. Im Produktivpfad ist er verboten
 * (siehe CLAUDE.md): dort muss Fehlendes knallen.
 *
 *   npx tsx scripts/discover-engine-api.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { FLAT_TEST_TERRAIN } from '../src/sim/terrain'
import { loadUnitBlueprint, spawnLuaUnit } from '../src/lua/unitFactory'

class NodeFile implements RandomAccessFile {
  private constructor(private readonly fh: FileHandle, readonly size: number) {}
  static async open(p: string): Promise<NodeFile> {
    const fh = await open(p, 'r')
    return new NodeFile(fh, (await fh.stat()).size)
  }
  async slice(s: number, e: number): Promise<ArrayBuffer> {
    if (e <= s) return new ArrayBuffer(0)
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

// Eine Unit pro Fraktion + Gebaeude/Fabrik/Panzer: deckt die Lifecycle-Pfade ab.
const IDS = [
  'uel0001', 'ual0001', 'url0001', 'xsl0001', // ACUs aller vier Fraktionen
  'ueb1101', 'ueb1103', 'ueb0101', 'uel0201', // Gen, Extraktor, Fabrik, Panzer
]

const files = new Map<string, Uint8Array>()
const open_: NodeFile[] = []
for (const archive of ['mohodata.scd', 'lua.scd']) {
  const f = await NodeFile.open(`${GAME}/gamedata/${archive}`)
  open_.push(f)
  const zip = await ZipArchive.open(f)
  for (const [key, entry] of zip.entries) if (key.endsWith('.lua')) files.set(key, await zip.read(entry))
}
const unitsFile = await NodeFile.open(`${GAME}/gamedata/units.scd`)
open_.push(unitsFile)
const unitsZip = await ZipArchive.open(unitsFile)
const bps = new Map<string, Uint8Array>()
for (const id of IDS) {
  files.set(`units/${id}/${id}_script.lua`, await unitsZip.read(unitsZip.get(`units/${id}/${id}_script.lua`)!))
  bps.set(id, await unitsZip.read(unitsZip.get(`units/${id}/${id}_unit.bp`)!))
}

const errors: string[] = []
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') errors.push(msg)
})
const engine = installEngine(host)
// Flaches Testgelaende — EXPLIZIT, weil die Engine ohne Karte knallt.
setTerrainSource(host, FLAT_TEST_TERRAIN)

const missing = new Set<string>()
host.installStubTrap((name) => missing.add(name))

for (const id of IDS) loadUnitBlueprint(host, id, bps.get(id)!)

console.log('\n== Spawn aller Testunits (Original-Klassen) ==')
const ids: number[] = []
for (const id of IDS) {
  try {
    ids.push(spawnLuaUnit(host, id, { x: 20 + ids.length * 8, y: 0, z: 20 }, 1))
    console.log(`  OK   ${id}`)
  } catch (e) {
    console.log(`  FEHLER ${id}: ${(e as Error).message.split('\n')[0]?.slice(0, 110)}`)
  }
}

// Laufzeitpfade: Bewegung + 60 Beats (Threads, Oekonomie, Bau)
if (ids[0]) host.eval(`__units[${ids[0]}]:GetNavigator():SetGoal({ 60, 0, 60 })`)
for (let i = 0; i < 60; i++) beat(engine)

console.log(`\n== FEHLENDE ENGINE-GLOBALS (${missing.size}) ==`)
console.log(missing.size === 0 ? '  (keine — die Original-Lua findet alles)' : `  ${[...missing].sort().join(', ')}`)

if (errors.length > 0) {
  console.log(`\n== WARNUNGEN (${errors.length}, erste 8) ==`)
  for (const w of errors.slice(0, 8)) console.log(`  ${w.slice(0, 130)}`)
}

const eco = engine.economy.army(1)
console.log(`\n== Oekonomie nach 60 Beats ==`)
console.log(`  Masse   ${eco.mass.toFixed(1)} / ${eco.maxMass.toFixed(0)}   (+${eco.incomeMass.toFixed(1)}/s)`)
console.log(`  Energie ${eco.energy.toFixed(1)} / ${eco.maxEnergy.toFixed(0)}   (+${eco.incomeEnergy.toFixed(1)}/s)`)

host.close()
for (const f of open_) await f.close()
