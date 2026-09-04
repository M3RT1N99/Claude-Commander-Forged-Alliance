import * as THREE from 'three'
import { createFeedbackMaterial, SHADER_PARAMS, type BlipAssets } from './commandFeedback'

/**
 * The UI's world meshes (CUIWorldMesh, lua/ui/controls/worldmesh.lua): the
 * rally marker rallypoint.lua hangs on a selected factory's last command
 * (Rally_lod0.scm, technique RallyPoint, UniformScale 0.10, lifetime 10)
 * and the tutorial's camera arrows. The UI VM keeps the objects
 * (ui-globals.lua __uiWorldMeshes); every beat gameUi hands the registry
 * over and this system reconciles it against three.js meshes -- the
 * engine's MeshRenderer draws each mesh instance with its technique.
 *
 * Engine behaviour ported (Cfile + mesh.fx):
 *  - SetMesh creates the mesh instance with the uniform scale, colour and LOD
 *    cutoff of the descriptor (CUIWorldMesh::SetMesh, Cfile:1295906-1296230)
 *  - SetStance places it (position + optional orientation, 1296427-1296500),
 *    SetHidden/SetScale/the parameter setters write the instance
 *  - technique RallyPoint (mesh.fx:4873-4894): CommandFeedbackVS(0.7) --
 *    the mesh scales from 1.0 to 0.7 over material.y = the lifetime
 *    parameter (:1937-1940, t = saturate(age / lifetime)); PS0(false): the
 *    albedo with its own alpha, no fade (:2435-2439); SrcAlpha blend
 *    Write_RGB, cull CW, no depth, alpha test > 0x23. The same material as
 *    the click blips (commandFeedback.ts).
 *  - the distance enlargement of CommandFeedbackVS (lodBasis, mesh.fx:1936)
 *    stays the named gap it is for the blips.
 *  - a shader name outside the feedback family (tutorial.lua:90 'Unit')
 *    falls back to the CommandFeedback parameters -- an approximation, no
 *    retail UI file but the tutorial uses it.
 */

/** One registered mesh with an instance, as ui-globals.lua serialises it. */
export interface WorldMeshRow {
  id: number
  /** Bumped by SetMesh (a new instance): the three.js mesh is rebuilt. */
  serial: number
  meshName: string
  textureName: string
  shaderName: string
  blueprintId: string
  scale: number
  color: string
  lodCutoff: number
  hidden: boolean
  x: number
  y: number
  z: number
  qx: number
  qy: number
  qz: number
  qw: number
  sx: number
  sy: number
  sz: number
  lifetime: number
  aux: number
  fractionComplete: number
  fractionHealth: number
}

interface LiveMesh {
  serial: number
  mesh: THREE.Mesh | null
  material: THREE.MeshBasicMaterial | null
  /** Frame seconds when the instance came to life (material.x). */
  born: number
  baseScale: number
  scaleTo: number
  fade: boolean
  row: WorldMeshRow
  /** Set when the asset load finished after the row disappeared. */
  dead: boolean
}

export class WorldMeshSystem {
  private readonly live = new Map<number, LiveMesh>()

  constructor(
    private readonly addToScene: (obj: THREE.Object3D) => void,
    private readonly loadAssets: (meshPath: string, texPath: string) => Promise<BlipAssets | null>,
    /** BlueprintID branch: LOD0 mesh, albedo and Display.UniformScale of a unit. */
    private readonly resolveBlueprint: (
      blueprintId: string,
    ) => Promise<{ meshPath: string; texPath: string; scale: number } | null>,
    private readonly now: () => number = () => performance.now() / 1000,
  ) {}

  /** Per UI beat: the registry as the UI VM holds it now. */
  sync(rows: WorldMeshRow[]): void {
    const seen = new Set<number>()
    for (const row of rows) {
      seen.add(row.id)
      const cur = this.live.get(row.id)
      if (!cur || cur.serial !== row.serial) {
        if (cur) this.remove(cur)
        this.create(row)
        continue
      }
      cur.row = row
      this.apply(cur)
    }
    for (const [id, cur] of this.live) {
      if (!seen.has(id)) {
        this.remove(cur)
        this.live.delete(id)
      }
    }
  }

  private create(row: WorldMeshRow): void {
    const params = SHADER_PARAMS[row.shaderName] ?? SHADER_PARAMS.CommandFeedback!
    const entry: LiveMesh = {
      serial: row.serial,
      mesh: null,
      material: null,
      born: this.now(),
      baseScale: row.scale,
      scaleTo: params.scaleTo,
      fade: params.fade,
      row,
      dead: false,
    }
    this.live.set(row.id, entry)
    void (async () => {
      let meshPath = row.meshName
      let texPath = row.textureName
      if (!meshPath && row.blueprintId) {
        const bp = await this.resolveBlueprint(row.blueprintId)
        if (!bp) return
        meshPath = bp.meshPath
        texPath = bp.texPath
        entry.baseScale = bp.scale
      }
      if (!meshPath) return
      const assets = await this.loadAssets(meshPath, texPath)
      if (!assets || entry.dead) return
      const material = createFeedbackMaterial(assets.texture)
      const mesh = new THREE.Mesh(assets.geometry, material)
      mesh.renderOrder = 9
      mesh.frustumCulled = false
      entry.mesh = mesh
      entry.material = material
      this.apply(entry)
      this.addToScene(mesh)
    })()
  }

  private apply(entry: LiveMesh): void {
    const m = entry.mesh
    if (!m) return
    const r = entry.row
    m.position.set(r.x, r.y, r.z)
    m.quaternion.set(r.qx, r.qy, r.qz, r.qw)
    m.visible = !r.hidden
  }

  private remove(entry: LiveMesh): void {
    entry.dead = true
    if (entry.mesh) entry.mesh.parent?.remove(entry.mesh)
    entry.material?.dispose()
    entry.mesh = null
    entry.material = null
  }

  /** Per render frame: the lifetime scale animation of the feedback shaders. */
  update(nowSeconds: number): void {
    for (const e of this.live.values()) {
      if (!e.mesh || !e.material) continue
      const r = e.row
      // CommandFeedbackVS: t = saturate((time - material.x) / material.y);
      // a lifetime of 0 divides to +inf and saturates to 1.
      const age = nowSeconds - e.born
      const t = r.lifetime > 0 ? Math.min(age / r.lifetime, 1) : 1
      const s = e.baseScale * (1 + (e.scaleTo - 1) * t)
      e.mesh.scale.set(s * r.sx, s * r.sy, s * r.sz)
      e.material.opacity = e.fade ? 1 - t : 1
    }
  }

  /** How many meshes are alive (CDP probes). */
  count(): number {
    return this.live.size
  }

  dispose(): void {
    for (const e of this.live.values()) this.remove(e)
    this.live.clear()
  }
}
