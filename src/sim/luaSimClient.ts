import type { GameVfs } from '../vfs/vfs'
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
}

interface StatesMsg {
  type: 'states'
  units: LuaUnitSnapshot[]
  economy: EcoSnapshot
}
type OutMsg =
  | { type: 'booted' }
  | { type: 'log'; level: string; msg: string }
  | { type: 'spawned'; reqId: number; uid: number }
  | { type: 'spawnError'; reqId: number; error: string }
  | StatesMsg

export class LuaSimClient {
  private readonly statesById = new Map<number, LuaUnitSnapshot>()
  private economy: EcoSnapshot | null = null
  private nextReq = 1
  private bootResolve: (() => void) | null = null
  private readonly spawnPending = new Map<number, { resolve: (uid: number) => void; reject: (e: Error) => void }>()

  private constructor(
    private readonly worker: Worker,
    private readonly vfs: GameVfs,
  ) {}

  static async create(vfs: GameVfs, log: (level: string, msg: string) => void): Promise<LuaSimClient> {
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
    worker.postMessage({ type: 'boot', files })
    await booted
    return client
  }

  private onMessage(m: OutMsg, log: (level: string, msg: string) => void): void {
    switch (m.type) {
      case 'booted':
        this.bootResolve?.()
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
  /** Letzte Armee-Ökonomie (Armee 1). */
  economySnapshot(): EcoSnapshot | null {
    return this.economy
  }
}
