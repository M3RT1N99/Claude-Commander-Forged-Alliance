import type { LuaHost } from '../lua/host'
import BRAIN_LUA from '../engine-lua/brain.lua?raw'

/**
 * Engine-Ökonomie pro Armee — die Zwei-Ratio-Verteilung aus
 * `func_ArmyProcessEconomy` (@0x771B50, docs/research/economy-binary.md), aber
 * gespeist von ECHTEN Lua-Units statt Hardcode. Im Original ist die Ökonomie
 * ein C++-Subsystem (`CEconomy` im `CArmyImpl`), das die Sim-Lua nur über
 * `CAiBrain`-Methoden sieht; jede Unit klinkt via `SetConsumptionActive`/
 * Produktion einen Request ein (perSecond·0.1). Genau diese Rolle spielt hier
 * die Engine: Units registrieren beim Spawn ihre Blueprint-Ökonomie, der Beat
 * rechnet die Verteilung, `brain:GetEconomyStored(...)` liest das Ergebnis.
 */

const f = Math.fround
const DT = f(0.1) // SecondsPerTick

export interface UnitEcon {
  prodM: number
  prodE: number
  consM: number
  consE: number
  storeM: number
  storeE: number
  /** Fertig gebaut? Baustellen tragen weder Produktion noch Lager bei. */
  complete: boolean
  /** Unit:SetProductionActive — getrennt vom Verbrauch (wie im Original). */
  prodActive: boolean
  /** Unit:SetConsumptionActive */
  consActive: boolean
  /**
   * Economy.NaturalProducer: exempt from the production throttle. Only the
   * ACUs/sACUs and uea0001/uea0003 carry it (verified-facts).
   */
  naturalProducer?: boolean
  /**
   * The consumption request's LimitingRate from the PREVIOUS economy tick —
   * Unit::HandleResourceManagement (Cfile:953936-953944 + 954011-954012)
   * multiplies the unit's production by exactly this rate unless the
   * blueprint is a NaturalProducer (the "mex stall"). Persistent like
   * mConsumptionData in the engine.
   */
  lastRate?: number
  /**
   * `Moho::Entity::Kill` sets `mIsDead` (Cfile:916084), and
   * `Unit::HandleResourceManagement` gates BOTH halves on it: consumption at
   * Cfile:953945 (`!IsDead && mConsumptionIsActive && mConsumptionData`) and
   * production at Cfile:953968 (`!mIsBeingBuilt && !IsDead &&
   * mProductionActive`). Death is not instant — `DeathThread` runs for several
   * beats (unit.lua:1200-1241) — so relying on `remove()` at OnDestroy let a
   * dead mex keep producing and a dead radar keep drawing power the whole time.
   */
  dead?: boolean
}

interface Consumer {
  mass: number
  energy: number
  rate: number
}

/**
 * Zwei-Ratio-Verteilung: r1 drosselt Doppel-Verbraucher (E und M) an der
 * knappsten Ressource, r2 lässt Einzel-Verbraucher der reichlichen Ressource
 * aus dem Rest weiterlaufen. Setzt `consumer.rate` (LimitingRate). Liefert das
 * tatsächlich Gewährte.
 */
