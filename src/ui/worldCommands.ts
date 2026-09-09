import type { LuaHost } from '../lua/host'
import type { Validity } from '../sim/ogrid'
import type { FactoryCommand } from '../sim/luaSimClient'

/**
 * Der Engine-Teil der Weltansicht: Klick → Befehl.
 *
 * Hier wird NICHTS entschieden. Die UI-Lua hält den Zustand ("was tut der nächste
 * Klick?") in `commandmode.lua`; die Engine FRAGT ihn ab (`GetCommandMode()`),
 * rechnet die Geometrie (Snap, Höhe) und schickt den Befehl an die Sim. Danach
 * meldet sie den ausgeführten Befehl zurück an die Lua
 * (`commandmode.OnCommandIssued`), die daraus ihren Modus beendet, das
 * Bau-Blip zeichnet und die Order-Buttons zurücksetzt.
 *
 * Genau so ist die Aufgabenteilung im Original: `CUIWorldView` behandelt den
 * Klick, liest den Command-Mode aus dem Lua-State und ruft `IssueCommand`; die
 * Lua sieht davon nur `OnCommandIssued` (commandmode.lua:146).
 *
 * Das Raster (COORDS_GridSnap @0x50B1E0, Cfile:641666-641686):
 *
 *   cell.x  = (int)(pos.x − sizeX/2)          -- Ganzzahl, 1-Meter-Raster
 *   cell.z  = (int)(pos.z − sizeZ/2)
 *   world.x = cell.x + sizeX/2                -- zurück in die Weltmitte
 *   world.z = cell.z + sizeZ/2
 *   world.y = GetElevation(world.x, world.z)  -- Höhe NACH dem Snap
 *
 * `sizeX/sizeZ` sind die GANZZAHLIGEN Footprint-Maße des Blueprints
 * (`Footprint.SizeX/SizeZ`, z. B. 5×5 bei ueb0101) — nicht SkirtSize, nicht
 * SelectionSize.
 */
export interface CommandMode {
  mode: 'order' | 'build' | 'buildanchored' | false
  /** Bei 'order' der RULEUCC_*-Name, bei 'build' die Blueprint-ID. */
  name: string | false
}

export interface WorldCommandSim {
  /** queue=true (held Shift) appends instead of replacing (Cfile:1240965). */
  move(id: number, x: number, z: number, queue?: boolean): void
  /** Attack (CAttackTargetTask): Unit `id` greift die Ziel-Unit an. */
  attack(id: number, targetId: number, queue?: boolean): void
  /** Ground attack: same task with an AITARGET_Ground position target. */
  attackGround(id: number, x: number, z: number, queue?: boolean): void
  /** Repair (dispatch 0x14): resume building the unfinished target. */
  repair(id: number, targetId: number, queue?: boolean): void
  /** Guard/assist (dispatch 0x0F, CUnitGuardTask): follow + assist the target. */
  guard(id: number, targetId: number, queue?: boolean): void
  /** Patrol (dispatch 0x10, CUnitPatrolTask): one leg, ring-rotated queue. */
  patrol(id: number, x: number, z: number, queue?: boolean): void
  /** Reclaim (dispatch 0x13, CUnitReclaimTask): drain the wreck prop. */
  reclaim(id: number, targetId: number, queue?: boolean): void
  /** Reclaim a MAP prop (tree/rock) by its scmap instance index. */
  reclaimMapProp(id: number, mapIndex: number, queue?: boolean): void
  /**
   * TransportLoadUnits (dispatch 0x16): the passengers `ids` and the
   * transport get ONE command targeting the transport (the CallTransport
   * click, Cfile:1241799-1241870).
   */
  transportLoad(ids: number[], transportId: number, queue?: boolean): void
  /**
   * TransportReverseLoadUnits (dispatch 0x17): the transports and the unit
   * to pick up; the sim keeps the closest transport with space (sub_6EF660,
   * Cfile:1006333-1006500).
   */
  transportReverseLoad(transportIds: number[], targetId: number, queue?: boolean): void
  /** TransportUnloadUnits (dispatch 0x18): drop the cargo at the point. */
  transportUnload(id: number, x: number, z: number, queue?: boolean): void
  /**
   * A FACTORY command (ISSUE_FactoryCommand, Cfile:1350766): the click's
   * command into the factory's command list -- the rally point is the Move at
   * its head, every product inherits the list (818487-818600). The factory
   * stays put.
   */
  factoryCommand(id: number, cmd: FactoryCommand, queue?: boolean): void
  build(
    builderId: number,
    blueprintId: string,
    pos: { x: number; y: number; z: number },
    army: number,
    /** Shift gehalten → der Bau-Auftrag hängt an die Reihe an, statt sie zu ersetzen. */
    queue?: boolean,
  ): Promise<number>
}

