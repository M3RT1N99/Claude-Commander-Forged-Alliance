/**
 * Verifiziert den Lua-Sim-Scheduler (src/lua/simThreads.ts): ForkThread/
 * WaitTicks über native Coroutinen, getrieben von __simTick() (Engine-Beat).
 * Das ist der Mechanismus, über den die Original-Unit.lua pro Tick läuft.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-simthreads.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { installSimThreads, simTick, currentTick, threadCount } from '../src/lua/simThreads'
import { bootArchives } from './gameFiles'

class NodeFile implements RandomAccessFile {
  private constructor(private readonly fh: FileHandle, readonly size: number) {}
  static async open(p: string): Promise<NodeFile> {
    const fh = await open(p, 'r'); return new NodeFile(fh, (await fh.stat()).size)
  }
  async slice(s: number, e: number): Promise<ArrayBuffer> {
    const b = Buffer.alloc(e - s); await this.fh.read(b, 0, e - s, s)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  }
  close(): Promise<void> { return this.fh.close() }
}

const GAME =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

const files = new Map<string, Uint8Array>()
const openFiles: NodeFile[] = []
for (const archive of ['mohodata.scd', 'lua.scd', ...(await bootArchives())]) {
  const file = await NodeFile.open(`${GAME}/gamedata/${archive}`)
  openFiles.push(file)
  const zip = await ZipArchive.open(file)
  for (const [key, entry] of zip.entries) if (key.endsWith('.lua')) files.set(key, await zip.read(entry))
}

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const num = (host: LuaHost, expr: string): number => Number(host.eval(`return ${expr}`))

const warnings: string[] = []
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})
installSimThreads(host)

console.log('\n== Zeit-Globals ==')
check(num(host, 'GetSimTicksPerSecond()') === 10, `GetSimTicksPerSecond = ${num(host, 'GetSimTicksPerSecond()')}`)
check(Math.abs(num(host, 'SecondsPerTick()') - 0.1) < 1e-9, `SecondsPerTick = ${num(host, 'SecondsPerTick()')}`)
check(currentTick(host) === 0, `Start-Tick = ${currentTick(host)}`)

console.log('\n== ForkThread + WaitTicks(1): Schleife läuft pro Tick ==')
host.eval('counter = 0')
host.eval('ForkThread(function() while true do counter = counter + 1; WaitTicks(1) end end)')
for (let i = 0; i < 5; i++) simTick(host)
check(num(host, 'counter') === 5, `Zähler nach 5 Ticks = ${num(host, 'counter')} (erwartet 5)`)
check(currentTick(host) === 5, `Tick = ${currentTick(host)}`)
check(Math.abs(num(host, 'GetGameTimeSeconds()') - 0.5) < 1e-9, `GetGameTimeSeconds = ${num(host, 'GetGameTimeSeconds()')} (0.5 s)`)

console.log('\n== WaitTicks(3): resümiert wie die Engine max(1, N-1) Ticks nach dem ersten Lauf ==')
host.eval('resumeTick = -1')
host.eval('ForkThread(function() WaitTicks(3); resumeTick = GetGameTick() end)')
const startTick = currentTick(host)
for (let i = 0; i < 4; i++) simTick(host)
// Engine (DoTaskTick, Cfile:438898): the yield count N>=2 is stored as N-1 and
// pre-decremented each tick, so WaitTicks(3) sleeps 2 ticks. First run at
// startTick+1, resume at startTick+3 — NOT startTick+4 (that was a one-tick-late
// off-by-one the raw store produced).
check(num(host, 'resumeTick') === startTick + 3, `resümiert bei Tick ${num(host, 'resumeTick')} (erwartet ${startTick + 3})`)

console.log('\n== ForkThread-Argumente ==')
host.eval('argsum = 0')
host.eval('ForkThread(function(a, b) argsum = a + b end, 3, 4)')
simTick(host)
check(num(host, 'argsum') === 7, `argsum = ${num(host, 'argsum')} (erwartet 7)`)

console.log('\n== KillThread stoppt einen Thread ==')
// Handle in einem GLOBAL halten (local überlebt den nächsten eval nicht).
host.eval('kc = 0; KILL = ForkThread(function() while true do kc = kc + 1; WaitTicks(1) end end)')
simTick(host) // kc = 1
simTick(host) // kc = 2
const before = num(host, 'kc')
host.eval('KillThread(KILL)')
simTick(host)
simTick(host)
check(num(host, 'kc') === before, `Zähler eingefroren nach KillThread (${num(host, 'kc')} == ${before})`)

console.log('\n== Verschachtelter ForkThread (Kind läuft im Folgetick) ==')
host.eval('childRan = false')
host.eval('ForkThread(function() ForkThread(function() childRan = true end) end)')
simTick(host) // Eltern läuft, forkt Kind
check(host.eval('return childRan') === false, 'Kind läuft NICHT im selben Tick')
simTick(host) // Kind läuft
check(host.eval('return childRan') === true, 'Kind läuft im Folgetick')

console.log('\n== threadCount: tote Threads werden entfernt ==')
const tc0 = threadCount(host)
host.eval('ForkThread(function() end)') // Einmal-Thread
check(threadCount(host) === tc0 + 1, `registriert: ${threadCount(host)} (${tc0}+1)`)
simTick(host)
check(threadCount(host) === tc0, `nach Lauf entfernt: ${threadCount(host)} (== ${tc0})`)

if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN:`)
  for (const w of warnings.slice(0, 5)) console.log(`  ${w.slice(0, 120)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nSIMTHREADS BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
