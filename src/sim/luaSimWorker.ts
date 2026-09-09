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
import { beginSession, type SessionInfo } from './session'
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
import { Heightfield, terrainTypeSampler, type HeightfieldData } from './terrain'
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
/**
 * Resolves the boot's wait for the client's unit payloads. The round trip
 * exists because `BeginSession()` creates units and the Sim cannot load a
 * blueprint mid-tick — see the comment at the call site.
 */
let unitsResolve: ((units: UnitPrep[]) => void) | null = null
/** Army start positions, from the map's markers via SetArmyStart. */
let starts: { army: number; x: number; z: number }[] = []

interface Vec3 {
  x: number
  y: number
  z: number
}
/** What `prepare()` needs to make a blueprint spawnable in the Sim. */
export interface UnitPrep {
  id: string
  scriptPath: string
  scriptBytes: Uint8Array | null
  bpBytes: Uint8Array | null
  bones: SimBone[]
}
type InMsg =
  // `waterElevation` is the map's water surface, or undefined when the map has
  // no water — the Sim needs it for GetSurfaceHeight, the motion layer rule and
  // projectile water impacts. Absent water means -10000, matching
  // Entity::GetStartingLayer (Cfile:857506-857510).
  | { type: 'boot'; files: Map<string, Uint8Array>; terrain: HeightfieldData; waterElevation?: number; props?: MapPropSpawn[]; session?: SessionInfo }
  // The client's answer to 'needUnits': one payload per blueprint the session
  // start named, so `prepare()` can put script, blueprint and skeleton in
  // place before `BeginSession()` creates the unit.
  | { type: 'units'; units: UnitPrep[] }
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
  // Capture (UNITCOMMAND_Capture, CUnitCaptureTask): take the enemy unit over.
  | { type: 'capture'; id: number; targetId: number; queue?: boolean }
  | { type: 'transportLoad'; ids: number[]; transportId: number; queue?: boolean }
  | { type: 'transportReverseLoad'; transportIds: number[]; targetId: number; queue?: boolean }
  | { type: 'transportUnload'; id: number; x: number; z: number; queue?: boolean }
  // SetFireState: the UI ASKS the sim via the sim driver (cfunc_SetFireStateL:
  // sSimDriver->ProcessInfo(entityId, "SetFireState", value)). EFireState
  // Cfile:702842-702850: ReturnFire=0, HoldFire=1, HoldGround=2.
  | { type: 'fireState'; id: number; state: number }
  // ToggleScriptBit (cfunc_ToggleScriptBitL): ProcessInfo carries the bit only.
  // The user-side binding filters by curState before asking the sim to flip it.
  | { type: 'scriptBit'; id: number; bit: number }
  | { type: 'autoMode'; id: number; enabled: boolean }
  | { type: 'autoSurfaceMode'; id: number; enabled: boolean }
  // Per-unit SetPaused (cfunc_SetPausedL "Pause builders in this list") —
  // DISTINCT from the whole-world 'pause' above (that halts the beat).
  | { type: 'unitPause'; id: number; paused: boolean }
  | { type: 'upgrade'; id: number; blueprint: string }
  // A FACTORY command (ISSUE_FactoryCommand, Cfile:1350766 -> Sim::
  // IssueFactoryCommand 1075805 -> UNIT_IssueFactoryCommand 1007613): into
  // the builder's command list, which every finished unit inherits; the
  // factory itself stays put. clear = not shift (the ClearQueue byte of the
  // message, CDecoder::DecodeIssueFactoryCommand 997129-997159).
  | { type: 'factoryCommand'; id: number; cmd: 'Move' | 'Patrol' | 'AttackGround'; x: number; z: number; queue?: boolean }
  | { type: 'factoryCommand'; id: number; cmd: 'Attack' | 'Guard'; targetId: number; queue?: boolean }
  // Der Reset traegt dieselbe Nutzlast wie der Boot: die Lua der NEUEN Karte
  // und ihre Sitzung. Ohne beides startete die zweite Sandbox ohne ACUs und
  // ohne Lagerstaetten — `SetupSession()` fand die Kartendateien nicht.
  | {
      type: 'reset'
      terrain: HeightfieldData
      waterElevation?: number
      props?: MapPropSpawn[]
      session?: SessionInfo
      files?: Map<string, Uint8Array>
    }
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
  // DEV diagnosis only (the page's __cfa bridge): a Lua expression that
  // returns JSON text, evaluated in the sim state. Never a game path.
  | { type: 'debugEval'; reqId: number; lua: string }
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

