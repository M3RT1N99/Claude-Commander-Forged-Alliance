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
  /** Ready built? Construction sites contribute neither production nor storage. */
  complete: boolean
  /** Unit:SetProductionActive — separate from consumption (as in the original). */
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

/** Resource status of an army. */
export class ArmyEconomy {
  // Binär (SSTIArmyVariableData-Ctor @0x6FD390): mStored = 0/0, mMaxStorage =
  // 0/0. Storage is created EXCLUSIVELY from StorageMass/StorageEnergy
  // Units (the ACU brings its own storage), starting supplies come from the
  // Lua-Global SetArmyEconomy(army, mass, energy) — not from TS constants.
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

  private readonly units = new Map<number, UnitEcon>()
  /** Transient build requests (set per tick by the build system). */
  private readonly buildReqs = new Map<number, Consumer>()

  register(id: number, e: UnitEcon): void {
    this.units.set(id, e)
  }

  /** Register resource requirements of a construction task for this tick. */
  setBuildRequest(taskId: number, mass: number, energy: number): void {
    this.buildReqs.set(taskId, { mass, energy, rate: 0 })
  }
  clearBuildRequest(taskId: number): void {
    this.buildReqs.delete(taskId)
  }
  /** Granted LimitingRate of the build task (valid after tick()). */
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
  remove(id: number): void {
    this.units.delete(id)
  }