export function distribute(
  availMass: number,
  availEnergy: number,
  consumers: Consumer[],
): { spentMass: number; spentEnergy: number } {
  let bothMass = 0
  let bothEnergy = 0
  let singleMass = 0
  let singleEnergy = 0
  for (const c of consumers) {
    if (c.mass > 0 && c.energy > 0) {
      bothMass = f(bothMass + c.mass)
      bothEnergy = f(bothEnergy + c.energy)
    } else {
      singleMass = f(singleMass + c.mass)
      singleEnergy = f(singleEnergy + c.energy)
    }
  }
  const totalMass = f(bothMass + singleMass)
  const totalEnergy = f(bothEnergy + singleEnergy)

  let r1 = 1
  let limitingIsMass = false
  if (totalEnergy > 0 && f(totalEnergy * r1) > availEnergy) r1 = availEnergy / totalEnergy
  if (totalMass > 0 && f(totalMass * r1) > availMass) {
    r1 = availMass / totalMass
    limitingIsMass = true
  }
  r1 = f(Math.max(0, Math.min(1, r1)))

  const leftoverMass = f(Math.max(0, availMass - f(bothMass * r1)))
  const leftoverEnergy = f(Math.max(0, availEnergy - f(bothEnergy * r1)))

  let r2 = 1
  if (limitingIsMass) {
    if (singleEnergy > 0 && f(singleEnergy * r2) > leftoverEnergy) r2 = leftoverEnergy / singleEnergy
  } else {
    if (singleMass > 0 && f(singleMass * r2) > leftoverMass) r2 = leftoverMass / singleMass
  }
  r2 = f(Math.max(0, Math.min(1, r2)))

  let spentMass = 0
  let spentEnergy = 0
  for (const c of consumers) {
    const needsLimiting = limitingIsMass ? c.mass > 0 : c.energy > 0
    c.rate = needsLimiting ? r1 : r2
    spentMass = f(spentMass + f(c.mass * c.rate))
    spentEnergy = f(spentEnergy + f(c.energy * c.rate))
  }
  return { spentMass, spentEnergy }
}

const RES = { ENERGY: 'energy', MASS: 'mass' } as const
type Res = 'ENERGY' | 'MASS'

/** Ressourcen-Zustand einer Armee. */
export class ArmyEconomy {
  // Binär (SSTIArmyVariableData-Ctor @0x6FD390): mStored = 0/0, mMaxStorage =
  // 0/0. Lager entsteht AUSSCHLIESSLICH aus StorageMass/StorageEnergy der
  // Units (die ACU bringt ihr Lager selbst mit), Startvorrat kommt aus dem
  // Lua-Global SetArmyEconomy(army, mass, energy) — nicht aus TS-Konstanten.
  mass = 0
  energy = 0
  maxMass = 0
  maxEnergy = 0
  incomeMass = 0
  incomeEnergy = 0
  expenseMass = 0
  expenseEnergy = 0
  /** Demand before throttling (brain:GetEconomyRequested). */
  requestedMass = 0
  requestedEnergy = 0
  // Reclaim income this beat. The engine writes reclaim to THREE places: storage,
  // the separate mTotals.mReclaimed counter (this pair, Cfile:1016010-1016024),
  // AND mResources — which becomes mIncome (Cfile:848620/848632, 1106784-1106791).
  // So reclaim IS folded into reported income (done in addReclaim, phase 4) and
  // ALSO surfaced as its own breakdown counter here. Kept per second like income.
  reclaimMass = 0
  reclaimEnergy = 0
  // Resources GIVEN this beat (GiveResource / reclaim). The engine adds them to
  // the INCOME accumulator (mResources), NOT to storage (Cfile:735044-735053,
  // 848620-848639), so active demand consumes them first and only the leftover
  // clamps into storage. Folded into `available` in tick(), then reset.
  private pendingMass = 0
  private pendingEnergy = 0

  private readonly units = new Map<number, UnitEcon>()
  /** Transiente Bau-Requests (pro Tick vom Bau-System gesetzt). */
  private readonly buildReqs = new Map<number, Consumer>()

  register(id: number, e: UnitEcon): void {
    this.units.set(id, e)
  }

