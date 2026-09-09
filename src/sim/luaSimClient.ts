import type { GameVfs } from '../vfs/vfs'
import type { HeightfieldData } from './terrain'
import type { EcoSnapshot } from '../ui/hud'
import { parseBlueprint } from '../formats/blueprint'
import { simBootPaths, mapSession } from './mapSession'
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

/** One command of a synced queue: id, EUnitCommandType and target position
 *  (y only where the sim resolved it -- factory commands always). */
export interface SimOrderEntry {
  id: number
  t: 'Move' | 'Attack' | 'Repair' | 'BuildMobile' | 'Patrol' | 'Guard' | 'Reclaim'
  x: number
  y?: number
  z: number
}

/** A command for a factory's command list (see LuaSimClient.factoryCommand). */
export type FactoryCommand =
  | { cmd: 'Move' | 'Patrol' | 'AttackGround'; x: number; z: number }
  | { cmd: 'Attack' | 'Guard'; targetId: number }

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
  /** Effective command-cap mask (UnitAttributes::commandCapsMask) — the UI
   *  mirror follows runtime Add/RemoveCommandCap through this sync. */
  caps?: number
  /** Effective toggle-cap mask, mutated by Add/RemoveToggleCap. */
  toggleCaps?: number
  /** Unit script-bit mask (mScriptBits), authoritative in the sim. */
  scriptBits?: number
  /** Current movement layer (Land/Water/Sub/Seabed/Air/Orbit). */
  layer?: string
  /** Automatic silo-build mode (mAutoMode). */
  autoMode?: boolean
  /** Automatic submarine surfacing mode (mAutoSurfaceMode). */
  autoSurfaceMode?: boolean
  /** Dead/DestroyQueued through the multi-beat death sequence — the UI mirror
   *  excludes it from selection/avatars (IsDead + DestroyQueued, Cfile:1361497). */
  dead?: boolean
  /** Shield strength ratio 0..1 (shield.lua UpdateShieldRatio -> SetShieldRatio);
   *  the UI shows it via GetShieldRatio. */
  shieldRatio?: number
  /** The unit's own build-restriction category (UnitAttributes::
   *  mRestrictionCategory) in the text form of globals.lua
   *  __categoryToString; '' when nothing is restricted. GetUnitCommandData
   *  subtracts it from the build menu (Cfile:1264642-1264646). */
  restrict?: string
  /** Bone names the sim has hidden (Unit:HideBone, CAniPoseBone::mVisible);
   *  absent when none. The renderer collapses their geometry. */
  hidden?: string[]
  /** The texture scroll of the entity, [s1x, s1y, s2x, s2y] = mVarDat.mScroll1
   *  and mScroll2 (CTextureScroller::Tick); present once a scroller exists. */
  scroll?: number[]
  /** Unit::SetCustomName (Cfile:979089-979120); absent when unnamed. */
  customName?: string
  /** UNITSTATE_UnSelectable (SetUnSelectable, Cfile:974215-974260); absent
   *  when selectable. */
  unselectable?: boolean
  /** WorkProgress (mUnitVarDat.mWorkProgress): the progress of what this unit
   *  is building/upgrading/enhancing, written by the build task every tick
   *  (Cfile:815482). construction.lua:380 draws it. */
  workProgress?: number
  /** UNITSTATE_BeingUpgraded (37): the successor growing on a structure. The
   *  drag box skips it (Cfile:1290062). */
  beingUpgraded?: boolean
  /** Erstellungs-Tick — die Build-Shader zählen ihr Alter darüber (material.x). */
  /**
   * The mesh blueprint the unit carries when it is NOT its own
   * Display.MeshBlueprint (Unit:SetMesh -- the personal shield's
   * OwnerShieldMesh, shield.lua:478); '' = no mesh at all. Absent while the
   * unit wears its blueprint mesh (units.lua swappedMesh).
   */
  mesh?: string
  born: number
  /** The unit's active order (command graph): type + target position. */
  order?: SimOrderEntry
  /** The full command queue, head first (CUnitCommandQueue). */
  orders?: SimOrderEntry[]
  /**
   * The FACTORY command list (CAiBuilderImpl::mCommands): the rally commands
   * the user side reads as the factory's command queue (UserUnit::
   * GetCommandQueue, Cfile:1367121-1367128), draws beside the unit's own
   * queue (1245537-1245575) and every product inherits (818487-818600).
   */
  fcmds?: SimOrderEntry[]
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
  /** Runtime transform scale from Projectile::MotionTick. */
  sx: number
  sy: number
  sz: number
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
  /**
   * SetEmitterParam by canonical EEmitterParam name (the POSITION slots
   * are ox/oy/oz, SCALE is scale) -- present only when the Lua set one.
   */
  params?: Record<string, number>
  /** SetEmitterCurveParam / ResizeEmitterCurve: the replaced curves by blueprint field. */
  curves?: Record<string, { XRange: number; Keys: [number, number, number][] }>
  /** SetBeamParam by canonical EBeamParam name. */
  beam?: Record<string, number>
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

