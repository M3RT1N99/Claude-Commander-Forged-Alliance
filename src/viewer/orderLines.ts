import * as THREE from 'three'

/**
 * Order lines + waypoint markers of the command graph (Moho::UICommandGraph;
 * every texture, color and rate below comes from
 * lua/ui/game/commandgraphparams.lua — the file the engine itself loads via
 * LoadPathParams, Cfile:1244312).
 *
 * Drawn for SELECTED units with an active order, using the *_selected_color
 * of the order type. One line quad (flat on the terrain) from unit to
 * target, the waypoint sprite on the target, the arrowhead at the line's
 * end (arrowhead_cap_offset −0.1).
 *
 * Two named approximations (the exact values are constants inside the
 * engine's line renderer, not in the params file): line width 0.3 world
 * meters, waypoint quad size 1.6 world meters.
 */

export interface OrderLineEntry {
  unitId: number
  type: 'Move' | 'Attack' | 'Repair' | 'BuildMobile'
  from: { x: number; y: number; z: number }
  to: { x: number; y: number; z: number }
}

/** commandgraphparams.lua — selected colors (ARGB) per order type. */
const PARAMS: Record<
  OrderLineEntry['type'],
  { color: number; alpha: number; waypoint: string }
> = {
  // UNITCOMMAND_Move (:74-78): default_MoveColors selected 'dd00ffff'
  Move: { color: 0x00ffff, alpha: 0xdd / 255, waypoint: 'move_btn_up' },
  // UNITCOMMAND_Attack (:43-47): default_AttackColors selected 'ddff0000'
  Attack: { color: 0xff0000, alpha: 0xdd / 255, waypoint: 'attack_btn_up' },
  // UNITCOMMAND_BuildMobile (:140-144): engineering selected 'ddffff00',
  // waypoint repair_btn_up.dds — Repair shares it.
  BuildMobile: { color: 0xffff00, alpha: 0xdd / 255, waypoint: 'repair_btn_up' },
  Repair: { color: 0xffff00, alpha: 0xdd / 255, waypoint: 'repair_btn_up' },
}

const LINE_WIDTH = 0.3 // approximation (renderer constant not recovered)
const WAYPOINT_SIZE = 1.6 // approximation
const ARROW_SIZE = 1.0 // approximation
const ARROWHEAD_CAP_OFFSET = -0.1 // commandgraphparams.lua:33
const Y_LIFT = 0.15 // keep the flat quads above the terrain

interface DrawnOrder {
  group: THREE.Group
  line: THREE.Mesh
  waypoint: THREE.Mesh
  arrow: THREE.Mesh
  type: OrderLineEntry['type']
}

export class OrderLineSystem {
  private readonly drawn = new Map<number, DrawnOrder>()
  private lineTex: THREE.Texture | null = null
  private arrowTex: THREE.Texture | null = null
  private readonly waypointTex = new Map<string, THREE.Texture>()

  constructor(private readonly addToScene: (obj: THREE.Object3D) => void) {}

  /**
   * The original textures: orderline_generic.dds / orderline_arrow04.dds and
   * the waypoint buttons (commandgraphparams.lua:16/46/76/142).
   */
  setTextures(
    line: THREE.Texture | null,
    arrow: THREE.Texture | null,
    waypoints: Map<string, THREE.Texture>,
  ): void {
    if (line) line.wrapS = line.wrapT = THREE.RepeatWrapping
    this.lineTex = line
    this.arrowTex = arrow
    for (const [k, v] of waypoints) this.waypointTex.set(k, v)
  }

  /** Redraw the graph for the currently selected units' orders. */
  update(entries: OrderLineEntry[]): void {
    const seen = new Set<number>()
    for (const e of entries) {
      seen.add(e.unitId)
      let d = this.drawn.get(e.unitId)
      if (d && d.type !== e.type) {
        this.remove(e.unitId)
        d = undefined
      }
      if (!d) {
        d = this.create(e.type)
        this.drawn.set(e.unitId, d)
      }
      this.layout(d, e)
    }
    for (const id of [...this.drawn.keys()]) {
      if (!seen.has(id)) this.remove(id)
    }
  }

  dispose(): void {
    for (const id of [...this.drawn.keys()]) this.remove(id)
  }

  private create(type: OrderLineEntry['type']): DrawnOrder {
    const p = PARAMS[type]
    const group = new THREE.Group()

    const lineMat = new THREE.MeshBasicMaterial({
      map: this.lineTex ?? undefined,
      color: p.color,
      transparent: true,
      opacity: p.alpha,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const line = new THREE.Mesh(new THREE.PlaneGeometry(1, LINE_WIDTH), lineMat)
    line.rotation.x = -Math.PI / 2
    group.add(line)

    const wpTex = this.waypointTex.get(p.waypoint) ?? null
    const waypoint = new THREE.Mesh(
      new THREE.PlaneGeometry(WAYPOINT_SIZE, WAYPOINT_SIZE),
      new THREE.MeshBasicMaterial({
        map: wpTex ?? undefined,
        color: wpTex ? 0xffffff : p.color,
        transparent: true,
        opacity: 0x88 / 255, // waypoint_selected_color '88ffffff' (:27)
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    waypoint.rotation.x = -Math.PI / 2
    group.add(waypoint)

    const arrow = new THREE.Mesh(
      new THREE.PlaneGeometry(ARROW_SIZE, ARROW_SIZE),
      new THREE.MeshBasicMaterial({
        map: this.arrowTex ?? undefined,
        color: p.color,
        transparent: true,
        opacity: p.alpha,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    arrow.rotation.x = -Math.PI / 2
    group.add(arrow)

    group.renderOrder = 5
    this.addToScene(group)
    return { group, line, waypoint, arrow, type }
  }

  private layout(d: DrawnOrder, e: OrderLineEntry): void {
    const dx = e.to.x - e.from.x
    const dz = e.to.z - e.from.z
    const len = Math.hypot(dx, dz)
    const angle = Math.atan2(dz, dx)

    d.line.position.set((e.from.x + e.to.x) / 2, (e.from.y + e.to.y) / 2 + Y_LIFT, (e.from.z + e.to.z) / 2)
    d.line.rotation.z = -angle
    d.line.scale.set(Math.max(len, 0.001), 1, 1)
    const mat = d.line.material as THREE.MeshBasicMaterial
    if (mat.map) mat.map.repeat.set(len, 1) // orderline_uv_aspect_ratio 1.0 (:17)

    d.waypoint.position.set(e.to.x, e.to.y + Y_LIFT, e.to.z)

    // Arrowhead sits at the line end, pulled back by the cap offset (:33).
    const t = len > 0 ? (len + ARROWHEAD_CAP_OFFSET) / len : 0
    d.arrow.position.set(e.from.x + dx * t, e.to.y + Y_LIFT, e.from.z + dz * t)
    d.arrow.rotation.z = -angle
  }

  private remove(id: number): void {
    const d = this.drawn.get(id)
    if (!d) return
    this.drawn.delete(id)
    d.group.removeFromParent()
    for (const m of [d.line, d.waypoint, d.arrow]) {
      m.geometry.dispose()
      ;(m.material as THREE.Material).dispose()
    }
  }
}
