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
import { spawnLuaUnit, spawnBuildSite, readLuaUnit, type LuaUnitState } from '../src/lua/unitFactory'
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

// --- Dateien (erstes Archiv gewinnt, wie im Browser) ------------------------
const game = await GameFiles.open()
const files = game.luaFiles
const allPaths = game.paths
const bpPaths = [...allPaths].filter((p) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(p))

// --- Die Sim-VM (Original-Engine-Boot, flaches Testgelände) -----------------
console.log('\n== Sim: ACU über die Original-Unit.lua ==')
const simHost = await LuaHost.create(files, () => {})
const engine = installEngine(simHost)
// readRow() (units.lua:757) also carries FractionComplete, which the exported
// LuaUnitState does not declare yet — read the row through the type it really is.
const readUnit = (id: number): LuaUnitState | null => readLuaUnit(simHost, id)
setTerrainSource(simHost, () => 20) // flaches Testgelände auf Höhe 20
// Blueprint UND Skelett — genau das, was der Worker beim Spawn mitschickt.
for (const id of ['uel0001', 'ueb0101']) await game.giveUnit(simHost, id)
const acu = spawnLuaUnit(simHost, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
check(acu > 0, `ACU gespawnt (id ${acu})`)
// GiveInitialResources läuft nach WaitTicks(5) — erst danach hat die Armee etwas.
for (let i = 0; i < 8; i++) beat(engine)
const eco0 = engine.economy.army(1)
// ZAHLEN festhalten, nicht das Armee-Objekt: army(1) ist eine Referenz, die sich
// mit jedem Beat weiterdreht — ein Vergleich gegen sie vergleicht sich selbst.
const maxMass0 = eco0.maxMass
check(eco0.mass > 0 && eco0.energy > 0, `Startvorrat aus GiveInitialResources: ${eco0.mass.toFixed(0)} Masse, ${eco0.energy.toFixed(0)} Energie`)

// --- Die UI-VM (dieselbe wie im Browser) ------------------------------------
console.log('\n== UI: Panels aufbauen, ACU auswählen ==')
const dims = new Map<string, [number, number]>()
for (const key of game.paths) {
  if (!key.startsWith('textures/ui/') || !key.endsWith('.dds')) continue
  try {
    const dds = parseDds(await game.read(key))
    dims.set(key, [dds.width, dds.height])
  } catch {
    // Kaputte DDS: nicht raten.
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
// The session-strict bindings (GetArmiesTable/GetFocusArmy error without a
// session) and the camera bridge must be in place BEFORE the game panels
// import — same order as the browser boot.
applySession(uiHost, { ...SANDBOX_SESSION, map: 'SCMP_009' })
;(globalThis as { __cfaUiCameraBridge?: unknown }).__cfaUiCameraBridge = () => undefined
setupGameUi(uiHost, log)
uiHost.setGlobal('__uiSimCommand', () => {})

// Die Engine spiegelt den Sim-Zustand in die UI-VM (UserUnit::UpdateUnitData).
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
check(Number(uiHost.eval(`return __uiSelectByIds({ ${acu} })`)) === 1, 'ACU in der UI ausgewählt')

// --- Das Bau-Icon: die Original-construction.lua startet den Command-Mode ---
console.log('\n== Bau-Icon → commandmode.lua ==')
uiHost.eval(`import('/lua/ui/game/commandmode.lua').StartCommandMode('build', { name = 'ueb0101' })`)
const cm = getCommandMode(uiHost)
check(cm.mode === 'build' && cm.name === 'ueb0101', `Command-Mode = build/${String(cm.name)}`)

const fp = footprintOf(uiHost, 'ueb0101')
check(fp[0] === 5 && fp[1] === 5, `Footprint aus dem Blueprint: ${fp[0]}×${fp[1]} (ueb0101_unit.bp:151)`)

// Der Snap ist keine Geschmacksfrage (COORDS_GridSnap @0x50B1E0):
//   cell.x  = trunc(103.4 − 2.5) = trunc(100.9) = 100
//   world.x = 100 + 2.5 = 102.5
//   cell.z  = trunc(108.9 − 2.5) = trunc(106.4) = 106  →  world.z = 108.5
// Ein 5×5-Gebäude sitzt also IMMER auf einer halben Koordinate — genau so steht
// es im Original auf dem Raster.
const snapped = snapToGrid(103.4, 108.9, fp[0], fp[1], () => 20)
check(
  snapped.x === 102.5 && snapped.z === 108.5,
  `Snap (103.4, 108.9) → (${snapped.x}, ${snapped.z}) — COORDS_GridSnap, 1-m-Raster`,
)
check(snapped.y === 20, 'Die Höhe kommt NACH dem Snap aus dem Gelände (Cfile:641588)')

// --- Der Klick in die Welt --------------------------------------------------
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
  guard: (id: number, targetId: number): void => {
    simHost.eval(`__dispatchGuard(${id}, ${targetId})`)
  },
  patrol: (id: number, x: number, z: number): void => {
    simHost.eval(`__dispatchPatrol(${id}, ${x}, ${z})`)
  },
  attackGround: (id: number, x: number, z: number): void => {
    simHost.eval(`__dispatchAttackGround(${id}, ${x}, ${z})`)
  },
  reclaim: (id: number, targetId: number): void => {
    simHost.eval(`__dispatchReclaim(${id}, ${targetId})`)
  },
  reclaimMapProp: (): void => {},
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
// A red ghost blocks the order: with an 'invalid' verdict worldClick issues
// nothing and leaves the command mode active (the world view refuses to place
// where CanBuildStructureAt fails). 'unknown'/'valid' would pass through.
const blocked = await worldClick(uiHost, sim, { x: 103.4, z: 108.9 }, () => 20, {
  queue: false,
  buildValidity: () => 'invalid' as const,
})
check(blocked !== null && blocked.includes('blockiert'), `blocked build → ${String(blocked)}`)
check(
  Number(simHost.eval('local n = 0 for _ in pairs(__buildTasks) do n = n + 1 end return n')) === 0,
  'A blocked build creates no build task',
)
check(getCommandMode(uiHost).mode === 'build', 'The command mode stays active after a blocked build')

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
const site0 = readUnit(siteId)
check(site0 !== null && site0.fraction === 0, `Baustelle steht mit FractionComplete 0 (id ${siteId})`)
check(
  site0 !== null && Math.abs(site0.x - 102.5) < 0.01 && Math.abs(site0.z - 108.5) < 0.01,
  `Baustelle liegt auf dem gerasterten Punkt (${site0?.x}, ${site0?.z})`,
)

// --- Der Bau läuft ----------------------------------------------------------
console.log('\n== Beats: der Bau wächst, die Ökonomie zahlt ==')
const massBefore = engine.economy.army(1).mass
for (let i = 0; i < 20; i++) beat(engine)
const site1 = readUnit(siteId)!
check(site1.fraction > 0, `Fortschritt nach 20 Beats: ${(site1.fraction * 100).toFixed(1)} %`)
check(site1.health > 0, `Leben wächst mit: ${site1.health.toFixed(0)} von ${site1.maxHealth}`)
const massAfter = engine.economy.army(1).mass
check(massAfter < massBefore, `Masse bezahlt: ${massBefore.toFixed(0)} → ${massAfter.toFixed(0)}`)

// Bis fertig. ueb0101: BuildTime aus dem Blueprint, ACU-BuildRate 10 →
// delta = 10/BuildTime · Rate · 0.1 pro Tick. Kein Zeitlimit erfinden: es wird
// gerechnet, bis die Sim fertig ist (oder es nie wird — dann knallt der Test).
let ticks = 20
while (readUnit(siteId)!.fraction < 1 && ticks < 4000) {
  beat(engine)
  ticks++
}
const done = readUnit(siteId)!
check(done.fraction >= 1, `Fabrik fertig nach ${ticks} Beats (${(ticks / 10).toFixed(0)} s Spielzeit)`)
check(done.health === done.maxHealth, `Volles Leben: ${done.health} = ${done.maxHealth}`)
// Die fertige Fabrik zählt jetzt in der Ökonomie (vorher NICHT — unfertige Units
// sind für die Ökonomie unsichtbar).
//
// Der EINE zusätzliche Beat ist kein Trick, sondern die Beat-Reihenfolge aus
// Sim::AdvanceBeat (@:1076363): Bau-Bedarf → Ökonomie → gewährte Rate anwenden.
// Fertig wird die Fabrik in der DRITTEN Stufe — das Lager der neuen Unit fließt
// also erst in den Ökonomie-Tick des nächsten Beats ein.
beat(engine)
const ecoEnd = engine.economy.army(1)
check(
  ecoEnd.maxMass === maxMass0 + 80,
  `Das Lager wuchs um die StorageMass der Fabrik: ${maxMass0} → ${ecoEnd.maxMass} (+80, ueb0101_unit.bp:148)`,
)

// --- Der Klick mit ausgewählter FABRIK -------------------------------------
//
// Eine Fabrik hat kein RULEUCC_Move (ueb0101_unit.bp) — ein Klick in die Welt
// ist für sie der SAMMELPUNKT (IssueFactoryRallyPoint, Cfile:1008266), kein
// Bewegungsbefehl. Vorher ging der Move-Befehl an alles, und die Sim hat das
// Gebäude an den Klickpunkt TELEPORTIERT (motion.lua: MaxSpeed 0 → „sofort am
// Ziel"). Genau das ist im Browser passiert.
console.log('\n== Klick mit ausgewählter Fabrik: Sammelpunkt, keine Fahrt ==')
mirror()
check(
  Number(uiHost.eval(`return __uiSelectByIds({ ${siteId} })`)) === 1,
  'Die fertige Fabrik ist ausgewählt',
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
    'Beide Bauer sind ausgewählt',
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
    'Die ACU ist ausgewählt',
  )
  const atkMsg = await worldClick(uiHost, sim, { x: 150, z: 150 }, () => 20, {
    queue: false,
    enemyTargetId: feind,
  })
  check(atkMsg === `Attack (1) → Unit ${feind}`, `worldClick → ${String(atkMsg)}`)
  check(
    simHost.eval(`return __attackOrders[${acu}] == ${feind}`) === true,
    'Die Sim führt die Attack-Order (CAttackTargetTask)',
  )
}

// RULEUCC_Move: a FORCED move — the click goes to the ground even if an enemy
// is under the cursor (the enemy is NOT attacked). This was a gap: a Move
// command mode fell through to the default handler and misrouted to Attack.
console.log('\n== RULEUCC_Move: forced move, even onto an enemy ==')
{
  simHost.eval(`__attackOrders[${acu}] = nil; __orders[${acu}] = nil; __orderActive[${acu}] = nil`)
  const enemy = spawnLuaUnit(simHost, 'uel0201', { x: 170, y: 20, z: 170 }, 2)
  mirror()
  uiHost.eval(`return __uiSelectByIds({ ${acu} })`)
  uiHost.eval(`import('/lua/ui/game/commandmode.lua').StartCommandMode('order', { name = 'RULEUCC_Move' })`)
  const mvMsg = await worldClick(uiHost, sim, { x: 170, z: 170 }, () => 20, {
    queue: false,
    enemyTargetId: enemy,
  })
  check(mvMsg !== null && mvMsg.startsWith('Move (1)'), `forced move onto an enemy is a Move (${mvMsg})`)
  check(
    simHost.eval(`return __attackOrders[${acu}] == nil`) === true,
    'the ACU did NOT attack — the forced move ignores the enemy target',
  )
}

// RULEUCC_Repair: a forced repair on the target under the cursor.
console.log('\n== RULEUCC_Repair: forced repair on the clicked unit ==')
{
  simHost.eval(`__abortBuildTasks(${acu}); __orders[${acu}] = nil; __orderActive[${acu}] = nil`)
  const damaged = spawnLuaUnit(simHost, 'ueb0101', { x: 180, y: 20, z: 180 }, 1)
  simHost.eval(`local u = __units[${damaged}]; u:SetHealth(nil, u:GetMaxHealth() * 0.5)`)
  mirror()
  uiHost.eval(`return __uiSelectByIds({ ${acu} })`)
  uiHost.eval(`import('/lua/ui/game/commandmode.lua').StartCommandMode('order', { name = 'RULEUCC_Repair' })`)
  const rpMsg = await worldClick(uiHost, sim, { x: 180, z: 180 }, () => 20, {
    queue: false,
    ownTargetId: damaged,
  })
  check(rpMsg !== null && rpMsg.startsWith('Repair (1)'), `forced repair on a damaged unit (${rpMsg})`)
  check(simHost.eval(`return __builderBusy(${acu})`) === true, 'the ACU has a repair task')
}

// An UNWIRED order mode must FAIL LOUDLY, not silently misroute to Attack/Move
// (CLAUDE.md). This is the systematic gap the audit found.
console.log('\n== An unwired order mode fails loudly ==')
{
  simHost.eval(`__abortBuildTasks(${acu}); __attackOrders[${acu}] = nil; __orders[${acu}] = nil; __orderActive[${acu}] = nil`)
  mirror()
  uiHost.eval(`return __uiSelectByIds({ ${acu} })`)
  uiHost.eval(`import('/lua/ui/game/commandmode.lua').StartCommandMode('order', { name = 'RULEUCC_Overcharge' })`)
  const ocMsg = await worldClick(uiHost, sim, { x: 190, z: 190 }, () => 20, { queue: false })
  check(
    ocMsg !== null && ocMsg.includes('not wired'),
    `an unwired mode returns a loud message, no misrouting (${ocMsg})`,
  )
  check(
    simHost.eval(`return __attackOrders[${acu}] == nil and not __units[${acu}].__goal`) === true,
    'and it issued NO move or attack',
  )
}

// Guard vs Repair: a right-click on an own FINISHED but DAMAGED unit is GUARD,
// not Repair — the engine's precedence (Cfile:1240337-1240397); the guard task
// itself repairs the damaged target.
console.log('\n== Right-click a finished damaged unit: Guard, not Repair ==')
{
  // End the command mode from the previous test: this is a plain right-click.
  uiHost.eval(`import('/lua/ui/game/commandmode.lua').EndCommandMode(true)`)
  simHost.eval(`__abortBuildTasks(${acu}); __guardOrders[${acu}] = nil; __orders[${acu}] = nil; __orderActive[${acu}] = nil`)
  const finished = spawnLuaUnit(simHost, 'uel0201', { x: 210, y: 20, z: 210 }, 1)
  simHost.eval(`local u = __units[${finished}]; u:SetHealth(nil, u:GetMaxHealth() * 0.5)`)
  for (let i = 0; i < 2; i++) beat(engine)
  mirror()
  uiHost.eval(`return __uiSelectByIds({ ${acu} })`)
  // No command mode: the default right-click. ownTargetId is the finished
  // damaged unit (fraction >= 1) — zielUnter classifies it as own, not repair.
  const gMsg = await worldClick(uiHost, sim, { x: 210, z: 210 }, () => 20, {
    queue: false,
    ownTargetId: finished,
  })
  check(gMsg !== null && gMsg.startsWith('Guard'), `a finished damaged unit is guarded, not repaired (${gMsg})`)
  check(
    simHost.eval(`return __guardOrders[${acu}] ~= nil`) === true,
    'the ACU has a guard order (which repairs the damaged target)',
  )
}

simHost.close()
uiHost.close()
await game.close()
console.log(failures === 0 ? '\nBEFEHLSKETTE BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
