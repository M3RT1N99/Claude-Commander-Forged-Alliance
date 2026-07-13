/**
 * Phase-A / A4: Instanziiert eine Unit über die ECHTE `lua/sim/Unit.lua` und
 * fährt `OnCreate` — der Beweis, dass das Original-Unit-Verhalten im
 * eingebetteten VM läuft.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-unit-create.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { installEngine } from '../src/lua/engine'

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
  for (const [key, entry] of zip.entries) {
    if (key.endsWith('.lua')) files.set(key, await zip.read(entry))
  }
}
const unitsFile = await NodeFile.open(`${GAME}/gamedata/units.scd`)
openFiles.push(unitsFile)
const unitsZip = await ZipArchive.open(unitsFile)
const bpKey = 'units/uel0001/uel0001_unit.bp'
files.set(bpKey, await unitsZip.read(unitsZip.get(bpKey)!))

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const warnings: string[] = []
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})

installEngine(host)

// Blueprint-Pipeline (A2) — registriert uel0001
host.eval(`
  __active_mods = {}
  __registered = { Unit={}, Mesh={}, Prop={}, Projectile={}, Emitter={}, TrailEmitter={}, Beam={} }
  local function collector(group) return function(bp) __registered[group][bp.BlueprintId or '?'] = bp end end
  RegisterUnitBlueprint=collector('Unit'); RegisterMeshBlueprint=collector('Mesh')
  RegisterPropBlueprint=collector('Prop'); RegisterProjectileBlueprint=collector('Projectile')
  RegisterEmitterBlueprint=collector('Emitter'); RegisterTrailEmitterBlueprint=collector('TrailEmitter')
  RegisterBeamBlueprint=collector('Beam')
  function BlueprintLoaderUpdateProgress() end
  __bpFiles = { '/${bpKey}' }
  function DiskFindFiles(dir, pattern)
    local out = {}
    for _, f in ipairs(__bpFiles) do
      if string.find(f, dir, 1, true) == 1 then out[#out+1] = f end
    end
    return out
  end
`)
host.loadGlobal('/lua/system/Blueprints.lua')

const missing = new Set<string>()
host.eval(`LoadBlueprints()`)

console.log('\n== Unit über echte Unit.lua instanziieren + OnCreate ==')
try {
  const result = host.eval(`
    local Unit = import('/lua/sim/Unit.lua').Unit
    local u = Unit()
    u.__bp = __registered.Unit['uel0001']
    u.__id = 1
    u.__army = 1
    u.__brain = {}
    u.__health = u.__bp.Defense.MaxHealth
    u:OnCreate()
    return { name = u.__bp.BlueprintId, hp = u:GetMaxHealth(), created = (u.__onCreateRan ~= nil) }
  `) as { name?: string; hp?: number } | undefined
  check(!!result, 'OnCreate() lief ohne Fehler durch')
  check(result?.name === 'uel0001', `Instanz kennt ihr Blueprint: ${result?.name}`)
  check(result?.hp === 12000, `GetMaxHealth() aus Original-bp: ${result?.hp}`)
} catch (err) {
  check(false, `OnCreate: ${(err as Error).message.slice(0, 200)}`)
}

console.log(`\nEntdeckte Engine-Globals in OnCreate (${missing.size}): ${[...missing].sort().slice(0, 40).join(', ')}`)
if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN (erste 4):`)
  for (const w of warnings.slice(0, 4)) console.log(`  ${w.slice(0, 110)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nA4 BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
