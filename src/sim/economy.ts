import type { LuaHost } from '../lua/host'

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
  active: boolean
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
  mass = f(150) // Start wie im Original-Skirmish
  energy = f(400)
  maxMass = f(650)
  maxEnergy = f(4000)
  incomeMass = 0
  incomeEnergy = 0
  expenseMass = 0
  expenseEnergy = 0

  private readonly units = new Map<number, UnitEcon>()

  register(id: number, e: UnitEcon): void {
    this.units.set(id, e)
  }
  setActive(id: number, active: boolean): void {
    const u = this.units.get(id)
    if (u) u.active = active
  }
  remove(id: number): void {
    this.units.delete(id)
  }

  /** Ein Wirtschafts-Tick (im Sim-Beat vor der Thread-Stage). */
  tick(): void {
    let prodM = 0
    let prodE = 0
    let maxM = f(650)
    let maxE = f(4000)
    const consumers: Consumer[] = []
    for (const u of this.units.values()) {
      if (!u.active) continue
      maxM = f(maxM + u.storeM)
      maxE = f(maxE + u.storeE)
      prodM = f(prodM + u.prodM)
      prodE = f(prodE + u.prodE)
      const cm = f(u.consM * DT)
      const ce = f(u.consE * DT)
      if (cm > 0 || ce > 0) consumers.push({ mass: cm, energy: ce, rate: 1 })
    }
    this.maxMass = maxM
    this.maxEnergy = maxE

    const availMass = f(this.mass + f(prodM * DT))
    const availEnergy = f(this.energy + f(prodE * DT))
    const { spentMass, spentEnergy } = distribute(availMass, availEnergy, consumers)

    this.mass = f(Math.min(Math.max(availMass - spentMass, 0), maxM))
    this.energy = f(Math.min(Math.max(availEnergy - spentEnergy, 0), maxE))
    this.incomeMass = prodM
    this.incomeEnergy = prodE
    this.expenseMass = f(spentMass / DT)
    this.expenseEnergy = f(spentEnergy / DT)
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
  host.setGlobal('__econRegister', (army: number, id: number, pm: number, pe: number, cm: number, ce: number, sm: number, se: number) => {
    mgr.army(army).register(id, { prodM: pm, prodE: pe, consM: cm, consE: ce, storeM: sm, storeE: se, active: true })
  })
  host.setGlobal('__econSetActive', (army: number, id: number, active: boolean) => {
    mgr.army(army).setActive(id, active !== false)
  })
  host.setGlobal('__econStored', (army: number, res: string) => mgr.army(army).stored((res === 'MASS' ? 'MASS' : 'ENERGY')))
  host.setGlobal('__econStoredRatio', (army: number, res: string) => mgr.army(army).storedRatio(res === 'MASS' ? 'MASS' : 'ENERGY'))
  host.setGlobal('__econIncome', (army: number, res: string) => mgr.army(army).income(res === 'MASS' ? 'MASS' : 'ENERGY'))

  // Per-Armee-Brain mit den Original-Economy-Accessoren (CAiBrain-Methoden).
  host.eval(`
    __brains = __brains or {}
    function __getBrain(army)
      if not __brains[army] then
        __brains[army] = {
          __army = army,
          GetArmyIndex = function(self) return army end,
          GetEconomyStored = function(self, res) return __econStored(army, res) end,
          GetEconomyStoredRatio = function(self, res) return __econStoredRatio(army, res) end,
          GetEconomyIncome = function(self, res) return __econIncome(army, res) end,
        }
      end
      return __brains[army]
    end
  `)
  void RES
}
