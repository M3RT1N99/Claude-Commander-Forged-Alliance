import type { SessionInfo } from './session'

/**
 * What the Sim worker's VFS has to contain, and which session runs in it.
 *
 * This lives next to `session.ts` and not inside `luaSimClient.ts` on purpose:
 * the browser boot cannot be run by a Node suite, but the *selection* can. Both
 * the client and `scripts/verify-browser-session.ts` call these functions, so a
 * file group that goes missing from the browser payload goes missing from the
 * suite as well — and the suite is the one that fails.
 */
export interface SimBootPaths {
  /**
   * `lua/**` AND `schook/**`. The whole of lua/, including lua/ui/: the
   * original UI is Lua (maui) and is meant to be executed, not rebuilt in
   * TS/HTML — excluding it here is exactly what prevented that. The Sim host
   * only loads what gets imported; preloading costs the VFS read alone, and
   * `readMany` turns a contiguous block into ONE archive access.
   *
   * schook/** is FA's patch hook layer: `doscript` appends the file of the same
   * name from /schook to every module (boot.lua runHooks;
   * bin/SupComDataPath.lua: hook = {'/schook'}). Without it the Sim lacks e.g.
   * SimUnitEnhancements/RemoveAllUnitEnhancements (schook/lua/SimSync.lua),
   * which unit.lua:1287 calls in EVERY OnDestroy — and
   * schook/lua/GlobalInit.lua, which loads the file that DEFINES
   * `BuffBlueprint`.
   *
   * And `loc/**`: globalInit.lua:22 loads Localization.lua, whose
   * `okLanguage()` (localization.lua:20-31) asks the VFS for the installed
   * language — `exists('/loc/<la>/strings_db.lua')`, then `'us'`, then
   * `DiskFindFiles('/loc', '*strings_db.lua')`. With no loc file in the
   * worker's VFS all three miss and the boot dies at
   * `string.gsub(dbfiles[1], ...)` on nil. The engine's VFS always has one.
   */
  core: string[]
  /**
   * Every projectile, prop and effect blueprint plus their scripts, and the
   * `env/**_prop.bp` map props.
   *
   * They must be in the Sim before the first shot: a weapon fires in the MIDDLE
   * of a tick (defaultweapons.lua calls `unit:CreateProjectile(bp.ProjectileId,
   * ...)`, uel0201_unit.bp:225 points at
   * `/projectiles/TDFGauss01/TDFGauss01_proj.bp`) — no place for an async
   * lookup on the main thread. The engine does the same: it loads ALL
   * blueprints at startup (Blueprints.lua via DiskFindFiles). The props become
   * the wrecks (unit.lua:1105 `CreateProp(pos, bp.Wreckage.Blueprint)`), and
   * reclaim needs the env props' Economy.ReclaimMassMax/EnergyMax.
   */
  blueprints: string[]
  /**
   * The map's own Lua. `SetupSession()` runs `doscript(ScenarioInfo.save)` and
   * `doscript(ScenarioInfo.script)` (siminit.lua:91-98) IN THE SIM — so
   * `_save.lua`, `_script.lua` and `_scenario.lua` have to be in the Sim's VFS,
   * not just readable by the main thread. Empty without a map folder.
   */
  map: string[]
}

const isMapLua = (p: string, folder: string): boolean =>
  p.startsWith(`maps/${folder.toLowerCase()}/`) && p.endsWith('.lua')

/** Splits a VFS path list into the three groups the Sim worker boots from. */
export function simBootPaths(all: Iterable<string>, mapFolder?: string): SimBootPaths {
  const core: string[] = []
  const blueprints: string[] = []
  const map: string[] = []
  const folder = mapFolder?.toLowerCase()
  for (const raw of all) {
    const p = raw.toLowerCase()
    if (
      (p.startsWith('lua/') || p.startsWith('schook/') || p.startsWith('loc/')) &&
      p.endsWith('.lua')
    )
      core.push(raw)
    else if (
      ((p.startsWith('projectiles/') || p.startsWith('props/') || p.startsWith('effects/')) &&
        (p.endsWith('.bp') || p.endsWith('.lua'))) ||
      (p.startsWith('env/') && p.endsWith('_prop.bp'))
    )
      blueprints.push(raw)
    else if (folder && isMapLua(p, folder)) map.push(raw)
  }
  return { core, blueprints, map }
}

/**
 * The map's `<name>_scenario.lua`. The name is NOT derivable from the folder —
 * `maputil.lua:106` finds it with `DiskFindFiles(dir, '*_scenario.lua')`, and
 * so do we.
 */
export function mapScenarioFile(all: Iterable<string>, mapFolder: string): string | undefined {
  const prefix = `maps/${mapFolder.toLowerCase()}/`
  for (const raw of all) {
    const p = raw.toLowerCase()
    if (p.startsWith(prefix) && p.endsWith('_scenario.lua')) return `/${raw}`
  }
  return undefined
}

/**
 * A skirmish on that map, for the sandbox and the suites.
 *
 * TWO armies, both human — and both halves of that are findings, not
 * convenience:
 *
 * - The army LIST is the lobby's job in the original: it reads the
 *   `_scenario.lua`, offers the slots and hands the engine what the players
 *   picked. We have no lobby yet, so two armies stand here; a four-slot map
 *   then plays two-handed, which `InitializeArmies` handles by iterating
 *   `ScenarioInfo.ArmySetup` (scenarioutilities.lua:467).
 * - `human: false` runs `InitializeArmyAI` in `brain:OnCreateAI(plan)`
 *   (Cfile:724516-724518) and dies at `aibrain.lua:1144`: `plat:ForkThread(...)`
 *   on `plat = self:GetPlatoonUniquelyNamed('ArmyPool')`, and
 *   `GetPlatoonUniquelyNamed` is one of the silent no-ops in `moho.lua`. There
 *   is no platoon system, so there is no AI army. See docs/STATUS.md.
 */
export function mapSession(all: Iterable<string>, mapFolder: string): SessionInfo | undefined {
  const scenarioFile = mapScenarioFile(all, mapFolder)
  if (!scenarioFile) return undefined
  return {
    type: 'skirmish',
    map: `/maps/${mapFolder}/${mapFolder}.scmap`,
    scenarioFile,
    armies: [
      { name: 'ARMY_1', index: 1, faction: 1, human: true },
      { name: 'ARMY_2', index: 2, faction: 1, human: true },
    ],
  }
}