/** Eine ausgewählte Einheit, wie die UI-VM sie meldet (__uiSelectionJson). */
export interface SelectedUnit {
  id: number
  army: number
  /** RULEUCC_Move steht in den CommandCaps des Blueprints. */
  canMove: boolean
  /** RULEUCC_Repair — darf Bauten weiterbauen (repair task, dispatch 0x14). */
  canRepair: boolean
  /** RULEUCC_Attack plus at least one attacker weapon. */
  canAttack: boolean
  /** At least one attacker weapon accepts a ground target. */
  canAttackGround: boolean
  /** RULEUCC_Guard, excluding stationary factories. */
  canGuard: boolean
  /** RULEUCC_Reclaim — may drain wrecks and map props (dispatch 0x13). */
  canReclaim: boolean
  /** Kategorie FACTORY — sie bekommt einen Sammelpunkt statt eines Move-Befehls. */
  isFactory: boolean
  /**
   * IsMobile (a MotionType other than RULEUMT_None). The click handler splits
   * the selection by it (sub_81EB20, Cfile:1239941-1240011): a mobile unit's
   * command goes out as a unit command, an immobile unit's as a FACTORY
   * command, which the sim keeps only for FACTORY builders (1007660-1007663).
   */
  isMobile: boolean
  /** RULEUCC_Transport -- the unit carries others (bit 8, Cfile:656687). */
  canTransport: boolean
  /** RULEUCC_CallTransport -- the unit can be carried (bit 9, Cfile:656689). */
  canCallTransport: boolean
  /** The categories the transport right-click predicates test. */
  isCommand: boolean
  isTransportation: boolean
  isTransportFocus: boolean
  canTransportCommander: boolean
  isTeleportation: boolean
  isExperimental: boolean
  /** Blueprint Air.CanFly. */
  canFly: boolean
  isFerryBeacon?: boolean
  isAirStaging?: boolean
  cannotUseAirStaging?: boolean
  /** Attached to something (the vtable+44 test of func_RightClickWithTransport,
   *  Cfile:1238700 -- UNVERIFIED which state; the UI mirror does not carry it). */
  isAttached?: boolean
}

/**
 * The own unit under the cursor as the two transport predicates see it
 * (GetRightMouseButtonAction, Cfile:1240291-1240304): its CallTransport cap,
 * the categories they test, Air.CanFly and its layer.
 */
export interface TransportHoverInfo {
  canCallTransport: boolean
  isTransportation: boolean
  isTeleportation: boolean
  isFerryBeacon: boolean
  isAirStaging: boolean
  isExperimental: boolean
  isCommand: boolean
  canTransportCommander: boolean
  canFly: boolean
  layer: string
  beingBuilt?: boolean
}

/**
 * func_RightClickWithTransport (Cfile:1238669-1238853): the hovered unit is
 * alive, not on the seabed and finished (1238676); some selected unit is
 * alive, finished and not attached (1238692-1238697; the third test is a
 * vtable slot the decompilation does not name, read as "attached" --
 * UNVERIFIED) and matches it: a COMMAND unit only a CANTRANSPORTCOMMANDER
 * transport or a ferry beacon (1238700-1238720); a TRANSPORTATION,
 * TELEPORTATION or FERRYBEACON target (1238746-1238768) while its byte 872
 * is clear (1238806); an AIRSTAGINGPLATFORM target while that byte is SET
 * and the unit is not CANNOTUSEAIRSTAGING (1238818-1238827). Which flag
 * byte 872 is stays UNVERIFIED -- it is not carried here, so both branches
 * read it as accepting.
 */
export function rightClickWithTransport(selection: SelectedUnit[], hover: TransportHoverInfo): boolean {
  if (hover.layer === 'Seabed' || hover.beingBuilt) return false
  for (const u of selection) {
    if (u.isAttached) continue
    if (u.isCommand && !hover.canTransportCommander && !hover.isFerryBeacon) continue
    if (hover.isTransportation || hover.isTeleportation || hover.isFerryBeacon) return true
    if (hover.isAirStaging && !u.cannotUseAirStaging) return true
  }
  return false
}

