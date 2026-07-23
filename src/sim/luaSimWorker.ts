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
import { queueFactoryBuild } from './build'
import {
  loadUnitBlueprint,
  loadProjectileBlueprints,
  loadPropBlueprints,
  spawnLuaUnit,
  spawnBuildSite,
  setUnitBones,
  type SimBone,
} from '../lua/unitFactory'
import { setTerrainSource } from '../lua/engineGlobals'
import { Heightfield, type HeightfieldData } from './terrain'

const ctx = self as unknown as Worker
let host: LuaHost | null = null
let engine: Engine | null = null
/** The Lua files remain there - a reset creates a fresh host from them. */
let bootFiles: Map<string, Uint8Array> | null = null
/**
 * Pause: die WELT steht (CWldSession::RequestPause). Der Beat setzt aus — kein
 * Tick, keine Ökonomie, keine Threads. Die UI läuft weiter (sie hat ihre eigene
 * VM und ihren eigenen Frame-Takt), genau wie im Original.
 */
let paused = false

interface Vec3 {
  x: number
  y: number
  z: number
}
type InMsg =
  | { type: 'boot'; files: Map<string, Uint8Array>; terrain: HeightfieldData }
  | { type: 'spawn'; reqId: number; id: string; scriptPath: string; scriptBytes: Uint8Array | null; bpBytes: Uint8Array | null; bones: SimBone[]; pos: Vec3; army: number }
  | { type: 'move'; id: number; x: number; z: number; queue?: boolean }
  | { type: 'stop'; id: number }
  // Attack (Dispatch 0x0A, CAttackTargetTask): in Waffenreichweite fahren,
  // Waffen aufs Befehlsziel.
  | { type: 'attack'; id: number; targetId: number; queue?: boolean }
  // Repair (dispatch 0x14): resume building an unfinished structure.
  | { type: 'repair'; id: number; targetId: number; queue?: boolean }
  // A factory's rally point (IssueFactoryRallyPoint, Cfile:1008266) — NONE
  // Movement order: the factory stops.
  | { type: 'rally'; id: number; x: number; y: number; z: number }
  | { type: 'reset'; terrain: HeightfieldData }
  // SessionRequestPause/SessionResume (mHelp: “Pause the world simulation.”).
  // The engine stops the WORLD — the beat doesn't continue, but the UI does.
  | { type: 'pause'; paused: boolean }
  // A build command: Set construction site (CreateUnit with beingBuilt=1, like
  // Sim::CreateUnit does) and give the order to the farmer.
  | {
      type: 'build'
      reqId: number
      builderId: number
      id: string
      scriptPath: string
      scriptBytes: Uint8Array | null
      bpBytes: Uint8Array | null
      bones: SimBone[]
      pos: Vec3
      army: number
      /** Shift held? The order is then ATTACHED to the construction series. */
      queue: boolean
    }
  // Factory order (IssueBlueprintCommand "UNITCOMMAND_BuildFactory"): the
  // Unit goes into the queue, the factory processes it in beat.
  | {
      type: 'factoryBuild'
      factoryId: number
      id: string
      scriptPath: string
      scriptBytes: Uint8Array | null
      bpBytes: Uint8Array | null
      bones: SimBone[]
      count: number
    }
  // Increase/DecreaseBuildCountInQueue (Moho::ISSUE_IncreaseCommandCount
  // Cfile:1257266 / DecreaseCommandCount Cfile:1257378): an entry of the
  // change factory queue by delta; <= 0 removes it.
  | { type: 'adjustQueue'; factoryId: number; index: number; delta: number }
  // An emitter blueprint for the particle system: the sim has all 2724
  // _emit.bp parsed on boot (__registered.Emitter) — the renderer fetches
  // Lazy them instead of reloading them yourself.
  | { type: 'emitterBp'; reqId: number; bp: string }
  // A mesh blueprint (wreck variants from ExtractWreckageBlueprint,
  // lua/system/blueprints.lua:187): ShaderName/SpecularName for the renderer.
  | { type: 'meshBp'; reqId: number; bp: string }
  // SimCallback of the UI (Cfile:1359123): a function from lua/simcallbacks.lua
  // call in the sim. argsLua is the serialization snapshot of the UI VM as
  // Lua constructor literal (SCR_ToByteStream equivalent), the choice comes
  // as entity IDs.
  | { type: 'simCallback'; func: string; argsLua: string; unitIds: number[] }

