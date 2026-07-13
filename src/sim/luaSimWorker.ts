/// <reference lib="webworker" />
/**
 * Web-Worker: hostet die eingebettete Original-Lua-Engine in einem eigenen
 * Thread. So blockiert die synchrone Lua-VM-Auswertung (Boot + OnCreate-Kaskade
 * + Beat) NICHT den Renderer — der frühere Boot-Freeze verschwindet.
 *
 * Der Worker treibt den 10-Hz-Beat (Ökonomie → Lua-Threads → Physik) per Timer
 * und postet nach jedem Beat die Unit-Zustände + Armee-Ökonomie an den
 * Main-Thread, der nur noch rendert. Kommandos (spawn/move/stop) kommen als
 * Nachrichten herein.
 */
import { LuaHost } from '../lua/host'
import { installEngine, beat, type Engine } from '../lua/engine'
import { loadUnitBlueprint, spawnLuaUnit } from '../lua/unitFactory'
import { setTerrainSource } from '../lua/engineGlobals'
import { Heightfield, type HeightfieldData } from './terrain'

const ctx = self as unknown as Worker
let host: LuaHost | null = null
let engine: Engine | null = null

interface Vec3 {
  x: number
  y: number
  z: number
}
type InMsg =
  | { type: 'boot'; files: Map<string, Uint8Array>; terrain: HeightfieldData }
  | { type: 'spawn'; reqId: number; id: string; scriptPath: string; scriptBytes: Uint8Array | null; bpBytes: Uint8Array | null; pos: Vec3; army: number }
  | { type: 'move'; id: number; x: number; z: number }
  | { type: 'stop'; id: number }

ctx.onmessage = async (e: MessageEvent<InMsg>): Promise<void> => {
  const msg = e.data
  if (msg.type === 'boot') {
    const h = await LuaHost.create(msg.files, (level, m) => ctx.postMessage({ type: 'log', level, msg: m }))
    // Der EINE Engine-Boot — derselbe wie in jeder Testsuite. Vorher stellte
    // sich der Worker die Engine selbst zusammen und vergaß dabei das
    // Bau-System (build.ts lief im Browser überhaupt nicht).
    engine = installEngine(h)
    // Das Gelände der geladenen Karte, VOR dem ersten Spawn: OnCreate-Pfade der
    // Original-Lua lesen GetSurfaceHeight, und ohne Quelle knallt es jetzt (statt
    // still 0 zu liefern). Dieselbe bilineare Abfrage wie im Renderer.
    const hf = new Heightfield(msg.terrain)
    setTerrainSource(h, (x, z) => hf.at(x, z))
    host = h
    ctx.postMessage({ type: 'booted' })
    setInterval(tickAndPost, 100) // 10-Hz-Sim-Beat im Worker-Thread
    return
  }
  if (!host) return
  if (msg.type === 'spawn') {
    try {
      if (msg.scriptBytes && !host.hasFile(msg.scriptPath)) host.addFile(msg.scriptPath, msg.scriptBytes)
      if (msg.bpBytes) loadUnitBlueprint(host, msg.id, msg.bpBytes)
      const uid = spawnLuaUnit(host, msg.id, msg.pos, msg.army)
      ctx.postMessage({ type: 'spawned', reqId: msg.reqId, uid })
    } catch (err) {
      ctx.postMessage({ type: 'spawnError', reqId: msg.reqId, error: (err as Error).message })
    }
  } else if (msg.type === 'move') {
    host.eval(`local u=__units[${msg.id}]; if u then u:GetNavigator():SetGoal({ ${msg.x}, 0, ${msg.z} }) end`)
  } else if (msg.type === 'stop') {
    host.eval(`local u=__units[${msg.id}]; if u then u:GetNavigator():AbortMove() end`)
  }
}

function tickAndPost(): void {
  if (!host || !engine) return
  // Ein Sim-Beat: Bau-Bedarf → Ökonomie → gewährte Rate → Lua-Threads → Physik.
  beat(engine)
  const units = host.eval('return __readAllUnits()')
  const a = engine.economy.army(1)
  ctx.postMessage({
    type: 'states',
    units,
    economy: {
      mass: a.mass, massStorage: a.maxMass, massIncome: a.incomeMass, massExpense: a.expenseMass,
      energy: a.energy, energyStorage: a.maxEnergy, energyIncome: a.incomeEnergy, energyExpense: a.expenseEnergy,
    },
  })
}
