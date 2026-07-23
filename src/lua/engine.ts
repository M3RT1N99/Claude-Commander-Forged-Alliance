import type { LuaHost } from './host'
import { installMoho } from './moho'
import { installEngineGlobals } from './engineGlobals'
import { installBlueprintPipeline, installUnitFactory } from './unitFactory'
import { installSimThreads } from './simThreads'
import { EconomyManager, installEconomy } from '../sim/economy'
import { installMotion, motionTick } from '../sim/motion'
import { installBuild, buildCollect, buildApply, factoryTick } from '../sim/build'
import { setupSession, SANDBOX_SESSION, type SessionInfo } from '../sim/session'
import { installCombat, weaponTick, projectileTick, flushDeletions } from './combat'
import { simTick } from './simThreads'

/**
 * DIE Engine — ein einziger Boot-Pfad.
 *
 * Vorher setzte jeder Aufrufer (Worker, jede Testsuite) die Engine aus
 * Einzelteilen selbst zusammen und ließ dabei Teile weg; der Stub-Trap
 * verdeckte die Lücken, sodass die Original-Lua auf einer halben Engine lief
 * und die Tests trotzdem grün waren. Genau diese Möglichkeit gibt es nicht
 * mehr: wer die Engine will, bekommt sie ganz.
 *
 * Reihenfolge (die im Code unten — dieser Kommentar hat sie schon einmal
 * falsch behauptet, und genau so einen Kommentar liest jemand, bevor er
 * umsortiert):
 *
 *   1. Engine-Primitive, wie die C++-Engine ihre luadef_*-Bindungen registriert,
 *      BEVOR die erste Zeile Original-Lua läuft:
 *        SimThreads → Globals → Economy → Motion → Build
 *   2. class.lua NEU laden. Der LuaHost-Bootstrap hat es schon geladen — da war
 *      ForkThread aber noch nil, und class.lua:78 macht
 *      `local ForkThread = ForkThread` (Upvalue-Snapshot). Ohne diesen zweiten
 *      Load stirbt class.lua:377 bei jedem State-Wechsel.
 *      globals.lua enthält bewusst kein einziges Class( — nur deshalb darf es
 *      vor dem Reload laufen. moho/units brauchen Class und stehen danach.
 *   3. Alles, was Class braucht oder Original-Lua ist:
 *        moho → utils.lua → Blueprints → UnitFactory → SimSync → terrainTypes
 *   4. Session (SimInit-Schritte 3a/5a): ScenarioInfo + Brains.
 */
export interface Engine {
  host: LuaHost
  economy: EconomyManager
}

