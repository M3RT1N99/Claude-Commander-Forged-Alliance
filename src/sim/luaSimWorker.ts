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
import type { MapPropSpawn } from './luaSimClient'

const ctx = self as unknown as Worker
let host: LuaHost | null = null
let engine: Engine | null = null
/** Die Lua-Dateien bleiben liegen — ein Reset baut daraus einen frischen Host. */
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
  | { type: 'boot'; files: Map<string, Uint8Array>; terrain: HeightfieldData; props?: MapPropSpawn[] }
  | { type: 'spawn'; reqId: number; id: string; scriptPath: string; scriptBytes: Uint8Array | null; bpBytes: Uint8Array | null; bones: SimBone[]; pos: Vec3; army: number }
  | { type: 'move'; id: number; x: number; z: number; queue?: boolean }
  | { type: 'stop'; id: number }
  // Attack (Dispatch 0x0A, CAttackTargetTask): in Waffenreichweite fahren,
  // Waffen aufs Befehlsziel.
  | { type: 'attack'; id: number; targetId: number; queue?: boolean }
  // Ground attack: the same dispatch (0x0A) with an AITARGET_Ground target
  // (CAiTarget carries a position, Cfile:812553-812563); never self-completes.
  | { type: 'attackGround'; id: number; x: number; z: number; queue?: boolean }
  // Guard/assist (dispatch 0x0F, CUnitGuardTask ctor Cfile:836763-837080).
  | { type: 'guard'; id: number; targetId: number; queue?: boolean }
  // Patrol (dispatch 0x10, CUnitPatrolTask): one leg; the loop is the
  // queue's ring rotation (sim-core.md:243-252).
  | { type: 'patrol'; id: number; x: number; z: number; queue?: boolean }
  // Repair (dispatch 0x14): resume building an unfinished structure.
  | { type: 'repair'; id: number; targetId: number; queue?: boolean }
  // SetFireState: the UI ASKS the sim via the sim driver (cfunc_SetFireStateL:
  // sSimDriver->ProcessInfo(entityId, "SetFireState", value)). EFireState
  // Cfile:702842-702850: ReturnFire=0, HoldFire=1, HoldGround=2.
  | { type: 'fireState'; id: number; state: number }
  // Der Sammelpunkt einer Fabrik (IssueFactoryRallyPoint, Cfile:1008266) — KEIN
  // Bewegungsbefehl: die Fabrik bleibt stehen.
  | { type: 'rally'; id: number; x: number; y: number; z: number }
  | { type: 'reset'; terrain: HeightfieldData; props?: MapPropSpawn[] }
  // Reclaim (dispatch 0x13, CUnitReclaimTask): drain the prop target —
  // either a sim prop id (wrecks) or a map-prop instance index.
  | { type: 'reclaim'; id: number; targetId?: number; mapIndex?: number; queue?: boolean }
  // SessionRequestPause/SessionResume (mHelp: „Pause the world simulation.").
  // Die Engine hält die WELT an — der Beat läuft nicht weiter, die UI schon.
  | { type: 'pause'; paused: boolean }
  // Ein Bau-Befehl: Baustelle setzen (CreateUnit mit beingBuilt=1, wie
  // Sim::CreateUnit es tut) und dem Bauer den Auftrag geben.
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
      /** Shift gehalten? Dann wird der Auftrag an die Bau-Reihe ANGEHÄNGT. */
      queue: boolean
    }
  // Fabrik-Auftrag (IssueBlueprintCommand "UNITCOMMAND_BuildFactory"): die
  // Einheit geht in die Warteschlange, die Fabrik arbeitet sie im Beat ab.
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
  // Cfile:1257266 / DecreaseCommandCount Cfile:1257378): einen Eintrag der
  // Fabrik-Warteschlange um delta aendern; <= 0 entfernt ihn.
  | { type: 'adjustQueue'; factoryId: number; index: number; delta: number }
  // Ein Emitter-Blueprint fuer das Partikelsystem: die Sim hat alle 2724
  // _emit.bp beim Boot geparst (__registered.Emitter) — der Renderer holt
  // sie lazy, statt sie selbst noch einmal zu laden.
  | { type: 'emitterBp'; reqId: number; bp: string }
  // Ein Mesh-Blueprint (Wrack-Varianten aus ExtractWreckageBlueprint,
  // lua/system/blueprints.lua:187): ShaderName/SpecularName fuer den Renderer.
  | { type: 'meshBp'; reqId: number; bp: string }
  // SimCallback der UI (Cfile:1359123): eine Funktion aus lua/simcallbacks.lua
  // in der Sim rufen. argsLua ist der Serialisierungs-Snapshot der UI-VM als
  // Lua-Konstruktor-Literal (SCR_ToByteStream-Aequivalent), die Auswahl kommt
  // als Entity-IDs.
  | { type: 'simCallback'; func: string; argsLua: string; unitIds: number[] }

