import * as THREE from 'three'
import type { GameVfs } from '../vfs/vfs'
import type { SimDecal } from '../sim/luaSimClient'
import { ddsToTexture } from './textures'
import type { DecalSceneUniforms } from './mapDecals'
import DECAL_VS from './shaders/decal.vert.glsl?raw'
import DECAL_FS from './shaders/decal.frag.glsl?raw'
import DECAL_NORMALS_FS from './shaders/decalNormals.frag.glsl?raw'
import DECAL_GLOW_FS from './shaders/decalGlow.frag.glsl?raw'
import SPLAT_VS from './shaders/splat.vert.glsl?raw'
import SPLAT_FS from './shaders/splat.frag.glsl?raw'

/**
 * The runtime splats and decals -- CreateSplat / CreateSplatOnBone /
 * CreateDecal -- as the render thread draws them once the beat's sync has
 * handed them over (CDecalManager::AddDecals, Cfile:1305857-1306038):
 *
 * - A SPLAT is a CWldSplat: one flat quad whose four corners are the
 *   heading-rotated extents from the position -- the position is the
 *   footprint's CORNER (ComputeCorner 1335287-1335306; the sim stored the
 *   Lua position minus half the size, CDecal::CDecal 907380-907400, and
 *   the render angle is mRot.y = -yaw, 907392-907395) -- each corner's Y
 *   read from the heightfield (UpdateVertices 1335570-1335625), drawn with
 *   terrain.fx TSplats (:1436-1447; SplatsVS/PS :1372-1434). The engine
 *   packs every splat texture into one atlas and draws the lot in one call
 *   (sub_802830 1219271-1219322); here one batch per texture.
 * - A DECAL is a CWldTerrainDecal like the map's own (the same
 *   tesselation and techniques the static decals use in mapDecals.ts):
 *   Albedo (TDecals), Normals and Alpha Normals (TDecalsNormals /
 *   TDecalsNormalsAlpha -- DecalsNormalsPS ignores its alphablend flag,
 *   :1108-1129), Glow (TDecalsGlow :1286-1298), AlbedoXP (TDecalsXP). The
 *   other types (water masks/albedo/normals, glow mask) are counted, not
 *   drawn.
 * - Alpha = GetLODAlpha (1335082-1335114) x mCurAlpha. mCurAlpha starts at
 *   1; once the tick passes mRemoveTick -- the expiry tick, or 1 after an
 *   explicit Destroy (RemoveDecals 1306039-1306058) -- ProcessRemovals
 *   (1306063-1306135) steps it down per tick, 0.2 for a decal, 0.03 for a
 *   splat, and destroys the object at 0.
 *
 * The per-army visibility flags (CDecalBuffer::CreateHandle
 * 1112277-1112325: allies see a splat, a decal follows line of sight) are
 * not modelled: everything is drawn (docs/STATUS.md).
 */

/** CWldTerrainDecal::sTypeDesc (Cfile:1966195-1966229), by index. */
const DECAL_TYPES = [
  'Undefined',
  'Albedo',
  'Normals',
  'Water Mask',
  'Water Albedo',
  'Water Normals',
  'Glow',
  'Alpha Normals',
  'Glow Mask',
  'AlbedoXP',
]

/** ProcessRemovals' per-tick alpha steps (Cfile:1306087 / 1306111). */
const FADE_STEP_DECAL = 0.2
const FADE_STEP_SPLAT = 0.03
const INITIAL_CAPACITY = 64

interface BatchCommon {
  key: string
  used: number
  free: number[]
}

/**
 * One texture's splats: a growing, non-indexed triangle soup -- six
 * vertices per quad (position/uv/alpha/cutoff). Non-indexed on purpose: a
 * 32-bit index buffer drew nothing in the headless WebGL context while a
 * 16-bit one did, and the SCM meshes of this renderer never needed more
 * than 16 bits; six vertices a quad costs nothing here.
 */
