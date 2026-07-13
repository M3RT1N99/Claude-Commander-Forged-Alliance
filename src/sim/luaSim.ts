import type { GameVfs } from '../vfs/vfs'
import { LuaHost, type LogSink } from '../lua/host'
import { installMoho } from '../lua/moho'
import {
  installUnitFactory,
  installBlueprintPipeline,
  loadUnitBlueprint,
  spawnLuaUnit,
  readLuaUnit,
  type LuaUnitState,
} from '../lua/unitFactory'
import { installSimThreads, simTick } from '../lua/simThreads'
import { installMotion, motionTick } from './motion'
import { EconomyManager, installEconomy, type ArmyEconomy } from './economy'

/**
 * Browser-Fassade für die eingebettete Original-Lua-Sim — jetzt die
 * Engine-first-Sim (M1–M4): die Original-Lua treibt Spawn, per-Tick-Threads,
 * Ökonomie und Bewegung. `beat()` ist der 10-Hz-Sim-Beat in Original-
 * Reihenfolge (Ökonomie → Lua-Threads → Physik-Fortschreibung).
 */
export class LuaSim {
  private readonly eco = new EconomyManager()

  private constructor(
    private readonly host: LuaHost,
    private readonly vfs: GameVfs,
  ) {}

  static async create(vfs: GameVfs, log?: LogSink): Promise<LuaSim> {
    // Framework + Sim-Lua vorladen (import() löst synchron auf). Die Reads
    // parallel in Batches — sequenziell wären es ~1300 einzelne Range-Requests
    // und die App friert ein.
    const files = new Map<string, Uint8Array>()
    // lua/ui/** ist das UI-Framework (maui) — für den Sim-Spawn nicht nötig;
    // spart hunderte Fetches. Sim + System + AI werden geladen.
    const paths = vfs.find(
      (p) => p.startsWith('lua/') && p.endsWith('.lua') && !p.startsWith('lua/ui/'),
    )
    const BATCH = 64
    for (let i = 0; i < paths.length; i += BATCH) {
      const batch = paths.slice(i, i + BATCH)
      const bytes = await Promise.all(batch.map((p) => vfs.read(p)))
      batch.forEach((p, j) => files.set(p, bytes[j]!))
    }
    const host = await LuaHost.create(files, log)
    host.loadGlobal('/lua/system/utils.lua')
    installMoho(host)
    installBlueprintPipeline(host)
    installUnitFactory(host)
    installSimThreads(host)
    const sim = new LuaSim(host, vfs)
    installEconomy(host, sim.eco)
    installMotion(host)
    // Stub-Trap zuletzt: nicht-implementierte Engine-Globals werden No-Op.
    host.installStubTrap(() => {})
    return sim
  }

  /** Spawnt eine Unit über ihre Original-Klasse; liefert ihren Zustand. */
  async spawn(
    blueprintId: string,
    pos: { x: number; y: number; z: number },
    army = 1,
  ): Promise<LuaUnitState> {
    const scriptPath = `units/${blueprintId}/${blueprintId}_script.lua`
    if (!this.host.hasFile(scriptPath) && this.vfs.exists(scriptPath)) {
      this.host.addFile(scriptPath, await this.vfs.read(scriptPath))
    }
    const bpPath = `units/${blueprintId}/${blueprintId}_unit.bp`
    if (this.vfs.exists(bpPath)) {
      loadUnitBlueprint(this.host, blueprintId, await this.vfs.read(bpPath))
    }
    const id = spawnLuaUnit(this.host, blueprintId, pos, army)
    const state = readLuaUnit(this.host, id)
    if (!state) throw new Error(`Lua-Unit ${id} nicht lesbar`)
    return state
  }

  /**
   * Ein Sim-Beat (10 Hz) in Original-Reihenfolge: Ökonomie (Army::OnTick) →
   * Lua-Threads (CTaskStage::DoFrame) → Physik (Entity::AdvanceCoords).
   */
  beat(): void {
    this.eco.tick()
    simTick(this.host)
    motionTick(this.host)
  }

  /** Bewegungsbefehl: setzt der Unit ein Ziel über ihren Navigator. */
  moveUnit(id: number, x: number, z: number): void {
    this.host.eval(`local u = __units[${id}]; if u then u:GetNavigator():SetGoal({ ${x}, 0, ${z} }) end`)
  }

  /** Stopp-Befehl: bricht die Bewegung der Unit ab. */
  stopUnit(id: number): void {
    this.host.eval(`local u = __units[${id}]; if u then u:GetNavigator():AbortMove() end`)
  }

  /** Aktueller Zustand einer Unit (Position/Heading/Health). */
  readState(id: number): LuaUnitState | null {
    return readLuaUnit(this.host, id)
  }

  /** Ökonomie-Zustand einer Armee (für die HUD). */
  army(n: number): ArmyEconomy {
    return this.eco.army(n)
  }

  dispose(): void {
    this.host.close()
  }
}
