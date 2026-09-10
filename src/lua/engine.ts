import type { LuaHost } from './host'
import { installMoho } from './moho'
import { installEngineGlobals, setTerrainSource, type TerrainSize } from './engineGlobals'
import { installBlueprintPipeline, installUnitFactory } from './unitFactory'
import { installSimThreads } from './simThreads'
import { EconomyManager, installEconomy } from '../sim/economy'
import { installMotion, motionTick } from '../sim/motion'
import { installBuild, buildCollect, buildApply, factoryTick } from '../sim/build'
import { installTransport } from '../sim/transport'
import { installCapture } from '../sim/capture'
import { installOvercharge } from '../sim/overcharge'
import { installDive } from '../sim/dive'
import { setupSession, SANDBOX_SESSION, type SessionInfo } from '../sim/session'
import { installCombat, weaponTick, projectileTick, flushDeletions } from './combat'
import { installSession } from './session'
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
  /**
   * Das Gelaende der Karte, GLEICH nach den Engine-Primitiven gesetzt.
   *
   * Die Engine laedt die Karte, bevor sie die Armeen erzeugt: `CInfluenceMap`
   * entsteht IN der Armee-Erzeugung und liest dabei das Heightfield
   * (Cfile:1017315-1017333). Wer die Sitzung mit einer KI-Armee faehrt, muss
   * das Gelaende deshalb hier uebergeben — sonst laeuft
   * `AIBrain:AddInitialEnemyThreat` (aibrain.lua:398, im `OnCreateAI` waehrend
   * `OnCreateArmyBrain`) gegen ein `GetMapSize()`, das noch nichts weiss, und
   * die Bedrohungskarte scheitert laut.
   *
   * Ohne KI-Armee bleibt der bisherige Weg gueltig: `setTerrainSource` nach
   * `installEngine` und vor `beginSession`.
   */
  terrain?: { heightAt: (x: number, z: number) => number; size?: TerrainSize },
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
  if (terrain) setTerrainSource(host, terrain.heightAt, terrain.size)
  installEconomy(host, economy)
  installMotion(host)
  installBuild(host)
  // The transport component and its tasks (CAiTransportImpl, CUnitLoadUnits,
  // CUnitCallTransport, CUnitUnloadUnits) -- primitives like the motion.
  installTransport(host)
  // The capture task (CUnitCaptureTask) and IssueCapture.
  installCapture(host)
  // The overcharge (the attack task pinned to the OverChargeWeapon) and
  // IssueOverCharge.
  installOvercharge(host)
  // The dive of a surfacing submarine and IssueDive.
  installDive(host)
  // moho: die C-Form, wie die Engine sie uebergibt — Methodenlisten und
  // Basisklassen, KEINE fertigen Klassen (globalInit.lua:27-29). Braucht
  // deshalb kein `Class` und steht vor der Boot-Kette.
  installMoho(host)
  // Die Blueprint-Pipeline ebenfalls davor: `__blueprints` ist in der Engine
  // gefuellt, BEVOR simInit.lua ueberhaupt laeuft (siminit.lua:8).
  installBlueprintPipeline(host)

  // ── Und hier faehrt die echte Boot-Kette ────────────────────────────────
  //
  // `Moho::Sim::Create` macht genau das: `SCR_LuaDoScript(mLuaState,
  // "/lua/simInit.lua", 0)` (Cfile:1071613). `simInit.lua` zieht
  // `globalInit.lua` nach, und das laedt config.lua (striktes `_G`),
  // import.lua, utils.lua, repr.lua, class.lua, trashbag.lua, Localization.lua,
  // MultiEvent.lua, collapse.lua — und wandelt danach `moho` um
  // (globalInit.lua:31-34).
  //
  // Vorher stand hier eine Handkette: class.lua neu laden, utils.lua,
  // repr.lua, buffblueprints.lua, spaeter `doscript('/lua/SimSync.lua')` und
  // `ResetSyncTable()`. Alles davon ist in globalInit.lua:16-24 bzw.
  // siminit.lua:45/100 enthalten — nachgebaut, wo es auszufuehren gereicht
  // haette.
  host.eval(`doscript('/lua/simInit.lua')`)

  // Ab hier gibt es `Class`, und `moho` ist umgewandelt.
  installUnitFactory(host)
  // Kampf: Schaden, Projektile, Props, Waffen-Tasks. Nach der UnitFactory, weil
  // die Löschwarteschlange und die Projektile auf __units/__nextUnitId aufsetzen.
  installCombat(host)
  // `/lua/SimSync.lua` und `ResetSyncTable()` stehen nicht mehr hier:
  // `simInit.lua:45` bzw. `:100` fahren sie selbst, samt schook-Hooks.
  // Original Lua: the global TerrainTypes list that GetTerrainType() serves
  // (terraintypes.lua:126; unit.lua:2420 indexes the result unchecked).
  host.loadGlobal('/lua/terrainTypes.lua')
  // The session-start steps as original Lua (src/engine-lua/session.lua).
  installSession(host)
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
  // Phase 0 — Fabriken mit Warteschlange setzen die nächste Einheit auf. Das
  // muss VOR dem Bedarf laufen, sonst hängt der frische Auftrag einen Beat lang
  // in der Luft.
  factoryTick(h)
  // Phase 1 — everyone who wants resources this tick registers demand.
  buildCollect(h)
  h.eval('__econEventsCollect()')
  // Phase 2 — the army economy distributes (two ratios).
  engine.economy.tick()
  // Phase 3 — consumers read back their granted LimitingRate and advance.
  buildApply(h)
  h.eval('__econEventsApply()')
  // Phase 4 — die Waffen-Tasks der Engine (CArmyImpl::OnTick, Cfile:1018024):
  // Zielsuche (alle TargetCheckInterval·10 Ticks) und Feuertakt (jeden Tick).
  // Sie laufen VOR der Thread-Stage: `OnFire` wechselt nur den Zustand der
  // Salven-FSM — geschossen wird im Coroutinen-Slice desselben Beats.
  weaponTick(h)
  // Phase 4b — der Zerfall der Bedrohungskarte. Die Engine faehrt ihn aus
  // `CArmyImpl::OnTick`, gestaffelt: jede Armee ist dran, wenn
  // `mSim->mCurTick % 30 == mConstDat.mIndex` (Cfile:1018010-1018011). Er
  // gehoert in denselben Abschnitt wie die uebrigen OnTick-Arbeiten der Armee.
  h.eval('__influenceTick(__gameTick or 0)')
  // Phase 5 — Lua coroutines (CTaskStage::DoFrame), then movement.
  simTick(h)
  motionTick(h)
  // Site decay is part of Unit::OnTick (same engine phase as motion,
  // Cfile:952824-952840): unfinished units lose build fraction every tick.
  // Beide Zweige von `Unit::OnTick` (Cfile:952810-952840): wer NICHT im Bau
  // ist, regeneriert; wer im Bau ist und nicht bedient wird, zerfaellt.
  h.eval('__regenTick()')
  h.eval('__decayTick()')
  // Phase 6 — Projektile fliegen (Projectile::MotionTick) und schlagen ein.
  projectileTick(h)
  // Phase 7 — die Löschwarteschlange (Sim::AdvanceBeat, Cfile:1076638): erst
  // hier laufen die OnDestroy-Callbacks. Entity:Destroy() löscht NICHT sofort.
  flushDeletions(h)
  // Phase 8 — close the beat like Sim::Sync does (Cfile:1074261, driven from
  // CSimDriver::Sync): serialise the Sync table to the user layer and then run
  // `ResetSyncTable()` (Cfile:1074772-1074773). Without the reset the table
  // grows for the whole session and every consumer sees stale entries from
  // earlier beats as if they had just happened — SimSync.lua's own header says
  // the table is per-beat.
  h.eval('ResetSyncTable()')
}
