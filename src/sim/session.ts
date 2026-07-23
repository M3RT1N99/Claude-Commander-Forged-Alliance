import type { LuaHost } from '../lua/host'

/**
 * Session setup — the engine side of SimInit.lua's boot sequence.
 *
 * SimInit.lua documents the order at its top:
 *   1. __blueprints is filled in from preloaded data
 *   2. SimInit.lua runs (globalInit, WaitTicks, SimSync)
 *   3a. ScenarioInfo is set up with info about the scenario   <- HERE
 *   4a. SetupSession() is called
 *   5a. Armies, brains and other game facilities are created  <- HERE
 *   6a. BeginSession() is called
 *
 * Steps 3a/5a are engine work: the engine knows the session (map, armies,
 * options) and publishes it to the Sim as the global `ScenarioInfo`, then
 * creates one brain per army. `aibrain.lua:421` reads `ScenarioInfo.type`,
 * the AI code reads `ScenarioInfo.ArmySetup[brain.Name]` — so this table is
 * not decoration, it is what the original Lua actually consumes.
 */

export interface SessionArmy {
  /** Army name as the Lua sees it, e.g. 'ARMY_1'. */
  name: string
  /** 1-based army index. */
  index: number
  /** 1 = UEF, 2 = Aeon, 3 = Cybran, 4 = Seraphim. */
  faction: number
  human: boolean
  /** 1-based command-source indices allowed to issue orders for this army. */
  authorizedCommandSources?: number[]
  /** Start resources are NOT set here — the ACU grants them via GiveInitialResources. */
  start?: { x: number; z: number }
}

export interface SessionInfo {
  type: 'skirmish' | 'campaign'
  map?: string
  armies: SessionArmy[]
  options?: Record<string, unknown>
}

/**
 * A two-army skirmish — the sandbox default. Army 2 hosts the selftest
 * enemies; without a session row the original ARMY_FromLuaState would
 * reject it ("Invalid army 2", Cfile:1358434).
 */
export const SANDBOX_SESSION: SessionInfo = {
  type: 'skirmish',
  armies: [
    { name: 'ARMY_1', index: 1, faction: 1, human: true },
    { name: 'ARMY_2', index: 2, faction: 3, human: false },
  ],
}

/**
 * Publishes ScenarioInfo to the Sim and creates the army brains (the original
 * AIBrain class from /lua/aibrain.lua, via __createBrain).
 */
export function setupSession(host: LuaHost, info: SessionInfo): void {
  const armySetup = info.armies
    .map(
      (a) => `      ['${a.name}'] = {
        ArmyIndex = ${a.index},
        ArmyName = '${a.name}',
        Human = ${a.human},
        Civilian = false,
        Faction = ${a.faction},
        AIPersonality = '',
      },`,
    )
    .join('\n')

  host.eval(`
    ScenarioInfo = {
      type = '${info.type}',
      map = '${info.map ?? ''}',
      Options = {},
      ArmySetup = {
${armySetup}
      },
    }
  `)

  // One brain per army — created by the engine, exactly as in step 5a.
  for (const a of info.armies) {
    host.eval(`__createBrain(${a.index}, ''):SetArmyStat('FactionIndex', ${a.faction})`)
    host.eval(`__brains[${a.index}].__faction = ${a.faction}`)
    host.eval(`__econSetArmyName('${a.name}', ${a.index})`)
  }

  // Skirmish default the original Lua sets up: every pair of distinct
  // non-civilian armies starts as enemies (scenarioutilities.lua:495);
  // self-ally comes from the army row itself (Cfile:1017297).
  for (const a of info.armies) {
    for (const b of info.armies) {
      if (a.index < b.index) host.eval(`SetAlliance(${a.index}, ${b.index}, 'Enemy')`)
    }
  }
}
