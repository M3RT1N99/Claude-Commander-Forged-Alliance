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
// `GetSimTicksPerSecond` gibt es in der Sim NICHT: die Bindung ist
// `scr_UserInits` und damit UI-only
// (`luadef_GetSimTicksPerSecond.mPrevDef = Moho::scr_UserInits.mForms`,
// Cfile:1264462) — genau wie `GameTick` (Cfile:1361911). Diese Zeile verlangte
// bis eben das Gegenteil und hielt damit unseren eigenen Fehler fest: beide
// standen in `threads.lua`, das in BEIDE VMs geht.
//
// Was die Sim hat, ist `SecondsPerTick` (scr_CoreInits, Cfile:702637) und
// `GetGameTick` (sim_SimInits, Cfile:1088856).
check(
  host.eval('return rawget(_G, "GetSimTicksPerSecond") == nil') === true,
  'GetSimTicksPerSecond ist NICHT in der Sim (scr_UserInits, Cfile:1264462)',
)
check(
  host.eval('return rawget(_G, "GameTick") == nil') === true,
  'GameTick ebenso wenig (scr_UserInits, Cfile:1361911)',
)
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

console.log('\n== A nested ForkThread runs in the SAME frame, after the queue (CTaskStage::DoFrame) ==')
// `DoFrame` (Cfile:439351-439395) pops threads off the head of `mThreads`
// until the list is EMPTY; the constructor appends a new thread to its tail
// (Cfile:438804-438807) with `mWaitTicks = 0`, and the pre-decrement in
// DoTaskTick (Cfile:438898) makes it due at once. So the child runs in the
// frame it was forked in -- after every thread that was already queued. This
// check used to assert the opposite ("Kind läuft NICHT im selben Tick"): that
// was our scheduler's snapshot bound, not the engine.
host.eval('order = {}')
host.eval(`
  ForkThread(function()
    order[#order + 1] = 'parent'
    ForkThread(function() order[#order + 1] = 'child' end)
  end)
  ForkThread(function() order[#order + 1] = 'queued' end)
`)
simTick(host)
const order = String(host.eval('return table.concat(order, ",")'))
check(order === 'parent,queued,child', `one tick runs parent, the already-queued thread, then the child (${order})`)

console.log('\n== WaitTicks(0) does not wait (DoTaskTick continues on TASKSTATUS_0) ==')
// Cfile:438938-438942: a yield of 0 stores `mWaitTicks = 0` and, for a thread
// that is not parked, `continue`s the tick loop -- the coroutine is resumed
// again in the same call.
host.eval('zero = 0')
host.eval('ForkThread(function() zero = 1; WaitTicks(0); zero = 2; WaitTicks(1); zero = 3 end)')
simTick(host)
check(num(host, 'zero') === 2, `after one tick the thread is past WaitTicks(0) but not WaitTicks(1) (zero = ${num(host, 'zero')})`)

console.log('\n== SuspendCurrentThread / ResumeThread: the resumed thread goes to the tail ==')
// Cfile:593112-593124: ResumeThread sets `mWaitTicks = 0` and appends the
// parked thread to `mThreads` -- so it runs in the current frame if one is
// running, after everything already queued.
host.eval('wake = -1; resumedAt = -1')
host.eval(`
  SLEEPER = ForkThread(function() SuspendCurrentThread(); wake = GetGameTick() end)
  ForkThread(function()
    WaitTicks(3)
    resumedAt = GetGameTick()
    ResumeThread(SLEEPER)
  end)
`)
for (let i = 0; i < 6; i++) simTick(host)
check(num(host, 'resumedAt') > 0 && num(host, 'wake') === num(host, 'resumedAt'), `the sleeper wakes in the tick it was resumed in (${num(host, 'wake')} == ${num(host, 'resumedAt')})`)
check(
  host.eval(`return (pcall(function() ResumeThread(false) end))`) === false &&
    host.eval(`return (pcall(function() SuspendCurrentThread() end))`) === false,
  'ResumeThread(false) and SuspendCurrentThread() outside a thread both throw (Cfile:593034, 593106)',
)

console.log('\n== Invalid yields end the thread with the engine warning (CLuaTask::TaskTick) ==')
const warnAt = warnings.length
const aliveBefore = threadCount(host)
host.eval('bad = 0')
host.eval(`
  ForkThread(function() while true do bad = bad + 1; coroutine.yield('soon') end end)
  ForkThread(function() while true do bad = bad + 1; coroutine.yield(-3) end end)
  ForkThread(function() while true do bad = bad + 1; coroutine.yield() end end)
  ForkThread(function() error('boom') end)
`)
for (let i = 0; i < 3; i++) simTick(host)
check(num(host, 'bad') === 3, `each thread ran exactly once (bad = ${num(host, 'bad')})`)
const fresh = warnings.slice(warnAt)
check(fresh.some((w) => w.startsWith('Invalid args to yield(); expected tick count')), 'a string yield: "Invalid args to yield(); expected tick count" (Cfile:592230)')
check(fresh.some((w) => w.startsWith('Invalid args to yield(); tick count must be >=0')), 'a negative yield: "tick count must be >=0" (Cfile:592216)')
check(fresh.some((w) => w.startsWith('Error running lua script: ') && w.includes('boom')), 'a Lua error: "Error running lua script: %s" (Cfile:592246)')
check(fresh.length === 3, `a bare yield ends the thread WITHOUT a warning (LUA_TNONE -> -1, Cfile:592208); ${fresh.length} warnings in total`)
check(threadCount(host) === aliveBefore, `all four threads are gone again (${threadCount(host)} alive, ${aliveBefore} before)`)

console.log('\n== KillThread: nil is ignored, anything else that is not a thread throws ==')
// Cfile:592571 skips LUA_TNIL; every other non-thread hits TypeError "thread".
check(host.eval('return (pcall(KillThread, nil))') === true, 'KillThread(nil) is a no-op')
check(host.eval('return (pcall(KillThread, 42))') === false, 'KillThread(42) throws')
check(host.eval('return (pcall(KillThread, false))') === false, 'KillThread(false) throws too')

console.log('\n== CurrentThread survives a nested __startThread ==')
host.eval('same = false')
host.eval(`
  ForkThread(function()
    local me = CurrentThread()
    __startThread(function() end)
    same = (CurrentThread() == me)
  end)
`)
simTick(host)
check(host.eval('return same') === true, 'the outer thread is current again after the inner first slice')

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