interface SplatBatch extends BatchCommon {
  kind: 'splat'
  mesh: THREE.Mesh
  material: THREE.ShaderMaterial
  capacity: number
  position: Float32Array
  uv: Float32Array
  alpha: Float32Array
  cutoff: Float32Array
}

/** One (type, textures) set of decals: an InstancedMesh with per-instance fade. */
interface DecalBatch extends BatchCommon {
  kind: 'decal'
  mesh: THREE.InstancedMesh
  material: THREE.ShaderMaterial
  capacity: number
  normals: boolean
  alpha: Float32Array
  cutoff: Float32Array
  rot: Float32Array | null
}

interface Live {
  id: number
  splat: boolean
  /** mRemoveTick: the expiry tick, 1 after Destroy, 0 = never. */
  removeTick: number
  alpha: number
  batch: SplatBatch | DecalBatch
  slot: number
}

export interface RuntimeDecalStats {
  alive: number
  splats: number
  decals: number
  batches: number
  skipped: Record<string, number>
  missing: string[]
}

export class RuntimeDecals {
  /** Splats, albedo and glow decals: the frame. */
  readonly group = new THREE.Group()
  /** Normals decals: the screen-space normal buffer. */
  readonly normalsGroup = new THREE.Group()
  private readonly live = new Map<number, Live>()
  private readonly batches = new Map<string, SplatBatch | DecalBatch>()
  private readonly textures = new Map<string, Promise<THREE.Texture | null>>()
  private readonly loaded: THREE.Texture[] = []
  /** Removals that arrived while the record's textures were still loading. */
  private readonly removedEarly = new Set<number>()
  private readonly missing: string[] = []
  private readonly skipped: Record<string, number> = {}
  private readonly dummy: THREE.DataTexture
  private readonly quad: THREE.PlaneGeometry
  private disposed = false

  constructor(
    private readonly u: DecalSceneUniforms,
    private readonly vfs: GameVfs,
    private readonly s3tcSupported: boolean,
    private readonly heightAt: (x: number, z: number) => number,
  ) {
    // Decals render between terrain and props/water, like the map's own.
    this.group.renderOrder = 1
    this.dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
    this.dummy.needsUpdate = true
    // The decal patch: the same terrain re-rasterisation as mapDecals.ts.
    this.quad = new THREE.PlaneGeometry(1, 1, 16, 16)
    this.quad.rotateX(-Math.PI / 2)
    this.quad.translate(0.5, 0.0, 0.5)
  }

  stats(): RuntimeDecalStats {
    let splats = 0
    for (const l of this.live.values()) if (l.splat) splats++
    return {
      alive: this.live.size,
      splats,
      decals: this.live.size - splats,
      batches: this.batches.size,
      skipped: { ...this.skipped },
      missing: [...this.missing],
    }
  }

  /** A record from the beat's sync (AddDecals). */
  add(d: SimDecal): void {
    if (this.disposed || this.live.has(d.id)) return
    void this.place(d)
  }

  /** CDecalHandle:Destroy -> RemoveDecals: mRemoveTick = 1, the fade starts. */
  remove(id: number): void {
    const l = this.live.get(id)
    if (l) l.removeTick = 1
    else this.removedEarly.add(id)
  }

  /** ProcessRemovals with the beat's tick (Cfile:1306063-1306135). */
  beat(tick: number): void {
    for (const l of [...this.live.values()]) {
      if (l.removeTick <= 0 || tick <= l.removeTick) continue
      const step = l.splat ? FADE_STEP_SPLAT : FADE_STEP_DECAL
      l.alpha = Math.max(0, l.alpha - step)
      this.writeAlpha(l)
      if (l.alpha === 0) this.destroy(l)
    }
  }

  count(): number {
    return this.live.size
  }

  /** The batch meshes (the DEV bridge, for in-page experiments). */
  objects(): THREE.Mesh[] {
    return [...this.batches.values()].map((b) => b.mesh)
  }

