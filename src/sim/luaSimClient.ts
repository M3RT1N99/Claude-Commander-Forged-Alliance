import type { GameVfs } from '../vfs/vfs'
import type { HeightfieldData } from './terrain'
import type { EcoSnapshot } from '../ui/hud'
import { parseBlueprint } from '../formats/blueprint'
import { resolveUnitPaths } from '../formats/unitPaths'
import { parseScm } from '../formats/scm'
import { toSimBones, type SimBone } from '../lua/unitFactory'

/**
 * Main-Thread-Fassade für die Lua-Engine im Web-Worker (luaSimWorker.ts).
 * Kommandos (spawn/move/stop) gehen per postMessage in den Worker; die pro
 * Beat gesendeten Unit-Zustände + Ökonomie werden hier gecacht, sodass der
 * Renderer synchron (ohne VM-Aufruf) darauf zugreift. Die Lua-VM blockiert
 * damit nie den Main-Thread.
 */

export interface LuaUnitSnapshot {
  id: number
  name: string
  x: number
  y: number
  z: number
  heading: number
  health: number
  maxHealth: number
  moving: boolean
  /** Construction progress (1 = finished). __readAllUnits sends it, it just never got read. */
  fraction: number
  /** Build tick — the build shaders count their age above (material.x). */
  born: number
  /** The unit's active order (command graph): type + target position. */
  order?: { t: 'Move' | 'Attack' | 'Repair' | 'BuildMobile'; x: number; z: number }
  /** The full command queue, head first (CUnitCommandQueue). */
  orders?: { t: 'Move' | 'Attack' | 'Repair' | 'BuildMobile'; x: number; z: number }[]
  /** Turret aim state per weapon (yaw/pitch bones, radians vs. rest pose). */
  turrets?: { b: string; y: number; pb?: string; p?: number }[]
  /** The unit's army (1-based) — unitsOfFocusArmy filters by this. */
  army: number
  /**
   * Leerlauf im Sinn der Engine (Idle-Sets am UserArmy, Cfile:1352334): kein
   * Bewegungsziel, kein Bau-Auftrag, keine Produktion. NICHT dasselbe wie
   * `!moving` — ein bauender Ingenieur steht still und ist trotzdem nicht idle.
   */
  idle: boolean
  /** Factory build queue: { id, count } — empty for all others. */
  buildQueue?: { id: string; count: number }[]
}

/**
 * Ein fliegendes Projektil, wie die Sim es meldet (__readAllProjectilesJson).
 * Die Engine zeichnet jeden Schuss — ohne diesen Kanal ist der Kampf im
 * Browser unsichtbar.
 */
export interface LuaProjectileSnapshot {
  id: number
  /** BlueprintId, z. B. '/projectiles/tdfgauss01/tdfgauss01_proj.bp'. */
  bp: string
  x: number
  y: number
  z: number
  qw: number
  qx: number
  qy: number
  qz: number
}

/**
 * Ein lebender Partikel-Emitter (Mündungsfeuer, Trail, Bau-/Einschlag-Effekt),
 * wie die Sim ihn meldet (__readAllEmittersJson). Die Weltposition rechnet die
 * Sim (Owner + Knochen) — das Partikelsystem des Renderers zeichnet daraus.
 */
export interface LuaEmitterSnapshot {
  id: number
  /** Emitter blueprint path, e.g. E.g. '/effects/emitters/..._emit.bp'. */
  bp: string
  x: number
  y: number
  z: number
  /** Bone-Orientierung (w,x,y,z) — LocalVelocity/-Acceleration drehen die
   *  Spawn-Richtungen einmalig in diesen Raum (Cfile:894849-894859). */
  qw: number
  qx: number
  qy: number
  qz: number
  /** ScaleEmitter-Faktor (Default 1). */
  scale: number
  /** Sim-Tick of Emergence — Starting point for curves/lifespan. */
  born: number
  enabled: boolean
  ox?: number
  oy?: number
  oz?: number
  /** Zweiter Endpunkt (nur Beams via AttachBeamEntityToEntity —
   *  CEfxBeam::AttachEntityToEntity @0x655B50): das Ziel-Bone in Welt. */
  x2?: number
  y2?: number
  z2?: number
}

