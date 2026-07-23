/**
 * Phase-A / A1: Bootet die Original-Lua-Sim-Umgebung (import + class.lua) im
 * eingebetteten VM und prüft, dass das Original-Modulsystem läuft.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-luaboot.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'

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

// Preload all Lua files. mohodata.scd = base, lua.scd overlaid.
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
console.log(`${files.size} Lua-Module vorgeladen`)

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const warnings: string[] = []
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})

console.log('\n== Boot: Modulsystem + Klassensystem ==')
check(host.eval('return type(import)') === 'function', 'import() is defined')
// Class is a callable table (ClassMeta:__call), not a function
check(host.eval('return type(Class)') === 'table', 'Class is defined (callable table)')
check(host.eval('return type(__modules)') === 'table', '__modules table exists')

console.log('\n== Class instantiation (original class.lua) ==')
const greet = host.eval(`
  TestClass = Class() {
      greeting = 'hello',
      Greet = function(self) return self.greeting .. ' ' .. self.name end,
  }
  local obj = TestClass()
  obj.name = 'acu'
  return obj:Greet()
`)
check(greet === 'hello acu', `Instance method + inheritance: "${greet}"`)

console.log('\n== Vererbung (2 Ebenen) ==')
const inh = host.eval(`
  Base = Class() { kind = 'base', Kind = function(self) return self.kind end }
  Derived = Class(Base) { kind = 'derived' }
  return Derived():Kind()
`)
check(inh === 'derived', `Derivation overwrites field: "${inh}"`)

console.log('\n== import() loads a real original module ==')
try {
  const utilsType = host.eval(`return type(import('/lua/system/utils.lua'))`)
  check(utilsType === 'table', `import('/lua/system/utils.lua') -> ${utilsType}`)
} catch (err) {
  check(false, `import utils.lua: ${(err as Error).message.slice(0, 80)}`)
}

if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN from the Lua boot (first 5):`)
  for (const w of warnings.slice(0, 5)) console.log(`  ${w.slice(0, 100)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nA1 BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
