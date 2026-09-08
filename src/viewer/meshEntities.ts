import * as THREE from 'three'
import SHIELD_VS from './shaders/shield.vert.glsl?raw'
import SHIELD_UEF_FS from './shaders/shieldUEF.frag.glsl?raw'
import SHIELD_CYBRAN_FS from './shaders/shieldCybran.frag.glsl?raw'
import SHIELD_AEON_FS from './shaders/shieldAeon.frag.glsl?raw'
import SHIELD_SERAPHIM_FS from './shaders/shieldSeraphim.frag.glsl?raw'

/**
 * The mesh entities of the sim: every plain Entity the original Lua gives a
 * mesh (Entity:SetMesh) -- the shield domes above all (shield.lua:263-283:
 * the Shield entity carries the dome mesh, its MeshZ the depth shell; both
 * hang on the owner at ShieldSize draw scale). The sim hands one row per
 * live mesh entity over per beat (props.lua __readMeshEntitiesJson); this
 * system reconciles them against three.js meshes and drives the shader
 * clocks -- what the engine's mesh renderer does for every
 * mVarDat.mMesh.
 *
 * The techniques (mesh.fx), each ported 1:1 into shaders/shield*.glsl:
 *   ShieldFill     (:6160-6178)  FlatVS + ShieldFillPS: alpha blend off,
 *                                write NONE, depth enabled -- a depth-only
 *                                shell drawn before the dome (SortOrder 999
 *                                vs 1000) so the dome's far half fails the
 *                                LessEqual test and only one layer shows.
 *   ShieldUEF      (:5965-5984)  FourUVTexShiftScaleVS(1,3,32,6, 0,0,
 *                                0.0003,0.005, -0.001,-0.005,
 *                                -0.0003,-0.0008) + ShieldPS; SrcAlpha/
 *                                InvSrcAlpha RGBA, cull none, LessEqual,
 *                                no depth write.
 *   ShieldCybran   (:6010-6038)  P0 FourUVTexShiftScaleVS(1,1,2,1, -0.01,0,
 *                                -0.002,0, 0,0.0012, 0.001,-0.0015) +
 *                                ShieldCybranPS(0.17); P1 ShieldPosition-
 *                                NormalOffsetVS(0.01, 1,1,4,1, 0.01,0,
 *                                -0.002,0, 0,0.0012, 0.001,-0.003) +
 *                                ShieldCybranPS(0.17); both cull CW.
 *   ShieldAeon     (:6063-6082)  ShieldNormalVS(1,12,8,3, 0,0, 0,0.032,
 *                                0.012,-0.032, 0,0.0012) + ShieldAeonPS.
 *   ShieldSeraphim (:6108-6130)  ShieldNormalVS(5,1,1,11, -0.00153,-0.0159,
 *                                0,0, 0.003,-0.0045, -0.005,-0.045) +
 *                                ShieldSeraphimPS; SrcAlpha/One, RGB only.
 * The engine picks a technique's fidelity from the "fidelity" option
 * (Cfile:1376670-1376690); the browser draws the highest each technique
 * defines (Med for the four domes -- none has a High variant). The engine's
 * fill-in of missing fidelity slots (CD3DEffect, Cfile:465940-466130) was
 * not decoded. Render stage POSTWATER + POSTEFFECT: after units and effects.
 *
 * Visibility: Entity::UpdateVisibility (Cfile:915171-915235) picks the mode
 * for the focus army's relation to the owner: the owner itself
 * mVizToFocusPlayer, allies mVizToAllies, enemies mVizToEnemies, neutrals
 * mVizToNeutrals; Never hides. Intel would need the recon grid -- this
 * browser has no recon model and draws Intel like Always (docs/STATUS.md).
 */

/** One registered mesh entity, as props.lua serialises it. */
export interface MeshEntityRow {
  id: number
  /** The mesh blueprint's long id, e.g. '/effects/entities/shield01/shield01_mesh'. */
  bp: string
  x: number
  y: number
  z: number
  heading: number
  /** SetDrawScale / SetScale -- uniform. */
  scale: number
  /** Health fraction (PARAM_FRACTIONHEALTH). */
  hp: number
  army: number
  viz: { focus: string; allies: string; enemies: string; neutrals: string }
}

