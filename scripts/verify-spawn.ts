/**
 * Sim-Anbindung Stufe 1: Spawnt eine Unit über ihre Original-Klasse
 * (`units/uel0001/uel0001_script.lua` → TypeClass) und liest den von der
 * Original-Lua gesetzten Zustand zurück.
 *
 *   npx tsx scripts/verify-spawn.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { installMoho } from '../src/lua/moho'
import { installUnitFactory, spawnLuaUnit, readLuaUnit } from '../src/lua/unitFactory'

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

const files = new Map<string, Uint8Array>()
const openFiles: NodeFile[] = []
for (const archive of ['mohodata.scd', 'lua.scd']) {
  const file = await NodeFile.open(`${GAME}/gamedata/${archive}`)
  openFiles.push(file)
  const zip = await ZipArchive.open(file)
  for (const [key, entry] of zip.entries) if (key.endsWith('.lua')) files.set(key, await zip.read(entry))
}
// Unit-Script + Blueprint aus units.scd
const unitsFile = await NodeFile.open(`${GAME}/gamedata/units.scd`)
openFiles.push(unitsFile)
const unitsZip = await ZipArchive.open(unitsFile)
for (const key of ['units/uel0001/uel0001_unit.bp', 'units/uel0001/uel0001_script.lua']) {
  files.set(key, await unitsZip.read(unitsZip.get(key)!))
}

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const warnings: string[] = []
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})
host.loadGlobal('/lua/system/utils.lua')
installMoho(host)

// Blueprint-Pipeline (registriert uel0001)
host.eval(`
  __active_mods = {}
  __registered = { Unit={}, Mesh={}, Prop={}, Projectile={}, Emitter={}, TrailEmitter={}, Beam={} }
  local function collector(g) return function(bp) __registered[g][bp.BlueprintId or '?'] = bp end end
  RegisterUnitBlueprint=collector('Unit'); RegisterMeshBlueprint=collector('Mesh')
  RegisterPropBlueprint=collector('Prop'); RegisterProjectileBlueprint=collector('Projectile')
  RegisterEmitterBlueprint=collector('Emitter'); RegisterTrailEmitterBlueprint=collector('TrailEmitter')
  RegisterBeamBlueprint=collector('Beam')
  function BlueprintLoaderUpdateProgress() end
  __bpFiles = { '/units/uel0001/uel0001_unit.bp' }
  function DiskFindFiles(dir, pattern)
    local out = {}
    for _, f in ipairs(__bpFiles) do if string.find(f, dir, 1, true) == 1 then out[#out+1]=f end end
    return out
  end
`)
host.loadGlobal('/lua/system/Blueprints.lua')

installUnitFactory(host)
const missing = new Set<string>()
host.installStubTrap((name) => missing.add(name))
host.eval(`LoadBlueprints()`)

console.log('\n== Spawn über Original-Klasse (UEL0001 = TWalkingLandUnit) ==')
try {
  const id = spawnLuaUnit(host, 'uel0001', { x: 128, y: 20, z: 128 }, 1)
  check(id > 0, `gespawnt, Unit-ID ${id}`)
  const state = readLuaUnit(host, id)
  check(state?.name === 'uel0001', `Zustand.name = ${state?.name}`)
  check(state?.x === 128 && state?.z === 128, `Position (${state?.x}, ${state?.y}, ${state?.z})`)
  check(state?.maxHealth === 12000, `maxHealth = ${state?.maxHealth} (aus Original-bp)`)
  check(
    typeof state?.health === 'number' && state.health > 0,
    `health = ${state?.health} (OnCreate-Kette gelaufen)`,
  )
} catch (err) {
  check(false, `spawn: ${(err as Error).message.slice(0, 200)}`)
}

console.log(`\nEngine-Globals in Spawn/OnCreate (${missing.size}): ${[...missing].sort().slice(0, 40).join(', ')}`)
if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN (erste 4):`)
  for (const w of warnings.slice(0, 4)) console.log(`  ${w.slice(0, 110)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nSPAWN BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
