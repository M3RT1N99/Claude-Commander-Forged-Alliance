import { bpGet, type BpObject } from '../formats/blueprint'

/**
 * Deterministischer Sim-Kern (M4).
 *
 * Grundsätze (nach Original-Vorbild, Referenz faf-re):
 *  - fixe Tickrate 10/s, die Sim rendert nichts und kennt kein Three.js
 *  - alle Zustandsgrößen sind float32 (Math.fround nach jeder Operation),
 *    damit Replays auf derselben Engine bit-identisch sind
 *  - keine Iteration über unsortierte Maps im Sim-Pfad
 *
 * Bekannte Grenze für späteres Lockstep-Multiplayer: Math.sin/cos/atan2
 * sind nicht IEEE-normiert und können zwischen JS-Engines abweichen —
 * vor dem Netcode durch tabellenbasierte Trigonometrie ersetzen.
 */

const f = Math.fround

export const SIM_TICK_RATE = 10
export const SIM_DT = f(1 / SIM_TICK_RATE)

export interface UnitStats {
  blueprintId: string
  maxSpeed: number
  /** Grad/s */
  turnRate: number
  acceleration: number
  brake: number
  /** Ankunftsradius in Weltmetern */
  arriveRadius: number
  maxHealth: number
  massProduction: number
  energyProduction: number
  massConsumption: number
  energyConsumption: number
  massStorage: number
  energyStorage: number
  buildCostMass: number
  buildCostEnergy: number
  /** Bauzeit-Einheiten (Economy.BuildTime) */
  buildTime: number
}

/** Leitet die Sim-Statistik aus einem UnitBlueprint ab. */
export function statsFromBlueprint(blueprintId: string, bp: BpObject): UnitStats {
  const num = (path: string, fallback: number): number => {
    const v = bpGet(bp, path)
    return typeof v === 'number' && v > 0 ? v : fallback
  }
  const sizeX = num('Footprint.SizeX', 1)
  const sizeZ = num('Footprint.SizeZ', 1)
  return {
    blueprintId,
    maxSpeed: f(num('Physics.MaxSpeed', 1.7)),
    turnRate: f(num('Physics.TurnRate', 90)),
    acceleration: f(num('Physics.MaxAcceleration', 2)),
    brake: f(num('Physics.MaxBrake', 2)),
    arriveRadius: f(Math.max(sizeX, sizeZ) / 2 + 0.15),
    maxHealth: f(num('Defense.MaxHealth', 100)),
    massProduction: f(num('Economy.ProductionPerSecondMass', 0)),
    energyProduction: f(num('Economy.ProductionPerSecondEnergy', 0)),
    massConsumption: f(num('Economy.MaintenanceConsumptionPerSecondMass', 0)),
    energyConsumption: f(num('Economy.MaintenanceConsumptionPerSecondEnergy', 0)),
    massStorage: f(num('Economy.StorageMass', 0)),
    energyStorage: f(num('Economy.StorageEnergy', 0)),
    buildCostMass: f(num('Economy.BuildCostMass', 0)),
    buildCostEnergy: f(num('Economy.BuildCostEnergy', 0)),
    buildTime: f(num('Economy.BuildTime', 1)),
  }
}

/**
 * Baurate des (impliziten) Konstrukteurs — Übergangslösung bis Ingenieure/
 * Fabriken existieren; 10 = BuildRate des UEF-ACU.
 * TODO: echte Builder-Zuordnung (Economy.BuildRate des bauenden Units).
 */
const BUILDER_RATE = 10

/**
 * Ein Ressourcen-Verbraucher eines Ticks (Bau oder Unterhalt) — entspricht
 * einem Eintrag in `CEconomy::mConsumptionData`. `mass`/`energy` sind die
 * diesen Tick angeforderten Beträge; `apply(ratio)` verrechnet die gewährte
 * `LimitingRate` (Baufortschritt bzw. Unterhaltseffekt).
 */
interface EconRequest {
  mass: number
  energy: number
  apply(ratio: number): void
}

/** Ressourcen-Zustand einer Armee (deterministisch, f32). */
export class Army {
  mass = f(150) // Startressourcen wie im Original-Skirmish
  energy = f(400)
  massStorage = f(650)
  energyStorage = f(4000)
  massIncome = 0
  energyIncome = 0
  massExpense = 0
  energyExpense = 0