/**
 * Ein PROP (Wrack, Fels, Baum), wie die Sim es meldet (__readAllPropsJson).
 * Wracks entstehen komplett in der Original-Lua (unit.lua:1090
 * CreateWreckageProp): CreateProp + SetMesh(Display.MeshBlueprintWrecked) +
 * SetScale(UniformScale) + AssociatedBP = Unit-Blueprint-Id.
 */
export interface LuaPropSnapshot {
  id: number
  /** Prop blueprint path, e.g. E.g. '/props/defaultwreckage/defaultwreckage_prop.bp'. */
  bp: string
  x: number
  y: number
  z: number
  heading: number
  /** prop:SetScale — on the unit's UniformScale wreck (unit.lua:1111). */
  scale: number
  /** Sim-Tick of creation (the wreckage shader varies its noise with it). */
  spawn: number
  /** Mesh blueprint from prop:SetMesh, e.g. E.g. '/units/uel0201/uel0201_mesh_wreck'. */
  meshBp?: string
  /** The unit behind the wreck (unit.lua:1137) — provides SCM + textures. */
  assoc?: string
}

/** What the sim needs to create a unit of this type. */
interface UnitPayload {
  scriptPath: string
  scriptBytes: Uint8Array | null
  bpBytes: Uint8Array | null
  /** Bone names from the SCM — the engine also has the skeleton in the sim. */
  bones: SimBone[]
}

interface StatesMsg {
  type: 'states'
  /** The beat's sim tick — the UI's playing time clock counts with it. */
  tick: number
  units: LuaUnitSnapshot[]
  projectiles: LuaProjectileSnapshot[]
  emitters: LuaEmitterSnapshot[]
  props: LuaPropSnapshot[]
  economy: EcoSnapshot
}
type OutMsg =
  | { type: 'booted' }
  | { type: 'reset-done' }
  | { type: 'log'; level: string; msg: string }
  | { type: 'spawned'; reqId: number; uid: number }
  | { type: 'spawnError'; reqId: number; error: string }
  | { type: 'emitterBp'; reqId: number; bp: unknown }
  | { type: 'meshBp'; reqId: number; bp: unknown }
  | StatesMsg

export class LuaSimClient {
  private readonly statesById = new Map<number, LuaUnitSnapshot>()
  private economy: EcoSnapshot | null = null
  /** The flying projectiles of the last beat — the renderer draws them. */
  private projectileStates: LuaProjectileSnapshot[] = []
  /** The living emitters of the last beat — fodder for the particle system. */
  private emitterStates: LuaEmitterSnapshot[] = []
  /** The props of the last beat (wrecks) — the renderer draws them. */
  private propStates: LuaPropSnapshot[] = []
  /** Letzter gemeldeter Sim-Tick (Spielzeit = Tick / 10). */
  gameTick = 0
  private nextReq = 1
  private bootResolve: (() => void) | null = null
  private resetResolve: (() => void) | null = null
  private readonly spawnPending = new Map<number, { resolve: (uid: number) => void; reject: (e: Error) => void }>()
  private readonly emitterBpPending = new Map<number, (bp: unknown) => void>()
  private readonly emitterBpCache = new Map<string, Promise<unknown>>()
  private readonly meshBpPending = new Map<number, (bp: unknown) => void>()
  private readonly meshBpCache = new Map<string, Promise<unknown>>()

  private constructor(
    private readonly worker: Worker,
    private readonly vfs: GameVfs,
  ) {}