  /** Ressourcen-Bedarf einer Bau-Aufgabe für diesen Tick anmelden. */
  setBuildRequest(taskId: number, mass: number, energy: number): void {
    this.buildReqs.set(taskId, { mass, energy, rate: 0 })
  }
  clearBuildRequest(taskId: number): void {
    this.buildReqs.delete(taskId)
  }
  /** Gewährte LimitingRate der Bau-Aufgabe (gültig nach tick()). */
  buildRate(taskId: number): number {
    return this.buildReqs.get(taskId)?.rate ?? 0
  }
  setComplete(id: number, complete: boolean): void {
    const u = this.units.get(id)
    if (u) u.complete = complete
  }
  setProductionActive(id: number, active: boolean): void {
    const u = this.units.get(id)
    if (u) u.prodActive = active
  }
  setConsumptionActive(id: number, active: boolean): void {
    const u = this.units.get(id)
    if (u) u.consActive = active
  }
  /**
   * Runtime per-second rate update (Set{Production,Consumption}PerSecond{Mass,
   * Energy}). The engine reads the mutable UnitAttributes each tick
   * (Cfile:976734-976735) and the original Lua drives the whole dynamic economy
   * through these setters: mass-extractor scaling by the MASS marker
   * (defaultunits.lua:785), adjacency modifiers + maintenance (unit.lua:745-759),
   * upgrade throttling (defaultunits.lua:817-841). Only the named field changes;
   * the others keep their spawn-registered value.
   */
  setRate(id: number, field: 'prodM' | 'prodE' | 'consM' | 'consE', value: number): void {
    const u = this.units.get(id)
    if (u) u[field] = value
  }
  /** Entity::Kill -> mIsDead (Cfile:916084). Not the same as removal: the unit
   *  stays registered until OnDestroy, it just stops contributing. */
  setDead(id: number): void {
    const u = this.units.get(id)
    if (u) u.dead = true
  }
  remove(id: number): void {
    this.units.delete(id)
  }

  /**
   * `Unit:GetResourceConsumed()` — the engine's `mResourceConsumed`
   * (pushed at Cfile:976943). `Unit::HandleResourceManagement` resets it to 0
   * every tick (Cfile:953937) and only sets it while the unit is alive AND
   * consumption is active AND it has a request (Cfile:953945-953948):
   *
   *   mResourceConsumed = CEconRequest::LimitingRate(mConsumptionData)
   *
   * `LimitingRate` is 1.0 for a request with nothing requested and otherwise
   * `min(granted / requested)` over the two slots (Cfile:1107891-1107909) —
   * which is exactly the per-consumer `rate` that `tick()` already persists as
   * `lastRate`. So: idle -> 0, full supply -> 1, stall -> the granted share.
   *
   * A unit the economy does not know reports 0, not 1: an unregistered unit is
   * not "fully supplied", it has no request at all.
   */
  resourceConsumed(id: number): number {
    const u = this.units.get(id)
    if (!u || !u.consActive || u.dead) return 0
    if (!(u.consM > 0 || u.consE > 0)) return 1
    return u.lastRate ?? 1
  }

