/**
 * Phase-A-Verifikation: Übersetzt ALLE Original-Lua-Dateien (lua.scd,
 * mohodata.scd, units.scd, projectiles.scd) mit dem FA-Dialekt-Transpiler
 * und prüft, dass daraus gültiges Standard-Lua (5.1) wird.
 *
 * Syntaxprüfung via luaparse (deterministisch, ohne VM-Zustand); die
 * Laufzeit-Kompatibilität (Shims) prüft ein zweiter Schritt im echten VM.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-lua.ts
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

// string.format the way FA uses it (Lua 5.0 → C, here Lua 5.4):
//   %d with a FRACTIONAL value throws "number has no integer representation"
//   in 5.4. unitview.lua:269 formats HEALTH with it
//   (`string.format("%d / %d", info.health, info.maxHealth)`) — every damaged
//   unit tore down the rollover panel.
//   %+s is an invalid conversion in 5.4, and economy.lua:305 uses it.
const formatChecks: [string, string][] = [
  ['return string.format("%d / %d", 12.7, 100)', '12 / 100'],
  ['return string.format("%d", -3.7)', '-3'],
  ['return string.format("%d%%", 55.2)', '55%'],
  ['return string.format("%+s", "x")', 'x'],
  ['return string.format("%.1f %d %s", 1.25, 7.9, "a")', '1.2 7 a'],
  ['return string.format("%5.2f|%d", 3.14159, 42)', ' 3.14|42'],
]
let formatOk = true
for (const [code, want] of formatChecks) {
  const got = await lua.doString(code)
  const ok = got === want
  if (!ok) formatOk = false
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${code.replace('return ', '')} → ${JSON.stringify(got)}`)
}

// __foriter (generic-for dispatcher): FA's LuaPlus 5.0 tolerates
// `for k,v in nil do` as a ZERO-iteration loop — the shipped UI relies on it
// (construction.lua:889 `for index, unitStack in currentCommandQueue do`, where
// currentCommandQueue is legitimately nil for a unit with no build queue,
// AssignNil @Cfile:1257091). Standard Lua 5.4 raises "attempt to call a nil
// value (for iterator)" and takes the whole click handler down. Tables and
// iterator triples must keep working. Tested through the REAL transpiler.
const forInChecks: [string, number][] = [
  ['local q = nil local n = 0 for k,v in q do n = n + 1 end return n', 0],
  ['local t = {a=1,b=2,c=3} local n = 0 for k,v in t do n = n + 1 end return n', 3],
  ['local n = 0 for i,v in ipairs({10,20,30}) do n = n + 1 end return n', 3],
  ['local n = 0 for k,v in pairs({x=1,y=2}) do n = n + 1 end return n', 2],
]
let forInOk = true
for (const [src, want] of forInChecks) {
  const { code } = transpileFaLua(src)
  const got = Number(await lua.doString(code))
  const ok = got === want
  if (!ok) forInOk = false
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} for-in (${src.slice(6, 22)}…) → ${got} (want ${want})`)
}
console.log(`for-in nil tolerance (LuaPlus): ${forInOk ? 'OK' : 'FEHLER'}`)

console.log(`Compat-Schicht im Lua-VM (wasmoon): ${compatOk && formatOk ? 'OK' : 'FEHLER'}`)

for (const f of openFiles) await f.close()

// Close the bare wasmoon engine and let libuv drain BEFORE exiting. On Windows
// `process.exit()` used to tear the wasmoon async handle down mid-close and
// assert `!(handle->flags & UV_HANDLE_CLOSING)` (src/win/async.c) AFTER every
// check had already passed — turning a green run red at random. Setting
// exitCode and returning lets the event loop finish that close cleanly.
lua.global.close()
process.exitCode = failures.length === 0 && compatOk && formatOk && forInOk ? 0 : 1
