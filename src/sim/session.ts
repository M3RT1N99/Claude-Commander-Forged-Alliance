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
  /** Player name from the lobby. Reaches `LocGlobals.PlayerName` only. */
  nickname?: string
  /** 1-based command-source indices allowed to issue orders for this army. */
  authorizedCommandSources?: number[]
  /** Start resources are NOT set here — the ACU grants them via GiveInitialResources. */
  start?: { x: number; z: number }
}

export interface SessionInfo {
  type: 'skirmish' | 'campaign'
  map?: string
  /**
   * Path to the map's `_scenario.lua`, e.g. `/maps/SCMP_009/SCMP_009_scenario.lua`.
   *
   * Set it and the session takes the REAL path: the original `SetupSession`
   * steps load the map's `_save.lua` and `_script.lua` into the Sim, the start
   * markers become army start positions, and the map script's `OnPopulate`
   * puts the ACUs on them. Leave it unset and the session stays a harness
   * (see the comment at the end of `setupSession`).
   */
  scenarioFile?: string
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

  // Options: the game's own default set, not an empty table. Without it
  // `Options.PrebuiltUnits` (scenarioutilities.lua:340) and
  // `Options.CivilianAlliance` (:440) are simply nil and the original Lua
  // silently takes the other branch. Values and their citations live in
  // `__defaultScenarioOptions()` (src/engine-lua/session.lua).
  host.eval(`
    ScenarioInfo = {
      type = '${info.type}',
      map = '${info.map ?? ''}',
      Options = __defaultScenarioOptions(),
      ArmySetup = {
${armySetup}
      },
    }
  `)
  for (const [k, v] of Object.entries(info.options ?? {})) {
    host.eval(`ScenarioInfo.Options[${JSON.stringify(k)}] = ${JSON.stringify(v)}`)
  }

  // ── THE REAL PATH — steps 4a and 5a, run by the original Lua ────────────
  //
  // Step 6a (`BeginSession` -> `OnPopulate` -> the ACUs) is deliberately NOT
  // here. It needs the unit blueprints, and the engine has those long before:
  // `__blueprints` is filled in before SimInit.lua runs at all
  // (siminit.lua:8). The caller loads them and then calls `beginSession()`,
  // exactly as `Sim::CreateArmies` (Cfile:1072015) and `Sim::BeginSession`
  // (Cfile:1072090) are two separate engine steps.
  if (info.scenarioFile) {
    host.eval(`__mergeScenarioFile(${JSON.stringify(info.scenarioFile)})`)
    // Step 4a: the engine calls SetupSession() once ScenarioInfo is set and
    // BEFORE any army exists (Cfile:1071898/1071906, siminit.lua:49-53). It
    // loads `/lua/dataInit.lua`, the map's `_save.lua` and `_script.lua` into
    // `ScenarioInfo.Env`, copies `Scenario` up to a global and resets the sync
    // table — and the schook hook puts `TriggerManager` in front of it
    // (schook/lua/simInit.lua:10-14).
    host.eval('SetupSession()')
  }

  // Step 5a: `Sim::CreateArmies` creates one brain per army and reports each
  // one to the Lua as `OnCreateArmyBrain(index, brain, name, nickname)`
  // (Cfile:1072015, siminit.lua:113-126). The schook hook runs
  // `InitializeStartLocation` + `SetPlans` first (schook/lua/simInit.lua:45-51)
  // — the start marker has to be in place before `OnPopulate`, because
  // `CreateInitialArmyUnit` reads the start position instead of being handed
  // one (Cfile:1025236-1025270).
  for (const a of info.armies) {
    host.eval(`__createBrain(${a.index}, ''):SetArmyStat('FactionIndex', ${a.faction})`)
    host.eval(`__brains[${a.index}].__faction = ${a.faction}`)
    host.eval(`__econSetArmyName('${a.name}', ${a.index})`)
    if (!info.scenarioFile) continue
    // The nickname is the player's lobby name; the engine takes it from the
    // launch info it also builds ArmySetup from. Without a lobby the army name
    // is what we have — it reaches exactly one place, `LocGlobals.PlayerName`
    // (siminit.lua:139-142), which expands `{g PlayerName}` in loc strings.
    const nickname = a.nickname ?? a.name
    host.eval(`OnCreateArmyBrain(${a.index}, __brains[${a.index}], '${a.name}', ${JSON.stringify(nickname)})`)
  }

  if (info.scenarioFile) return

  // NO SCENARIO — and then this is a harness, not a game.
  //
  // The original Lua still reaches for the map: MassCollectionUnit.OnCreate
  // calls ScenarioUtils.GetMarkers() (defaultunits.lua:776) to see whether the
  // extractor stands on a mass point. Without `Scenario` that is `pairs(nil)`.
  // `__harnessScenario()` puts an empty one there — see its comment for why
  // that is not the same thing as the global it replaced.
  host.eval('__harnessScenario()')
  //
  // Without a map there is no map script, so nothing runs `InitializeArmies()`
  // and nobody sets an alliance. The sandbox and most suites live here. This
  // loop is therefore SCAFFOLDING that stands in for the map script; it is not
  // engine behaviour, and it is deliberately not a translation of
  // scenarioutilities.lua:488-500 — that translation used to sit here and
  // dropped both civilian branches (:491-493, :497-498) while claiming the
  // line number of the original.
  //
  // With a real scenario the branch above runs and the original sets the
  // alliances itself. Then this code is not reached.
  for (const a of info.armies) {
    for (const b of info.armies) {
      if (a.index < b.index) host.eval(`SetAlliance(${a.index}, ${b.index}, 'Enemy')`)
    }
  }
}

/**
 * Step 6a — `BeginSession()` (Cfile:1072090/1072097, siminit.lua:145-146).
 *
 * Separate from `setupSession` on purpose: this is where the map script's
 * `OnPopulate` runs and puts the initial units on the map, so every unit
 * blueprint it may name has to be registered first. The engine has them
 * preloaded (siminit.lua:8); we load them between the two calls.
 *
 * Does nothing without a scenario — there is no map script to run.
 */
export function beginSession(host: LuaHost, info: SessionInfo): void {
  if (!info.scenarioFile) return
  // The schook hook runs `CreateProps()` + `CreateResources()` before the base
  // BeginSession (schook/lua/simInit.lua:17-18) — the map's props and deposits
  // belong to the world and must stand before `OnPopulate`, because a unit that
  // lands on a mass point asks for them. Which function `OnPopulate` actually
  // is was decided by `doscript(ScenarioInfo.script, ...)` in SetupSession; for
  // SCMP_009 it is `ScenarioUtils.InitializeArmies()`
  // (SCMP_009_script.lua:3-5), for another map something else — which is why
  // nothing here may be wired to a name.
  host.eval('BeginSession()')
}
