/**
 * Phase-A-Verifikation: Übersetzt ALLE Original-Lua-Dateien (lua.scd,
 * mohodata.scd, units.scd, projectiles.scd) mit dem FA-Dialekt-Transpiler
 * und prüft, dass daraus gültiges Standard-Lua (5.1) wird.
 *
 * Syntaxprüfung via luaparse (deterministisch, ohne VM-Zustand); die
 * Laufzeit-Kompatibilität (Shims) prüft ein zweiter Schritt im echten VM.
 *
 *   npx tsx scripts/verify-lua.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import * as luaparse from 'luaparse'
import { LuaFactory } from 'wasmoon'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { transpileFaLua, COMPAT_LUA } from '../src/lua/transpile'

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

let total = 0
let ok = 0
let bytecode = 0
const failures: string[] = []
const stats = { hashComments: 0, notEquals: 0, forInTable: 0, continues: 0, varargArg: 0 }
const openFiles: NodeFile[] = []

for (const archive of ['lua.scd', 'mohodata.scd', 'units.scd', 'projectiles.scd']) {
  const file = await NodeFile.open(`${GAME}/gamedata/${archive}`)
  openFiles.push(file)
  const zip = await ZipArchive.open(file)
  const luaFiles = [...zip.entries.values()].filter((e) => e.name.toLowerCase().endsWith('.lua'))
  let archiveOk = 0

  for (const entry of luaFiles) {
    const bytes = await zip.read(entry)
    if (bytes[0] === 0x1b) {
      bytecode++ // vorkompilierter Lua-Bytecode, kein Quelltext
      continue
    }
    total++
    const { code, stats: s } = transpileFaLua(new TextDecoder('latin1').decode(bytes))
    stats.hashComments += s.hashComments
    stats.notEquals += s.notEquals
    stats.forInTable += s.forInTable
    stats.continues += s.continues
    stats.varargArg += s.varargArg

    try {
      // 5.3: goto/Labels (für `continue`) und C-Bitoperatoren (`|`, `&`),
      // die FA ebenfalls nutzt — beides kann der Ziel-VM (Lua 5.4) nativ.
      luaparse.parse(code, { luaVersion: '5.3', comments: false, scope: false })
      ok++
      archiveOk++
    } catch (err) {
      failures.push(`${entry.name}: ${(err as Error).message.slice(0, 100)}`)
    }
  }
  console.log(`${archive}: ${archiveOk}/${luaFiles.length} Lua-Dateien sind gültiges Lua`)
}

console.log(
  `\nTranspiler: ${stats.hashComments} '#'-Kommentare, ${stats.notEquals} '!=', ` +
    `${stats.forInTable} 'for-in-Tabelle', ${stats.continues} 'continue', ` +
    `${stats.varargArg} 'arg'-Vararg umgeschrieben`,
)
console.log(
  `Ergebnis: ${ok}/${total} Original-Lua-Dateien parsen als Standard-Lua` +
    (bytecode > 0 ? ` (${bytecode} Bytecode-Dateien übersprungen)` : ''),
)
if (failures.length > 0) {
  console.error(`\n${failures.length} Fehler:`)
  for (const f of failures.slice(0, 20)) console.error(`  ${f}`)
}

// Laufzeit-Check: Compat-Schicht muss im echten VM laden
const lua = await new LuaFactory().createEngine()
await lua.doString(COMPAT_LUA)
const compatOk = await lua.doString(
  'return type(table.getn) == "function" and type(unpack) == "function" ' +
    'and type(setfenv) == "function" and type(math.mod) == "function"',
)
lua.global.close()
console.log(`Compat-Schicht im Lua-VM (wasmoon): ${compatOk ? 'OK' : 'FEHLER'}`)

for (const f of openFiles) await f.close()
process.exit(failures.length === 0 && compatOk ? 0 : 1)