  /**
   * Bootet die Sim. Das Terrain ist PFLICHT — die Original-Lua liest
   * GetSurfaceHeight schon in OnCreate-Pfaden, und die Engine liefert dafür
   * keine stille 0 mehr, sondern knallt. Ohne Karte gibt es keine Sim.
   */
  static async create(
    vfs: GameVfs,
    terrain: HeightfieldData,
    log: (level: string, msg: string) => void,
  ): Promise<LuaSimClient> {
    // ALL lua/ files, including lua/ui/. The original UI is Lua (maui) and
    // should be executed, not recreated in TS/HTML — here
    // Excluding them prevented exactly that. The sim host only loads anyway
    // what is imported; preloading only costs the VFS read.
    // ONE archive access per contiguous block instead of two per file
    // (vfs.readMany): `lua/**` is located in lua.scd (7 MB) and mohodata.scd — on
    // It doesn't cost anything to read the piece.
    // lua/** AND schook/**: schook.scd is the PATCH HOOK LAYER from FA —
    // doscript appends the file of the same name from /schook to each module
    // (boot.lua runHooks; bin/SupComDataPath.lua: hook = {'/schook'}).
    // Without these files the Sim will be missing, among other things. SimUnitEnhancements/
    // RemoveAllUnitEnhancements (schook/lua/SimSync.lua) — unit.lua:1287
    // calls this in EVERY OnDestroy.
    const files = await vfs.readMany(
      vfs.find((p) => (p.startsWith('lua/') || p.startsWith('schook/')) && p.endsWith('.lua')),
    )

    // Plus ALL PROJECTILES (`projectiles/<id>/<id>_proj.bp` + `_script.lua`).
    //
    // You must lie in the sim before the first shot: a gun fires
    // IN THE MIDDLE of the tick (defaultweapons.lua calls `unit:CreateProjectile(
    // bp.ProjectileId, ...)`, uel0201_unit.bp:225 points to
    // `/projectiles/TDFGauss01/TDFGauss01_proj.bp`) — there is no room for
    // an asynchronous lookup on the main thread. The engine does it the same way:
    // it loads ALL blueprints at startup (Blueprints.lua via DiskFindFiles).
    // Cost: 289 blueprints + 288 scripts = 652 KB, one archive access.
    // Plus the PROPS (`props/**.bp`) - this is where the wrecks come from
    // (unit.lua:1105 CreateProp(pos, bp.Wreckage.Blueprint)).
    const projPaths = vfs.find(
      (p) =>
        (p.startsWith('projectiles/') || p.startsWith('props/') || p.startsWith('effects/')) &&
        (p.endsWith('.bp') || p.endsWith('.lua')),
    )
    for (const [p, b] of await vfs.readMany(projPaths)) files.set(p, b)

    const worker = new Worker(new URL('./luaSimWorker.ts', import.meta.url), { type: 'module' })
    const client = new LuaSimClient(worker, vfs)
    const booted = new Promise<void>((res) => {
      client.bootResolve = res
    })
    worker.onmessage = (e: MessageEvent<OutMsg>) => client.onMessage(e.data, log)
    worker.postMessage({ type: 'boot', files, terrain })
    await booted
    return client
  }

  private onMessage(m: OutMsg, log: (level: string, msg: string) => void): void {
    switch (m.type) {
      case 'booted':
        this.bootResolve?.()
        break
      case 'reset-done':
        this.resetResolve?.()
        break
      case 'log':
        log(m.level, m.msg)
        break
      case 'states':
        this.economy = m.economy
        this.gameTick = m.tick
        this.projectileStates = m.projectiles ?? []
        this.emitterStates = m.emitters ?? []
        this.propStates = m.props ?? []
        this.statesById.clear()
        for (const u of m.units) this.statesById.set(u.id, u)
        break
      case 'spawned': {
        const p = this.spawnPending.get(m.reqId)
        this.spawnPending.delete(m.reqId)
        p?.resolve(m.uid)
        break
      }
      case 'spawnError': {
        const p = this.spawnPending.get(m.reqId)
        this.spawnPending.delete(m.reqId)
        p?.reject(new Error(m.error))
        break
      }
      case 'emitterBp': {
        const p = this.emitterBpPending.get(m.reqId)
        this.emitterBpPending.delete(m.reqId)
        p?.(m.bp)
        break
      }
      case 'meshBp': {
        const p = this.meshBpPending.get(m.reqId)
        this.meshBpPending.delete(m.reqId)
        p?.(m.bp)
        break
      }
    }
  }

  /**
   * Alles, was die Sim braucht, um eine Unit dieses Typs zu erzeugen: das
   * Script, das Blueprint — und das SKELETT.
   *
   * Das Skelett ist kein Renderer-Kram: die Engine lädt das Modell auch in der
   * Sim, weil Waffentürme, Mündungen und Bau-Knochen an Knochennamen hängen
   * (`weapon.lua:67` bricht ohne sie ab). Es wird hier aus derselben SCM-Datei
   * gelesen, die auch der Renderer nimmt.
   *
   * Gecacht, weil jede Fabrik-Einheit denselben Typ mehrfach baut.
   */
  private readonly payloadCache = new Map<string, UnitPayload>()