ctx.onmessage = async (e: MessageEvent<InMsg>): Promise<void> => {
  const msg = e.data
  if (msg.type === 'boot') {
    bootFiles = msg.files
    const h = await LuaHost.create(msg.files, (level, m) => ctx.postMessage({ type: 'log', level, msg: m }))
    // The ONE engine boot — the same as in every test suite. Before presented
    // The worker put the engine together himself and forgot about it
    // Construction system (build.ts didn't run in the browser at all).
    engine = installEngine(h)
    // The terrain of the loaded map, BEFORE the first spawn: OnCreate paths of the
    // Original Lua read GetSurfaceHeight, and without source it now pops (instead of
    // silently deliver 0). Same bilinear query as in the renderer.
    const hf = new Heightfield(msg.terrain)
    setTerrainSource(h, (x, z) => hf.at(x, z))
    // ALL projectile and prop blueprints, BEFORE the first shot. The engine
    // also loads everything at startup (Blueprints.lua via DiskFindFiles) —
    // In the middle of a tick, a weapon cannot reload anything.
    loadBlueprintGroups(h, msg.files)
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
  if (msg.type === 'pause') {
    paused = msg.paused
    return
  }
  if (!host) return
  // Script, blueprint and skeleton must be in the sim BEFORE a unit
  // of this type is created - even if the factory itself spawns them later.
  const prepare = (m: { id: string; scriptPath: string; scriptBytes: Uint8Array | null; bpBytes: Uint8Array | null; bones: SimBone[] }): void => {
    if (!host) return
    if (m.scriptBytes && !host.hasFile(m.scriptPath)) host.addFile(m.scriptPath, m.scriptBytes)
    if (m.bpBytes) loadUnitBlueprint(host, m.id, m.bpBytes)
    setUnitBones(host, m.id, m.bones ?? [])
  }
  if (msg.type === 'spawn') {
    try {
      prepare(msg)
      const uid = spawnLuaUnit(host, msg.id, msg.pos, msg.army)
      ctx.postMessage({ type: 'spawned', reqId: msg.reqId, uid })
    } catch (err) {
      ctx.postMessage({ type: 'spawnError', reqId: msg.reqId, error: (err as Error).message })
    }
  } else if (msg.type === 'build') {
    try {
      prepare(msg)
      // Sequence as in the engine: first the construction site (Sim::CreateUnit with
      // beingBuilt=1), then the order to the builder (OnStartBuild/'MobileBuild').
      const uid = spawnBuildSite(host, msg.id, msg.pos, msg.army)
      host.eval(`__issueBuildTask(${msg.builderId}, ${uid}, nil, ${!msg.queue})`)
      ctx.postMessage({ type: 'spawned', reqId: msg.reqId, uid })
    } catch (err) {
      ctx.postMessage({ type: 'spawnError', reqId: msg.reqId, error: (err as Error).message })
    }
  } else if (msg.type === 'factoryBuild') {
    prepare(msg)
    queueFactoryBuild(host, msg.factoryId, msg.id, msg.count)
  } else if (msg.type === 'adjustQueue') {
    host.eval(`__adjustFactoryQueue(${msg.factoryId}, ${msg.index}, ${msg.delta})`)
  } else if (msg.type === 'emitterBp') {
    // __emitterBpJson returns JSON (or 'null') — pull parses directly.
    const bp = host.pull<unknown>(`__emitterBpJson(${JSON.stringify(msg.bp)})`)
    ctx.postMessage({ type: 'emitterBp', reqId: msg.reqId, bp })
  } else if (msg.type === 'meshBp') {
    const bp = host.pull<unknown>(`__meshBpJson(${JSON.stringify(msg.bp)})`)
    ctx.postMessage({ type: 'meshBp', reqId: msg.reqId, bp })
  } else if (msg.type === 'simCallback') {
    // NO host.call with objects (wasmoon passes them as userdata,
    // not as a Lua table) — the Args literal evaluates the Lua page.
    const ids = msg.unitIds.map((n) => Math.floor(n)).join(',')
    host.eval(`__simCallback(${JSON.stringify(msg.func)}, ${msg.argsLua}, { ${ids} })`)
  } else if (msg.type === 'move') {
    // The command dispatch (IAiCommandDispatchImpl::DispatchTask @0x608EF0):
    // a move REPLACES the work - ongoing construction breaks with the full one
    // Abort chain ends (Cfile:814989), only then does the navigator destination come.
    // Shift (queue) appends instead: clear = NOT shift (Cfile:1240965).
    host.eval(`__dispatchMove(${msg.id}, ${msg.x}, ${msg.z}, ${msg.queue ? 'false' : 'true'})`)
  } else if (msg.type === 'rally') {
    host.eval(`local u=__units[${msg.id}]; if u then u:SetRallyPoint({ ${msg.x}, ${msg.y}, ${msg.z} }) end`)
  } else if (msg.type === 'stop') {
    host.eval(`__dispatchStop(${msg.id})`)
  } else if (msg.type === 'attack') {
    host.eval(`__dispatchAttack(${msg.id}, ${msg.targetId}, ${msg.queue ? 'false' : 'true'})`)
  } else if (msg.type === 'repair') {
    host.eval(`__dispatchRepair(${msg.id}, ${msg.targetId}, ${msg.queue ? 'false' : 'true'})`)
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
  loadBlueprintGroups(h, files)
  host = h
}

/**
 * Projektil- und Prop-Blueprints registrieren (die echte Pipeline,
 * `LoadBlueprints()`). Beides ist Voraussetzung für den Kampf: ohne
 * Projektil-Blueprint knallt `CreateProjectile` („Invalid blueprint",
 * Cfile:930793), ohne Prop-Blueprint gibt es kein Wrack.
 */
function loadBlueprintGroups(h: LuaHost, files: Map<string, Uint8Array>): void {
  const proj: string[] = []
  const props: string[] = []
  for (const path of files.keys()) {
    if (!path.endsWith('.bp')) continue
    // `/effects/entities/**` are also ProjectileBlueprints: the rubble
    // at death (defaultexplosions.lua:285) and the Nuke effect controller.
    if (path.startsWith('projectiles/') || path.startsWith('effects/')) proj.push(path)
    else if (path.startsWith('props/')) props.push(path)
  }
  const nProj = loadProjectileBlueprints(h, proj)
  const nProps = loadPropBlueprints(h, props)
  ctx.postMessage({
    type: 'log',
    level: 'INFO',
    msg: `Sim: ${nProj} Projektil-Blueprints, ${nProps} Prop-Blueprints`,
  })
}

function tickAndPost(): void {
  if (!host || !engine) return
  // Break: no beat. The status is still reported — the UI continues to show
  // what is there (the engine continues to render when paused).
  if (paused) return
  // A sim beat: construction needs → economics → granted rate → Lua threads → physics.
  beat(engine)
  // The state comes as a JSON STRING (LuaHost.pull), not as a return value:
  // a returned Lua table is stuck in the wasmoon registry and becomes
  // never collected - at 10 beats/s the Sim VM would otherwise slowly fill up.
  // (Side effect that is also gone: an EMPTY table appeared as `{}`
  // `[]`, and the main thread died because of "m.units is not iterable".)
  const units = host.pull<unknown[]>('__readAllUnitsJson()')
  // The PROJECTILES belong to the state: the engine records every shot
  // (CUIWorldView renders the sim entities). Without this channel there is a fight
  // Invisible in the browser - the sim shoots and no one sees it.
  const projectiles = host.pull<unknown[]>('__readAllProjectilesJson()')
  // The EMITTERS (muzzle flashes, trails, construction/impact effects): the sim
  // calculates their world position (owner + bones), draws the particle system.
  const emitters = host.pull<unknown[]>('__readAllEmittersJson()')
  // The PROPS (wrecks): Unit.OnKilled → CreateWreckageProp → CreateProp is running
  // completely in the original Lua; Without this channel, any wreck remains invisible.
  const props = host.pull<unknown[]>('__readAllPropsJson()')
  const a = engine.economy.army(1)
  // The SIM-TICK belongs to the state: the game time clock of the UI (score.lua:230,
  // GetGameTime) counts in Sim ticks and stands still when paused.
  const tick = Number(host.eval('return __gameTick'))
  ctx.postMessage({
    type: 'states',
    tick,
    units,
    projectiles,
    emitters,
    props,
    economy: {
      mass: a.mass, massStorage: a.maxMass, massIncome: a.incomeMass, massExpense: a.expenseMass,
      energy: a.energy, energyStorage: a.maxEnergy, energyIncome: a.incomeEnergy, energyExpense: a.expenseEnergy,
      massRequested: a.requestedMass, energyRequested: a.requestedEnergy,
    },
  })
}