/**
 * A plain entity with a mesh (Entity:SetMesh -- the shield domes above all),
 * as props.lua __readMeshEntitiesJson serialises it: the mesh blueprint's
 * long id, the world position (attached entities follow their parent per
 * beat), heading, the uniform draw scale, the health fraction
 * (PARAM_FRACTIONHEALTH), the army and the four visibility modes.
 */
export interface LuaMeshEntitySnapshot {
  id: number
  bp: string
  x: number
  y: number
  z: number
  heading: number
  scale: number
  hp: number
  army: number
  viz: { focus: string; allies: string; enemies: string; neutrals: string }
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
  /** The mesh entities (shield domes and shells) of this beat. */
  meshEntities?: LuaMeshEntitySnapshot[]
  /** Map-prop indices whose sim props died this beat (reclaim/destroy). */
  removedMapProps?: number[]
  /** Sim->user audio requests (SAudioRequest analog). */
  audio?: SimAudioRequest[]
  /** Sim->user camera shakes (SCamShakeParams, Sim::mSyncCamShake). */
  camShakes?: SimCamShake[]
  /** Light particles spawned this beat (CreateLightParticle, Cfile:905874-906033). */
  lights?: SimLightParticle[]
  /** Splats and decals created this beat (CreateSplat / CreateDecal / CreateSplatOnBone). */
  decalAdds?: SimDecal[]
  /** Decal handles destroyed this beat (CDecalHandle:Destroy). */
  decalRemovals?: number[]
  /** The army build restrictions as category text per army (the deny-list
   *  the sim enforces; the UI subtracts it from the build menu). */
  armyRestrictions?: Record<string, string>
  economy: EcoSnapshot
}

/** One camera shake request: Entity:ShakeCamera's epicentre and numbers
 *  (cfunc_EntityShakeCameraL, Cfile:931108-931169). */
/** One light particle: a flat additive quad of constant size at a fixed
 *  world point, its ramp sampled with t/lifetime (TLight_ADD, particle.fx). */
/**
 * A splat or decal as the sim records it (SDecalInfo, Cfile:907248-907282):
 * the world position and heading, the two sizes (size.y is 1), the two
 * texture paths already resolved as CDecalManager::AddDecals does it
 * (1305895-1305930; '' = none), the type string ('' for a splat; the
 * decal types are CWldTerrainDecal::sTypeDesc, 1966195-1966229), the LOD
 * parameter, the expiry tick (0 = never), the army, the fidelity, and the
 * creation tick.
 */
export interface SimDecal {
  id: number
  x: number
  y: number
  z: number
  heading: number
  sx: number
  sz: number
  tex1: string
  tex2: string
  type: string
  lod: number
  expire: number
  army: number
  fidelity: number
  splat: boolean
  tick: number
}

export interface SimLightParticle {
  x: number
  y: number
  z: number
  size: number
  /** Lifetime in the particle clock's unit (sim ticks, like the curves). */
  life: number
  tex: string
  ramp: string
  army: number
  /** The sim tick of the spawn -- the particle's birth. */
  tick: number
}

export interface SimCamShake {
  x: number
  y: number
  z: number
  radius: number
  max: number
  min: number
  duration: number
}

/** One sim->user audio request (SAudioRequest: EntitySound=0, StartLoop=1,
 *  StopLoop=2 — effects-audio.md "Sound-Lua-API"). */