/**
 * func_RightClickTransport (Cfile:1238854-1239027): the hovered unit is alive
 * and finished (1238860); some selected unit that is not TELEPORTATION, with
 * the hovered not EXPERIMENTAL (1238879-1238895), is a TRANSPORTFOCUS unit
 * (1238913-1238917) that may carry a COMMAND target only when it is
 * CANTRANSPORTCOMMANDER (1238930-1238946); a TRANSPORTATION or FERRYBEACON
 * selection takes a non-flyer (1238972-1239001), an AIRSTAGINGPLATFORM a
 * flyer (1239003-1239016). The engine asks only when the hovered unit's caps
 * carry RULEUCC_CallTransport (1240300-1240304): the caller's check. The
 * second field test at 1238912 (a value != 2) is UNVERIFIED and not modelled.
 */
export function rightClickTransport(selection: SelectedUnit[], hover: TransportHoverInfo): boolean {
  if (hover.beingBuilt) return false
  for (const u of selection) {
    if (u.isTeleportation || hover.isExperimental) continue
    if (!u.isTransportFocus) continue
    if (hover.isCommand && !u.canTransportCommander) continue
    if (u.isTransportation || u.isFerryBeacon) {
      if (!hover.canFly) return true
    } else if (u.isAirStaging && hover.canFly) {
      return true
    }
  }
  return false
}

/** Der Command-Mode, wie die Original-Lua ihn führt (commandmode.lua:109). */
export function getCommandMode(host: LuaHost): CommandMode {
  return host.pull<CommandMode>('__uiCommandModeJson()')
}

/** Footprint-Maße aus dem Blueprint der UI-VM (Footprint.SizeX/SizeZ). */
export function footprintOf(host: LuaHost, blueprintId: string): [number, number] {
  const fp = host.pull<[number, number] | null>(
    `__uiFootprintJson('${blueprintId.replaceAll("'", '')}')`,
  )
  if (!fp) throw new Error(`Kein Blueprint '${blueprintId}' in der UI-VM`)
  return fp
}

/**
 * Rasterfang. `elevation` liefert die Geländehöhe — dieselbe Quelle, aus der die
 * Sim ihre Höhe zieht (sonst steht das Gebäude im Bild woanders als in der Sim).
 *
 * `waterElevation` (the map's water surface, or undefined when the map has no
 * water) clamps the build height UP to the water surface on underwater cells,
 * exactly like COORDS_ToWorldPos / GetSurfaceHeight (`y = max(terrainY,
 * waterElevation)`, Cfile:641654 / 1089843-1089852). Seabed-anchored footprints
 * (occupancy caps & LAYER_Seabed) keep the raw terrain, but those caps are not
 * exposed to the UI VM, so every underwater build floats to the surface — a
 * documented residual for the rare seabed structure.
 */
export function snapToGrid(
  x: number,
  z: number,
  sizeX: number,
  sizeZ: number,
  elevation: (x: number, z: number) => number,
  waterElevation?: number,
): { x: number; y: number; z: number } {
  const cellX = Math.trunc(x - sizeX / 2)
  const cellZ = Math.trunc(z - sizeZ / 2)
  const worldX = cellX + sizeX / 2
  const worldZ = cellZ + sizeZ / 2
  const terrainY = elevation(worldX, worldZ)
  const y = waterElevation !== undefined && waterElevation > terrainY ? waterElevation : terrainY
  return { x: worldX, y, z: worldZ }
}

/**
 * Ein Klick in die Welt. Liefert true, wenn der Klick zu einem Befehl wurde.
 *
 * `selection` sind die Einheiten, die die UI-VM als ausgewählt führt — dieselbe
 * Liste, mit der orders.lua und construction.lua arbeiten.
 */