  /** Diagnostic view of the batches (the DEV bridge). Not a game concept. */
  debug(): unknown[] {
    return [...this.batches.values()].map((b) => {
      if (b.kind === 'splat') {
        return {
          key: b.key,
          used: b.used,
          free: b.free.length,
          firstCorners: [0, 1, 2, 5].flatMap((k) => Array.from(b.position.subarray(k * 3, k * 3 + 3))).map((v) => Math.round(v * 100) / 100),
          firstAlpha: b.alpha[0],
          firstCutoff: b.cutoff[0],
          inScene: !!b.mesh.parent,
          visible: b.mesh.visible,
        }
      }
      const m = new THREE.Matrix4()
      b.mesh.getMatrixAt(0, m)
      return {
        key: b.key,
        used: b.used,
        free: b.free.length,
        count: b.mesh.count,
        firstPos: m.elements.slice(12, 15).map((v) => Math.round(v * 100) / 100),
        firstAlpha: b.alpha[0],
        firstCutoff: b.cutoff[0],
        inScene: !!b.mesh.parent,
        normals: b.normals,
      }
    })
  }

  dispose(): void {
    this.disposed = true
    for (const b of this.batches.values()) {
      b.mesh.geometry.dispose()
      b.material.dispose()
    }
    for (const t of this.loaded) t.dispose()
    this.loaded.length = 0
    this.textures.clear()
    this.removedEarly.clear()
    this.batches.clear()
    this.live.clear()
    this.group.clear()
    this.normalsGroup.clear()
    this.quad.dispose()
    this.dummy.dispose()
  }

  // ---------------------------------------------------------------------