  /**
   * Ein Wirtschafts-Tick — 1:1 nach `func_ArmyProcessEconomy` @0x771B50
   * (aus der ForgedAlliance.exe rekonstruiert, siehe
   * docs/research/economy-binary.md). Kern ist die Zwei-Ratio-Verteilung:
   * Produktion ist bedingungsloses Einkommen; jeder Bau/Unterhalt ist ein
   * eigener Request; r1 drosselt Doppel-Verbraucher (brauchen E *und* M) an
   * der knappsten Ressource, r2 lässt Einzel-Verbraucher der reichlichen
   * Ressource aus dem Rest weiterlaufen. Kein globaler Stall-Faktor.
   *
   * @internal
   */
  tick(units: SimUnit[], armyIndex: number): void {
    // 1. Einheiten durchgehen: Produktion (bedingungslos), Lagerkapazität und
    //    die Verbraucher-Requests (Unterhalt fertiger Units + Baustellen).
    let massProd = 0
    let energyProd = 0
    let massStore = f(650)
    let energyStore = f(4000)
    const requests: EconRequest[] = []

    for (const u of units) {
      // health<=0 bei fertigen Einheiten = tot; Baustellen zählen weiter
      if (u.army !== armyIndex || (u.health <= 0 && u.buildProgress >= 1)) continue
      const s = u.stats
      massStore = f(massStore + s.massStorage)
      energyStore = f(energyStore + s.energyStorage)

      if (u.buildProgress >= 1) {
        massProd = f(massProd + s.massProduction)
        energyProd = f(energyProd + s.energyProduction)
        const cm = f(s.massConsumption * SIM_DT)
        const ce = f(s.energyConsumption * SIM_DT)
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        if (cm > 0 || ce > 0) requests.push({ mass: cm, energy: ce, apply: () => {} })
      } else {
        // Baustelle: Sollschritt = BuildRate/BuildTime, Kosten anteilig
        const step = Math.min(
          f(f(BUILDER_RATE / Math.max(s.buildTime, 1)) * SIM_DT),
          f(1 - u.buildProgress),
        )
        requests.push({
          mass: f(s.buildCostMass * step),
          energy: f(s.buildCostEnergy * step),
          apply: (ratio) => {
            u.buildProgress = Math.min(f(u.buildProgress + f(step * ratio)), 1)
            u.health = f(s.maxHealth * u.buildProgress) // Health wächst mit dem Bau
          },
        })
      }
    }

    this.massStorage = massStore
    this.energyStorage = energyStore

    // 2. Verfügbarer Pool = Vorrat + Einkommen dieses Ticks (Handicap = 0).
    let availMass = f(this.mass + f(massProd * SIM_DT))
    let availEnergy = f(this.energy + f(energyProd * SIM_DT))

    // 3. Nachfrage in Doppel- (E und M) und Einzel-Verbraucher trennen.
    let bothMass = 0
    let bothEnergy = 0
    let singleMass = 0
    let singleEnergy = 0
    for (const r of requests) {
      if (r.mass > 0 && r.energy > 0) {
        bothMass = f(bothMass + r.mass)
        bothEnergy = f(bothEnergy + r.energy)
      } else {
        singleMass = f(singleMass + r.mass)
        singleEnergy = f(singleEnergy + r.energy)
      }
    }
    const totalMass = f(bothMass + singleMass)
    const totalEnergy = f(bothEnergy + singleEnergy)

    // 4. Primäre Ratio r1 + Engpass-Ressource (Energie zuerst prüfen).
    let r1 = 1
    let limitingIsMass = false
    if (totalEnergy > 0 && f(totalEnergy * r1) > availEnergy) r1 = availEnergy / totalEnergy
    if (totalMass > 0 && f(totalMass * r1) > availMass) {
      r1 = availMass / totalMass
      limitingIsMass = true
    }
    r1 = f(Math.max(0, Math.min(1, r1)))

    // 5. Doppel-Verbraucher bedienen, Rest für die Einzel-Verbraucher.
    const leftoverMass = f(Math.max(0, availMass - f(bothMass * r1)))
    const leftoverEnergy = f(Math.max(0, availEnergy - f(bothEnergy * r1)))

    // 6. Sekundäre Ratio r2 — nur für die reichliche (Nicht-Engpass-)Ressource.
    let r2 = 1
    if (limitingIsMass) {
      if (singleEnergy > 0 && f(singleEnergy * r2) > leftoverEnergy) r2 = leftoverEnergy / singleEnergy
    } else {
      if (singleMass > 0 && f(singleMass * r2) > leftoverMass) r2 = leftoverMass / singleMass
    }
    r2 = f(Math.max(0, Math.min(1, r2)))

    // 7. Verteilen: wer die Engpass-Ressource NICHT braucht, bekommt r2.
    let spentMass = 0
    let spentEnergy = 0
    for (const r of requests) {
      const needsLimiting = limitingIsMass ? r.mass > 0 : r.energy > 0
      const ratio = needsLimiting ? r1 : r2
      const gm = f(r.mass * ratio)
      const ge = f(r.energy * ratio)
      availMass = f(availMass - gm)
      availEnergy = f(availEnergy - ge)
      spentMass = f(spentMass + gm)
      spentEnergy = f(spentEnergy + ge)
      r.apply(ratio)
    }

    // 8. Lager klemmen (Overflow über Kapazität geht verloren — kein Sharing).
    this.mass = f(Math.min(Math.max(availMass, 0), massStore))
    this.energy = f(Math.min(Math.max(availEnergy, 0), energyStore))

    // Buchhaltung fürs HUD (pro Sekunde): Einkommen = Produktion, Ausgabe =
    // tatsächlich gewährt (mLastUseActual), damit netto = Lageränderung.
    this.massIncome = massProd
    this.energyIncome = energyProd
    this.massExpense = f(spentMass / SIM_DT)
    this.energyExpense = f(spentEnergy / SIM_DT)
  }
}

