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
  massStorage: number
  energyStorage: number
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
    massStorage: f(num('Economy.StorageMass', 0)),
    energyStorage: f(num('Economy.StorageEnergy', 0)),
  }
}

/** Ressourcen-Zustand einer Armee (deterministisch, f32). */
export class Army {
  mass = f(150) // Startressourcen wie im Original-Skirmish
  energy = f(400)
  massStorage = f(650)
  energyStorage = f(4000)
  massIncome = 0
  energyIncome = 0

  /** @internal */
  tick(units: SimUnit[], armyIndex: number): void {
    let massIn = 0
    let energyIn = 0
    let massStore = f(650)
    let energyStore = f(4000)
    for (const u of units) {
      if (u.army !== armyIndex || u.health <= 0) continue
      massIn = f(massIn + u.stats.massProduction)
      energyIn = f(energyIn + u.stats.energyProduction)
      massStore = f(massStore + u.stats.massStorage)
      energyStore = f(energyStore + u.stats.energyStorage)
    }
    this.massIncome = massIn
    this.energyIncome = energyIn
    this.massStorage = massStore
    this.energyStorage = energyStore
    this.mass = Math.min(f(this.mass + f(massIn * SIM_DT)), massStore)
    this.energy = Math.min(f(this.energy + f(energyIn * SIM_DT)), energyStore)
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
