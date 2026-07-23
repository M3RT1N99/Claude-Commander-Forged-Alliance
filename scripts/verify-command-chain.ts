/**
 * Die Techdemo-Kette, headless und in einem Stück:
 *
 *   ACU auswählen  → GetSelectedUnits (UI-VM)
 *   Bau-Icon       → commandmode.StartCommandMode('build', {name='ueb0101'})
 *   Klick in die Welt
 *       → Engine: Snap aufs Raster (COORDS_GridSnap @0x50B1E0)
 *       → Sim:    Baustelle (CreateUnit beingBuilt=1) + OnStartBuild
 *       → UI:     commandmode.OnCommandIssued → Modus endet
 *   Beats laufen   → Fortschritt entsteht aus buildRate/BuildTime · Rate · 0.1
 *                    (CBuildTaskHelper::UpdateWorkProgress @0x5f5f2c)
 *                  → die Ökonomie zahlt dafür
 *
 * Beide Lua-States sind echt (Sim + UI), beide Seiten laufen über Original-Lua.
 * Was hier grün ist, ist im Browser derselbe Code — main.ts ruft dieselben
 * Funktionen aus src/ui/worldCommands.ts.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-command-chain.ts
 */
import { readdir, readFile } from 'node:fs/promises'
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit, spawnBuildSite, readLuaUnit } from '../src/lua/unitFactory'
import { GameFiles, GAME_DIR } from './gameFiles'
import {
  installUiEngine,
  setupUi,
  setupGameUi,
  createRootFrame,
  loadUiBlueprints,
} from '../src/lua/uiEngine'
import { worldClick, getCommandMode, snapToGrid, footprintOf } from '../src/ui/worldCommands'
import { findFiles } from '../src/vfs/glob'
import { parseDds } from '../src/formats/dds'
import { FontBook } from '../src/ui/fonts'


let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const quiet = process.argv.includes('--quiet')
const log = (msg: string): void => {
  if (!quiet) console.log(`  · ${msg}`)
}

// --- Files (first archive wins, like in the browser) -----------------------
const game = await GameFiles.open()
const files = game.luaFiles
const allPaths = game.paths
const bpPaths = [...allPaths].filter((p) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(p))