/** Geometry and textures of a mesh blueprint's LOD0, resolved by main.ts. */
export interface MeshEntityAssets {
  geometry: THREE.BufferGeometry
  albedo: THREE.Texture | null
  normals: THREE.Texture | null
  specular: THREE.Texture | null
  secondary: THREE.Texture | null
  shader: string
}

export type ArmyRelation = 'focus' | 'ally' | 'enemy' | 'neutral'

interface Technique {
  shader: 'uef' | 'cybran' | 'aeon' | 'seraphim' | 'fill'
  normalMapped?: boolean
  normalOffset?: number
  texScale: [number, number, number, number]
  texShiftA: [number, number, number, number]
  texShiftB: [number, number, number, number]
  alphaBase?: number
  cull: 'none' | 'cw'
  additive?: boolean
  writeAlpha?: boolean
}

/** The technique passes per ShaderName, in pass order (mesh.fx, see above). */
const TECHNIQUES: Record<string, Technique[]> = {
  ShieldFill: [{ shader: 'fill', texScale: [1, 1, 1, 1], texShiftA: [0, 0, 0, 0], texShiftB: [0, 0, 0, 0], cull: 'cw' }],
  ShieldUEF: [
    {
      shader: 'uef',
      texScale: [1, 3, 32, 6],
      texShiftA: [0, 0, 0.0003, 0.005],
      texShiftB: [-0.001, -0.005, -0.0003, -0.0008],
      cull: 'none',
      writeAlpha: true,
    },
  ],
  ShieldCybran: [
    {
      shader: 'cybran',
      texScale: [1, 1, 2, 1],
      texShiftA: [-0.01, 0, -0.002, 0],
      texShiftB: [0, 0.0012, 0.001, -0.0015],
      alphaBase: 0.17,
      cull: 'cw',
      writeAlpha: true,
    },
    {
      shader: 'cybran',
      normalOffset: 0.01,
      texScale: [1, 1, 4, 1],
      texShiftA: [0.01, 0, -0.002, 0],
      texShiftB: [0, 0.0012, 0.001, -0.003],
      alphaBase: 0.17,
      cull: 'cw',
      writeAlpha: true,
    },
  ],
  ShieldAeon: [
    {
      shader: 'aeon',
      normalMapped: true,
      texScale: [1, 12, 8, 3],
      texShiftA: [0, 0, 0, 0.032],
      texShiftB: [0.012, -0.032, 0, 0.0012],
      cull: 'cw',
      writeAlpha: true,
    },
  ],
  ShieldSeraphim: [
    {
      shader: 'seraphim',
      normalMapped: true,
      texScale: [5, 1, 1, 11],
      texShiftA: [-0.00153, -0.0159, 0, 0],
      texShiftB: [0.003, -0.0045, -0.005, -0.045],
      cull: 'cw',
      additive: true,
    },
  ],
}

/** Render order: after the units (0) and the effects; the fill before the dome (SortOrder 999 / 1000). */
const ORDER_FILL = 30
const ORDER_DOME = 31

// ShieldFillPS (mesh.fx:3309): returns 0; the technique writes no colour.
const FILL_FS = 'void main() { gl_FragColor = vec4(0.0); }'

const FRAGMENT: Record<Exclude<Technique['shader'], 'fill'>, string> = {
  uef: SHIELD_UEF_FS,
  cybran: SHIELD_CYBRAN_FS,
  aeon: SHIELD_AEON_FS,
  seraphim: SHIELD_SERAPHIM_FS,
}

// Rasterizer_Cull_CW is mesh.fx's ordinary back-face cull: the opaque unit
// techniques use the very same state (Unit_HighFidelity :4719,
// Unit_MedFidelity :4739) and show their outer faces, and every one of
// Sphere01's 960 triangles is wound counter-clockwise seen from outside
// (measured: cross(e1, e2) . centroid > 0 for all) -- three.js FrontSide.
// The depth shell therefore holds the near hemisphere, and the dome's far
// half fails its LessEqual test behind it.
const sideOf = (cull: Technique['cull']): THREE.Side => (cull === 'cw' ? THREE.FrontSide : THREE.DoubleSide)