  private async unitPayload(id: string): Promise<UnitPayload> {
    const hit = this.payloadCache.get(id)
    if (hit) return hit
    const scriptPath = `units/${id}/${id}_script.lua`
    const bpPath = `units/${id}/${id}_unit.bp`
    const payload: UnitPayload = {
      scriptPath,
      scriptBytes: this.vfs.exists(scriptPath) ? await this.vfs.read(scriptPath) : null,
      bpBytes: this.vfs.exists(bpPath) ? await this.vfs.read(bpPath) : null,
      bones: [],
    }
    if (payload.bpBytes) {
      try {
        const bp = parseBlueprint(new TextDecoder('utf-8').decode(payload.bpBytes))
        const paths = resolveUnitPaths(id, bp, (p) => this.vfs.exists(p))
        if (paths && this.vfs.exists(paths.mesh)) {
          payload.bones = toSimBones(parseScm(await this.vfs.read(paths.mesh)))
        }
      } catch {
        // No model (e.g. effect units): then the unit doesn't have one
        // Bone. This is a fact about the unit, not a flaw in the engine —
        // ValidateBone then correctly returns false.
      }
    }
    this.payloadCache.set(id, payload)
    return payload
  }

  /** Spawns a unit via its original class in the worker; provides the unit ID. */
  async spawn(id: string, pos: { x: number; y: number; z: number }, army = 1): Promise<number> {
    const p = await this.unitPayload(id)
    const reqId = this.nextReq++
    return new Promise<number>((resolve, reject) => {
      this.spawnPending.set(reqId, { resolve, reject })
      this.worker.postMessage({ type: 'spawn', reqId, id, ...p, pos, army })
    })
  }

  /**
   * Construction command: Set the construction site and give the order to the farmer. Returns the ID
   * the construction site.
   *
   * The engine does exactly that: `Sim::CreateUnit(params, beingBuilt = 1)` and
   * then `OnStartBuild(target, 'MobileBuild')` auf dem Bauer. Der Fortschritt
   * entsteht dann von selbst im Beat (`buildRate/BuildTime · ResourceConsumed ·
   * 0.1`, CBuildTaskHelper::UpdateWorkProgress @0x5f5f2c) — hier wird NICHTS
   * nachgerechnet.
   */
  async build(
    builderId: number,
    id: string,
    pos: { x: number; y: number; z: number },
    army = 1,
    /** Shift held? The order is then attached to the construction series. */
    queue = false,
  ): Promise<number> {
    const p = await this.unitPayload(id)
    const reqId = this.nextReq++
    return new Promise<number>((resolve, reject) => {
      this.spawnPending.set(reqId, { resolve, reject })
      this.worker.postMessage({ type: 'build', reqId, builderId, id, ...p, pos, army, queue })
    })
  }

  /**
   * Factory Order: `count` units in the factory queue. That is,
   * what `IssueBlueprintCommand("UNITCOMMAND_BuildFactory", id, count)` in the
   * Engine triggers (construction.lua:884). The factory works them to the beat -
   * via the original `FactoryUnit` (defaultunits.lua:422).
   */
  async factoryBuild(factoryId: number, id: string, count: number): Promise<void> {
    const p = await this.unitPayload(id)
    this.worker.postMessage({ type: 'factoryBuild', factoryId, id, ...p, count })
  }

  /**
   * Change a factory queue entry — the sim end of
   * Increase/DecreaseBuildCountInQueue (Moho::ISSUE_IncreaseCommandCount
   * Cfile:1257266 / DecreaseCommandCount Cfile:1257378). `delta` < 0 takes
   * away; If the counter falls to 0, the entry disappears.
   */
  adjustBuildQueue(factoryId: number, index: number, delta: number): void {
    this.worker.postMessage({ type: 'adjustQueue', factoryId, index, delta })
  }

  /**
   * Resets the session: fresh Lua host, fresh engine, new terrain.
   * Without this, ACUs will stack up on the second sandbox start - and with them the
   * double starting supply from GiveInitialResources.
   */
  async reset(terrain: HeightfieldData): Promise<void> {
    const done = new Promise<void>((res) => {
      this.resetResolve = res
    })
    this.statesById.clear()
    this.economy = null
    this.worker.postMessage({ type: 'reset', terrain })
    await done
  }