export async function worldClick(
  host: LuaHost,
  sim: WorldCommandSim,
  hit: { x: number; z: number },
  elevation: (x: number, z: number) => number,
  opts: {
    queue: boolean
    /** Die FEINDLICHE Unit unter dem Cursor (Picking der Engine) — sie macht
     *  aus dem Standard-Klick einen Attack-Befehl (Dispatch 0x0A). */
    enemyTargetId?: number
    /** An OWN UNFINISHED unit under the cursor — the default click resumes
     *  its construction via the repair task (dispatch 0x14). */
    repairTargetId?: number
    /** An OWN HEALTHY unit under the cursor — the default click guards it
     *  (dispatch 0x0F: assist builds, share factory queues, follow). */
    ownTargetId?: number
    /** That unit as the transport predicates see it (rightClickWithTransport /
     *  rightClickTransport) -- the transport defaults come before Guard. */
    ownHover?: TransportHoverInfo
    /** A wreck prop under the cursor (sim prop id) — reclaim (0x13). */
    reclaimPropId?: number
    /** A map prop under the cursor — its scmap instance index. */
    reclaimMapPropIndex?: number
    /** The map's water surface height (undefined = no water) — a build is
     *  clamped up to it on underwater cells (GetSurfaceHeight, Cfile:641654). */
    waterElevation?: number
    /** The enemy under the cursor is RECLAIMABLE (being built, or category
     *  RECLAIMABLE, and not busy — mirrors v52 @Cfile:1240220). When the
     *  selection cannot attack it, the engine issues Reclaim (Cfile:1240271). */
    enemyReclaimable?: boolean
    /** Placement validity at the snapped cell (canBuildStructureAt). The world
     *  view (UIBuildDragger) does not issue a build where the ghost is red —
     *  the same query that colours the ghost gates the order. */
    buildValidity?: (blueprintId: string, x: number, z: number) => Validity
  } = { queue: false },
): Promise<string | null> {
  // pull() liefert JSON — eine LEERE Lua-Tabelle wuerde als `{}` in JS ankommen,
  // nicht als `[]`, und `for…of` warf dann "selection is not iterable".
  const selection = host.pull<SelectedUnit[]>('__uiSelectionJson()')
  if (selection.length === 0) return null

  const cm = getCommandMode(host)

  // Der Attack-Button (orders.lua:151 AttackOrderBehavior) setzt den
  // Command-Mode 'order' mit RULEUCC_Attack — der nächste Klick greift an.
  // Ohne Unit unterm Cursor ist es ein BODEN-Angriff: derselbe Dispatch
  // (0x0A, CUnitAttackTargetTask) mit AITARGET_Ground-Position statt Entity
  // (Cfile:812553-812563); die Order endet nie von selbst (HasTarget bleibt
  // true für Ground, Cfile:800284).
  if (cm.mode === 'order' && cm.name === 'RULEUCC_Attack') {
    let n = 0
    for (const u of selection) {
      if (!u.isMobile) {
        // An immobile FACTORY takes the attack into its command list: its
        // products attack (ISSUE_FactoryCommand, Cfile:1241000-1241182).
        if (u.isFactory) {
          sim.factoryCommand(
            u.id,
            opts.enemyTargetId === undefined
              ? { cmd: 'AttackGround', x: hit.x, z: hit.z }
              : { cmd: 'Attack', targetId: opts.enemyTargetId },
            opts.queue,
          )
          n++
        }
        continue
      }
      if (opts.enemyTargetId === undefined) {
        if (!u.canAttackGround) continue
        sim.attackGround(u.id, hit.x, hit.z, opts.queue)
      } else {
        if (!u.canAttack) continue
        sim.attack(u.id, opts.enemyTargetId, opts.queue)
      }
      n++
    }
    if (n === 0) return null
    onCommandIssued(host, {
      CommandType: 'Attack',
      Position: { x: hit.x, y: elevation(hit.x, hit.z), z: hit.z },
      Clear: !opts.queue,
    })
    return opts.enemyTargetId === undefined
      ? `Attack (${n}) → ground ${hit.x.toFixed(1)}, ${hit.z.toFixed(1)}`
      : `Attack (${n}) → unit ${opts.enemyTargetId}`
  }

  // The Patrol button/hotkey (orders.lua:699, P/Shift-P via
  // StartCommandMode order RULEUCC_Patrol): every click is one patrol
  // waypoint; held Shift keeps the mode alive (commandmode.lua:81-85) and
  // the queue's ring rotation loops the points (sim-core.md:243-252).
  if (cm.mode === 'order' && cm.name === 'RULEUCC_Patrol') {
    let n = 0
    for (const u of selection) {
      if (!u.isMobile) {
        // An immobile FACTORY takes the patrol into its command list: its
        // products patrol (ISSUE_FactoryCommand, Cfile:1241396-1241420).
        if (u.isFactory) {
          sim.factoryCommand(u.id, { cmd: 'Patrol', x: hit.x, z: hit.z }, opts.queue)
          n++
        }
      } else if (u.canMove) {
        sim.patrol(u.id, hit.x, hit.z, opts.queue)
        n++
      }
    }
    if (n === 0) return null
    onCommandIssued(host, {
      CommandType: 'Patrol',
      Position: { x: hit.x, y: elevation(hit.x, hit.z), z: hit.z },
      Clear: !opts.queue,
    })
    return `Patrol (${n}) → ${hit.x.toFixed(0)}, ${hit.z.toFixed(0)}`
  }

  // The Guard button (orders.lua, RULEUCC_Guard): a click on a unit guards
  // it (dispatch 0x0F). Guarding a POINT wraps a Move first
  // (Cfile:830638-830650) — the point-guard task itself is a named gap, so
  // a ground click just moves there. Guard on an ENEMY is capture in the
  // original (sub_613A80) — capture is a gap, so only own/allied units take.
  if (cm.mode === 'order' && cm.name === 'RULEUCC_Guard') {
    const target = opts.ownTargetId ?? opts.repairTargetId
    if (target !== undefined) {
      let n = 0
      for (const u of selection) {
        if (u.canGuard && u.id !== target) {
          sim.guard(u.id, target, opts.queue)
          n++
        }
      }
      if (n === 0) return null
      onCommandIssued(host, {
        CommandType: 'Guard',
        Position: { x: hit.x, y: elevation(hit.x, hit.z), z: hit.z },
        Clear: !opts.queue,
      })
      return `Guard (${n}) → Unit ${target}`
    }
    let moved = 0
    for (const u of selection) {
      if (u.canGuard && u.canMove) {
        sim.move(u.id, hit.x, hit.z, opts.queue)
        moved++
      }
    }
    if (moved === 0) return null
    onCommandIssued(host, {
      CommandType: 'Guard',
      Position: { x: hit.x, y: elevation(hit.x, hit.z), z: hit.z },
      Clear: !opts.queue,
    })
    return `Guard point → move ${hit.x.toFixed(0)}, ${hit.z.toFixed(0)}`
  }

  // The Reclaim button (orders.lua, RULEUCC_Reclaim): a click on a wreck or
  // a map prop (tree, rock) dispatches 0x13 (CUnitReclaimTask) — the cost
  // and yield come from the TARGET's Lua (GetReclaimCosts, prop.lua:153).
  // A click on bare ground does nothing; the mode stays armed.
  if (cm.mode === 'order' && cm.name === 'RULEUCC_Reclaim') {
    if (opts.reclaimPropId === undefined && opts.reclaimMapPropIndex === undefined) return null
    let n = 0
    for (const u of selection) {
      if (!u.canReclaim) continue
      if (opts.reclaimPropId !== undefined) {
        sim.reclaim(u.id, opts.reclaimPropId, opts.queue)
      } else {
        sim.reclaimMapProp(u.id, opts.reclaimMapPropIndex!, opts.queue)
      }
      n++
    }
    if (n === 0) return null
    onCommandIssued(host, {
      CommandType: 'Reclaim',
      Position: { x: hit.x, y: elevation(hit.x, hit.z), z: hit.z },
      Clear: !opts.queue,
    })
    return opts.reclaimPropId !== undefined
      ? `Reclaim (${n}) → prop ${opts.reclaimPropId}`
      : `Reclaim (${n}) → map prop #${opts.reclaimMapPropIndex}`
  }

  // The Move button/hotkey (orders.lua, RULEUCC_Move): a FORCED move — the
  // click goes to the ground point regardless of what is under the cursor (an
  // enemy is NOT attacked, an own unit is NOT guarded). Factories rally.
  if (cm.mode === 'order' && cm.name === 'RULEUCC_Move') {
    let moved = 0
    let rallied = 0
    for (const u of selection) {
      if (!u.isMobile) {
        // The immobile part of the selection gets the Move as a FACTORY
        // command (ISSUE_FactoryCommand, Cfile:1241182); only a FACTORY
        // builder keeps it -- as its rally point.
        if (u.isFactory) {
          sim.factoryCommand(u.id, { cmd: 'Move', x: hit.x, z: hit.z }, opts.queue)
          rallied++
        }
      } else if (u.canMove) {
        sim.move(u.id, hit.x, hit.z, opts.queue)
        moved++
      }
    }
    if (moved === 0 && rallied === 0) return null
    onCommandIssued(host, {
      // The rally point is a UNITCOMMAND_Move in the factory's command list
      // (Cfile:1008346) — its feedback is a Move blip, not an invented type.
      CommandType: 'Move',
      Position: { x: hit.x, y: elevation(hit.x, hit.z), z: hit.z },
      Clear: !opts.queue,
    })
    return `Move (${moved}) → ${hit.x.toFixed(0)}, ${hit.z.toFixed(0)}`
  }

  // The Repair button/hotkey (orders.lua, RULEUCC_Repair): a FORCED repair on
  // the unit under the cursor (own, finished or unfinished) — the same repair
  // task as the default right-click (dispatch 0x14). Bare ground does nothing.
  if (cm.mode === 'order' && cm.name === 'RULEUCC_Repair') {
    const target = opts.repairTargetId ?? opts.ownTargetId
    if (target === undefined) return null
    let n = 0
    for (const u of selection) {
      if (u.canRepair && u.id !== target) {
        sim.repair(u.id, target, opts.queue)
        n++
      }
    }
    if (n === 0) return null
    onCommandIssued(host, {
      CommandType: 'Repair',
      Position: { x: hit.x, y: elevation(hit.x, hit.z), z: hit.z },
      Clear: !opts.queue,
    })
    return `Repair (${n}) → Unit ${target}`
  }

  // The Transport button (orders.lua:709, RULEUCC_Transport): a click on a
  // unit that can call a transport is the reverse load -- the closest
  // transport of the selection with space goes to pick it up (HandleEvent,
  // Cfile:1241600-1241617 -> sub_6EF660 in the sim); a click on the ground
  // unloads the cargo there (1241640-1241665).
  if (cm.mode === 'order' && cm.name === 'RULEUCC_Transport') {
    const transports = selection.filter((u) => u.canTransport)
    if (transports.length === 0) return null
    const ids = transports.map((u) => u.id)
    if (opts.ownTargetId !== undefined && opts.ownHover?.canCallTransport) {
      sim.transportReverseLoad(ids, opts.ownTargetId, opts.queue)
      onCommandIssued(host, {
        CommandType: 'TransportLoadUnits',
        Position: { x: hit.x, y: elevation(hit.x, hit.z), z: hit.z },
        Clear: !opts.queue,
      })
      return `TransportLoad (${ids.length}) → Unit ${opts.ownTargetId}`
    }
    for (const id of ids) sim.transportUnload(id, hit.x, hit.z, opts.queue)
    onCommandIssued(host, {
      CommandType: 'TransportUnloadUnits',
      Position: { x: hit.x, y: elevation(hit.x, hit.z), z: hit.z },
      Clear: !opts.queue,
    })
    return `TransportUnload (${ids.length}) → ${hit.x.toFixed(1)}, ${hit.z.toFixed(1)}`
  }

  // The CallTransport mode (RULEUCC_CallTransport, no button of its own --
  // the default right-click sets it, Cfile:1240294-1240298): a click on a
  // transport loads the selection into it; the transport joins the command
  // (HandleEvent 1241799-1241870).
  if (cm.mode === 'order' && cm.name === 'RULEUCC_CallTransport') {
    if (opts.ownTargetId === undefined) return null
    const ids = selection.filter((u) => u.canCallTransport && u.isMobile).map((u) => u.id)
    if (ids.length === 0) return null
    sim.transportLoad(ids, opts.ownTargetId, opts.queue)
    onCommandIssued(host, {
      CommandType: 'TransportLoadUnits',
      Position: { x: hit.x, y: elevation(hit.x, hit.z), z: hit.z },
      Clear: !opts.queue,
    })
    return `CallTransport (${ids.length}) → Unit ${opts.ownTargetId}`
  }

  // Any OTHER order mode (Capture, Overcharge, Nuke, Tactical, Teleport, Ferry,
  // Sacrifice, Dive, SiloBuild*, Script): the sim has no task for it yet.
  // FAIL LOUDLY (CLAUDE.md) rather than fall through to the default handler,
  // which would silently misroute the click to Attack/Move.
  if (cm.mode === 'order') {
    return `command mode ${cm.name} is not wired to the sim yet — click ignored`
  }

  if (cm.mode === 'build' || cm.mode === 'buildanchored') {
    if (!cm.name) return null
    const [sx, sz] = footprintOf(host, cm.name)
    const pos = snapToGrid(hit.x, hit.z, sx, sz, elevation, opts.waterElevation)
    // Red ghost -> no order. The engine's world view refuses to place a
    // structure where CanBuildStructureAt fails; 'unknown' (mobile / deposit-
    // restricted, no markers) is left to pass, matching the neutral ghost.
    if (opts.buildValidity && opts.buildValidity(cm.name, pos.x, pos.z) === 'invalid') {
      return `Bau: ${cm.name} auf ${pos.x.toFixed(1)}, ${pos.z.toFixed(1)} blockiert — kein Befehl`
    }
    // The first builder of the selection places the site; every other
    // selected unit with RULEUCC_Repair joins the SAME site through the
    // repair/build task — the engine's BuildAssist result (dispatch 0x09;
    // the follow-the-builder guard part stays a documented gap).
    const builder = selection[0]!
    const siteId = await sim.build(builder.id, cm.name, pos, builder.army, opts.queue)
    let helpers = 0
    if (siteId > 0) {
      for (const u of selection) {
        if (u.id !== builder.id && u.canRepair) {
          sim.repair(u.id, siteId, opts.queue)
          helpers++
        }
      }
    }
    onCommandIssued(host, {
      CommandType: 'BuildMobile',
      Blueprint: cm.name,
      Position: pos,
      Clear: !opts.queue,
    })
    const wer = helpers > 0 ? ` (+${helpers} Assist)` : ''
    return `Bau: ${cm.name} auf ${pos.x.toFixed(1)}, ${pos.z.toFixed(1)}${wer}`
  }

  // Ohne Bau-Modus hängt der Standardbefehl an den COMMAND-CAPS der Einheit:
  //
  //   Klick auf FEIND             → Attack (der Default der Engine)
  //   RULEUCC_Move (Panzer, ACU)  → Bewegungsbefehl
  //   Fabrik ohne Move            → SAMMELPUNKT (IssueFactoryRallyPoint,
  //                                 eine eigene Engine-Bindung, Cfile:1008266)
  //
  // Wer den Move-Befehl an alles schickt, schickt ihn auch an Gebäude — und die
  // fuhren dann durch die Gegend, statt einen Sammelpunkt zu bekommen.
  const y = elevation(hit.x, hit.z)
  if (opts.enemyTargetId !== undefined) {
    let n = 0
    for (const u of selection) {
      if (!u.isMobile) {
        // Immobile FACTORY: the attack goes into its command list.
        if (u.isFactory) {
          sim.factoryCommand(u.id, { cmd: 'Attack', targetId: opts.enemyTargetId }, opts.queue)
          n++
        }
        continue
      }
      if (!u.canAttack) continue
      sim.attack(u.id, opts.enemyTargetId, opts.queue)
      n++
    }
    if (n > 0) {
      onCommandIssued(host, {
        CommandType: 'Attack',
        Position: { x: hit.x, y, z: hit.z },
        Clear: !opts.queue,
      })
      return `Attack (${n}) → Unit ${opts.enemyTargetId}`
    }
    // No selected unit can attack it (the engine's sub_81D080 short-circuit is
    // false). If the enemy is reclaimable and the selection can reclaim, the
    // engine issues Reclaim instead of doing nothing (Cfile:1240271-1240288) —
    // e.g. a pure-engineer selection right-clicking an enemy structure under
    // construction. Reclaim of a live unit target uses the same dispatch 0x13.
    if (opts.enemyReclaimable) {
      let r = 0
      for (const u of selection) {
        if (u.canReclaim) {
          sim.reclaim(u.id, opts.enemyTargetId, opts.queue)
          r++
        }
      }
      if (r > 0) {
        onCommandIssued(host, {
          CommandType: 'Reclaim',
          Position: { x: hit.x, y, z: hit.z },
          Clear: !opts.queue,
        })
        return `Reclaim (${r}) → Unit ${opts.enemyTargetId}`
      }
    }
    return null
  }
  // The transport defaults sit between Reclaim and Repair
  // (GetRightMouseButtonAction, Cfile:1240291-1240315): a selection that can
  // call a transport clicking one calls it (RULEUCC_CallTransport ->
  // TransportLoadUnits with the transport in the set); a transport clicking
  // a unit that can call one picks it up (RULEUCC_Transport ->
  // TransportReverseLoadUnits). The third branch -- a hovered FERRYBEACON
  // with a selection that may use it (sub_81DA20, 1240310-1240315) -- is the
  // ferry, which is not modelled (docs/STATUS.md).
  if (opts.ownTargetId !== undefined && opts.ownHover) {
    if (selection.some((u) => u.canCallTransport) && rightClickWithTransport(selection, opts.ownHover)) {
      const ids = selection.filter((u) => u.canCallTransport && u.isMobile).map((u) => u.id)
      sim.transportLoad(ids, opts.ownTargetId, opts.queue)
      onCommandIssued(host, {
        CommandType: 'TransportLoadUnits',
        Position: { x: hit.x, y, z: hit.z },
        Clear: !opts.queue,
      })
      return `CallTransport (${ids.length}) → Unit ${opts.ownTargetId}`
    }
    if (opts.ownHover.canCallTransport && rightClickTransport(selection, opts.ownHover)) {
      const ids = selection.filter((u) => u.canTransport).map((u) => u.id)
      sim.transportReverseLoad(ids, opts.ownTargetId, opts.queue)
      onCommandIssued(host, {
        CommandType: 'TransportLoadUnits',
        Position: { x: hit.x, y, z: hit.z },
        Clear: !opts.queue,
      })
      return `TransportLoad (${ids.length}) → Unit ${opts.ownTargetId}`
    }
  }
  // Click on an OWN UNFINISHED structure: units with RULEUCC_Repair resume
  // its construction (repair task, dispatch 0x14) — the engine default.
  if (opts.repairTargetId !== undefined) {
    let n = 0
    for (const u of selection) {
      if (u.canRepair && u.id !== opts.repairTargetId) {
        sim.repair(u.id, opts.repairTargetId, opts.queue)
        n++
      }
    }
    if (n > 0) {
      onCommandIssued(host, {
        CommandType: 'Repair',
        Position: { x: hit.x, y, z: hit.z },
        Clear: !opts.queue,
      })
      return `Repair (${n}) → Unit ${opts.repairTargetId}`
    }
  }
  // Click on an OWN HEALTHY unit: the engine's default is Guard/assist
  // (dispatch 0x0F) — engineers join builds, factories share queues,
  // everyone else follows.
  if (opts.ownTargetId !== undefined) {
    let n = 0
    for (const u of selection) {
      if (u.canGuard && u.id !== opts.ownTargetId) {
        sim.guard(u.id, opts.ownTargetId, opts.queue)
        n++
      }
    }
    if (n > 0) {
      onCommandIssued(host, {
        CommandType: 'Guard',
        Position: { x: hit.x, y, z: hit.z },
        Clear: !opts.queue,
      })
      return `Guard (${n}) → Unit ${opts.ownTargetId}`
    }
  }
  // Click on a WRECK or MAP PROP: units with RULEUCC_Reclaim reclaim it —
  // the engine's right-click default on reclaimables (dispatch 0x13).
  if (opts.reclaimPropId !== undefined || opts.reclaimMapPropIndex !== undefined) {
    let n = 0
    for (const u of selection) {
      if (!u.canReclaim) continue
      if (opts.reclaimPropId !== undefined) {
        sim.reclaim(u.id, opts.reclaimPropId, opts.queue)
      } else {
        sim.reclaimMapProp(u.id, opts.reclaimMapPropIndex!, opts.queue)
      }
      n++
    }
    if (n > 0) {
      onCommandIssued(host, {
        CommandType: 'Reclaim',
        Position: { x: hit.x, y, z: hit.z },
        Clear: !opts.queue,
      })
      return opts.reclaimPropId !== undefined
        ? `Reclaim (${n}) → prop ${opts.reclaimPropId}`
        : `Reclaim (${n}) → map prop #${opts.reclaimMapPropIndex}`
    }
  }
  let moved = 0
  let rallied = 0
  for (const u of selection) {
    if (!u.isMobile) {
      // The immobile part of the selection gets the Move as a FACTORY command
      // (sub_81EB20 split, ISSUE_FactoryCommand Cfile:1241182): the rally
      // point of a FACTORY builder, nothing for any other immobile unit.
      if (u.isFactory) {
        sim.factoryCommand(u.id, { cmd: 'Move', x: hit.x, z: hit.z }, opts.queue)
        rallied++
      }
    } else if (u.canMove) {
      sim.move(u.id, hit.x, hit.z, opts.queue)
      moved++
    }
  }
  if (moved === 0 && rallied === 0) return null

  onCommandIssued(host, {
    // The rally point is a UNITCOMMAND_Move in the factory's command list
    // (Cfile:1008346), so its feedback is a Move blip — 'RallyPoint' is not a
    // valid EUnitCommandType.
    CommandType: 'Move',
    Position: { x: hit.x, y, z: hit.z },
    Clear: !opts.queue,
  })
  const at = `${hit.x.toFixed(0)}, ${hit.z.toFixed(0)}`
  if (moved > 0 && rallied > 0) return `Move (${moved}) + Sammelpunkt (${rallied}) → ${at}`
  if (rallied > 0) return `Sammelpunkt → ${at}`
  return `Move → ${at}`
}

/**
 * Den ausgeführten Befehl an die Lua zurückmelden (commandmode.lua:146). Sie
 * beendet daraufhin den Command-Mode (außer bei gehaltener Shift-Taste) und
 * setzt die Order-Buttons zurück.
 *
 * Das Feld-Layout ist das der Engine: command.CommandType, command.Blueprint,
 * command.Target.Position, command.Clear (commandmode.lua:147-160).
 */
function onCommandIssued(
  host: LuaHost,
  cmd: {
    CommandType: string
    Blueprint?: string
    Position: { x: number; y: number; z: number }
    Clear: boolean
  },
): void {
  const bp = cmd.Blueprint ? `'${cmd.Blueprint}'` : 'nil'
  host.eval(
    `__uiCommandIssued('${cmd.CommandType}', ${bp}, ` +
      `${cmd.Position.x}, ${cmd.Position.y}, ${cmd.Position.z}, ${cmd.Clear})`,
  )
}
