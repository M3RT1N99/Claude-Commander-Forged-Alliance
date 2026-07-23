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

/** One scmap map prop for the sim boot (blueprint + world transform). */
export interface MapPropSpawn {
  /** Index into the scmap prop list — the stable id the instanced renderer
   *  uses to hide reclaimed/destroyed instances. */
  index: number
  bp: string
  x: number
  y: number
  z: number
  heading: number
}

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
  /** Baufortschritt (1 = fertig). __readAllUnits schickt es, es wurde nur nie gelesen. */
  fraction: number
  /** Fire state (EFireState Cfile:702842: ReturnFire=0, HoldFire=1, HoldGround=2). */
  fireState?: number
  /** Guarded unit id (0 = none) — mUnit->mGuardedUnit mirrored per beat. */
  guard?: number
  /** Erstellungs-Tick — die Build-Shader zählen ihr Alter darüber (material.x). */
  born: number
  /** The unit's active order (command graph): type + target position. */
  order?: { t: 'Move' | 'Attack' | 'Repair' | 'BuildMobile' | 'Patrol'; x: number; z: number }
  /** The full command queue, head first (CUnitCommandQueue). */
  orders?: { t: 'Move' | 'Attack' | 'Repair' | 'BuildMobile' | 'Patrol'; x: number; z: number }[]
  /** Turret aim state per weapon (yaw/pitch bones, radians vs. rest pose). */
  turrets?: { b: string; y: number; pb?: string; p?: number }[]
  /** Die Armee der Unit (1-basiert) — unitsOfFocusArmy filtert danach. */
  army: number
  /**
   * Leerlauf im Sinn der Engine (Idle-Sets am UserArmy, Cfile:1352334): kein
   * Bewegungsziel, kein Bau-Auftrag, keine Produktion. NICHT dasselbe wie
   * `!moving` — ein bauender Ingenieur steht still und ist trotzdem nicht idle.
   */
  idle: boolean
  /** Bau-Warteschlange einer Fabrik: { id, count } — leer bei allen anderen. */
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
  /** Emitter-Blueprint-Pfad, z. B. '/effects/emitters/..._emit.bp'. */
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
  /** Sim-Tick der Entstehung — Startpunkt für Kurven/Lebensdauer. */
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
  /** Prop-Blueprint-Pfad, z. B. '/props/defaultwreckage/defaultwreckage_prop.bp'. */
  bp: string
  x: number
  y: number
  z: number
  heading: number
  /** prop:SetScale — beim Wrack der UniformScale der Unit (unit.lua:1111). */
  scale: number
  /** Sim-Tick der Entstehung (der Wreckage-Shader variiert sein Noise damit). */
  spawn: number
  /** Mesh-Blueprint aus prop:SetMesh, z. B. '/units/uel0201/uel0201_mesh_wreck'. */
  meshBp?: string
  /** Die Unit hinter dem Wrack (unit.lua:1137) — liefert SCM + Texturen. */
  assoc?: string
}

/** Was die Sim braucht, um eine Unit dieses Typs zu erzeugen. */
interface UnitPayload {
  scriptPath: string
  scriptBytes: Uint8Array | null
  bpBytes: Uint8Array | null
  /** Knochennamen aus der SCM — die Engine hat das Skelett auch in der Sim. */
  bones: SimBone[]
}