  move(id: number, x: number, z: number, queue = false): void {
    this.worker.postMessage({ type: 'move', id, x, z, queue })
  }
  stop(id: number): void {
    this.worker.postMessage({ type: 'stop', id })
  }
  /** Attack command (CAttackTargetTask): Unit `id` attacks `targetId`. */
  attack(id: number, targetId: number, queue = false): void {
    this.worker.postMessage({ type: 'attack', id, targetId, queue })
  }
  /** Repair (dispatch 0x14): resume building the unfinished `targetId`. */
  repair(id: number, targetId: number, queue = false): void {
    this.worker.postMessage({ type: 'repair', id, targetId, queue })
  }

  /**
   * The rally point of a factory (IssueFactoryRallyPoint, Cfile:1008266). The
   * Factory doesn't MOVE — its fresh units go there
   * (defaultunits.lua:578 CalculateRollOffPoint reads GetRallyPoint).
   */
  setRallyPoint(id: number, x: number, y: number, z: number): void {
    this.worker.postMessage({ type: 'rally', id, x, y, z })
  }

  /**
   * Pause/continue running the world — what SessionRequestPause/SessionResume
   * do in the engine (CWldSession::RequestPause). The pause rider
   * Original UI (tabs.lua:425/428) ends up here.
   */
  setPaused(paused: boolean): void {
    this.worker.postMessage({ type: 'pause', paused })
  }

  /** Last known state of a unit (from the worker beat). */
  state(id: number): LuaUnitSnapshot | undefined {
    return this.statesById.get(id)
  }
  /** All known unit states (last beat). */
  allStates(): LuaUnitSnapshot[] {
    return [...this.statesById.values()]
  }

  /** The flying projectiles from the last beat (empty if no one shoots). */
  allProjectiles(): LuaProjectileSnapshot[] {
    return this.projectileStates
  }

  /** The living emitters of the last beat (muzzle flashes, trails, …). */
  allEmitters(): LuaEmitterSnapshot[] {
    return this.emitterStates
  }

  /**
   * Das geparste Emitter-/Trail-/Beam-Blueprint zur Id — aus der Sim, die
   * beim Boot alle _emit.bp geladen hat (__registered.Emitter). Liefert null,
   * wenn es keines gibt. Gecacht: jede Id geht höchstens einmal in den Worker.
   */
  emitterBlueprint(bp: string): Promise<unknown> {
    let p = this.emitterBpCache.get(bp)
    if (!p) {
      const reqId = this.nextReq++
      p = new Promise<unknown>((resolve) => {
        this.emitterBpPending.set(reqId, resolve)
        this.worker.postMessage({ type: 'emitterBp', reqId, bp })
      })
      this.emitterBpCache.set(bp, p)
    }
    return p
  }

  /** The props of the last beat (wrecks, rocks, trees). */
  allProps(): LuaPropSnapshot[] {
    return this.propStates
  }

  /**
   * SimCallback der UI (Cfile:1359123): ruft eine Funktion aus
   * lua/simcallbacks.lua in der Sim-VM. argsLua ist der Snapshot der UI-VM
   * als Lua-Literal, unitIds die mitgeschickte Auswahl.
   */
  simCallback(func: string, argsLua: string, unitIds: number[]): void {
    this.worker.postMessage({ type: 'simCallback', func, argsLua, unitIds })
  }

  /**
   * A mesh blueprint from the sim (e.g. the wreck variant
   * '/units/uel0201/uel0201_mesh_wreck' from ExtractWreckageBlueprint,
   * lua/system/blueprints.lua:187). null if there is none. Cached.
   */
  meshBlueprint(bp: string): Promise<unknown> {
    let p = this.meshBpCache.get(bp)
    if (!p) {
      const reqId = this.nextReq++
      p = new Promise<unknown>((resolve) => {
        this.meshBpPending.set(reqId, resolve)
        this.worker.postMessage({ type: 'meshBp', reqId, bp })
      })
      this.meshBpCache.set(bp, p)
    }
    return p
  }

  /** Letzte Armee-Ökonomie (Armee 1). */
  economySnapshot(): EcoSnapshot | null {
    return this.economy
  }
}