export function installEngine(
  host: LuaHost,
  economy = new EconomyManager(),
  session: SessionInfo = SANDBOX_SESSION,
): Engine {
  // Engine primitives (the C functions) go in FIRST, before a single line of
  // original Lua runs — same as the real engine, which registers every
  // luadef_* binding into the Lua state and only then lets globalInit.lua load
  // class.lua. This is not cosmetic: class.lua:78 does
  // `local ForkThread = ForkThread`, snapshotting the global as an upvalue. If
  // the scheduler does not exist yet, that upvalue stays nil forever and
  // class.lua:377 (start the state's Main thread) dies on every state change.
  installSimThreads(host)
  installEngineGlobals(host)
  installEconomy(host, economy)
  installMotion(host)
  installBuild(host)
  // Reload the class system now that the engine globals exist (the LuaHost
  // bootstrap loaded it earlier, when ForkThread was still nil).
  host.loadGlobal('/lua/system/class.lua')

  // From here on original Lua runs and may capture engine globals.
  installMoho(host)
  host.loadGlobal('/lua/system/utils.lua')
  // globalInit.lua:19 lädt repr.lua direkt nach utils — simcallbacks.lua:18
  // calls `repr(name)` in the error path, unit.lua uses it in debug branches.
  // The UI VM had it (uiEngine.ts), the Sim VM didn't: found it when the
  // SimCallback dispatcher died instead of "No callback named..." to `repr == nil`.
  host.loadGlobal('/lua/system/repr.lua')
  installBlueprintPipeline(host)
  installUnitFactory(host)
  // Combat: Damage, Projectiles, Props, Weapon Tasks. After the UnitFactory because
  // set the delete queue and projectiles to __units/__nextUnitId.
  installCombat(host)
  // Original Lua, not recreated: SimInit.lua:45 runs `doscript
  // '/lua/SimSync.lua'`. She creates the Sim→UI bridge (Sync, UnitData) —
  // without it, Unit:OnPreCreate fails at SyncMeta (unit.lua:23-40 writes
  // in UnitData). This is the first building block of the real boot chain.
  //
  // And via `doscript`, not via loadGlobal: only doscript drives it
  // HOOKS with (boot.lua, `hook = {'/schook'}` from bin/SupComDataPath.lua).
  // `schook/lua/simsync.lua:61` defines `RemoveAllUnitEnhancements` — and
  // That's exactly what unit.lua:1287 calls when EVERY unit dies (OnDestroy). Without that
  // Hook dies the death path, and no wreck remains.
  host.eval(`doscript('/lua/SimSync.lua')`)
  host.eval('ResetSyncTable()')
  // Original Lua: the global TerrainTypes list that GetTerrainType() serves
  // (terraintypes.lua:126; unit.lua:2420 indexes the result unchecked).
  host.loadGlobal('/lua/terrainTypes.lua')
  // Step 3a/5a of the SimInit.lua boot: publish ScenarioInfo, create the brains.
  setupSession(host, session)
  return { host, economy }
}

/**
 * Ein Sim-Beat (10 Hz) in der Reihenfolge aus `Sim::AdvanceBeat` (@:1076363):
 * Ressourcen der Armee rechnen → Aufgaben (Lua-Coroutinen) → Bewegung.
 *
 * Der Bau ist ein Ökonomie-Verbraucher (CEconRequest): erst Bedarf anmelden,
 * dann verteilt die Ökonomie, dann wird die gewährte LimitingRate auf den
 * Baufortschritt angewandt (CBuildTaskHelper::UpdateWorkProgress @0x5f5f2c).
 */
export function beat(engine: Engine): void {
  const h = engine.host
  // Phase 0 — Queued Factories deploy the next unit. The
  // must run BEFORE the demand, otherwise the fresh order will hang for a beat
  // in the air.
  factoryTick(h)
  // Phase 1 — everyone who wants resources this tick registers demand.
  buildCollect(h)
  h.eval('__econEventsCollect()')
  // Phase 2 — the army economy distributes (two ratios).
  engine.economy.tick()
  // Phase 3 — consumers read back their granted LimitingRate and advance.
  buildApply(h)
  h.eval('__econEventsApply()')
  // Phase 4 — the engine's weapon tasks (CArmyImpl::OnTick, Cfile:1018024):
  // Target search (every TargetCheckInterval·10 ticks) and firing cycle (every tick).
  // They run BEFORE the thread stage: `OnFire` only changes the state of the
  // Salvo FSM — shooting takes place in the coroutine slice of the same beat.
  weaponTick(h)
  // Phase 5 — Lua coroutines (CTaskStage::DoFrame), then movement.
  simTick(h)
  motionTick(h)
  // Site decay is part of Unit::OnTick (same engine phase as motion,
  // Cfile:952824-952840): unfinished units lose build fraction every tick.
  h.eval('__decayTick()')
  // Phase 6 — Projectiles fly (Projectile::MotionTick) and impact.
  projectileTick(h)
  // Phase 7 — the delete queue (Sim::AdvanceBeat, Cfile:1076638): first
  // This is where the OnDestroy callbacks run. Entity:Destroy() does NOT delete immediately.
  flushDeletions(h)
}