export type UnitCommand = { type: 'move'; x: number; z: number }

export class SimUnit {
  /** Aktueller Zustand (f32) */
  x: number
  z: number
  heading: number
  speed = 0
  health: number
  /**
   * Baufortschritt 0..1 (Floating Economy: Kosten fließen kontinuierlich
   * über die Bauzeit; bei Ressourcenmangel verlangsamt sich der Bau).
   */
  buildProgress = 1

  /** Zustand des vorherigen Ticks (für Render-Interpolation) */
  prevX: number
  prevZ: number
  prevHeading: number

  readonly queue: UnitCommand[] = []

  constructor(
    readonly id: number,
    readonly stats: UnitStats,
    x: number,
    z: number,
    heading = 0,
    readonly army = 1,
  ) {
    this.x = f(x)
    this.z = f(z)
    this.heading = f(heading)
    this.health = stats.maxHealth
    this.prevX = this.x
    this.prevZ = this.z
    this.prevHeading = this.heading
  }

  get moving(): boolean {
    return this.queue.length > 0 || this.speed > 0.01
  }
}

export class SimWorld {
  readonly units: SimUnit[] = []
  /** Armeen, Index 0 = Armee 1 */
  readonly armies: Army[] = [new Army(), new Army()]
  tickCount = 0
  private nextId = 1

  spawn(stats: UnitStats, x: number, z: number, heading = 0, army = 1): SimUnit {
    const unit = new SimUnit(this.nextId++, stats, x, z, heading, army)
    this.units.push(unit)
    while (this.armies.length < army) this.armies.push(new Army())
    return unit
  }

  army(index: number): Army {
    return this.armies[index - 1] ?? this.armies[0]!
  }

  issueMove(unit: SimUnit, x: number, z: number, append = false): void {
    if (!append) unit.queue.length = 0
    unit.queue.push({ type: 'move', x: f(x), z: f(z) })
  }

  stop(unit: SimUnit): void {
    unit.queue.length = 0
  }

  /** Ein fester Sim-Schritt (0,1 s). */
  tick(): void {
    for (const u of this.units) {
      u.prevX = u.x
      u.prevZ = u.z
      u.prevHeading = u.heading
      this.tickUnit(u)
    }
    for (let i = 0; i < this.armies.length; i++) {
      this.armies[i]!.tick(this.units, i + 1)
    }
    this.tickCount++
  }

  private tickUnit(u: SimUnit): void {
    const s = u.stats
    const cmd = u.queue[0]

    let targetSpeed = 0
    if (cmd) {
      const dx = f(cmd.x - u.x)
      const dz = f(cmd.z - u.z)
      const dist = f(Math.hypot(dx, dz))

      if (dist <= s.arriveRadius) {
        u.queue.shift()
      } else {
        // Drehung zum Ziel mit TurnRate
        const wanted = f(Math.atan2(dx, dz))
        let diff = f(wanted - u.heading)
        while (diff > Math.PI) diff = f(diff - f(2 * Math.PI))
        while (diff < -Math.PI) diff = f(diff + f(2 * Math.PI))
        const maxTurn = f(f((s.turnRate * Math.PI) / 180) * SIM_DT)
        u.heading =
          Math.abs(diff) <= maxTurn
            ? wanted
            : f(u.heading + f(Math.sign(diff) * maxTurn))

        // Zielgeschwindigkeit: volle Fahrt wenn ausgerichtet, gedrosselt in
        // der Kurve; vor dem Ziel bremsweggenau abbremsen (v = √(2·b·d))
        const aligned = Math.abs(diff) < Math.PI / 3
        const brakeLimit = f(Math.sqrt(f(f(2 * s.brake) * dist)))
        targetSpeed = Math.min(aligned ? s.maxSpeed : f(s.maxSpeed * 0.4), brakeLimit)
      }
    }

    // Beschleunigen/Bremsen
    const delta = f(targetSpeed - u.speed)
    const maxAccel = f(s.acceleration * SIM_DT)
    const maxBrake = f(s.brake * SIM_DT)
    if (delta > maxAccel) u.speed = f(u.speed + maxAccel)
    else if (delta < -maxBrake) u.speed = f(u.speed - maxBrake)
    else u.speed = f(targetSpeed)

    if (u.speed > 0) {
      const step = f(u.speed * SIM_DT)
      u.x = f(u.x + f(Math.sin(u.heading) * step))
      u.z = f(u.z + f(Math.cos(u.heading) * step))
    }
  }
}
