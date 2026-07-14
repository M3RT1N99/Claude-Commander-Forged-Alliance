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
  move(id: number, x: number, z: number): void
  build(
    builderId: number,
    blueprintId: string,
    pos: { x: number; y: number; z: number },
    army: number,
  ): Promise<number>
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
  opts: { queue: boolean } = { queue: false },
): Promise<string | null> {
  // pull() liefert JSON — eine LEERE Lua-Tabelle wuerde als `{}` in JS ankommen,
  // nicht als `[]`, und `for…of` warf dann "selection is not iterable".
  const selection = host.pull<{ id: number; army: number }[]>('__uiSelectionJson()')
  if (selection.length === 0) return null

  const cm = getCommandMode(host)

  if (cm.mode === 'build' || cm.mode === 'buildanchored') {
    if (!cm.name) return null
    const [sx, sz] = footprintOf(host, cm.name)
    const pos = snapToGrid(hit.x, hit.z, sx, sz, elevation)
    // Nur der erste Bauer der Selektion setzt die Baustelle; die übrigen helfen
    // (Assist) — das kommt, sobald die Sim Assist kennt. Bis dahin baut einer.
    const builder = selection[0]!
    await sim.build(builder.id, cm.name, pos, builder.army)
    onCommandIssued(host, {
      CommandType: 'BuildMobile',
      Blueprint: cm.name,
      Position: pos,
      Clear: !opts.queue,
    })
    return `Bau: ${cm.name} auf ${pos.x.toFixed(1)}, ${pos.z.toFixed(1)}`
  }

  // Ohne Bau-Modus ist der Klick ein Bewegungsbefehl — der Standardbefehl der
  // Weltansicht (RULEUCC_Move), egal ob er über den Move-Button oder direkt kam.
  for (const u of selection) sim.move(u.id, hit.x, hit.z)
  onCommandIssued(host, {
    CommandType: 'Move',
    Position: { x: hit.x, y: elevation(hit.x, hit.z), z: hit.z },
    Clear: !opts.queue,
  })
  return `Move → ${hit.x.toFixed(0)}, ${hit.z.toFixed(0)}`
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
