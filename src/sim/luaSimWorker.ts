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
/** Die Lua-Dateien bleiben liegen — ein Reset baut daraus einen frischen Host. */
let bootFiles: Map<string, Uint8Array> | null = null

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
  | { type: 'reset'; terrain: HeightfieldData }

ctx.onmessage = async (e: MessageEvent<InMsg>): Promise<void> => {
  const msg = e.data
  if (msg.type === 'boot') {
    bootFiles = msg.files
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
  if (msg.type === 'reset') {
    if (!bootFiles) return
    await resetSession(bootFiles, msg.terrain)
    ctx.postMessage({ type: 'reset-done' })
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

/**
 * Sitzung neu aufsetzen (neue Karte/Sandbox-Neustart).
 *
 * Es reicht NICHT, die Units zu löschen: die Armee-Ökonomie hält Lager und
 * Vorrat, und jede neue ACU schenkt beim Spawn erneut ihr Lager
 * (GiveInitialResources). Ohne echten Reset stand nach dem zweiten Start das
 * doppelte Startkapital da. Also: frischer LuaHost, frischer Engine-Boot —
 * derselbe Weg wie beim ersten Mal.
 */
async function resetSession(files: Map<string, Uint8Array>, terrain: HeightfieldData): Promise<void> {
  host?.close()
  const h = await LuaHost.create(files, (level, m) => ctx.postMessage({ type: 'log', level, msg: m }))
  engine = installEngine(h)
  const hf = new Heightfield(terrain)
  setTerrainSource(h, (x, z) => hf.at(x, z))
  host = h
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
      massRequested: a.requestedMass, energyRequested: a.requestedEnergy,
    },
  })
}