// --- The Sim VM (original engine boot, flat test site) -----------------
console.log('\n== Sim: ACU via the Original-Unit.lua ==')
const simHost = await LuaHost.create(files, () => {})
const engine = installEngine(simHost)
setTerrainSource(simHost, () => 20) // flat test area at altitude 20
// Blueprint AND Skeleton — exactly what the worker sends with it when spawning.
for (const id of ['uel0001', 'ueb0101']) await game.giveUnit(simHost, id)
const acu = spawnLuaUnit(simHost, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
check(acu > 0, `ACU gespawnt (id ${acu})`)
// GiveInitialResources runs after WaitTicks(5) — only then does the army have anything.
for (let i = 0; i < 8; i++) beat(engine)
const eco0 = engine.economy.army(1)
// Hold NUMBERS, not the army object: army(1) is a reference that
// keeps turning with every beat - a comparison against them compares itself.
const maxMass0 = eco0.maxMass
check(eco0.mass > 0 && eco0.energy > 0, `Starting supply from GiveInitialResources: ${eco0.mass.toFixed(0)} mass, ${eco0.energy.toFixed(0)} energy`)

// --- The UI VM (same as in the browser) ------------------------------------
console.log('\n== UI: Build panels, select ACU ==')
const dims = new Map<string, [number, number]>()
for (const key of game.paths) {
  if (!key.startsWith('textures/ui/') || !key.endsWith('.dds')) continue
  try {
    const dds = parseDds(await game.read(key))
    dims.set(key, [dds.width, dds.height])
  } catch {
    // Broken DDS: don't guess.
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
setupGameUi(uiHost, log)
uiHost.setGlobal('__uiSimCommand', () => {})

// The engine reflects the sim state into the UI VM (UserUnit::UpdateUnitData).
const mirror = (): void => {
  for (const u of simHost.eval('return __readAllUnits()') as {
    id: number
    name: string
    x: number
    y: number
    z: number
    health: number
    maxHealth: number
    fraction: number
    moving: boolean
  }[]) {
    uiHost.eval(
      `__uiSetUnit(${u.id}, '${u.name}', 1, ${u.x}, ${u.y}, ${u.z}, ${u.health}, ${u.maxHealth}, ${u.fraction}, ${!u.moving})`,
    )
  }
}
mirror()
check(Number(uiHost.eval(`return __uiSelectByIds({ ${acu} })`)) === 1, 'ACU selected in the UI')

// --- The construction icon: the Original-construction.lua starts the command mode ---
console.log('\n== Bau-Icon → commandmode.lua ==')
uiHost.eval(`import('/lua/ui/game/commandmode.lua').StartCommandMode('build', { name = 'ueb0101' })`)
const cm = getCommandMode(uiHost)
check(cm.mode === 'build' && cm.name === 'ueb0101', `Command-Mode = build/${String(cm.name)}`)

const fp = footprintOf(uiHost, 'ueb0101')
check(fp[0] === 5 && fp[1] === 5, `Footprint aus dem Blueprint: ${fp[0]}×${fp[1]} (ueb0101_unit.bp:151)`)

// The snap is not a question of taste (COORDS_GridSnap @0x50B1E0):
//   cell.x  = trunc(103.4 − 2.5) = trunc(100.9) = 100
//   world.x = 100 + 2.5 = 102.5
//   cell.z = trunc(108.9 − 2.5) = trunc(106.4) = 106 → world.z = 108.5
// So a 5×5 building ALWAYS sits on half a coordinate — that’s exactly what it says
// it in the original on the grid.
const snapped = snapToGrid(103.4, 108.9, fp[0], fp[1], () => 20)
check(
  snapped.x === 102.5 && snapped.z === 108.5,
  `Snap (103.4, 108.9) → (${snapped.x}, ${snapped.z}) — COORDS_GridSnap, 1-m-Raster`,
)
check(snapped.y === 20, 'The height comes AFTER the snap from the terrain (Cfile:641588)')

// --- The click into the world --------------------------------------------------
console.log('\n== Klick in die Welt: Baustelle + Auftrag ==')
const sim = {
  move: (id: number, x: number, z: number): void => {
    simHost.eval(`local u = __units[${id}] if u then u:GetNavigator():SetGoal({ ${x}, 0, ${z} }) end`)
  },
  attack: (id: number, targetId: number): void => {
    simHost.eval(`__dispatchAttack(${id}, ${targetId})`)
  },
  repair: (id: number, targetId: number): void => {
    simHost.eval(`__dispatchRepair(${id}, ${targetId})`)
  },
  setRallyPoint: (id: number, x: number, y: number, z: number): void => {
    simHost.eval(`local u = __units[${id}] if u then u:SetRallyPoint({ ${x}, ${y}, ${z} }) end`)
  },
  build: async (
    builderId: number,
    bpId: string,
    pos: { x: number; y: number; z: number },
    army: number,
  ): Promise<number> => {
    const uid = spawnBuildSite(simHost, bpId, pos, army)
    simHost.eval(`__issueBuildTask(${builderId}, ${uid})`)
    return uid
  },
}
const msg = await worldClick(uiHost, sim, { x: 103.4, z: 108.9 }, () => 20)
check(msg !== null && msg.startsWith('Bau: ueb0101'), `worldClick → ${String(msg)}`)
check(
  getCommandMode(uiHost).mode === false,
  'Der Command-Mode ist zu Ende (OnCommandIssued → EndCommandMode, commandmode.lua:147)',
)

const site = Number(simHost.eval('local n = 0 for _ in pairs(__buildTasks) do n = n + 1 end return n'))
check(site === 1, 'Die Sim hat genau EINEN Bau-Auftrag')

const siteId = Number(
  simHost.eval(`
    for id, u in pairs(__units) do
      if u.__bp and u.__bp.BlueprintId == 'ueb0101' then return id end
    end
    return 0
  `),
)
const site0 = readLuaUnit(simHost, siteId)
check(site0 !== null && site0.fraction === 0, `Baustelle steht mit FractionComplete 0 (id ${siteId})`)
check(
  site0 !== null && Math.abs(site0.x - 102.5) < 0.01 && Math.abs(site0.z - 108.5) < 0.01,
  `Baustelle liegt auf dem gerasterten Punkt (${site0?.x}, ${site0?.z})`,
)

// --- Construction is underway --------------------------------------------------------
console.log('\n== Beats: the building grows, the economy pays ==')
const massBefore = engine.economy.army(1).mass
for (let i = 0; i < 20; i++) beat(engine)
const site1 = readLuaUnit(simHost, siteId)!
check(site1.fraction > 0, `Fortschritt nach 20 Beats: ${(site1.fraction * 100).toFixed(1)} %`)
check(site1.health > 0, `Leben wächst mit: ${site1.health.toFixed(0)} von ${site1.maxHealth}`)
const massAfter = engine.economy.army(1).mass
check(massAfter < massBefore, `Masse bezahlt: ${massBefore.toFixed(0)} → ${massAfter.toFixed(0)}`)

// See you done. ueb0101: BuildTime from the blueprint, ACU BuildRate 10 →
// delta = 10/BuildTime · Rate · 0.1 per tick. Don't invent a time limit: it will
// Calculated until the sim is finished (or it never is - then the test fails).
let ticks = 20
while (readLuaUnit(simHost, siteId)!.fraction < 1 && ticks < 4000) {
  beat(engine)
  ticks++
}
const done = readLuaUnit(simHost, siteId)!
check(done.fraction >= 1, `Factory finished according to ${ticks} beats (${(ticks / 10).toFixed(0)} s playing time)`)
check(done.health === done.maxHealth, `Volles Leben: ${done.health} = ${done.maxHealth}`)
// The finished factory now counts in the economy (previously NOT - unfinished units
// are invisible to the economy).
//
// The ONE additional beat is not a trick, but rather the beat order
// Sim::AdvanceBeat (@:1076363): Construction demand → economy → apply granted rate.
// The factory will be finished in the THIRD stage - the warehouse of the new unit will flow
// So first into the economics of the next beat.
beat(engine)
const ecoEnd = engine.economy.army(1)
check(
  ecoEnd.maxMass === maxMass0 + 80,
  `The warehouse grew by the factory's StorageMass: ${maxMass0} → ${ecoEnd.maxMass} (+80, ueb0101_unit.bp:148)`,
)

// --- The click with selected FACTORY -------------------------------------
//
// A factory does not have a RULEUCC_Move (ueb0101_unit.bp) — one click in the world
// is for them the COLLECTION POINT (IssueFactoryRallyPoint, Cfile:1008266), no
// Movement command. Before, the move command went to everything, and the sim has that
// Building TELEPORTED to the click point (motion.lua: MaxSpeed ​​0 → “immediately on
// Target"). That's exactly what happened in the browser.
console.log('\n== Click with factory selected: collection point, no journey ==')
mirror()
check(
  Number(uiHost.eval(`return __uiSelectByIds({ ${siteId} })`)) === 1,
  'The finished factory is selected',
)

const before = readLuaUnit(simHost, siteId)!
const rallyMsg = await worldClick(uiHost, sim, { x: 140, z: 150 }, () => 20)
check(rallyMsg === 'Sammelpunkt → 140, 150', `worldClick → ${String(rallyMsg)}`)

for (let i = 0; i < 10; i++) beat(engine)
const after = readLuaUnit(simHost, siteId)!
check(
  after.x === before.x && after.z === before.z,
  `Die Fabrik STEHT (${after.x.toFixed(1)}, ${after.z.toFixed(1)}) — sie fährt nicht zum Klick`,
)
const rally = simHost.eval(`
  local p = __units[${siteId}]:GetRallyPoint()
  return string.format('%.0f,%.0f', p[1], p[3])
`) as string
check(rally === '140,150', `Ihr Sammelpunkt steht auf dem Klick: ${rally}`)

// Multi-builder click: the first selected builder places the site, every
// other selected unit with RULEUCC_Repair joins the same site (BuildAssist
// result via the repair/build task).
console.log('\n== Bau-Klick mit ZWEI Bauern: der zweite hilft ==')
{
  const acu2 = spawnLuaUnit(simHost, 'uel0001', { x: 96, y: 20, z: 100 }, 1)
  mirror()
  check(
    Number(uiHost.eval(`return __uiSelectByIds({ ${acu}, ${acu2} })`)) === 2,
    'Both pawns are selected',
  )
  uiHost.eval(`import('/lua/ui/game/commandmode.lua').StartCommandMode('build', { name = 'ueb0101' })`)
  const assistMsg = await worldClick(uiHost, sim, { x: 92.4, z: 92.1 }, () => 20)
  check(
    assistMsg !== null && assistMsg.includes('(+1 Assist)'),
    `worldClick → ${String(assistMsg)}`,
  )
  check(
    simHost.eval(`return __builderBusy(${acu}) and __builderBusy(${acu2})`) === true,
    'BEIDE Bauer haben einen Bau-Task auf der Baustelle',
  )
}

// A click on an ENEMY unit issues Attack (dispatch 0x0A) instead of Move —
// the picked target travels as enemyTargetId, exactly like CUIWorldView
// hands the picked entity to the command dispatch.
console.log('\n== Klick auf den Feind: Attack statt Move ==')
{
  await game.giveUnit(simHost, 'uel0201')
  const feind = spawnLuaUnit(simHost, 'uel0201', { x: 150, y: 20, z: 150 }, 2)
  check(
    Number(uiHost.eval(`return __uiSelectByIds({ ${acu} })`)) === 1,
    'The ACU is selected',
  )
  const atkMsg = await worldClick(uiHost, sim, { x: 150, z: 150 }, () => 20, {
    queue: false,
    enemyTargetId: feind,
  })
  check(atkMsg === `Attack (1) → Unit ${feind}`, `worldClick → ${String(atkMsg)}`)
  check(
    simHost.eval(`return __attackOrders[${acu}] == ${feind}`) === true,
    'The Sim executes the attack order (CAttackTargetTask)',
  )
}

simHost.close()
uiHost.close()
await game.close()
console.log(failures === 0 ? '\nBEFEHLSKETTE BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
