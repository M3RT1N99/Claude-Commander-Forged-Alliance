/**
 * Die Lua-VMs dürfen nicht auslaufen.
 *
 * Anlass: die UI-VM lief im Browser nach wenigen Minuten in ihre 2-GB-Grenze
 * ("Cannot enlarge memory ... not enough memory") und riss das Spiel mit.
 *
 * Ursache — gemessen, nicht geraten: **jeder Rückgabewert aus Lua nach JS bleibt
 * im wasmoon-Registry hängen** und wird vom Lua-GC nie eingesammelt. Zuwachs bei
 * 2000 Aufrufen, jeweils NACH einem collectgarbage("collect"):
 *
 *   Tabelle zurückgeben       156,6 MB   ← der maui-Snapshot, 60× pro Sekunde
 *   JSON-String zurückgeben    24,9 MB
 *   Aufruf ohne Rückgabewert    0,0 MB
 *   Lua ruft eine JS-Funktion   0,0 MB   ← der Weg, den wir jetzt gehen
 *
 * Deshalb liefern die Heiß-Pfade (maui-Snapshot, Unit-Zustand) ihre Daten als
 * JSON-String an eine JS-Funktion (LuaHost.pull). Dieser Test hält das fest:
 * er fährt tausend Frames und prüft, dass der Lua-Heap NICHT wächst.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-vm-memory.ts
 */
import { readdir, readFile } from 'node:fs/promises'
import { LuaHost } from '../src/lua/host'
import {
  installUiEngine,
  setupUi,
  setupGameUi,
  createRootFrame,
  loadUiBlueprints,
} from '../src/lua/uiEngine'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit } from '../src/lua/unitFactory'
import { findFiles } from '../src/vfs/glob'
import { parseDds } from '../src/formats/dds'
import { FontBook } from '../src/ui/fonts'
import { GameFiles, GAME_DIR } from './gameFiles'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const game = await GameFiles.open()

// --- Die UI-VM: 1000 Frames rendern ----------------------------------------
console.log('\n== UI-VM: 1000 Frames (der Renderer zieht den maui-Snapshot) ==')
const dims = new Map<string, [number, number]>()
for (const key of game.paths) {
  if (!key.startsWith('textures/ui/') || !key.endsWith('.dds')) continue
  try {
    const d = parseDds(await game.read(key))
    dims.set(key, [d.width, d.height])
  } catch {
    // Kaputte DDS: nicht raten.
  }
}
const fonts = new FontBook()
for (const n of await readdir(`${GAME_DIR}/fonts`)) {
  if (/\.ttf$/i.test(n)) fonts.add(await readFile(`${GAME_DIR}/fonts/${n}`))
}

const ui = await LuaHost.create(game.luaFiles, () => {})
installUiEngine(ui, {
  exists: (p) => game.exists(p),
  find: (dir, pattern) => findFiles(game.paths, dir, pattern),
  textureSize: (p) => dims.get(p) ?? null,
  stringAdvance: (t, f, s) => fonts.advance(t, f, s),
  fontMetrics: (f, s) => fonts.metrics(f, s),
})
setupUi(ui)
createRootFrame(ui, 1920, 1080)
loadUiBlueprints(ui, [...game.paths].filter((p) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(p)))
setupGameUi(ui, () => {})
ui.setGlobal('__uiSimCommand', () => {})
ui.eval(`__uiSetUnit(1, 'uel0001', 1, 100, 20, 100, 12000, 12000, 1, true)`)
ui.eval('__uiSelectByIds({ 1 })')

const heapMb = (h: LuaHost): number => {
  h.eval('collectgarbage("collect")')
  return Number(h.eval('return collectgarbage("count")')) / 1024
}

// Einlaufen lassen (die ersten Frames legen Caches an), dann messen.
for (let i = 0; i < 50; i++) {
  ui.eval('__mauiFrame(0.016)')
  ui.pull('__mauiSnapshotJson()')
}
const uiBefore = heapMb(ui)
for (let i = 0; i < 1000; i++) {
  ui.eval('__mauiFrame(0.016)')
  ui.pull('__mauiSnapshotJson()')
}
const uiAfter = heapMb(ui)
const uiGrowth = uiAfter - uiBefore
console.log(`  · Lua-Heap ${uiBefore.toFixed(1)} MB → ${uiAfter.toFixed(1)} MB`)
// Ein bisschen Rauschen ist normal (Caches, Strings). Ein LECK sieht anders aus:
// die alte Fassung wuchs pro 1000 Frames um ~78 MB.
check(uiGrowth < 5, `UI-VM wächst über 1000 Frames um ${uiGrowth.toFixed(1)} MB (Grenze: 5)`)

const snapshot = ui.pull<{ id: number }[]>('__mauiSnapshotJson()')
check(snapshot.length > 50, `Der JSON-Snapshot trägt ${snapshot.length} Controls (er ist echt)`)

// --- Die Sim-VM: 1000 Beats -------------------------------------------------
console.log('\n== Sim-VM: 1000 Beats (der Worker zieht den Unit-Zustand) ==')
const sim = await LuaHost.create(game.luaFiles, () => {})
const engine = installEngine(sim)
setTerrainSource(sim, () => 20)
await game.giveUnit(sim, 'uel0001')
spawnLuaUnit(sim, 'uel0001', { x: 100, y: 20, z: 100 }, 1)

for (let i = 0; i < 50; i++) {
  beat(engine)
  sim.pull('__readAllUnitsJson()')
}
const simBefore = heapMb(sim)
for (let i = 0; i < 1000; i++) {
  beat(engine)
  sim.pull('__readAllUnitsJson()')
}
const simAfter = heapMb(sim)
const simGrowth = simAfter - simBefore
console.log(`  · Lua-Heap ${simBefore.toFixed(1)} MB → ${simAfter.toFixed(1)} MB`)
check(simGrowth < 5, `Sim-VM wächst über 1000 Beats um ${simGrowth.toFixed(1)} MB (Grenze: 5)`)

const units = sim.pull<{ id: number; name: string }[]>('__readAllUnitsJson()')
check(units.length === 1 && units[0]!.name === 'uel0001', 'Der JSON-Zustand trägt die ACU')

ui.close()
sim.close()
await game.close()
console.log(failures === 0 ? '\nVM-SPEICHER BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