export interface SimAudioRequest {
  t: 0 | 1 | 2
  bank: string
  cue: string
  /** Loop handle (HSound analog); 0 for one-shots. */
  h: number
}
type OutMsg =
  | { type: 'booted'; starts?: { army: number; x: number; z: number }[] }
  // The worker asks for the blueprints the session start can name. It waits for
  // the answer before `BeginSession()` — see luaSimWorker.ts at the call site.
  | { type: 'needUnits'; ids: string[] }
  | { type: 'reset-done'; starts?: { army: number; x: number; z: number }[] }
  | { type: 'log'; level: string; msg: string }
  | { type: 'spawned'; reqId: number; uid: number }
  | { type: 'spawnError'; reqId: number; error: string }
  | { type: 'emitterBp'; reqId: number; bp: unknown }
  | { type: 'meshBp'; reqId: number; bp: unknown }
  | { type: 'debugEval'; reqId: number; value: unknown }
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
  private meshEntityStates: LuaMeshEntitySnapshot[] = []
  /** Accumulated dead map-prop indices; drained by the instanced renderer. */
  private readonly removedMapProps: number[] = []
  /** Accumulated sim audio requests; drained by GameAudio in main. */
  private readonly audioRequests: SimAudioRequest[] = []
  /** Accumulated camera shakes; drained by the viewer in main. */
  private readonly camShakes: SimCamShake[] = []
  /** Accumulated light particles; drained by the particle system in main. */
  private readonly lights: SimLightParticle[] = []
  private readonly decalAdds: SimDecal[] = []
  private readonly decalRemovals: number[] = []
  private armyRestrictions: Record<string, string> = {}
  /** Letzter gemeldeter Sim-Tick (Spielzeit = Tick / 10). */
  gameTick = 0
  private nextReq = 1
  private bootResolve: (() => void) | null = null
  /**
   * Where the armies start — the map's ARMY_n markers, as
   * `InitializeStartLocation` wrote them into `SetArmyStart`
   * (scenarioutilities.lua:1026-1033). Empty without a map session.
   */
  armyStarts: { army: number; x: number; z: number }[] = []
  private resetResolve: (() => void) | null = null
  private readonly spawnPending = new Map<number, { resolve: (uid: number) => void; reject: (e: Error) => void }>()
  private readonly emitterBpPending = new Map<number, (bp: unknown) => void>()
  private readonly emitterBpCache = new Map<string, Promise<unknown>>()
  private readonly meshBpPending = new Map<number, (bp: unknown) => void>()
  private readonly meshBpCache = new Map<string, Promise<unknown>>()
  private readonly debugEvalPending = new Map<number, (v: unknown) => void>()

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
    /**
     * The map's water surface, or undefined when the map has no water. The Sim
     * needs it for GetSurfaceHeight, the motion layer rule (only Water /
     * AmphibiousFloating / Hover float, Cfile:765809) and projectile water
     * impacts. Until this was wired the Sim ran with -10000 forever, so every
     * water-dependent decision silently resolved to "no water".
     */
    waterElevation?: number,
    /** scmap map props — spawned in the sim before any unit (Sim::Setup 7). */
    props: MapPropSpawn[] = [],
    /**
     * The map's folder under `maps/`. With it the worker runs the REAL session
     * start: the map's `_save.lua`/`_script.lua` go into the Sim's VFS,
     * `SetupSession()` loads them and `BeginSession()` runs the map's own
     * `OnPopulate` — which is what puts the ACUs on the ARMY_n markers. Without
     * it the Sim stays the map-less harness from `session.ts`.
     */
    mapFolder?: string,
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
    const groups = simBootPaths(vfs.find(() => true), mapFolder)
    const files = await vfs.readMany(groups.core)

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
    for (const [p, b] of await vfs.readMany(groups.blueprints)) files.set(p, b)
    // Und die Lua der Karte: `SetupSession()` macht `doscript` darauf IN DER
    // SIM (siminit.lua:91-98), also muss sie im VFS des Workers liegen — nicht
    // nur im Hauptthread lesbar sein.
    for (const [p, b] of await vfs.readMany(groups.map)) files.set(p, b)

    const worker = new Worker(new URL('./luaSimWorker.ts', import.meta.url), { type: 'module' })
    const client = new LuaSimClient(worker, vfs)
    const booted = new Promise<void>((res) => {
      client.bootResolve = res
    })
    worker.onmessage = (e: MessageEvent<OutMsg>) => client.onMessage(e.data, log)
    const session = mapFolder ? mapSession(vfs.find(() => true), mapFolder) : undefined
    worker.postMessage({ type: 'boot', files, terrain, waterElevation, props, session })
    await booted
    return client
  }

  private onMessage(m: OutMsg, log: (level: string, msg: string) => void): void {
    switch (m.type) {
      case 'booted':
        this.armyStarts = m.starts ?? []
        this.bootResolve?.()
        break
      case 'needUnits':
        // The Sim named the blueprints its session start can create. Answering
        // is what lets `BeginSession()` run the map's OnPopulate — the worker
        // waits for this message.
        void Promise.all(m.ids.map(async (id) => ({ id, ...(await this.unitPayload(id)) }))).then(
          (units) => this.worker.postMessage({ type: 'units', units }),
        )
        break
      case 'reset-done':
        // Die Startpositionen der NEUEN Karte uebernehmen — der Reset hat sie
        // aus deren Markern gelesen.
        this.armyStarts = m.starts ?? []
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
        this.meshEntityStates = m.meshEntities ?? []
        // Map-prop instances that died this beat (reclaimed/destroyed) —
        // consumed by the instanced map-prop renderer.
        if (m.removedMapProps && m.removedMapProps.length > 0) {
          for (const idx of m.removedMapProps) this.removedMapProps.push(idx)
        }
        if (m.audio && m.audio.length > 0) {
          for (const r of m.audio) this.audioRequests.push(r)
        }
        if (m.camShakes && m.camShakes.length > 0) {
          for (const s of m.camShakes) this.camShakes.push(s)
        }
        if (m.decalAdds && m.decalAdds.length > 0) {
          for (const d of m.decalAdds) this.decalAdds.push(d)
        }
        if (m.decalRemovals && m.decalRemovals.length > 0) {
          for (const id of m.decalRemovals) this.decalRemovals.push(id)
        }
        if (m.lights && m.lights.length > 0) {
          for (const l of m.lights) this.lights.push(l)
        }
        if (m.armyRestrictions) this.armyRestrictions = m.armyRestrictions
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
      case 'debugEval': {
        const p = this.debugEvalPending.get(m.reqId)
        this.debugEvalPending.delete(m.reqId)
        p?.(m.value)
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
  async reset(
    terrain: HeightfieldData,
    props: MapPropSpawn[] = [],
    waterElevation?: number,
    /**
     * Der Ordner der NEUEN Karte. Ohne ihn faehrt der Reset ohne Sitzung: keine
     * ACUs, keine Lagerstaetten — `SetupSession()` laeuft dann gar nicht.
     */
    mapFolder?: string,
  ): Promise<void> {
    const done = new Promise<void>((res) => {
      this.resetResolve = res
    })
    // Der GANZE Sitzungsschnappschuss, nicht nur die Einheiten: Projektile,
    // Emitter, Props, der Tick und die Startpositionen gehoerten alle zur alten
    // Karte. `armyStarts` insbesondere — sonst zeigt die Kamera der neuen
    // Sandbox auf den Startpunkt der vorigen.
    this.statesById.clear()
    this.economy = null
    this.removedMapProps.length = 0
    this.audioRequests.length = 0
    this.camShakes.length = 0
    this.lights.length = 0
    this.decalAdds.length = 0
    this.decalRemovals.length = 0
    this.projectileStates = []
    this.emitterStates = []
    this.propStates = []
    this.gameTick = 0
    this.armyStarts = []

    const alle = this.vfs.find(() => true)
    const session = mapFolder ? mapSession(alle, mapFolder) : undefined
    // Die Lua der neuen Karte muss mit: der Worker hat nur die der alten.
    const files = mapFolder
      ? await this.vfs.readMany(simBootPaths(alle, mapFolder).map)
      : undefined
    this.worker.postMessage({ type: 'reset', terrain, waterElevation, props, session, files })
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
  /** ToggleScriptBit (cfunc_ToggleScriptBitL): the UI has already filtered
   *  units by their current state; ProcessInfo carries only the bit to flip. */
  toggleScriptBit(id: number, bit: number): void {
    this.worker.postMessage({ type: 'scriptBit', id, bit })
  }
  setAutoMode(id: number, enabled: boolean): void {
    this.worker.postMessage({ type: 'autoMode', id, enabled })
  }
  setAutoSurfaceMode(id: number, enabled: boolean): void {
    this.worker.postMessage({ type: 'autoSurfaceMode', id, enabled })
  }
  /** IssueUpgrade (cfunc_IssueUpgradeL, Cfile:1011315): upgrade this structure
   *  to `blueprint` (General.UpgradesTo). The successor is built at the old
   *  building's position with the old building as its builder. */
  upgrade(id: number, blueprint: string): void {
    this.worker.postMessage({ type: 'upgrade', id, blueprint })
  }
  /** Per-unit SetPaused (cfunc_SetPausedL): pause a builder/factory's
   *  production — DISTINCT from the whole-world session pause (`setPaused`). */
  setUnitPaused(id: number, paused: boolean): void {
    this.worker.postMessage({ type: 'unitPause', id, paused })
  }

  /**
   * A FACTORY command (ISSUE_FactoryCommand, Cfile:1350766): Move / Patrol /
   * Attack / Guard into the factory's command list. The rally point is the
   * Move at its head (GetRallyPoint, 980887-980900); every finished unit
   * inherits the whole list (818487-818600); the factory itself stays put.
   * Shift appends, otherwise the list is replaced (the ClearQueue byte,
   * 997129-997159).
   */
  factoryCommand(id: number, cmd: FactoryCommand, queue?: boolean): void {
    this.worker.postMessage({ type: 'factoryCommand', id, ...cmd, queue })
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

  /** The mesh entities of the last beat (the shield domes and shells). */
  allMeshEntities(): LuaMeshEntitySnapshot[] {
    return this.meshEntityStates
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

  /** Drain the sim->user audio requests since the last call. */
  drainAudioRequests(): SimAudioRequest[] {
    if (this.audioRequests.length === 0) return []
    return this.audioRequests.splice(0, this.audioRequests.length)
  }

  /** The army build restrictions of the last beat (category text per army). */
  getArmyRestrictions(): Record<string, string> {
    return this.armyRestrictions
  }

  /** Drain the splats and decals created since the last call. */
  drainDecalAdds(): SimDecal[] {
    if (this.decalAdds.length === 0) return []
    return this.decalAdds.splice(0, this.decalAdds.length)
  }

  /** Drain the decal handles destroyed since the last call. */
  drainDecalRemovals(): number[] {
    if (this.decalRemovals.length === 0) return []
    return this.decalRemovals.splice(0, this.decalRemovals.length)
  }

  /** Drain the light particles spawned since the last call. */
  drainLights(): SimLightParticle[] {
    if (this.lights.length === 0) return []
    return this.lights.splice(0, this.lights.length)
  }

  /** Drain the sim->user camera shakes since the last call. */
  drainCamShakes(): SimCamShake[] {
    if (this.camShakes.length === 0) return []
    return this.camShakes.splice(0, this.camShakes.length)
  }

  /** Reclaim (dispatch 0x13, CUnitReclaimTask): drain prop `targetId`. */
  reclaim(id: number, targetId: number, queue = false): void {
    this.worker.postMessage({ type: 'reclaim', id, targetId, queue })
  }
  /** Reclaim a MAP prop by its scmap instance index (picked from the
   *  instanced renderer; the sim resolves the prop id). */
  reclaimMapProp(id: number, mapIndex: number, queue = false): void {
    this.worker.postMessage({ type: 'reclaim', id, mapIndex, queue })
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
   * DEV diagnosis only: a Lua expression returning JSON text, evaluated in
   * the sim state (the page's __cfa.simEval). Not a game path.
   */
  debugEval(lua: string): Promise<unknown> {
    const reqId = this.nextReq++
    return new Promise<unknown>((resolve) => {
      this.debugEvalPending.set(reqId, resolve)
      this.worker.postMessage({ type: 'debugEval', reqId, lua })
    })
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
