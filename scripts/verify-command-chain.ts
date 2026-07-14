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
import { open, readdir, readFile, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit, spawnBuildSite, readLuaUnit, loadUnitBlueprint } from '../src/lua/unitFactory'
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
    if (e <= s) return new ArrayBuffer(0)
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
const files = new Map<string, Uint8Array>()
const allPaths = new Set<string>()
const openFiles: NodeFile[] = []
const zips: ZipArchive[] = []
for (const archive of (await readdir(`${GAME}/gamedata`))
  .filter((n) => n.toLowerCase().endsWith('.scd'))
  .sort((a, b) => a.localeCompare(b))) {
  const f = await NodeFile.open(`${GAME}/gamedata/${archive}`)
  openFiles.push(f)
  const zip = await ZipArchive.open(f)
  zips.push(zip)
  for (const [key, entry] of zip.entries) {
    allPaths.add(key.toLowerCase())
    if ((key.endsWith('.lua') || key.endsWith('.bp')) && !files.has(key)) {
      files.set(key, await zip.read(entry))
    }
  }
}
const bpPaths = [...allPaths].filter((p) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(p))

// --- Die Sim-VM (Original-Engine-Boot, flaches Testgelände) -----------------
console.log('\n== Sim: ACU über die Original-Unit.lua ==')
const simHost = await LuaHost.create(files, () => {})
const engine = installEngine(simHost)
setTerrainSource(simHost, () => 20) // flaches Testgelände auf Höhe 20
// Die Blueprints der beteiligten Units über die echte Pipeline (dieselbe, die
// der Worker beim Spawn benutzt).
for (const id of ['uel0001', 'ueb0101']) {
  loadUnitBlueprint(simHost, id, files.get(`units/${id}/${id}_unit.bp`)!)
}
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
for (const zip of zips) {
  for (const [key, entry] of zip.entries) {
    if (!key.startsWith('textures/ui/') || !key.endsWith('.dds') || dims.has(key)) continue
    try {
      const dds = parseDds(await zip.read(entry))
      dims.set(key, [dds.width, dds.height])
    } catch {
      // Kaputte DDS: nicht raten.
    }
  }
}
const fonts = new FontBook()
for (const name of await readdir(`${GAME}/fonts`)) {
  if (/\.ttf$/i.test(name)) fonts.add(await readFile(`${GAME}/fonts/${name}`))
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
setupUi(uiHost)
createRootFrame(uiHost, 1920, 1080)
loadUiBlueprints(uiHost, bpPaths)
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

// --- Der Bau läuft ----------------------------------------------------------
console.log('\n== Beats: der Bau wächst, die Ökonomie zahlt ==')
const massBefore = engine.economy.army(1).mass
for (let i = 0; i < 20; i++) beat(engine)
const site1 = readLuaUnit(simHost, siteId)!
check(site1.fraction > 0, `Fortschritt nach 20 Beats: ${(site1.fraction * 100).toFixed(1)} %`)
check(site1.health > 0, `Leben wächst mit: ${site1.health.toFixed(0)} von ${site1.maxHealth}`)
const massAfter = engine.economy.army(1).mass
check(massAfter < massBefore, `Masse bezahlt: ${massBefore.toFixed(0)} → ${massAfter.toFixed(0)}`)

// Bis fertig. ueb0101: BuildTime aus dem Blueprint, ACU-BuildRate 10 →
// delta = 10/BuildTime · Rate · 0.1 pro Tick. Kein Zeitlimit erfinden: es wird
// gerechnet, bis die Sim fertig ist (oder es nie wird — dann knallt der Test).
let ticks = 20
while (readLuaUnit(simHost, siteId)!.fraction < 1 && ticks < 4000) {
  beat(engine)
  ticks++
}
const done = readLuaUnit(simHost, siteId)!
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

simHost.close()
uiHost.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nBEFEHLSKETTE BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
