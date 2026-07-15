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
  /** Baufortschritt (1 = fertig). __readAllUnits schickt es, es wurde nur nie gelesen. */
  fraction: number
  /** Bau-Warteschlange einer Fabrik: { id, count } — leer bei allen anderen. */
  buildQueue?: { id: string; count: number }[]
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
  units: LuaUnitSnapshot[]
  economy: EcoSnapshot
}
type OutMsg =
  | { type: 'booted' }
  | { type: 'reset-done' }
  | { type: 'log'; level: string; msg: string }
  | { type: 'spawned'; reqId: number; uid: number }
  | { type: 'spawnError'; reqId: number; error: string }
  | StatesMsg

export class LuaSimClient {
  private readonly statesById = new Map<number, LuaUnitSnapshot>()
  private economy: EcoSnapshot | null = null
  private nextReq = 1
  private bootResolve: (() => void) | null = null
  private resetResolve: (() => void) | null = null
  private readonly spawnPending = new Map<number, { resolve: (uid: number) => void; reject: (e: Error) => void }>()

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
    // ALLE lua/-Dateien, auch lua/ui/. Die UI des Originals ist Lua (maui) und
    // soll ausgeführt werden, nicht in TS/HTML nachgebaut — sie hier
    // auszuschließen hat genau das verhindert. Der Sim-Host lädt ohnehin nur,
    // was importiert wird; das Vorladen kostet nur den VFS-Lesevorgang.
    // EIN Archiv-Zugriff pro zusammenhängendem Block statt zwei pro Datei
    // (vfs.readMany): `lua/**` liegt in lua.scd (7 MB) und mohodata.scd — am
    // Stück gelesen kostet das nichts.
    const files = await vfs.readMany(vfs.find((p) => p.startsWith('lua/') && p.endsWith('.lua')))

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
   * Setzt die Sitzung zurück: frischer Lua-Host, frische Engine, neues Gelände.
   * Ohne das stapeln sich beim zweiten Sandbox-Start ACUs — und mit ihnen der
   * doppelte Startvorrat aus GiveInitialResources.
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

  move(id: number, x: number, z: number): void {
    this.worker.postMessage({ type: 'move', id, x, z })
  }
  stop(id: number): void {
    this.worker.postMessage({ type: 'stop', id })
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

  /** Letzte Armee-Ökonomie (Armee 1). */
  economySnapshot(): EcoSnapshot | null {
    return this.economy
  }
}
