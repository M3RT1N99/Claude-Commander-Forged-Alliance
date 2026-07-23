import type { LuaHost } from '../lua/host'

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
  /**
   * Der SAMMELPUNKT einer Fabrik (IssueFactoryRallyPoint, Cfile:1008266). Er ist
   * kein Bewegungsbefehl: die Fabrik bleibt stehen, nur ihre frischen Einheiten
   * fahren dorthin (defaultunits.lua:578 CalculateRollOffPoint).
   */
  setRallyPoint(id: number, x: number, y: number, z: number): void
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
  /** Kategorie FACTORY — sie bekommt einen Sammelpunkt statt eines Move-Befehls. */
  isFactory: boolean
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
 */
export function snapToGrid(
  x: number,
  z: number,
  sizeX: number,
  sizeZ: number,
  elevation: (x: number, z: number) => number,
): { x: number; y: number; z: number } {
  const cellX = Math.trunc(x - sizeX / 2)
  const cellZ = Math.trunc(z - sizeZ / 2)
  const worldX = cellX + sizeX / 2
  const worldZ = cellZ + sizeZ / 2
  return { x: worldX, y: elevation(worldX, worldZ), z: worldZ }
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
      if (opts.enemyTargetId === undefined) sim.attackGround(u.id, hit.x, hit.z, opts.queue)
      else sim.attack(u.id, opts.enemyTargetId, opts.queue)
      n++
    }
    onCommandIssued(host, {
      CommandType: 'Attack',
      Position: { x: hit.x, y: elevation(hit.x, hit.z), z: hit.z },
      Clear: !opts.queue,
    })
    return opts.enemyTargetId === undefined
      ? `Attack (${n}) → Boden ${hit.x.toFixed(1)}, ${hit.z.toFixed(1)}`
      : `Attack (${n}) → Unit ${opts.enemyTargetId}`
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
        if (u.id !== target) {
          sim.guard(u.id, target, opts.queue)
          n++
        }
      }
      onCommandIssued(host, {
        CommandType: 'Guard',
        Position: { x: hit.x, y: elevation(hit.x, hit.z), z: hit.z },
        Clear: !opts.queue,
      })
      return `Guard (${n}) → Unit ${target}`
    }
    for (const u of selection) sim.move(u.id, hit.x, hit.z, opts.queue)
    onCommandIssued(host, {
      CommandType: 'Guard',
      Position: { x: hit.x, y: elevation(hit.x, hit.z), z: hit.z },
      Clear: !opts.queue,
    })
    return `Guard-Punkt → Move ${hit.x.toFixed(0)}, ${hit.z.toFixed(0)}`
  }

  if (cm.mode === 'build' || cm.mode === 'buildanchored') {
    if (!cm.name) return null
    const [sx, sz] = footprintOf(host, cm.name)
    const pos = snapToGrid(hit.x, hit.z, sx, sz, elevation)
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
      sim.attack(u.id, opts.enemyTargetId, opts.queue)
      n++
    }
    onCommandIssued(host, {
      CommandType: 'Attack',
      Position: { x: hit.x, y, z: hit.z },
      Clear: !opts.queue,
    })
    return `Attack (${n}) → Unit ${opts.enemyTargetId}`
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
      if (u.id !== opts.ownTargetId) {
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
  let moved = 0
  let rallied = 0
  for (const u of selection) {
    if (u.canMove) {
      sim.move(u.id, hit.x, hit.z, opts.queue)
      moved++
    } else if (u.isFactory) {
      sim.setRallyPoint(u.id, hit.x, y, hit.z)
      rallied++
    }
  }
  if (moved === 0 && rallied === 0) return null

  onCommandIssued(host, {
    CommandType: moved > 0 ? 'Move' : 'RallyPoint',
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