function buildMaterial(
  t: Technique,
  assets: MeshEntityAssets,
  envCube: THREE.Texture | null,
  born: number,
): THREE.Material {
  if (t.shader === 'fill') {
    // FlatVS + ShieldFillPS returns 0 with AlphaBlend_Disable_Write_None and
    // Depth_Enable: nothing but depth is written. The SAME vertex shader as
    // the dome (with no defines, the extra varyings unused): the dome's
    // LessEqual test against this depth needs bit-identical z, and a
    // built-in material's vertex path rounds differently.
    return new THREE.ShaderMaterial({
      vertexShader: SHIELD_VS,
      fragmentShader: FILL_FS,
      uniforms: {
        time: { value: 0 },
        creationTime: { value: 0 },
        texScale: { value: new THREE.Vector4(1, 1, 1, 1) },
        texShiftA: { value: new THREE.Vector4() },
        texShiftB: { value: new THREE.Vector4() },
      },
      colorWrite: false,
      depthWrite: true,
      depthTest: true,
      side: sideOf(t.cull),
    })
  }
  const defines: Record<string, boolean> = {}
  if (t.normalMapped) defines.NORMALMAPPED = true
  if (t.normalOffset !== undefined) defines.NORMAL_OFFSET = true
  const black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
  black.needsUpdate = true
  const material = new THREE.ShaderMaterial({
    vertexShader: SHIELD_VS,
    fragmentShader: FRAGMENT[t.shader],
    defines,
    uniforms: {
      time: { value: 0 },
      creationTime: { value: born },
      texScale: { value: new THREE.Vector4(...t.texScale) },
      texShiftA: { value: new THREE.Vector4(...t.texShiftA) },
      texShiftB: { value: new THREE.Vector4(...t.texShiftB) },
      normalOffset: { value: t.normalOffset ?? 0 },
      drawScale: { value: 1 },
      fractionHealth: { value: 1 },
      alphaBase: { value: t.alphaBase ?? 0 },
      albedoMap: { value: assets.albedo ?? black },
      specularMap: { value: assets.specular ?? black },
      secondaryMap: { value: assets.secondary ?? black },
      normalsMap: { value: assets.normals ?? black },
      environmentMap: { value: envCube },
    },
    transparent: true,
    depthTest: true,
    depthWrite: false, // Depth_Enable_LessEqual_Write_None
    depthFunc: THREE.LessEqualDepth,
    side: sideOf(t.cull),
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: t.additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    // Write_RGBA keeps the frame alpha (the glow buffer) in play; Write_RGB
    // leaves it alone -- the frame alpha is unused here either way.
    blendSrcAlpha: t.writeAlpha ? THREE.SrcAlphaFactor : THREE.ZeroFactor,
    blendDstAlpha: t.writeAlpha ? (t.additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor) : THREE.OneFactor,
  })
  return material
}

interface LiveEntity {
  row: MeshEntityRow
  bp: string
  meshes: THREE.Mesh[]
  materials: THREE.Material[]
  born: number
  dead: boolean
  assets?: MeshEntityAssets
}

export class MeshEntitySystem {
  private readonly live = new Map<number, LiveEntity>()
  private readonly unknownLogged = new Set<string>()

  constructor(
    private readonly addToScene: (obj: THREE.Object3D) => void,
    private readonly removeFromScene: (obj: THREE.Object3D) => void,
    /** LOD0 geometry, textures and ShaderName of a mesh blueprint (cached by main). */
    private readonly loadAssets: (bp: string) => Promise<MeshEntityAssets | null>,
    private readonly envCube: () => THREE.Texture | null,
    private readonly relationTo: (army: number) => ArmyRelation,
    private readonly log: (msg: string) => void,
    /** mesh.fx `time`: game ticks + the frame's beat fraction (main.ts meshShaderTime). */
    private readonly now: () => number,
  ) {}