  /** Ein Wirtschafts-Tick (im Sim-Beat vor der Thread-Stage). */
  tick(): void {
    // Reclaim is a per-beat counter (mReclaimed, ctor-init 0, Cfile:1016016):
    // reset it each tick. The reclaim grants run in phase 4 (AFTER this tick()
    // in phase 2, src/lua/engine.ts:106-136); the end-of-beat snapshot sees
    // exactly this beat's reclaim.
    this.reclaimMass = 0
    this.reclaimEnergy = 0
    let prodM = 0
    let prodE = 0
    let maxM = 0
    let maxE = 0
    const consumers: Consumer[] = []
    const unitConsumers: [UnitEcon, Consumer][] = []
    for (const u of this.units.values()) {
      if (!u.complete) continue // Baustellen tragen weder Produktion noch Lager bei
      maxM = f(maxM + u.storeM)
      maxE = f(maxE + u.storeE)
      // UNVERIFIED: in the engine the storage handling (mExtraStorage,
      // Cfile:953970-953977) sits INSIDE the same
      // `!mIsBeingBuilt && !IsDead && mProductionActive` gate as production, so
      // a dying — or merely production-disabled — unit may also stop
      // contributing storage. That branch was not traced far enough to say what
      // it writes, so storage is left ungated here rather than changed on a
      // guess. Only the two halves the audit actually established are gated:
      // production (Cfile:953968) and consumption (Cfile:953945).
      if (u.prodActive && !u.dead) {
        // The mex stall (Unit::HandleResourceManagement,
        // Cfile:953936-953944 + 954011-954012): non-NaturalProducers scale
        // their production by the LimitingRate of their OWN consumption
        // request from the previous economy tick. A mass extractor whose
        // energy upkeep is only partially granted produces proportionally
        // less mass; the ACU (NaturalProducer) never throttles.
        let factor = 1
        if (!u.naturalProducer && u.consActive && (u.consM > 0 || u.consE > 0)) {
          factor = u.lastRate ?? 1
        }
        prodM = f(prodM + f(u.prodM * factor))
        prodE = f(prodE + f(u.prodE * factor))
      }
      // Consumption is gated on IsDead exactly like production (Cfile:953945).
      if (u.consActive && !u.dead) {
        const cm = f(u.consM * DT)
        const ce = f(u.consE * DT)
        if (cm > 0 || ce > 0) {
          const c: Consumer = { mass: cm, energy: ce, rate: 1 }
          consumers.push(c)
          unitConsumers.push([u, c])
        }
      }
    }
    // Bau-Aufgaben sind ebenfalls Verbraucher (CEconRequest); ihre gewährte
    // LimitingRate skaliert den Baufortschritt.
    for (const r of this.buildReqs.values()) consumers.push(r)
    this.maxMass = maxM
    this.maxEnergy = maxE

    let reqM = 0
    let reqE = 0
    for (const c of consumers) {
      reqM = f(reqM + c.mass)
      reqE = f(reqE + c.energy)
    }
    this.requestedMass = f(reqM / DT)
    this.requestedEnergy = f(reqE / DT)

    // Given/reclaimed resources are income this beat (Cfile:1106670-1106674):
    // fold them into `available` so demand can consume them, then reset.
    const givenMass = this.pendingMass
    const givenEnergy = this.pendingEnergy
    const availMass = f(this.mass + f(prodM * DT) + givenMass)
    const availEnergy = f(this.energy + f(prodE * DT) + givenEnergy)
    this.pendingMass = 0
    this.pendingEnergy = 0
    const { spentMass, spentEnergy } = distribute(availMass, availEnergy, consumers)
    // Persist each unit's granted rate for next tick's production factor.
    for (const [u, c] of unitConsumers) u.lastRate = c.rate

    this.mass = f(Math.min(Math.max(availMass - spentMass, 0), maxM))
    this.energy = f(Math.min(Math.max(availEnergy - spentEnergy, 0), maxE))
    // Reported income = production + given (+ reclaim, added in addReclaim during
    // phase 4). The engine's mIncome is mResources = production + given + reclaim
    // (Cfile:954020/735044/848620 -> 1106784-1106791). given is absolute per tick,
    // so /DT to the per-second convention the getters use.
    this.incomeMass = f(prodM + givenMass / DT)
    this.incomeEnergy = f(prodE + givenEnergy / DT)
    this.expenseMass = f(spentMass / DT)
    this.expenseEnergy = f(spentEnergy / DT)
    // Documented reductions (no impact at the 1-army default, deferred):
    //  * Reported usage is the true per-consumer spend; the engine reports the
    //    aggregate both.X*r1 + single.X*r2 (Cfile:1106779-1106788), which differs
    //    only during a stall with single-resource-only consumers.
    //  * Per-army handicap multiplies income by (1+handicap) before the ratios
    //    (Cfile:1106655-1106664) — gated on handicap != 0, unused at default.
    //  * mResourceSharing water-fills overflow to allies before the storage clamp
    //    (Cfile:1106826-1106960); a lone army drops its overflow either way.
  }