interface StatesMsg {
  type: 'states'
  /** Der Sim-Tick des Beats — die Spielzeit-Uhr der UI zaehlt damit. */
  tick: number
  units: LuaUnitSnapshot[]
  projectiles: LuaProjectileSnapshot[]
  emitters: LuaEmitterSnapshot[]
  props: LuaPropSnapshot[]
  /** Map-prop indices whose sim props died this beat (reclaim/destroy). */
  removedMapProps?: number[]
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
  /** Die fliegenden Projektile des letzten Beats — der Renderer zeichnet sie. */
  private projectileStates: LuaProjectileSnapshot[] = []
  /** Die lebenden Emitter des letzten Beats — Futter fürs Partikelsystem. */
  private emitterStates: LuaEmitterSnapshot[] = []
  /** Die Props des letzten Beats (Wracks) — der Renderer zeichnet sie. */
  private propStates: LuaPropSnapshot[] = []
  /** Accumulated dead map-prop indices; drained by the instanced renderer. */
  private readonly removedMapProps: number[] = []
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
    /** scmap map props — spawned in the sim before any unit (Sim::Setup 7). */
    props: MapPropSpawn[] = [],
  ): Promise<LuaSimClient> {
    // ALLE lua/-Dateien, auch lua/ui/. Die UI des Originals ist Lua (maui) und
    // soll ausgeführt werden, nicht in TS/HTML nachgebaut — sie hier
    // auszuschließen hat genau das verhindert. Der Sim-Host lädt ohnehin nur,
    // was importiert wird; das Vorladen kostet nur den VFS-Lesevorgang.
    // EIN Archiv-Zugriff pro zusammenhängendem Block statt zwei pro Datei
    // (vfs.readMany): `lua/**` liegt in lua.scd (7 MB) und mohodata.scd — am
    // Stück gelesen kostet das nichts.
    // lua/** UND schook/**: schook.scd ist der PATCH-HOOK-LAYER von FA —
    // doscript hängt zu jedem Modul die gleichnamige Datei aus /schook an
    // (boot.lua runHooks; bin/SupComDataPath.lua: hook = {'/schook'}).
    // Ohne diese Dateien fehlen der Sim u. a. SimUnitEnhancements/
    // RemoveAllUnitEnhancements (schook/lua/SimSync.lua) — unit.lua:1287
    // ruft das in JEDEM OnDestroy.
    const files = await vfs.readMany(
      vfs.find((p) => (p.startsWith('lua/') || p.startsWith('schook/')) && p.endsWith('.lua')),
    )

    // Dazu ALLE PROJEKTILE (`projectiles/<id>/<id>_proj.bp` + `_script.lua`).
    //
    // Sie müssen vor dem ersten Schuss in der Sim liegen: eine Waffe feuert
    // MITTEN im Tick (defaultweapons.lua ruft `unit:CreateProjectile(
    // bp.ProjectileId, ...)`, uel0201_unit.bp:225 zeigt auf
    // `/projectiles/TDFGauss01/TDFGauss01_proj.bp`) — dort ist kein Platz für
    // einen asynchronen Nachschlag im Hauptthread. Die Engine macht es genauso:
    // sie lädt beim Start ALLE Blueprints (Blueprints.lua über DiskFindFiles).
    // Kosten: 289 Blueprints + 288 Skripte = 652 KB, ein Archiv-Zugriff.
    // Dazu die PROPS (`props/**.bp`) — daraus entstehen die Wracks
    // (unit.lua:1105 CreateProp(pos, bp.Wreckage.Blueprint)).
    // And the 334 env/** map-prop blueprints (rocks, trees): the engine
    // creates every scmap prop in Sim::Setup step 7 (Cfile:1072041-1072105)
    // — reclaim needs their Economy.ReclaimMassMax/EnergyMax in the sim.
    const projPaths = vfs.find(
      (p) =>
        ((p.startsWith('projectiles/') || p.startsWith('props/') || p.startsWith('effects/')) &&
          (p.endsWith('.bp') || p.endsWith('.lua'))) ||
        (p.startsWith('env/') && p.endsWith('_prop.bp')),
    )
    for (const [p, b] of await vfs.readMany(projPaths)) files.set(p, b)

    const worker = new Worker(new URL('./luaSimWorker.ts', import.meta.url), { type: 'module' })
    const client = new LuaSimClient(worker, vfs)
    const booted = new Promise<void>((res) => {
      client.bootResolve = res
    })
    worker.onmessage = (e: MessageEvent<OutMsg>) => client.onMessage(e.data, log)
    worker.postMessage({ type: 'boot', files, terrain, props })
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
        // Map-prop instances that died this beat (reclaimed/destroyed) —
        // consumed by the instanced map-prop renderer.
        if (m.removedMapProps && m.removedMapProps.length > 0) {
          for (const idx of m.removedMapProps) this.removedMapProps.push(idx)
        }
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
        // Kein Modell (z. B. Effekt-Einheiten): dann hat die Unit eben keine
        // Knochen. Das ist eine Tatsache über die Unit, keine Lücke der Engine —
        // ValidateBone liefert dann korrekt false.
      }
    }
    this.payloadCache.set(id, payload)
    return payload
  }

  /** Spawnt eine Unit über ihre Original-Klasse im Worker; liefert die Unit-ID. */
  async spawn(id: string, pos: { x: number; y: number; z: number }, army = 1): Promise<number> {
    const p = await this.unitPayload(id)
    const reqId = this.nextReq++
    return new Promise<number>((resolve, reject) => {
      this.spawnPending.set(reqId, { resolve, reject })
      this.worker.postMessage({ type: 'spawn', reqId, id, ...p, pos, army })
    })
  }

  /**
   * Bau-Befehl: Baustelle setzen und dem Bauer den Auftrag geben. Liefert die ID
   * der Baustelle.
   *
   * Die Engine tut genau das: `Sim::CreateUnit(params, beingBuilt = 1)` und
   * danach `OnStartBuild(target, 'MobileBuild')` auf dem Bauer. Der Fortschritt
   * entsteht dann von selbst im Beat (`buildRate/BuildTime · ResourceConsumed ·
   * 0.1`, CBuildTaskHelper::UpdateWorkProgress @0x5f5f2c) — hier wird NICHTS
   * nachgerechnet.
   */
  async build(
    builderId: number,
    id: string,
    pos: { x: number; y: number; z: number },
    army = 1,
    /** Shift gehalten? Dann hängt der Auftrag an die Bau-Reihe an. */
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
   * Fabrik-Auftrag: `count` Einheiten in die Warteschlange der Fabrik. Das ist,
   * was `IssueBlueprintCommand("UNITCOMMAND_BuildFactory", id, count)` in der
   * Engine auslöst (construction.lua:884). Die Fabrik arbeitet sie im Beat ab —
   * über die Original-`FactoryUnit` (defaultunits.lua:422).
   */
  async factoryBuild(factoryId: number, id: string, count: number): Promise<void> {
    const p = await this.unitPayload(id)
    this.worker.postMessage({ type: 'factoryBuild', factoryId, id, ...p, count })
  }

  /**
   * Einen Eintrag der Fabrik-Warteschlange ändern — das Sim-Ende von
   * Increase/DecreaseBuildCountInQueue (Moho::ISSUE_IncreaseCommandCount
   * Cfile:1257266 / DecreaseCommandCount Cfile:1257378). `delta` < 0 nimmt
   * weg; fällt der Zähler auf 0, verschwindet der Eintrag.
   */
  adjustBuildQueue(factoryId: number, index: number, delta: number): void {
    this.worker.postMessage({ type: 'adjustQueue', factoryId, index, delta })
  }

  /**
   * Setzt die Sitzung zurück: frischer Lua-Host, frische Engine, neues Gelände.
   * Ohne das stapeln sich beim zweiten Sandbox-Start ACUs — und mit ihnen der
   * doppelte Startvorrat aus GiveInitialResources.
   */
  async reset(terrain: HeightfieldData, props: MapPropSpawn[] = []): Promise<void> {
    const done = new Promise<void>((res) => {
      this.resetResolve = res
    })
    this.statesById.clear()
    this.economy = null
    this.removedMapProps.length = 0
    this.worker.postMessage({ type: 'reset', terrain, props })
    await done
  }

  move(id: number, x: number, z: number, queue = false): void {
    this.worker.postMessage({ type: 'move', id, x, z, queue })
  }
  stop(id: number): void {
    this.worker.postMessage({ type: 'stop', id })
  }
  /** Attack-Befehl (CAttackTargetTask): Unit `id` greift `targetId` an. */
  attack(id: number, targetId: number, queue = false): void {
    this.worker.postMessage({ type: 'attack', id, targetId, queue })
  }
  /** Ground attack: same task with an AITARGET_Ground position target. */
  attackGround(id: number, x: number, z: number, queue = false): void {
    this.worker.postMessage({ type: 'attackGround', id, x, z, queue })
  }
  /** Guard/assist (dispatch 0x0F): follow + assist `targetId`. */
  guard(id: number, targetId: number, queue = false): void {
    this.worker.postMessage({ type: 'guard', id, targetId, queue })
  }
  /** Patrol (dispatch 0x10): one leg; the queue's ring rotation loops it. */
  patrol(id: number, x: number, z: number, queue = false): void {
    this.worker.postMessage({ type: 'patrol', id, x, z, queue })
  }
  /** Repair (dispatch 0x14): resume building the unfinished `targetId`. */
  repair(id: number, targetId: number, queue = false): void {
    this.worker.postMessage({ type: 'repair', id, targetId, queue })
  }
  /** SetFireState (cfunc_SetFireStateL → sim driver ProcessInfo, ui-globals.lua:617). */
  setFireState(id: number, state: number): void {
    this.worker.postMessage({ type: 'fireState', id, state })
  }

  /**
   * Der Sammelpunkt einer Fabrik (IssueFactoryRallyPoint, Cfile:1008266). Die
   * Fabrik BEWEGT sich nicht — ihre frischen Einheiten fahren dorthin
   * (defaultunits.lua:578 CalculateRollOffPoint liest GetRallyPoint).
   */
  setRallyPoint(id: number, x: number, y: number, z: number): void {
    this.worker.postMessage({ type: 'rally', id, x, y, z })
  }

  /**
   * Die Welt anhalten/weiterlaufen lassen — was SessionRequestPause/SessionResume
   * in der Engine tun (CWldSession::RequestPause). Der Pause-Reiter der
   * Original-UI (tabs.lua:425/428) landet hier.
   */
  setPaused(paused: boolean): void {
    this.worker.postMessage({ type: 'pause', paused })
  }

  /** Letzter bekannter Zustand einer Unit (aus dem Worker-Beat). */
  state(id: number): LuaUnitSnapshot | undefined {
    return this.statesById.get(id)
  }
  /** Alle bekannten Unit-Zustände (letzter Beat). */
  allStates(): LuaUnitSnapshot[] {
    return [...this.statesById.values()]
  }

  /** Die fliegenden Projektile des letzten Beats (leer, wenn keiner schießt). */
  allProjectiles(): LuaProjectileSnapshot[] {
    return this.projectileStates
  }

  /** Die lebenden Emitter des letzten Beats (Mündungsfeuer, Trails, …). */
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

  /** Die Props des letzten Beats (Wracks, Felsen, Bäume). */
  allProps(): LuaPropSnapshot[] {
    return this.propStates
  }

  /** Drain the map-prop indices that died since the last call. */
  drainRemovedMapProps(): number[] {
    if (this.removedMapProps.length === 0) return []
    return this.removedMapProps.splice(0, this.removedMapProps.length)
  }

  /** Reclaim (dispatch 0x13, CUnitReclaimTask): drain prop `targetId`. */
  reclaim(id: number, targetId: number, queue = false): void {
    this.worker.postMessage({ type: 'reclaim', id, targetId, queue })
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
   * Ein Mesh-Blueprint aus der Sim (z. B. die Wrack-Variante
   * '/units/uel0201/uel0201_mesh_wreck' aus ExtractWreckageBlueprint,
   * lua/system/blueprints.lua:187). null, wenn es keines gibt. Gecacht.
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