/**
 * Spawn the scmap map props in chunked evals (a single Lua literal for
 * ~46k props would be a multi-megabyte chunk). Unknown blueprints WARN
 * once per path inside __spawnMapProp and are skipped.
 */
function spawnMapProps(h: LuaHost, props: MapPropSpawn[]): void {
  const CHUNK = 500
  for (let i = 0; i < props.length; i += CHUNK) {
    const calls: string[] = []
    for (const p of props.slice(i, i + CHUNK)) {
      const bp = p.bp.toLowerCase().replace(/^\//, '')
      calls.push(
        `__spawnMapProp(${p.index}, ${JSON.stringify('/' + bp)}, ${p.x}, ${p.y}, ${p.z}, ${p.heading})`,
      )
    }
    h.eval(calls.join('\n'))
  }
  if (props.length > 0) {
    // The engine logs " NUM PROPS = %d" after its creation loop
    // (Cfile:1072082).
    const n = Number(
      h.eval(`local n = 0 for _, p in pairs(__props) do if p.__mapIndex then n = n + 1 end end return n`),
    )
    ctx.postMessage({ type: 'log', level: 'INFO', msg: `NUM PROPS = ${n} (of ${props.length} scmap entries)` })
  }
}

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
    // ALLE Projektil- und Prop-Blueprints, VOR dem ersten Schuss. Die Engine
    // lädt beim Start ebenfalls alles (Blueprints.lua über DiskFindFiles) —
    // mitten im Tick kann eine Waffe nichts nachladen.
    loadBlueprintGroups(h, msg.files)
    // Map props BEFORE any unit spawn — the engine creates them in
    // Sim::Setup step 7, after the armies and before Lua BeginSession
    // (Cfile:1072041-1072105).
    spawnMapProps(h, msg.props ?? [])
    host = h
    ctx.postMessage({ type: 'booted' })
    setInterval(tickAndPost, 100) // 10-Hz-Sim-Beat im Worker-Thread
    return
  }
  if (msg.type === 'reset') {
    if (!bootFiles) return
    await resetSession(bootFiles, msg.terrain)
    if (host) spawnMapProps(host, msg.props ?? [])
    ctx.postMessage({ type: 'reset-done' })
    return
  }
  if (msg.type === 'pause') {
    paused = msg.paused
    return
  }
  if (!host) return
  // Script, Blueprint und Skelett muessen in der Sim liegen, BEVOR eine Unit
  // dieses Typs entsteht — auch wenn die Fabrik sie spaeter selbst spawnt.
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
      // Reihenfolge wie in der Engine: erst die Baustelle (Sim::CreateUnit mit
      // beingBuilt=1), dann der Auftrag an den Bauer (OnStartBuild/'MobileBuild').
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
    // __emitterBpJson liefert JSON (oder 'null') — pull parst direkt.
    const bp = host.pull<unknown>(`__emitterBpJson(${JSON.stringify(msg.bp)})`)
    ctx.postMessage({ type: 'emitterBp', reqId: msg.reqId, bp })
  } else if (msg.type === 'meshBp') {
    const bp = host.pull<unknown>(`__meshBpJson(${JSON.stringify(msg.bp)})`)
    ctx.postMessage({ type: 'meshBp', reqId: msg.reqId, bp })
  } else if (msg.type === 'simCallback') {
    // KEIN host.call mit Objekten (wasmoon reicht sie als userdata durch,
    // nicht als Lua-Tabelle) — das Args-Literal wertet die Lua-Seite aus.
    const ids = msg.unitIds.map((n) => Math.floor(n)).join(',')
    host.eval(`__simCallback(${JSON.stringify(msg.func)}, ${msg.argsLua}, { ${ids} })`)
  } else if (msg.type === 'move') {
    // Der Befehls-Dispatch (IAiCommandDispatchImpl::DispatchTask @0x608EF0):
    // ein Move ERSETZT die Arbeit — laufender Bau bricht mit der vollen
    // Abbruch-Kette ab (Cfile:814989), erst dann kommt das Navigator-Ziel.
    // Shift (queue) appends instead: clear = NOT shift (Cfile:1240965).
    host.eval(`__dispatchMove(${msg.id}, ${msg.x}, ${msg.z}, ${msg.queue ? 'false' : 'true'})`)
  } else if (msg.type === 'rally') {
    host.eval(`local u=__units[${msg.id}]; if u then u:SetRallyPoint({ ${msg.x}, ${msg.y}, ${msg.z} }) end`)
  } else if (msg.type === 'stop') {
    host.eval(`__dispatchStop(${msg.id})`)
  } else if (msg.type === 'attack') {
    host.eval(`__dispatchAttack(${msg.id}, ${msg.targetId}, ${msg.queue ? 'false' : 'true'})`)
  } else if (msg.type === 'attackGround') {
    host.eval(`__dispatchAttackGround(${msg.id}, ${msg.x}, ${msg.z}, ${msg.queue ? 'false' : 'true'})`)
  } else if (msg.type === 'guard') {
    host.eval(`__dispatchGuard(${msg.id}, ${msg.targetId}, ${msg.queue ? 'false' : 'true'})`)
  } else if (msg.type === 'patrol') {
    host.eval(`__dispatchPatrol(${msg.id}, ${msg.x}, ${msg.z}, ${msg.queue ? 'false' : 'true'})`)
  } else if (msg.type === 'reclaim') {
    if (msg.mapIndex !== undefined) {
      host.eval(`__dispatchReclaimMapProp(${msg.id}, ${msg.mapIndex}, ${msg.queue ? 'false' : 'true'})`)
    } else {
      host.eval(`__dispatchReclaim(${msg.id}, ${msg.targetId}, ${msg.queue ? 'false' : 'true'})`)
    }
  } else if (msg.type === 'repair') {
    host.eval(`__dispatchRepair(${msg.id}, ${msg.targetId}, ${msg.queue ? 'false' : 'true'})`)
  } else if (msg.type === 'fireState') {
    // No task, no queue: fire state is unit state, not a command
    // (Unit::SetFireState — weapons read it every tick, weapons.lua:89/229).
    host.eval(`local u=__units[${msg.id}]; if u then u:SetFireState(${msg.state}) end`)
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
    // `/effects/entities/**` sind ebenfalls ProjectileBlueprints: die Trümmer
    // beim Tod (defaultexplosions.lua:285) und die Nuke-Effekt-Controller.
    if (path.startsWith('projectiles/') || path.startsWith('effects/')) proj.push(path)
    // props/** are the wreck blueprints; env/**_prop.bp are the 334 map
    // props (rocks, trees) — Sim::Setup creates one prop per scmap entry.
    else if (path.startsWith('props/') || (path.startsWith('env/') && path.endsWith('_prop.bp')))
      props.push(path)
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
  // Pause: kein Beat. Der Zustand wird trotzdem gemeldet — die UI zeigt weiter
  // an, was steht (die Engine rendert im Pausenzustand auch weiter).
  if (paused) return
  // Ein Sim-Beat: Bau-Bedarf → Ökonomie → gewährte Rate → Lua-Threads → Physik.
  beat(engine)
  // Der Zustand kommt als JSON-STRING (LuaHost.pull), nicht als Rückgabewert:
  // eine zurückgegebene Lua-Tabelle bleibt im wasmoon-Registry hängen und wird
  // nie eingesammelt — bei 10 Beats/s läuft die Sim-VM sonst langsam voll.
  // (Nebenwirkung, die damit auch weg ist: eine LEERE Tabelle kam als `{}` statt
  // `[]` an, und der Main-Thread starb an "m.units is not iterable".)
  const units = host.pull<unknown[]>('__readAllUnitsJson()')
  // Die PROJEKTILE gehoeren zum Zustand: die Engine zeichnet jeden Schuss
  // (CUIWorldView rendert die Sim-Entities). Ohne diesen Kanal ist der Kampf
  // im Browser unsichtbar — die Sim schiesst, und niemand sieht es.
  const projectiles = host.pull<unknown[]>('__readAllProjectilesJson()')
  // Die EMITTER (Muendungsfeuer, Trails, Bau-/Einschlag-Effekte): die Sim
  // rechnet ihre Weltposition (Owner + Knochen), das Partikelsystem zeichnet.
  const emitters = host.pull<unknown[]>('__readAllEmittersJson()')
  // Die PROPS (Wracks): Unit.OnKilled → CreateWreckageProp → CreateProp laeuft
  // komplett in der Original-Lua; ohne diesen Kanal bleibt jedes Wrack unsichtbar.
  const props = host.pull<unknown[]>('__readAllPropsJson()')
  // Map-prop instances that died this beat — the instanced renderer hides
  // them (map props are NOT serialized per beat, only their removals).
  const removedMapProps = host.pull<number[]>('__drainRemovedMapPropsJson()')
  // Sim->user audio requests (SAudioRequest analog: EntitySound=0,
  // StartLoop=1, StopLoop=2) — weapon fire, unit ambient loops.
  const audio = host.pull<unknown[]>('__drainAudioRequestsJson()')
  const a = engine.economy.army(1)
  // Der SIM-TICK gehoert zum Zustand: die Spielzeit-Uhr der UI (score.lua:230,
  // GetGameTime) zaehlt in Sim-Ticks und steht bei Pause still.
  const tick = Number(host.eval('return __gameTick'))
  ctx.postMessage({
    type: 'states',
    tick,
    units,
    projectiles,
    emitters,
    props,
    removedMapProps,
    audio,
    economy: {
      mass: a.mass, massStorage: a.maxMass, massIncome: a.incomeMass, massExpense: a.expenseMass,
      energy: a.energy, energyStorage: a.maxEnergy, energyIncome: a.incomeEnergy, energyExpense: a.expenseEnergy,
      massRequested: a.requestedMass, energyRequested: a.requestedEnergy,
    },
  })
}