  /**
   * brain:GiveResource(res, amount) — schenkt der Armee Ressourcen (auf das
   * Lager gedeckelt). Wird u. a. von GiveInitialResources jeder ACU gerufen.
   * Der Deckel greift erst, wenn das Lager der Unit registriert ist; darum
   * läuft GiveInitialResources im Original erst nach WaitTicks(5).
   */
  give(res: Res, amount: number): void {
    // Add to this beat's income (unclamped), NOT straight to storage: the
    // engine lets given/reclaimed resources feed current demand and only clamps
    // the leftover into storage (Cfile:735044-735053), so a full store no
    // longer silently drops a reclaim.
    if (res === 'MASS') this.pendingMass += amount
    else this.pendingEnergy += amount
  }

  /**
   * `taken = brain:TakeResource(type, amount)` — cfunc_CAiBrainTakeResourceL
   * (Cfile:735173-735270). A DIFFERENT function from GiveResource, not its
   * mirror image:
   *  - it works on `mTotals.mStored` (Cfile:735238-735252), NOT on `mResources`,
   *    which is the per-beat income accumulator `give()` feeds (Cfile:735044-735053);
   *  - it takes `min(requested, stored)` — the `isUnder` select at
   *    Cfile:735239/735247 picks the stored value when the request exceeds it;
   *  - it writes back `max(0, stored - taken)` (Cfile:735253-735263), so storage
   *    never goes negative;
   *  - it RETURNS the amount actually taken (Cfile:735264-735269; the binding's
   *    own help string is "taken = TakeResource(type,amount)", Cfile:735162).
   * The effect is immediate, not deferred to the next beat.
   *
   * simutils.lua:152-155 feeds this return straight into GiveResource, so the
   * return value is load-bearing, not decoration.
   *
   * No max-storage clamp and no `amount >= 0` guard: the engine has neither,
   * and inventing one would be a second divergence.
   */
  take(res: Res, amount: number): number {
    const stored = res === 'MASS' ? this.mass : this.energy
    const taken = amount <= stored ? amount : stored
    const left = stored - taken > 0 ? f(stored - taken) : 0
    if (res === 'MASS') this.mass = left
    else this.energy = left
    return taken
  }

  /**
   * This tick's reclaim grant (mass/energy per tick) — accumulated separately
   * from income as a per-second rate (like income/expense, /DT). Storage is
   * still filled by `give()`/GiveResource; this is ONLY the reclaimed display
   * counter (the engine writes to both places, Cfile:848614-848639). Reset in tick().
   */
  addReclaim(massPerTick: number, energyPerTick: number): void {
    // ONLY the separate mReclaimed display counter. Reclaim's income contribution
    // already flows through __reclaimTick's GiveResource -> pendingMass ->
    // incomeMass (the engine writes reclaim to mResources->mIncome exactly ONCE,
    // Cfile:848620); adding it here too double-counted it in GetEconomyIncome/Trend.
    this.reclaimMass = f(this.reclaimMass + massPerTick / DT)
    this.reclaimEnergy = f(this.reclaimEnergy + energyPerTick / DT)
  }

  /** brain:GetEconomyUsage(res) — actual spend per second (after throttling). */
  usage(res: Res): number {
    return res === 'MASS' ? this.expenseMass : this.expenseEnergy
  }
  /** brain:GetEconomyRequested(res) — demand per second (before throttling). */
  requested(res: Res): number {
    return res === 'MASS' ? this.requestedMass : this.requestedEnergy
  }
  /** brain:GetEconomyTrend(res) — net change per tick (income minus spend). */
  trend(res: Res): number {
    return f((this.income(res) - this.usage(res)) * DT)
  }

  stored(res: Res): number {
    return res === 'MASS' ? this.mass : this.energy
  }
  storedRatio(res: Res): number {
    const max = res === 'MASS' ? this.maxMass : this.maxEnergy
    return max > 0 ? this.stored(res) / max : 0
  }
  income(res: Res): number {
    return res === 'MASS' ? this.incomeMass : this.incomeEnergy
  }
}

/** Verwaltet die Ökonomie aller Armeen. */
export class EconomyManager {
  private readonly armies = new Map<number, ArmyEconomy>()

  army(n: number): ArmyEconomy {
    let a = this.armies.get(n)
    if (!a) {
      a = new ArmyEconomy()
      this.armies.set(n, a)
    }
    return a
  }