  /** Per sim beat: the registry as the sim holds it now. */
  sync(rows: MeshEntityRow[]): void {
    const seen = new Set<number>()
    for (const row of rows) {
      seen.add(row.id)
      const cur = this.live.get(row.id)
      if (!cur || cur.bp !== row.bp) {
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

  private create(row: MeshEntityRow): void {
    // material.x: the game tick the mesh instance was created on
    // (MeshInstance ctor, Cfile:1193097 / :1191960) -- the whole tick.
    const entry: LiveEntity = { row, bp: row.bp, meshes: [], materials: [], born: Math.floor(this.now()), dead: false }
    this.live.set(row.id, entry)
    void (async () => {
      const assets = await this.loadAssets(row.bp)
      if (!assets || entry.dead) return
      entry.assets = assets
      const passes = TECHNIQUES[assets.shader]
      if (!passes) {
        if (!this.unknownLogged.has(assets.shader)) {
          this.unknownLogged.add(assets.shader)
          this.log(`mesh entity ${row.bp}: no port of technique '${assets.shader}' -- not drawn`)
        }
        return
      }
      passes.forEach((t, i) => {
        const material = buildMaterial(t, assets, this.envCube(), entry.born)
        const mesh = new THREE.Mesh(assets.geometry, material)
        mesh.frustumCulled = false
        mesh.renderOrder = (t.shader === 'fill' ? ORDER_FILL : ORDER_DOME) + i
        entry.meshes.push(mesh)
        entry.materials.push(material)
        this.addToScene(mesh)
      })
      this.apply(entry)
    })()
  }

  private apply(entry: LiveEntity): void {
    const r = entry.row
    const relation = this.relationTo(r.army)
    const mode =
      relation === 'focus' ? r.viz.focus : relation === 'ally' ? r.viz.allies : relation === 'enemy' ? r.viz.enemies : r.viz.neutrals
    const visible = mode !== 'Never'
    for (const m of entry.meshes) {
      m.position.set(r.x, r.y, r.z)
      m.rotation.set(0, r.heading, 0)
      m.scale.setScalar(r.scale)
      m.visible = visible
    }
    for (const mat of entry.materials) {
      const u = (mat as THREE.ShaderMaterial).uniforms
      if (!u) continue
      if (u.fractionHealth) u.fractionHealth.value = r.hp
      if (u.drawScale) u.drawScale.value = r.scale
    }
  }

  private remove(entry: LiveEntity): void {
    entry.dead = true
    for (const m of entry.meshes) this.removeFromScene(m)
    for (const mat of entry.materials) mat.dispose()
    entry.meshes.length = 0
    entry.materials.length = 0
  }

  /**
   * Diagnostic view of every live entity (the DEV bridge): which textures
   * resolved, what the scene meshes carry. Not a game concept.
   */
  debug(): unknown[] {
    return [...this.live.values()].map((e) => ({
      id: e.row.id,
      bp: e.bp,
      shader: e.assets?.shader ?? null,
      textures: e.assets
        ? { albedo: !!e.assets.albedo, normals: !!e.assets.normals, specular: !!e.assets.specular, secondary: !!e.assets.secondary }
        : null,
      meshes: e.meshes.map((m) => ({
        visible: m.visible,
        renderOrder: m.renderOrder,
        scale: m.scale.x,
        pos: [m.position.x, m.position.y, m.position.z],
        side: (m.material as THREE.Material).side,
        inScene: !!m.parent,
      })),
    }))
  }

  /** The live scene meshes (the DEV bridge, for in-page experiments). */
  objects(): THREE.Mesh[] {
    return [...this.live.values()].flatMap((e) => e.meshes)
  }

  /**
   * Per render frame: the shader clock -- mesh.fx `time` in game TICKS plus
   * the frame's beat fraction, modulo 36000 (MeshRenderer::ConfigureShader
   * Cfile:1194898-1194903; the texture shifts and pulses of the shield
   * shaders count in it, `sin(frac(0.01 * time) * 3.14)` is a 100-tick pulse).
   */
  update(time: number): void {
    for (const e of this.live.values()) {
      for (const mat of e.materials) {
        const u = (mat as THREE.ShaderMaterial).uniforms
        if (u?.time) u.time.value = time
      }
    }
  }

  /** How many mesh entities are alive (CDP probes). */
  count(): number {
    return this.live.size
  }

  /** How many have their meshes in the scene (assets loaded). */
  drawn(): number {
    let n = 0
    for (const e of this.live.values()) if (e.meshes.length > 0) n++
    return n
  }

  dispose(): void {
    for (const e of this.live.values()) this.remove(e)
    this.live.clear()
  }
}
