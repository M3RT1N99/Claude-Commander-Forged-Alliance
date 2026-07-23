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
  // Reclaim income this beat — kept separate from income (mTotals.mReclaimed,
  // the third pair in SSTIArmyVariableData, Cfile:1016010-1016024). The engine
  // writes reclaim to TWO places: storage AND this counter (Cfile:848614-848639);
  // reclaimed is NOT folded into income. Kept per second like income/expense.
  reclaimMass = 0
  reclaimEnergy = 0

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
  remove(id: number): void {
    this.units.delete(id)
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

  /**
   * This tick's reclaim grant (mass/energy per tick) — accumulated separately
   * from income as a per-second rate (like income/expense, /DT). Storage is
   * still filled by `give()`/GiveResource; this is ONLY the reclaimed display
   * counter (the engine writes to both places, Cfile:848614-848639). Reset in tick().
   */
  addReclaim(massPerTick: number, energyPerTick: number): void {
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
  // Bau-Requests: das Bau-System meldet vor dem Tick den Bedarf an und liest
  // danach die gewährte LimitingRate zurück (CEconRequest::LimitingRate).
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
