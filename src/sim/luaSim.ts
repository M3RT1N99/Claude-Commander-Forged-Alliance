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

/**
 * Browser-Fassade für die eingebettete Original-Lua-Sim. Bootet den Lua-Host
 * aus dem gemounteten Spiel-VFS und spawnt Units über ihre echten
 * Lua-Klassen (Blueprint-Pipeline + Unit.lua). Der von der Original-Lua
 * gesetzte Zustand (Position/Health/…) wird an Renderer/Sandbox gereicht.
 */
export class LuaSim {
  private constructor(
    private readonly host: LuaHost,
    private readonly vfs: GameVfs,
  ) {}

  static async create(vfs: GameVfs, log?: LogSink): Promise<LuaSim> {
    // Framework + Sim + Fraktionsklassen (lua/**) vorladen — import() löst
    // synchron auf. Unit-spezifische Skripte/Blueprints kommen erst beim
    // Spawn dazu (addFile). Transpiliert wird lazy (mountModule).
    const files = new Map<string, Uint8Array>()
    for (const path of vfs.find((p) => p.startsWith('lua/') && p.endsWith('.lua'))) {
      files.set(path, await vfs.read(path))
    }
    const host = await LuaHost.create(files, log)
    host.loadGlobal('/lua/system/utils.lua')
    installMoho(host)
    installBlueprintPipeline(host)
    installUnitFactory(host)
    // Nicht-implementierte Engine-Globals (BuffBlueprint, DiskToLocal, …) als
    // Identitäts-Stubs — sonst wirft die Blueprint-DSL und safecall verschluckt
    // die Registrierung still. (Gleis B; echte Impl. folgt inkrementell.)
    host.installStubTrap(() => {})
    return new LuaSim(host, vfs)
  }

  /**
   * Spawnt eine Unit über ihre Original-Lua-Klasse und liefert den von
   * `OnCreate` gesetzten Zustand. Das Blueprint wird bei Bedarf registriert.
   */
  async spawn(
    blueprintId: string,
    pos: { x: number; y: number; z: number },
    army = 1,
  ): Promise<LuaUnitState> {
    // Unit-Script + Blueprint bei Bedarf ins VFS des Hosts nachladen.
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

  dispose(): void {
    this.host.close()
  }
}