  private loadTexture(path: string): Promise<THREE.Texture | null> {
    const key = path.replace(/^\//, '').toLowerCase()
    if (!key) return Promise.resolve(null)
    let p = this.textures.get(key)
    if (!p) {
      p = (async () => {
        if (!this.vfs.exists(key)) {
          this.missing.push(key)
          return null
        }
        const t = ddsToTexture(await this.vfs.read(key), this.s3tcSupported)
        // Decal samplers are CLAMP (render-details.md par. 3).
        t.wrapS = THREE.ClampToEdgeWrapping
        t.wrapT = THREE.ClampToEdgeWrapping
        this.loaded.push(t)
        return t
      })()
      this.textures.set(key, p)
    }
    return p
  }

  /**
   * ComputeCutoffLOD (Cfile:1335313-1335329) when the Lua passed no
   * lodParam: the footprint's diagonal times ren_DecalAlbedoLodCutoff
   * (15.0, :421724) for mType == DECALTYPE_Tarmac (the splat's tag,
   * :1364776), 4 (Water Albedo) and 8 (Glow Mask); times
   * ren_DecalNormalLodCutoff (6.0, :421723) for every other type. Every
   * shipped caller passes a lodParam > 0, so the fallback is rarely reached.
   */
  private cutoffFor(d: SimDecal, type: number): number {
    if (d.lod > 0) return d.lod
    const diag = Math.hypot(d.sx, d.sz)
    return diag * (d.splat || type === 4 || type === 8 ? 15.0 : 6.0)
  }

  private async place(d: SimDecal): Promise<void> {
    if (d.splat) {
      const tex = await this.loadTexture(d.tex1)
      if (!tex || this.disposed || this.live.has(d.id)) return
      const batch = this.splatBatch(d.tex1, tex)
      const slot = this.alloc(batch)
      this.writeSplat(batch, slot, d)
      this.live.set(d.id, { id: d.id, splat: true, removeTick: this.initialRemoveTick(d), alpha: 1, batch, slot })
      return
    }
    // LookupDecalType (1334911-1334927): exact match, else "unknown decal
    // type" and index 0 -- Undefined draws nothing.
    let type = DECAL_TYPES.indexOf(d.type)
    if (type < 0) {
      console.warn(`unknown decal type: ${d.type}`)
      type = 0
    }
    const drawable = type === 1 || type === 2 || type === 6 || type === 7 || type === 9
    if (!drawable) {
      const name = DECAL_TYPES[type] ?? String(type)
      this.skipped[name] = (this.skipped[name] ?? 0) + 1
      return
    }
    const [tex1, tex2] = await Promise.all([this.loadTexture(d.tex1), this.loadTexture(d.tex2)])
    if (!tex1 || this.disposed || this.live.has(d.id)) return
    const batch = this.decalBatch(type, d.tex1, d.tex2, tex1, tex2)
    const slot = this.alloc(batch)
    this.writeDecal(batch, slot, d, type)
    this.live.set(d.id, { id: d.id, splat: false, removeTick: this.initialRemoveTick(d), alpha: 1, batch, slot })
  }

  /**
   * mRemoveTick at placement: the expiry tick -- or 1 when the handle was
   * destroyed while the textures were still loading (the engine's object
   * exists from the sync on; its removal would have found it).
   */
  private initialRemoveTick(d: SimDecal): number {
    if (this.removedEarly.delete(d.id)) return 1
    return d.expire
  }

  private alloc(b: SplatBatch | DecalBatch): number {
    const free = b.free.pop()
    if (free !== undefined) return free
    if (b.used >= b.capacity) this.grow(b)
    return b.used++
  }

  // ------------------------------------------------------------- splats

  private splatBatch(path: string, tex: THREE.Texture): SplatBatch {
    const key = `splat|${path.toLowerCase()}`
    const have = this.batches.get(key)
    if (have && have.kind === 'splat') return have
    const u = this.u
    const material = new THREE.ShaderMaterial({
      vertexShader: SPLAT_VS,
      fragmentShader: SPLAT_FS,
      uniforms: {
        ...u.shadow,
        ...u.normalBuffer,
        decalAlbedo: { value: tex },
        heightTex: { value: u.heightTex },
        heightScale: { value: u.heightScale },
        hmUvScale: { value: u.hmUvScale },
        hmUvOffset: { value: u.hmUvOffset },
        hmTexel: { value: u.hmTexel },
        mapSize: { value: u.mapSize },
        waterRamp: { value: u.waterRamp ?? this.dummy },
        hasWater: { value: u.waterRamp ? 1 : 0 },
        waterElevation: { value: u.waterElevation },
        depthToG: { value: u.depthToG },
        sunDirection: { value: u.lighting.sunDirection },
        sunColor: { value: u.lighting.sunColor },
        sunAmbience: { value: u.lighting.sunAmbience },
        shadowFillColor: { value: u.lighting.shadowFillColor },
        specularColor: { value: u.lighting.specularColor },
        lightingMultiplier: { value: u.lighting.lightingMultiplier },
      },
      // TSplats (:1439-1441): SrcAlpha/InvSrcAlpha on RGB (the frame alpha
      // stays), depth LessEqual without write, cull none with a small
      // negative bias (Rasterizer_Cull_None_Bias_Neg001; the D3D DepthBias
      // to polygonOffset mapping is UNVERIFIED, the decal's offset is used).
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.ZeroFactor,
      blendDstAlpha: THREE.OneFactor,
      depthWrite: false,
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })
    const capacity = INITIAL_CAPACITY
    const batch: SplatBatch = {
      kind: 'splat',
      key,
      used: 0,
      free: [],
      capacity,
      position: new Float32Array(capacity * 18),
      uv: new Float32Array(capacity * 12),
      alpha: new Float32Array(capacity * 6),
      cutoff: new Float32Array(capacity * 6),
      material,
      mesh: new THREE.Mesh(new THREE.BufferGeometry(), material),
    }
    batch.mesh.frustumCulled = false
    this.rebuildSplatGeometry(batch)
    this.group.add(batch.mesh)
    this.batches.set(key, batch)
    return batch
  }

  private rebuildSplatGeometry(b: SplatBatch): void {
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.BufferAttribute(b.position, 3))
    g.setAttribute('uv', new THREE.BufferAttribute(b.uv, 2))
    g.setAttribute('alpha', new THREE.BufferAttribute(b.alpha, 1))
    g.setAttribute('cutoff', new THREE.BufferAttribute(b.cutoff, 1))
    b.mesh.geometry.dispose()
    b.mesh.geometry = g
  }

