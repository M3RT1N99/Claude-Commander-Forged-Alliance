/**
 * Repro/regression for "the commander cannot be given a move command".
 *
 * It walks the EXACT browser path, not the simplified test mirror:
 *   Sim:  spawn the ACU (uel0001, army 1), run init beats.
 *   Sync: mirror every unit into the UI VM with the FULL 17-arg __uiSetUnit,
 *         INCLUDING the effective command-cap mask `caps` — that is what
 *         gameUi.beat() sends (gameUi.ts:287-290). The 10-arg mirror in
 *         verify-command-chain never exercises this and hid the bug.
 *   UI:   select the ACU, read __uiSelectionJson() and assert canMove — the
 *         gate worldClick() uses before it ever calls sim.move.
 *   Sim:  dispatch a real move and beat; the ACU must physically travel.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-commander-move.ts
 */
import { readdir, readFile } from 'node:fs/promises'
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit } from '../src/lua/unitFactory'
import { GameFiles, GAME_DIR } from './gameFiles'
import {
  installUiEngine,
  setupUi,
  setupGameUi,
  createRootFrame,
  loadUiBlueprints,
  applySession,
} from '../src/lua/uiEngine'
import { SANDBOX_SESSION } from '../src/sim/session'
import { findFiles } from '../src/vfs/glob'
import { parseDds } from '../src/formats/dds'
import { FontBook } from '../src/ui/fonts'
import { FLAT_TEST_MAP_SIZE } from '../src/sim/terrain'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const log = (msg: string): void => console.log(`  · ${msg}`)

// --- Files ------------------------------------------------------------------
const game = await GameFiles.open()
const files = game.luaFiles
const allPaths = game.paths
const bpPaths = [...allPaths].filter((p) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(p))

// --- Sim VM -----------------------------------------------------------------
console.log('\n== Sim: spawn the ACU (uel0001, army 1) ==')
const simHost = await LuaHost.create(files, () => {})
const engine = installEngine(simHost)
setTerrainSource(simHost, () => 20, FLAT_TEST_MAP_SIZE)
await game.giveUnit(simHost, 'uel0001')
const acu = spawnLuaUnit(simHost, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
check(acu > 0, `ACU spawned (id ${acu})`)
for (let i = 0; i < 8; i++) beat(engine)

// The effective command-cap mask the sim SENDS to the UI (readRow.caps).
const caps = Number(simHost.eval(`return __ensureCommandCapMask(__units[${acu}])`))
check((caps & 0x1) === 0x1, `Sim cap mask has RULEUCC_Move bit (0x1): mask=0x${caps.toString(16)}`)

// --- UI VM (same boot as the browser) ---------------------------------------
console.log('\n== UI: build panels, mirror the ACU the BROWSER way ==')
const dims = new Map<string, [number, number]>()
for (const key of game.paths) {
  if (!key.startsWith('textures/ui/') || !key.endsWith('.dds')) continue
  try {
    const dds = parseDds(await game.read(key))
    dims.set(key, [dds.width, dds.height])
  } catch {
    /* broken dds: skip */
  }
}
const fonts = new FontBook()
for (const name of await readdir(`${GAME_DIR}/fonts`)) {
  if (/\.ttf$/i.test(name)) fonts.add(await readFile(`${GAME_DIR}/fonts/${name}`))
}
const uiHost = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') log(`UI-WARN: ${msg.slice(0, 160)}`)
})
installUiEngine(uiHost, {
  exists: (p) => allPaths.has(p),
  find: (dir, pattern) => findFiles(allPaths, dir, pattern),
  textureSize: (p) => dims.get(p) ?? null,
  stringAdvance: (t, f, s) => fonts.advance(t, f, s),
  fontMetrics: (f, s) => fonts.metrics(f, s),
})
createRootFrame(uiHost, 1920, 1080)
setupUi(uiHost)
loadUiBlueprints(uiHost, bpPaths)
applySession(uiHost, { ...SANDBOX_SESSION, map: 'SCMP_009' })
;(globalThis as { __cfaUiCameraBridge?: unknown }).__cfaUiCameraBridge = () => undefined
setupGameUi(uiHost, log)
// Record what worldClick WOULD send to the sim.
const simCalls: string[] = []
uiHost.setGlobal('__uiSimCommand', (name: string) => {
  simCalls.push(name)
})

