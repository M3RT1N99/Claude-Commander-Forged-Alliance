/**
 * Phase-A / A2: Fährt die Original-Blueprint-Pipeline
 * (`lua/system/Blueprints.lua`) im eingebetteten VM mit einem echten
 * Unit-Blueprint und prüft, dass Registrierung + Mesh-Extraktion laufen.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-blueprints.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { installEngine } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { FLAT_TEST_TERRAIN } from '../src/sim/terrain'

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
// Make a real unit blueprint (from units.scd) available to the pipeline
const unitsFile = await NodeFile.open(`${GAME}/gamedata/units.scd`)
openFiles.push(unitsFile)
const unitsZip = await ZipArchive.open(unitsFile)
const bpKey = 'units/uel0001/uel0001_unit.bp'
files.set(bpKey, await unitsZip.read(unitsZip.get(bpKey)!))
console.log(`${files.size} modules preloaded (incl. 1 unit blueprint)`)

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const warnings: string[] = []
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})

// Load utils.lua globally (provides sortedpairs + table.deepcopy/merged, which the
// pipeline needs). Runs in global Env → functions become global.
host.loadGlobal('/lua/system/utils.lua')

// The REAL pipeline - no replica in the test (otherwise Sound{} is missing, for example).
installEngine(host)
// Flat test area - EXPLICIT because the engine crashes without a map (no silent 0 value).
setTerrainSource(host, FLAT_TEST_TERRAIN)

// Discovery Trap: the Blueprint DSL uses engine constructors (Sound{},
// Vector{}, ...). We discover them instead of guessing.
const missing = new Set<string>()

console.log('\n== Original pipeline: LoadBlueprints() ==')
// The real LoadBlueprints() drives Init -> doscript(bp) -> ExtractAllMesh ->
// ModBlueprints -> RegisterAllBlueprints — just fed with our one
// Blueprint (DiskFindFiles oben).
host.eval(`__bpFiles = { '/${bpKey}' }; LoadBlueprints()`)

const storedId = host.eval(`
  local k = next(__registered.Unit)
  return k
`) as string
check(typeof storedId === 'string' && storedId.length > 0, `Blueprint registriert: id="${storedId}"`)

console.log('\n== Ergebnis ==')
const faction = host.eval(`return __registered.Unit['${storedId}'].General.FactionName`)
check(faction === 'UEF', `FactionName from original bp: ${faction}`)
const hp = host.eval(`return __registered.Unit['${storedId}'].Defense.MaxHealth`)
check(hp === 12000, `Defense.MaxHealth: ${hp}`)
const meshBp = host.eval(`return __registered.Unit['${storedId}'].Display.MeshBlueprint`)
check(typeof meshBp === 'string' && meshBp.includes('uel0001'), `ExtractMeshBlueprint setzte MeshBlueprint: ${meshBp}`)
const meshCount = host.eval(`local n=0 for _ in pairs(__registered.Mesh) do n=n+1 end return n`)
check(typeof meshCount === 'number' && meshCount >= 1, `${meshCount} Mesh-Blueprint(s) extrahiert+registriert`)

console.log(
  `\nEntdeckte Engine-Globals (Blueprint-DSL + Pipeline): ${[...missing].sort().join(', ')}`,
)
if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN (erste 4):`)
  for (const w of warnings.slice(0, 4)) console.log(`  ${w.slice(0, 100)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nA2 BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