  tick(): void {
    for (const a of this.armies.values()) a.tick()
  }
}

/**
 * Verdrahtet die Ökonomie mit dem Lua-Host: die Bridge-Globals, die
 * `__spawnUnit` (Registrierung) und die moho-Methoden (SetProductionActive,
 * brain:GetEconomyStored) aufrufen.
 */
export function installEconomy(host: LuaHost, mgr: EconomyManager): void {
  const armyIndex = new Map<string, number>()
  host.setGlobal('__econRegister', (army: number, id: number, pm: number, pe: number, cm: number, ce: number, sm: number, se: number, naturalProducer?: boolean) => {
    mgr.army(army).register(id, {
      prodM: pm, prodE: pe, consM: cm, consE: ce, storeM: sm, storeE: se,
      complete: true, prodActive: true, consActive: true,
      naturalProducer: naturalProducer === true, lastRate: 1,
    })
  })
  // Getrennte Toggles wie im Original (Produktion ≠ Verbrauch), plus der
  // Fertig-Zustand (Baustellen tragen nichts bei).
  host.setGlobal('__econSetComplete', (army: number, id: number, v: boolean) => {
    mgr.army(army).setComplete(id, v !== false)
  })
  host.setGlobal('__econSetProductionActive', (army: number, id: number, v: boolean) => {
    mgr.army(army).setProductionActive(id, v !== false)
  })
  host.setGlobal('__econSetConsumptionActive', (army: number, id: number, v: boolean) => {
    mgr.army(army).setConsumptionActive(id, v !== false)
  })
  // Runtime rate change from Set*PerSecond* (moho.lua) — the dynamic economy.
  host.setGlobal(
    '__econUpdateRate',
    (army: number, id: number, field: 'prodM' | 'prodE' | 'consM' | 'consE', value: number) => {
      mgr.army(army).setRate(id, field, value)
    },
  )
  // Bau-Requests: das Bau-System meldet vor dem Tick den Bedarf an und liest
  // danach die gewährte LimitingRate zurück (CEconRequest::LimitingRate).
  host.setGlobal('__econSetBuildRequest', (army: number, taskId: number, mass: number, energy: number) => {
    mgr.army(army).setBuildRequest(taskId, mass, energy)
  })
  host.setGlobal('__econClearBuildRequest', (army: number, taskId: number) => {
    mgr.army(army).clearBuildRequest(taskId)
  })
  host.setGlobal('__econBuildRate', (army: number, taskId: number) => mgr.army(army).buildRate(taskId))
  // Unit:GetResourceConsumed — the per-unit granted rate (mResourceConsumed,
  // Cfile:953937/953945-953948). The value already exists as the consumer's
  // `rate`; it was simply never bridged into Lua.
  host.setGlobal('__econResourceConsumed', (army: number, id: number) =>
    mgr.army(army).resourceConsumed(id),
  )
  host.setGlobal('__econUnregister', (army: number, id: number) => {
    mgr.army(army).remove(id)
  })
  // Entity::Kill -> mIsDead (Cfile:916084). The unit stays registered until
  // OnDestroy; it simply stops producing and consuming from this beat on
  // (Cfile:953945 / 953968).
  host.setGlobal('__econSetDead', (army: number, id: number) => {
    mgr.army(army).setDead(id)
  })

  // Echtes Engine-Global: SetArmyEconomy(army, mass, energy) setzt den
  // Startvorrat der Armee (Original: aus dem Szenario/SetupSession heraus
  // gerufen). Vorher standen 150/400 als TS-Konstante im Code — erfunden.
  host.setGlobal('SetArmyEconomy', (army: number | string, mass: number, energy: number) => {
    const a = mgr.army(typeof army === 'number' ? army : (armyIndex.get(army) ?? 1))
    a.mass = mass
    a.energy = energy
  })
  // Armee-Namen → Index (SetArmyEconomy akzeptiert im Original beides).
  host.setGlobal('__econSetArmyName', (name: string, index: number) => {
    armyIndex.set(name, index)
  })

  // GiveResource: die echte Quelle der Startressourcen. Jede ACU forkt in
  // OnStopBeingBuilt `GiveInitialResources` (uel0001_script.lua:159-163):
  // nach WaitTicks(5) schenkt sie der Armee ihr eigenes Lager
  // (Economy.StorageEnergy = 4000, StorageMass = 650). Genau daher kommen die
  // Startwerte — nicht aus einer TS-Konstante.
  host.setGlobal('__econGive', (army: number, res: string, amount: number) => {
    mgr.army(army).give(res.toUpperCase() === 'MASS' ? 'MASS' : 'ENERGY', amount)
  })
  // TakeResource is NOT a negative GiveResource — it drains storage, clamps to
  // what is there and returns the amount taken (Cfile:735173-735270).
  host.setGlobal('__econTake', (army: number, res: string, amount: number) =>
    mgr.army(army).take(res.toUpperCase() === 'MASS' ? 'MASS' : 'ENERGY', amount),
  )
  // This tick's reclaim grant into the separate reclaimed counter (on top of
  // the storage credit via __econGive) — the engine writes to both places
  // (Cfile:848614-848639). Mass/energy per tick; addReclaim converts to the
  // per-second rate.
  host.setGlobal('__econReclaim', (army: number, mass: number, energy: number) => {
    mgr.army(army).addReclaim(mass, energy)
  })
  host.setGlobal('__econStored', (army: number, res: string) => mgr.army(army).stored((res === 'MASS' ? 'MASS' : 'ENERGY')))
  host.setGlobal('__econStoredRatio', (army: number, res: string) => mgr.army(army).storedRatio(res === 'MASS' ? 'MASS' : 'ENERGY'))
  // Die Brain-Getter liefern PER-TICK-Werte — rohe Feld-Reads aus
  // CEconomy.mTotals ohne Skalierung (GetEconomyIncome Cfile:739923, Usage =
  // mLastUseActual Cfile:739997, Requested = mLastUseRequested Cfile:740071;
  // Befüllung pro Tick: HandleResourceManagement ×0.1 Cfile:954011-954028,
  // Übernahme func_ArmyProcessEconomy Cfile:1106790). Die Original-Lua rechnet
  // SELBST hoch: defaultweapons.lua:970 `GetEconomyIncome('ENERGY') * 10
  // # per tick to per seconds`, xab1401 (Paragon) ebenso. Unsere internen
  // Felder bleiben pro Sekunde (HUD/Worker) — nur die Bridge skaliert.
  host.setGlobal('__econIncome', (army: number, res: string) => mgr.army(army).income(res === 'MASS' ? 'MASS' : 'ENERGY') * DT)

  host.setGlobal('__econUsage', (army: number, res: string) => mgr.army(army).usage(res === 'MASS' ? 'MASS' : 'ENERGY') * DT)
  host.setGlobal('__econRequested', (army: number, res: string) => mgr.army(army).requested(res === 'MASS' ? 'MASS' : 'ENERGY') * DT)
  host.setGlobal('__econTrend', (army: number, res: string) => mgr.army(army).trend(res === 'MASS' ? 'MASS' : 'ENERGY'))

  // Das Brain ist KEIN Engine-Objekt mit angeflanschten Feldern, sondern die
  // Original-Klasse `AIBrain` aus /lua/aibrain.lua:342 — sie leitet von
  // moho.aibrain_methods ab (die C++-Basis, die wir liefern) und bringt ihre
  // eigene Logik mit (z. B. ESRegisterUnitMassStorage, aibrain.lua:500).
  // Vorher stand hier ein handgebautes TS-Table: genau der Nachbau, den es
  // nicht geben darf. Die Engine erzeugt das Brain und ruft OnCreateHuman —
  // wie im Original beim Aufbau der Armeen.
  host.eval(BRAIN_LUA)
  void RES
}
