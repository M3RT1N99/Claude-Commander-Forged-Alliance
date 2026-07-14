import type { GameVfs } from '../vfs/vfs'
import type { HeightfieldData } from './terrain'
import type { EcoSnapshot } from '../ui/hud'

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
    const files = new Map<string, Uint8Array>()
    const paths = vfs.find((p) => p.startsWith('lua/') && p.endsWith('.lua'))
    const BATCH = 64
    for (let i = 0; i < paths.length; i += BATCH) {
      const batch = paths.slice(i, i + BATCH)
      const bytes = await Promise.all(batch.map((p) => vfs.read(p)))
      batch.forEach((p, j) => files.set(p, bytes[j]!))
    }
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

  /** Spawnt eine Unit über ihre Original-Klasse im Worker; liefert die Unit-ID. */
  async spawn(id: string, pos: { x: number; y: number; z: number }, army = 1): Promise<number> {
    const scriptPath = `units/${id}/${id}_script.lua`
    const scriptBytes = this.vfs.exists(scriptPath) ? await this.vfs.read(scriptPath) : null
    const bpPath = `units/${id}/${id}_unit.bp`
    const bpBytes = this.vfs.exists(bpPath) ? await this.vfs.read(bpPath) : null
    const reqId = this.nextReq++
    return new Promise<number>((resolve, reject) => {
      this.spawnPending.set(reqId, { resolve, reject })
      this.worker.postMessage({ type: 'spawn', reqId, id, scriptPath, scriptBytes, bpBytes, pos, army })
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
  ): Promise<number> {
    const scriptPath = `units/${id}/${id}_script.lua`
    const scriptBytes = this.vfs.exists(scriptPath) ? await this.vfs.read(scriptPath) : null
    const bpPath = `units/${id}/${id}_unit.bp`
    const bpBytes = this.vfs.exists(bpPath) ? await this.vfs.read(bpPath) : null
    const reqId = this.nextReq++
    return new Promise<number>((resolve, reject) => {
      this.spawnPending.set(reqId, { resolve, reject })
      this.worker.postMessage({
        type: 'build', reqId, builderId, id, scriptPath, scriptBytes, bpBytes, pos, army,
      })
    })
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