ctx.onmessage = (e: MessageEvent<InMsg>): void => {
  // Ein Fehler im Worker war bisher ein STILLER Tod: `onmessage` war async, und
  // eine abgelehnte Zusage landete nirgends — der Hauptthread wartete dann
  // ewig auf 'booted'. Jetzt meldet der Worker, woran er gestorben ist.
  void handleMessage(e.data).catch((err: unknown) => {
    const text = err instanceof Error ? `${err.message} — ${err.stack ?? ''}` : String(err)
    ctx.postMessage({ type: 'log', level: 'WARN', msg: `Sim-Worker: ${text.slice(0, 600)}` })
  })
}

const handleMessage = async (msg: InMsg): Promise<void> => {
  if (msg.type === 'boot') {
    bootFiles = msg.files
    const h = await LuaHost.create(msg.files, (level, m) => ctx.postMessage({ type: 'log', level, msg: m }))
    // Der EINE Engine-Boot — derselbe wie in jeder Testsuite. Vorher stellte
    // sich der Worker die Engine selbst zusammen und vergaß dabei das
    // Bau-System (build.ts lief im Browser überhaupt nicht).
    // Die Sitzung geht MIT in den Boot: mit Szenariodatei faehrt der echte
    // Sitzungsstart (SetupSession -> OnCreateArmyBrain), ohne bleibt es der
    // kartenlose Harness aus session.ts.
    engine = installEngine(h, undefined, msg.session)
    // Das Gelände der geladenen Karte, VOR dem ersten Spawn: OnCreate-Pfade der
    // Original-Lua lesen GetSurfaceHeight, und ohne Quelle knallt es jetzt (statt
    // still 0 zu liefern). Dieselbe bilineare Abfrage wie im Renderer.
    const hf = new Heightfield(msg.terrain)
    setTerrainSource(h, (x, z) => hf.at(x, z), {
      width: msg.terrain.width,
      height: msg.terrain.height,
      sampleAt: (ix, iz) => hf.sample(ix, iz),
      waterElevation: msg.waterElevation,
      terrainTypeAt: terrainTypesOf(msg.terrain),
    })
    reportTerrainTypes(h, msg.terrain)
    // ALLE Projektil- und Prop-Blueprints, VOR dem ersten Schuss. Die Engine
    // lädt beim Start ebenfalls alles (Blueprints.lua über DiskFindFiles) —
    // mitten im Tick kann eine Waffe nichts nachladen.
    loadBlueprintGroups(h, msg.files)
    // Map props BEFORE any unit spawn — the engine creates them in
    // Sim::Setup step 7, after the armies and before Lua BeginSession
    // (Cfile:1072041-1072105).
    spawnMapProps(h, msg.props ?? [])
    host = h

    // Schritt 6a. `BeginSession()` laeuft das `OnPopulate` der Karte
    // (siminit.lua:145) und erzeugt dabei Einheiten — die Sim kann mitten im
    // Tick nichts nachladen. Die Engine hat alle Blueprints lange vorher
    // (siminit.lua:8); wir koennen das nicht mitschicken, weil zu jeder Einheit
    // ihr SKELETT gehoert (78 MB _lod0.scm fuer 580 Einheiten). Also fragt die
    // Sim SELBST, welche Blueprints dieser Sitzungsstart benennen kann
    // (__sessionInitialUnits, aus factions.lua und den Gruppen der Karte), und
    // der Client schickt genau die.
    if (msg.session?.scenarioFile) {
      const ids = h.pull<string[]>('__sessionInitialUnitsJson()')
      ctx.postMessage({ type: 'log', level: 'INFO', msg: `Sitzungsstart: ${ids.join(', ')} angefordert` })
      const geliefert = new Promise<UnitPrep[]>((res) => {
        unitsResolve = res
      })
      ctx.postMessage({ type: 'needUnits', ids })
      for (const u of await geliefert) prepare(h, u)
      beginSession(h, msg.session)
      ctx.postMessage({
        type: 'log',
        level: 'INFO',
        msg: `BeginSession: ${h.eval('local n = 0 for _ in pairs(__units) do n = n + 1 end return n')} Einheiten aus OnPopulate`,
      })
      // Und wo die Armeen stehen, sagt jetzt die Sim — aus dem Marker der
      // Karte, den `InitializeStartLocation` in `SetArmyStart` geschrieben hat
      // (scenarioutilities.lua:1026-1033). Der Hauptthread hat dafuer vorher
      // die `_save.lua` selbst geparst.
      starts = msg.session.armies.map((a) => {
        const p = h.pull<[number, number]>(`__armyStartPosJson(${a.index})`)
        return { army: a.index, x: p[0], z: p[1] }
      })
    }

    ctx.postMessage({ type: 'booted', starts })
    setInterval(tickAndPost, 100) // 10-Hz-Sim-Beat im Worker-Thread
    return
  }
  if (msg.type === 'reset') {
    if (!bootFiles) return
    // Die Karten-Lua der NEUEN Karte nachreichen, sonst faehrt `SetupSession()`
    // gegen Dateien, die im VFS des Workers nicht liegen.
    for (const [pfad, bytes] of msg.files ?? []) bootFiles.set(pfad, bytes)
    starts = []
    try {
      await resetSession(bootFiles, msg.terrain, msg.waterElevation, msg.session)
      if (host) spawnMapProps(host, msg.props ?? [])
      if (host && engine && msg.session?.scenarioFile) {
        const h = host
        const ids = h.pull<string[]>('__sessionInitialUnitsJson()')
        const geliefert = new Promise<UnitPrep[]>((res) => {
          unitsResolve = res
        })
        ctx.postMessage({ type: 'needUnits', ids })
        for (const u of await geliefert) prepare(h, u)
        beginSession(h, msg.session)
        starts = msg.session.armies.map((a) => {
          const p = h.pull<[number, number]>(`__armyStartPosJson(${a.index})`)
          return { army: a.index, x: p[0], z: p[1] }
        })
      }
    } finally {
      // IMMER antworten. Bricht der Reset ab, wartet `startSandbox` sonst
      // ewig auf `reset-done` und die Karte bleibt leer, ohne dass etwas
      // meldet, warum.
      ctx.postMessage({ type: 'reset-done', starts })
    }
    return
  }
  if (msg.type === 'units') {
    unitsResolve?.(msg.units)
    unitsResolve = null
    return
  }
  if (msg.type === 'pause') {
    paused = msg.paused
    return
  }
  if (!host) return
  if (msg.type === 'spawn') {
    try {
      prepare(host, msg)
      const uid = spawnLuaUnit(host, msg.id, msg.pos, msg.army)
      ctx.postMessage({ type: 'spawned', reqId: msg.reqId, uid })
    } catch (err) {
      ctx.postMessage({ type: 'spawnError', reqId: msg.reqId, error: (err as Error).message })
    }
  } else if (msg.type === 'build') {
    try {
      prepare(host, msg)
      // Reihenfolge wie in der Engine: erst die Baustelle (Sim::CreateUnit mit
      // beingBuilt=1), dann der Auftrag an den Bauer (OnStartBuild/'MobileBuild').
      const uid = spawnBuildSite(host, msg.id, msg.pos, msg.army)
      host.eval(`__issueBuildTask(${msg.builderId}, ${uid}, nil, ${!msg.queue})`)
      ctx.postMessage({ type: 'spawned', reqId: msg.reqId, uid })
    } catch (err) {
      ctx.postMessage({ type: 'spawnError', reqId: msg.reqId, error: (err as Error).message })
    }
  } else if (msg.type === 'factoryBuild') {
    prepare(host, msg)
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
  } else if (msg.type === 'debugEval') {
    let value: unknown
    try {
      value = host.pull<unknown>(msg.lua)
    } catch (err) {
      value = { error: err instanceof Error ? err.message : String(err) }
    }
    ctx.postMessage({ type: 'debugEval', reqId: msg.reqId, value })
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
  } else if (msg.type === 'factoryCommand') {
    const clear = msg.queue ? 'false' : 'true'
    if ('targetId' in msg) {
      host.eval(`__dispatchFactory${msg.cmd}(${msg.id}, ${msg.targetId}, ${clear})`)
    } else {
      host.eval(`__dispatchFactory${msg.cmd}(${msg.id}, ${msg.x}, ${msg.z}, ${clear})`)
    }
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
  } else if (msg.type === 'capture') {
    host.eval(`__dispatchCapture(${msg.id}, ${msg.targetId}, ${msg.queue ? 'false' : 'true'})`)
  } else if (msg.type === 'transportLoad') {
    // The user's CallTransport (Cfile:1241799-1241870): one command for the
    // passengers and the transport; each validated like the engine's
    // func_ProcessUnitCommand (transport.lua).
    const ids = msg.ids.map((n) => Math.floor(n)).join(',')
    host.eval(`__dispatchTransportLoad({ ${ids} }, ${Math.floor(msg.transportId)}, ${msg.queue ? 'false' : 'true'})`)
  } else if (msg.type === 'transportReverseLoad') {
    const ids = msg.transportIds.map((n) => Math.floor(n)).join(',')
    host.eval(`__dispatchTransportReverseLoad({ ${ids} }, ${Math.floor(msg.targetId)}, ${msg.queue ? 'false' : 'true'})`)
  } else if (msg.type === 'transportUnload') {
    host.eval(`__dispatchTransportUnload({ ${Math.floor(msg.id)} }, ${msg.x}, ${msg.z}, ${msg.queue ? 'false' : 'true'})`)
  } else if (msg.type === 'fireState') {
    // No task, no queue: fire state is unit state, not a command
    // (Unit::SetFireState — weapons read it every tick, weapons.lua:89/229).
    host.eval(`local u=__units[${msg.id}]; if u then u:SetFireState(${msg.state}) end`)
  } else if (msg.type === 'scriptBit') {
    // Unit::ToggleScriptBit performs the actual flip and fires
    // OnScriptBitSet/OnScriptBitClear through SetScriptBit.
    host.eval(`local u=__units[${msg.id}]; if u then u:ToggleScriptBit(${msg.bit}) end`)
  } else if (msg.type === 'autoMode') {
    host.eval(`local u=__units[${msg.id}]; if u then u:SetAutoMode(${msg.enabled ? 'true' : 'false'}) end`)
  } else if (msg.type === 'autoSurfaceMode') {
    // ProcessInfo invokes the native Unit setter; it is not a public sim-Lua
    // binding, so keep the internal state write at this worker seam.
    host.eval(`local u=__units[${msg.id}]; if u then u.__autoSurfaceMode=${msg.enabled ? 'true' : 'false'} end`)
  } else if (msg.type === 'upgrade') {
    // IssueUpgrade(units, blueprintId) — cfunc_IssueUpgradeL (Cfile:1011315):
    // exactly two arguments, no queue clear. The sim turns it into the
    // CUnitUpgradeTask (build.lua __issueUpgrade).
    host.eval(
      `local u=__units[${msg.id}]; if u then IssueUpgrade({ u }, ${JSON.stringify(msg.blueprint)}) end`,
    )
  } else if (msg.type === 'unitPause') {
    // Per-unit SetPaused: halts this builder/factory's production only
    // (build.lua gates __buildCollect/__factoryTick on u.__paused).
    host.eval(`local u=__units[${msg.id}]; if u then u:SetPaused(${msg.paused ? 'true' : 'false'}) end`)
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
async function resetSession(
  files: Map<string, Uint8Array>,
  terrain: HeightfieldData,
  waterElevation?: number,
  session?: SessionInfo,
): Promise<void> {
  // ERST die Referenz fallen lassen, DANN den alten State freigeben.
  //
  // `tickAndPost` laeuft mit 10 Hz weiter, waehrend dieser `await` haengt, und
  // sein Waechter ist `if (!host || !engine) return`. Solange `host` noch auf
  // den geschlossenen State zeigt, greift der Waechter nicht — der Beat ruft in
  // einen freigegebenen Lua-State.
  const alt = host
  host = null
  engine = null
  alt?.close()

  const h = await LuaHost.create(files, (level, m) => ctx.postMessage({ type: 'log', level, msg: m }))
  const hf = new Heightfield(terrain)
  // Dieselbe Reihenfolge wie im Boot: das Gelaende steht, BEVOR die Armeen
  // entstehen (die Bedrohungskarte wird in der Armee-Erzeugung angelegt und
  // liest dabei das Heightfield, Cfile:1017321-1017333).
  engine = installEngine(h, undefined, session, {
    heightAt: (x, z) => hf.at(x, z),
    size: { width: terrain.width, height: terrain.height, waterElevation, terrainTypeAt: terrainTypesOf(terrain) },
  })
  reportTerrainTypes(h, terrain)
  loadBlueprintGroups(h, files)
  host = h
}

/**
 * The terrain-type layer is part of the map, not an option: without it the
 * Sim answered "Default" for every position, so lava did no damage and every
 * wreck sat at the wrong offset -- silently, for as long as the browser
 * session existed. A map without the layer is refused here.
 */
function terrainTypesOf(terrain: HeightfieldData): (x: number, z: number) => number {
  const sampler = terrainTypeSampler(terrain)
  if (!sampler) throw new Error('Sim boot: the map has no terrain-type layer (HeightfieldData.terrainType)')
  return sampler
}

/** One log line with what the layer holds -- the evidence that it is read. */
function reportTerrainTypes(h: LuaHost, terrain: HeightfieldData): void {
  const namen = new Set<string>()
  for (let x = 8; x < terrain.width; x += 32) {
    for (let z = 8; z < terrain.height; z += 32) {
      namen.add(String(h.eval(`return GetTerrainType(${x}, ${z}).Name`)))
    }
  }
  ctx.postMessage({ type: 'log', level: 'LOG', msg: `Sim: terrain types on the map: ${[...namen].join(', ')}` })
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
    // The mesh blueprints outside effects/: units/**_mesh.bp, meshes/** and
    // env/**_mesh.bp -- MeshBlueprint files, the same LoadBlueprints pass as
    // the effects (blueprints.lua:330-331; simBootPaths hands them over).
    else if (path.startsWith('units/') || path.startsWith('meshes/') || path.startsWith('env/')) proj.push(path)
  }
  const nProj = loadProjectileBlueprints(h, proj)
  const nProps = loadPropBlueprints(h, props)
  ctx.postMessage({
    type: 'log',
    level: 'INFO',
    msg: `Sim: ${nProj} Projektil-Blueprints, ${nProps} Prop-Blueprints`,
  })
}

/**
 * Script, blueprint and skeleton have to be in the Sim BEFORE a unit of that
 * kind comes into being — whether the client spawns it, a factory produces it,
 * or the map's `OnPopulate` creates it during `BeginSession()`.
 */
function prepare(h: LuaHost, m: UnitPrep): void {
  if (m.scriptBytes && !h.hasFile(m.scriptPath)) h.addFile(m.scriptPath, m.scriptBytes)
  if (m.bpBytes) loadUnitBlueprint(h, m.id, m.bpBytes)
  setUnitBones(h, m.id, m.bones ?? [])
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
  // The mesh entities (Entity + SetMesh: the shield domes and shells) --
  // one row per live one, props.lua __readMeshEntitiesJson.
  const meshEntities = host.pull<unknown[]>('__readMeshEntitiesJson()')
  // Map-prop instances that died this beat — the instanced renderer hides
  // them (map props are NOT serialized per beat, only their removals).
  const removedMapProps = host.pull<number[]>('__drainRemovedMapPropsJson()')
  // Sim->user audio requests (SAudioRequest analog: EntitySound=0,
  // StartLoop=1, StopLoop=2) — weapon fire, unit ambient loops.
  const audio = host.pull<unknown[]>('__drainAudioRequestsJson()')
  // Sim->user camera shakes (Sim::mSyncCamShake, handed over with the beat
  // like the engine's Sync, Cfile:1074494-1074501).
  const camShakes = host.pull<unknown[]>('__drainCamShakesJson()')
  // The light particles spawned this beat (CreateLightParticle -> the
  // particle buffer, Cfile:906023).
  const lights = host.pull<unknown[]>('__drainLightParticlesJson()')
  // The splats and decals created this beat and the handles destroyed this
  // beat (CDecalManager::AddDecals / RemoveDecals with the sync,
  // Cfile:1327849-1327851).
  const decalAdds = host.pull<unknown[]>('__drainDecalAddsJson()')
  const decalRemovals = host.pull<number[]>('__drainDecalRemovalsJson()')
  // The army build restrictions (the lobby's restricted units, siminit.lua:190)
  // as text per army: the user side subtracts them from every build menu
  // (GetUnitCommandData x army->mVarDat.mCat, Cfile:1264632-1264646).
  const armyRestrictions = host.pull<Record<string, string>>('__armyRestrictionsJson()')
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
    meshEntities,
    removedMapProps,
    audio,
    camShakes,
    lights,
    decalAdds,
    decalRemovals,
    armyRestrictions,
    economy: {
      mass: a.mass, massStorage: a.maxMass, massIncome: a.incomeMass, massExpense: a.expenseMass,
      energy: a.energy, energyStorage: a.maxEnergy, energyIncome: a.incomeEnergy, energyExpense: a.expenseEnergy,
      massRequested: a.requestedMass, energyRequested: a.requestedEnergy,
      reclaimMass: a.reclaimMass, reclaimEnergy: a.reclaimEnergy,
    },
  })
}
