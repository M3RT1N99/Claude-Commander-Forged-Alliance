/**
 * Phase-A / A3: Lädt die echten Unit-Klassen (`lua/sim/Unit.lua` +
 * `lua/defaultunits.lua`) mit ihrer kompletten import-Kaskade in den VM und
 * prüft, dass die Klassenhierarchie verlinkt ist.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-units.ts
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
console.log(`${files.size} Module vorgeladen`)

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
// Flat test area - EXPLICIT because the engine crashes without a map (no silent 0 value).
setTerrainSource(host, FLAT_TEST_TERRAIN)

// Discovery trap: report missing engine globals (no guessing).
const missing = new Set<string>()

console.log('\n== Import cascade: Unit.lua + defaultunits.lua ==')
try {
  const unitType = host.eval(`return type(import('/lua/sim/Unit.lua').Unit)`)
  check(unitType === 'table', `import('/lua/sim/Unit.lua').Unit -> ${unitType}`)
} catch (err) {
  check(false, `Unit.lua: ${(err as Error).message.slice(0, 140)}`)
}

try {
  host.eval(`import('/lua/defaultunits.lua')`)
  const kinds = host.eval(`
    local d = import('/lua/defaultunits.lua')
    local n = 0
    for _ in pairs(d) do n = n + 1 end
    return n
  `)
  check(typeof kinds === 'number' && kinds >= 20, `defaultunits.lua defines ${kinds} classes`)

  // Check derivation: StructureUnit inherits (transitively) from Unit
  const derives = host.eval(`
    local d = import('/lua/defaultunits.lua')
    local Unit = import('/lua/sim/Unit.lua').Unit
    local function derivesFrom(cls, base)
      if cls == base then return true end
      if not cls.__bases then return false end
      for _, b in ipairs(cls.__bases) do
        if derivesFrom(b, base) then return true end
      end
      return false
    end
    return derivesFrom(d.StructureUnit, Unit)
  `)
  check(derives === true, 'StructureUnit inherits from Unit (class hierarchy linked)')
} catch (err) {
  check(false, `defaultunits.lua: ${(err as Error).message.slice(0, 140)}`)
}

console.log(`\nEntdeckte Engine-Globals (${missing.size}): ${[...missing].sort().slice(0, 40).join(', ')}`)
if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN (erste 5):`)
  for (const w of warnings.slice(0, 5)) console.log(`  ${w.slice(0, 110)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nA3 BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