  /**
   * CWldSplat::UpdateVertices (Cfile:1335570-1335625) with ComputeCorner
   * (1335287-1335306): corner (u, v) = position + u * (sx cos a, sx sin a)
   * + v * (-sz sin a, sz cos a) with a = mOrientation.y = -heading
   * (907392-907395), its Y from the heightfield; the UVs (0,0) (1,0) (1,1)
   * (0,1) (UpdateBatchTexture 1335626-1335661). The engine re-reads the
   * heights every frame -- this heightfield does not deform, once is the
   * same.
   */
  private writeSplat(b: SplatBatch, slot: number, d: SimDecal): void {
    const c = Math.cos(-d.heading)
    const s = Math.sin(-d.heading)
    const corners: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ]
    // Two triangles (0 1 2) (0 2 3) as six vertices.
    const order = [0, 1, 2, 0, 2, 3]
    const cutoff = this.cutoffFor(d, 0)
    for (let k = 0; k < 6; k++) {
      const [uu, vv] = corners[order[k]!]!
      const x = d.x + vv * (-d.sz * s) + uu * (d.sx * c)
      const z = d.z + vv * (d.sz * c) + uu * (d.sx * s)
      const v = slot * 6 + k
      b.position[v * 3] = x
      b.position[v * 3 + 1] = this.heightAt(x, z)
      b.position[v * 3 + 2] = z
      b.uv[v * 2] = uu
      b.uv[v * 2 + 1] = vv
      b.alpha[v] = 1
      b.cutoff[v] = cutoff
    }
    this.touch(b.mesh.geometry, ['position', 'uv', 'alpha', 'cutoff'])
  }

  // ------------------------------------------------------------- decals

  private decalBatch(
    type: number,
    path1: string,
    path2: string,
    tex1: THREE.Texture,
    tex2: THREE.Texture | null,
  ): DecalBatch {
    const key = `${type}|${path1.toLowerCase()}|${path2.toLowerCase()}`
    const have = this.batches.get(key)
    if (have && have.kind === 'decal') return have
    const u = this.u
    const normals = type === 2 || type === 7
    const capacity = INITIAL_CAPACITY
    let material: THREE.ShaderMaterial
    if (normals) {
      material = new THREE.ShaderMaterial({
        vertexShader: DECAL_VS,
        fragmentShader: DECAL_NORMALS_FS,
        defines: { NORMALS_DECAL: true, INSTANCED_FADE: true, ...(tex2 ? { HAS_MASK: true } : {}) },
        uniforms: {
          decalNormalTex: { value: tex1 },
          decalMaskTex: { value: tex2 ?? this.dummy },
          heightTex: { value: u.heightTex },
          heightScale: { value: u.heightScale },
          hmUvScale: { value: u.hmUvScale },
          hmUvOffset: { value: u.hmUvOffset },
          mapSize: { value: u.mapSize },
          decalHeightOffset: { value: 0 },
          cutOffLOD: { value: 0 },
        },
        transparent: true,
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
    } else if (type === 6) {
      material = new THREE.ShaderMaterial({
        vertexShader: DECAL_VS,
        fragmentShader: DECAL_GLOW_FS,
        defines: { INSTANCED_FADE: true },
        uniforms: {
          decalAlbedo: { value: tex1 },
          decalMask: { value: tex2 ?? this.dummy },
          heightTex: { value: u.heightTex },
          heightScale: { value: u.heightScale },
          hmUvScale: { value: u.hmUvScale },
          hmUvOffset: { value: u.hmUvOffset },
          mapSize: { value: u.mapSize },
          decalHeightOffset: { value: 0 },
        },
        // TDecalsGlow (:1290): AlphaBlend_One_One_Write_A -- RGB untouched
        // (factors 0 / 1), the alpha added.
        transparent: true,
        blending: THREE.CustomBlending,
        blendSrc: THREE.ZeroFactor,
        blendDst: THREE.OneFactor,
        blendSrcAlpha: THREE.OneFactor,
        blendDstAlpha: THREE.OneFactor,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
    } else {
      const defines: Record<string, boolean> = { INSTANCED_FADE: true }
      if (type === 9 || u.xpShader) defines.XP = true
      if (tex2) defines.HAS_SPEC = true
      material = new THREE.ShaderMaterial({
        vertexShader: DECAL_VS,
        fragmentShader: DECAL_FS,
        defines,
        uniforms: {
          ...u.shadow,
          ...u.normalBuffer,
          decalAlbedo: { value: tex1 },
          decalSpec: { value: tex2 ?? this.dummy },
          heightTex: { value: u.heightTex },
          heightScale: { value: u.heightScale },
          hmUvScale: { value: u.hmUvScale },
          hmUvOffset: { value: u.hmUvOffset },
          hmTexel: { value: u.hmTexel },
          mapSize: { value: u.mapSize },
          decalHeightOffset: { value: 0 },
          waterRamp: { value: u.waterRamp ?? this.dummy },
          hasWater: { value: u.waterRamp ? 1 : 0 },
          waterElevation: { value: u.waterElevation },
          depthToG: { value: u.depthToG },
          sunDirection: { value: u.lighting.sunDirection },
          sunColor: { value: u.lighting.sunColor },
          sunAmbience: { value: u.lighting.sunAmbience },
          shadowFillColor: { value: u.lighting.shadowFillColor },
          specularColor: { value: u.lighting.specularColor },
          lightingMultiplier: { value: u.lighting.lightingMultiplier },
          cutOffLOD: { value: 0 },
        },
        transparent: true,
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      })
    }
    const batch: DecalBatch = {
      kind: 'decal',
      key,
      used: 0,
      free: [],
      capacity,
      normals,
      material,
      alpha: new Float32Array(capacity),
      cutoff: new Float32Array(capacity),
      rot: normals ? new Float32Array(capacity * 2) : null,
      mesh: new THREE.InstancedMesh(this.quad, material, capacity),
    }
    this.attachInstanceAttributes(batch)
    batch.mesh.count = 0
    batch.mesh.frustumCulled = false
    ;(normals ? this.normalsGroup : this.group).add(batch.mesh)
    this.batches.set(key, batch)
    return batch
  }

  private attachInstanceAttributes(b: DecalBatch): void {
    // The instanced attributes live on a clone of the shared patch: one
    // geometry per batch, the vertex data shared.
    const geo = this.quad.clone()
    geo.setAttribute('instAlpha', new THREE.InstancedBufferAttribute(b.alpha, 1))
    geo.setAttribute('instCutoff', new THREE.InstancedBufferAttribute(b.cutoff, 1))
    if (b.rot) geo.setAttribute('instRot', new THREE.InstancedBufferAttribute(b.rot, 2))
    b.mesh.geometry = geo
  }

  private writeDecal(b: DecalBatch, slot: number, d: SimDecal, type: number): void {
    // Decal space -> world: T(corner) * RY(heading) * S(sx, 1, sz) -- the
    // quad point (u, v) lands on corner + u * sx * (cos h, -sin h) + v * sz
    // * (sin h, cos h), the footprint ComputeCorner spans with its angle
    // -heading (three.js RY(h) maps x to (cos h x + sin h z, -sin h x +
    // cos h z)).
    const m = new THREE.Matrix4()
    const step = new THREE.Matrix4()
    m.makeTranslation(d.x, d.y, d.z)
    m.multiply(step.makeRotationY(d.heading))
    m.multiply(step.makeScale(d.sx, 1, d.sz))
    b.mesh.setMatrixAt(slot, m)
    b.mesh.instanceMatrix.needsUpdate = true
    b.alpha[slot] = 1
    b.cutoff[slot] = this.cutoffFor(d, type)
    if (b.rot) {
      // The same rotation the instance matrix applies (decalNormals.frag
      // rotates the tangent normal with x' = c x + s z, z' = -s x + c z).
      b.rot[slot * 2] = Math.cos(d.heading)
      b.rot[slot * 2 + 1] = Math.sin(d.heading)
    }
    if (slot >= b.mesh.count) b.mesh.count = slot + 1
    this.touch(b.mesh.geometry, ['instAlpha', 'instCutoff', 'instRot'])
  }

  // ------------------------------------------------------------- shared

  private writeAlpha(l: Live): void {
    const b = l.batch
    if (b.kind === 'splat') {
      for (let i = 0; i < 6; i++) b.alpha[l.slot * 6 + i] = l.alpha
      this.touch(b.mesh.geometry, ['alpha'])
    } else {
      b.alpha[l.slot] = l.alpha
      this.touch(b.mesh.geometry, ['instAlpha'])
    }
  }

  private destroy(l: Live): void {
    const b = l.batch
    if (b.kind === 'splat') {
      // Degenerate triangles: every vertex on the origin.
      for (let i = 0; i < 6; i++) {
        const p = (l.slot * 6 + i) * 3
        b.position[p] = 0
        b.position[p + 1] = 0
        b.position[p + 2] = 0
        b.alpha[l.slot * 6 + i] = 0
      }
      this.touch(b.mesh.geometry, ['position', 'alpha'])
    } else {
      b.alpha[l.slot] = 0
      b.mesh.setMatrixAt(l.slot, new THREE.Matrix4().makeScale(0, 0, 0))
      b.mesh.instanceMatrix.needsUpdate = true
      this.touch(b.mesh.geometry, ['instAlpha'])
    }
    b.free.push(l.slot)
    this.live.delete(l.id)
  }

  private grow(b: SplatBatch | DecalBatch): void {
    const capacity = b.capacity * 2
    if (b.kind === 'splat') {
      const copy = (a: Float32Array, per: number): Float32Array => {
        const n = new Float32Array(capacity * per)
        n.set(a)
        return n
      }
      b.position = copy(b.position, 18)
      b.uv = copy(b.uv, 12)
      b.alpha = copy(b.alpha, 6)
      b.cutoff = copy(b.cutoff, 6)
      b.capacity = capacity
      this.rebuildSplatGeometry(b)
      return
    }
    const alpha = new Float32Array(capacity)
    alpha.set(b.alpha)
    const cutoff = new Float32Array(capacity)
    cutoff.set(b.cutoff)
    let rot: Float32Array | null = null
    if (b.rot) {
      rot = new Float32Array(capacity * 2)
      rot.set(b.rot)
    }
    const mesh = new THREE.InstancedMesh(this.quad, b.material, capacity)
    for (let i = 0; i < b.capacity; i++) {
      const m = new THREE.Matrix4()
      b.mesh.getMatrixAt(i, m)
      mesh.setMatrixAt(i, m)
    }
    mesh.count = b.mesh.count
    mesh.frustumCulled = false
    const parent = b.mesh.parent
    parent?.remove(b.mesh)
    b.mesh.geometry.dispose()
    b.mesh = mesh
    b.alpha = alpha
    b.cutoff = cutoff
    b.rot = rot
    b.capacity = capacity
    this.attachInstanceAttributes(b)
    mesh.instanceMatrix.needsUpdate = true
    parent?.add(mesh)
  }

  private touch(geometry: THREE.BufferGeometry, names: string[]): void {
    for (const n of names) {
      const a = geometry.getAttribute(n)
      if (a) a.needsUpdate = true
    }
  }
}