  /** An economic tick (in the sim beat before the thread stage). */
  tick(): void {
    let prodM = 0
    let prodE = 0
    let maxM = 0
    let maxE = 0
    const consumers: Consumer[] = []
    const unitConsumers: [UnitEcon, Consumer][] = []
    for (const u of this.units.values()) {
      if (!u.complete) continue // Construction sites contribute neither production nor storage
      maxM = f(maxM + u.storeM)
      maxE = f(maxE + u.storeE)
      if (u.prodActive) {
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
      if (u.consActive) {
        const cm = f(u.consM * DT)
        const ce = f(u.consE * DT)
        if (cm > 0 || ce > 0) {
          const c: Consumer = { mass: cm, energy: ce, rate: 1 }
          consumers.push(c)
          unitConsumers.push([u, c])
        }
      }
    }
    // Construction tasks are also consumers (CEconRequest); their granted
    // LimitingRate scales the construction progress.
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

    const availMass = f(this.mass + f(prodM * DT))
    const availEnergy = f(this.energy + f(prodE * DT))
    const { spentMass, spentEnergy } = distribute(availMass, availEnergy, consumers)
    // Persist each unit's granted rate for next tick's production factor.
    for (const [u, c] of unitConsumers) u.lastRate = c.rate

    this.mass = f(Math.min(Math.max(availMass - spentMass, 0), maxM))
    this.energy = f(Math.min(Math.max(availEnergy - spentEnergy, 0), maxE))
    this.incomeMass = prodM
    this.incomeEnergy = prodE
    this.expenseMass = f(spentMass / DT)
    this.expenseEnergy = f(spentEnergy / DT)
  }

  /**
   * brain:GiveResource(res, amount) — schenkt der Armee Ressourcen (auf das
   * Lager gedeckelt). Wird u. a. von GiveInitialResources jeder ACU gerufen.
   * Der Deckel greift erst, wenn das Lager der Unit registriert ist; darum
   * läuft GiveInitialResources im Original erst nach WaitTicks(5).
   */
  give(res: Res, amount: number): void {
    if (res === 'MASS') this.mass = f(Math.min(Math.max(this.mass + amount, 0), this.maxMass))
    else this.energy = f(Math.min(Math.max(this.energy + amount, 0), this.maxEnergy))
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

/** Manages the economy of all armies. */
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
  // Separate toggles like in the original (production ≠ consumption), plus that
  // Finished condition (construction sites contribute nothing).
  host.setGlobal('__econSetComplete', (army: number, id: number, v: boolean) => {
    mgr.army(army).setComplete(id, v !== false)
  })
  host.setGlobal('__econSetProductionActive', (army: number, id: number, v: boolean) => {
    mgr.army(army).setProductionActive(id, v !== false)
  })
  host.setGlobal('__econSetConsumptionActive', (army: number, id: number, v: boolean) => {
    mgr.army(army).setConsumptionActive(id, v !== false)
  })
  // Construction requests: the construction system reports the need before the tick and reads
  // then returns the granted LimitingRate (CEconRequest::LimitingRate).
  host.setGlobal('__econSetBuildRequest', (army: number, taskId: number, mass: number, energy: number) => {
    mgr.army(army).setBuildRequest(taskId, mass, energy)
  })
  host.setGlobal('__econClearBuildRequest', (army: number, taskId: number) => {
    mgr.army(army).clearBuildRequest(taskId)
  })
  host.setGlobal('__econBuildRate', (army: number, taskId: number) => mgr.army(army).buildRate(taskId))
  host.setGlobal('__econUnregister', (army: number, id: number) => {
    mgr.army(army).remove(id)
  })

  // Real Engine Global: SetArmyEconomy(army, mass, energy) sets the
  // Army starting supply (original: from the scenario/setup session
  // called). Previously, 150/400 was a TS constant in the code — invented.
  host.setGlobal('SetArmyEconomy', (army: number | string, mass: number, energy: number) => {
    const a = mgr.army(typeof army === 'number' ? army : (armyIndex.get(army) ?? 1))
    a.mass = mass
    a.energy = energy
  })
  // Army names → Index (SetArmyEconomy accepts both in the original).
  host.setGlobal('__econSetArmyName', (name: string, index: number) => {
    armyIndex.set(name, index)
  })

  // GiveResource: the real source of startup resources. Every ACU forks in
  // OnStopBeingBuilt `GiveInitialResources` (uel0001_script.lua:159-163):
  // according to WaitTicks(5) she gives the army her own camp
  // (Economy.StorageEnergy = 4000, StorageMass = 650). That's exactly where they come from
  // Starting values ​​— not from a TS constant.
  host.setGlobal('__econGive', (army: number, res: string, amount: number) => {
    mgr.army(army).give(res.toUpperCase() === 'MASS' ? 'MASS' : 'ENERGY', amount)
  })
  host.setGlobal('__econStored', (army: number, res: string) => mgr.army(army).stored((res === 'MASS' ? 'MASS' : 'ENERGY')))
  host.setGlobal('__econStoredRatio', (army: number, res: string) => mgr.army(army).storedRatio(res === 'MASS' ? 'MASS' : 'ENERGY'))
  // The brain getters deliver PER-TICK values ​​— raw field reads
  // CEconomy.mTotals without scaling (GetEconomyIncome Cfile:739923, Usage =
  // mLastUseActual Cfile:739997, Requested = mLastUseRequested Cfile:740071;
  // Filling per tick: HandleResourceManagement ×0.1 Cfile:954011-954028,
  // Takeover func_ArmyProcessEconomy Cfile:1106790). The original Lua does the math
  // SELF high: defaultweapons.lua:970 `GetEconomyIncome('ENERGY') * 10
  // # per tick to per seconds`, xab1401 (Paragon) as well. Our internal
  // Fields remain per second (HUD/Worker) — only the bridge scales.
  host.setGlobal('__econIncome', (army: number, res: string) => mgr.army(army).income(res === 'MASS' ? 'MASS' : 'ENERGY') * DT)

  host.setGlobal('__econUsage', (army: number, res: string) => mgr.army(army).usage(res === 'MASS' ? 'MASS' : 'ENERGY') * DT)
  host.setGlobal('__econRequested', (army: number, res: string) => mgr.army(army).requested(res === 'MASS' ? 'MASS' : 'ENERGY') * DT)
  host.setGlobal('__econTrend', (army: number, res: string) => mgr.army(army).trend(res === 'MASS' ? 'MASS' : 'ENERGY'))

  // The Brain is NOT an engine object with flanged fields, but the
  // Original class `AIBrain` from /lua/aibrain.lua:342 — it derives from
  // moho.aibrain_methods (the C++ base we deliver) and brings your
  // own logic (e.g. ESRegisterUnitMassStorage, aibrain.lua:500).
  // There was previously a hand-built TS table here: exactly the replica it was
  // is not allowed to give. The engine creates the Brain and calls OnCreateHuman —
  // as in the original when building the armies.
  host.eval(BRAIN_LUA)
  void RES
}