// The FULL browser mirror: gameUi.beat() -> __uiSetUnit with all 17 args,
// INCLUDING caps at position 13 (gameUi.ts:287-290).
type Row = {
  id: number
  name: string
  army: number
  x: number
  y: number
  z: number
  health: number
  maxHealth: number
  workProgress: number
  idle: boolean
  fireState: number
  guard: number
  caps: number
  dead: boolean
  shieldRatio: number
  fraction: number
  beingUpgraded: boolean
}
const mirror = (): void => {
  // Go through the JSON STRING path (__readAllUnitsJson), NOT the raw table:
  // that is what the browser consumes (LuaSimClient.allStates parses this exact
  // JSON, gameUi.beat feeds it into __uiSetUnit). The raw-table path hides a
  // whole class of serialization bugs — the command-cap mask was rounded to 6
  // significant digits by '%.6g' there and lost RULEUCC_Move, which is the very
  // bug this suite exists to catch.
  const json = simHost.pull<Row[]>('__readAllUnitsJson()')
  for (const u of json) {
    uiHost.eval(
      `__uiSetUnit(${u.id}, '${u.name}', ${u.army ?? 1}, ${u.x}, ${u.y}, ${u.z}, ` +
        `${u.health}, ${u.maxHealth}, ${u.workProgress ?? 0}, ${u.idle === true}, ` +
        `${u.fireState ?? 0}, ${u.guard ?? 0}, ${u.caps ?? -1}, ${u.dead === true}, ` +
        `${u.shieldRatio ?? 0}, ${u.fraction ?? 1}, ${u.beingUpgraded === true})`,
    )
  }
}
mirror()
check(Number(uiHost.eval(`return __uiSelectByIds({ ${acu} })`)) === 1, 'ACU selected in the UI VM')

// --- The gate: canMove in the real selection JSON ---------------------------
console.log('\n== The gate: __uiSelectionJson().canMove ==')
const selJson = String(uiHost.eval('return __uiSelectionJson()'))
log(`selection JSON: ${selJson}`)
const sel = JSON.parse(selJson) as { id: number; canMove: boolean; isFactory: boolean }[]
const acuSel = sel.find((s) => s.id === acu)
check(acuSel !== undefined, 'the ACU is in the selection JSON')
check(acuSel?.canMove === true, `canMove is TRUE for the ACU (got ${acuSel?.canMove}) — the gate worldClick uses`)
check(acuSel?.isFactory === false, `the ACU is NOT classified as a factory (got ${acuSel?.isFactory})`)

// --- The full worldClick path: does it CALL sim.move for the ACU? -----------
console.log('\n== worldClick → sim.move (the browser default + RULEUCC_Move) ==')
const moveCalls: { id: number; x: number; z: number; queue: boolean }[] = []
const recSim = {
  move: (id: number, x: number, z: number, queue = false) => moveCalls.push({ id, x, z, queue }),
  attack: () => {},
  attackGround: () => {},
  repair: () => {},
  capture: () => {},
  guard: () => {},
  patrol: () => {},
  reclaim: () => {},
  reclaimMapProp: () => {},
  transportLoad: () => {},
  transportReverseLoad: () => {},
  transportUnload: () => {},
  factoryCommand: () => {},
  build: async () => 0,
}
const { worldClick } = await import('../src/ui/worldCommands')
// 1) Default right-click on empty ground (no command mode, no target).
uiHost.eval(`import('/lua/ui/game/commandmode.lua').EndCommandMode(true)`)
moveCalls.length = 0
const dm = await worldClick(uiHost, recSim, { x: 140, z: 140 }, () => 20, { queue: false })
check(
  moveCalls.length === 1 && moveCalls[0]!.id === acu,
  `default right-click issues sim.move for the ACU (calls=${moveCalls.length}) → ${String(dm)}`,
)
// 2) The Move hotkey/button: StartCommandMode order RULEUCC_Move, then click.
uiHost.eval(`import('/lua/ui/game/commandmode.lua').StartCommandMode('order', { name = 'RULEUCC_Move' })`)
moveCalls.length = 0
const om = await worldClick(uiHost, recSim, { x: 150, z: 150 }, () => 20, { queue: false })
check(
  moveCalls.length === 1 && moveCalls[0]!.id === acu,
  `RULEUCC_Move mode issues sim.move for the ACU (calls=${moveCalls.length}) → ${String(om)}`,
)
uiHost.eval(`import('/lua/ui/game/commandmode.lua').EndCommandMode(true)`)

// --- Physical move: dispatch a move, beat, the ACU must travel --------------
console.log('\n== Physical move: __dispatchMove then beat ==')
const pos0 = simHost.eval(`local p = __units[${acu}].__pos return { p[1], p[3] }`) as number[]
simHost.eval(`__dispatchMove(${acu}, 140, 140, true)`)
for (let i = 0; i < 40; i++) beat(engine)
const pos1 = simHost.eval(`local p = __units[${acu}].__pos return { p[1], p[3] }`) as number[]
const traveled = Math.hypot(pos1[0]! - pos0[0]!, pos1[1]! - pos0[1]!)
log(`ACU moved from (${pos0[0]!.toFixed(1)}, ${pos0[1]!.toFixed(1)}) to (${pos1[0]!.toFixed(1)}, ${pos1[1]!.toFixed(1)})`)
check(traveled > 1, `the ACU physically travels toward the goal (moved ${traveled.toFixed(1)} ogrids)`)

simHost.close()
uiHost.close()
// Close the .scd archive handles explicitly. Node 25 turns a GC-time
// FileHandle close into a thrown error ("closed during garbage collection")
// that flips a green run red — the same teardown trap documented for
// verify-lua. Set exitCode and let the event loop drain instead of exiting hard.
await game.close()
console.log(failures === 0 ? '\nCOMMANDER-MOVE PASSED' : `\n${failures} CHECK(S) FAILED`)
process.exitCode = failures === 0 ? 0 : 1
