import * as THREE from 'three'
import type { ScmapDecal } from '../formats/scmap'
import type { GameVfs } from '../vfs/vfs'
import { ddsToTexture } from './textures'
import DECAL_VS from './shaders/decal.vert.glsl?raw'
import DECAL_FS from './shaders/decal.frag.glsl?raw'
import DECAL_NORMALS_FS from './shaders/decalNormals.frag.glsl?raw'
import type { ShadowUniforms } from './shadow'
import type { NormalBufferUniforms } from './terrainNormals'

/**
 * Map decals — render-details.md par. 3. The original re-rasterizes the
 * terrain grid inside each decal's bounds and projects it with DecalMatrix
 * (CWldTerrainDecal.cpp:797-835, row-vector convention):
 *
 *   M = translate(-position) * RotY(rot.y) * RotX(rot.x) * RotZ(rot.z),
 *   columns divided by scale; UV = (local.x, local.z), origin = CORNER.
 *
 * Here every decal is an instance of one subdivided unit quad; the
 * instance matrix is M^-1 (decal space -> world), so the quad parameter is
 * the decal UV and the vertex shader lifts the patch onto the heightmap.
 * One InstancedMesh per texture set keeps the draw calls low (SCMP_009:
 * 1233 albedo decals over ~40 textures).
 *
 * Albedo decals (type 1, `group`) render into the frame (TDecals);
 * normals decals (type 2, `normalsGroup`) render into the screen-space
 * normal buffer (TDecalsNormals, DecalsNormalsPS :1108) — the viewer adds
 * that group to the TerrainNormalsPass scene, not the main scene.
 */
export interface MapDecalsStats {
  instances: number
  textures: number
  /** Type-2 instances rendered into the normal buffer. */
  normalInstances: number
  skippedTypes: Map<number, number>
  missing: string[]
}

/** Shared terrain uniforms the decal shader needs (from setMap). */
export interface DecalSceneUniforms {
  heightTex: THREE.Texture
  heightScale: number
  hmUvScale: THREE.Vector2
  hmUvOffset: THREE.Vector2
  hmTexel: THREE.Vector2
  mapSize: THREE.Vector2
  waterRamp: THREE.Texture | null
  waterElevation: number
  depthToG: number
  xpShader: boolean
  /** Shared shadow uniforms (ShadowRenderer.uniforms). */
  shadow: ShadowUniforms
  /** Shared screen-space normal buffer uniforms (TerrainNormalsPass). */
  normalBuffer: NormalBufferUniforms
  lighting: {
    sunDirection: THREE.Vector3
    sunColor: THREE.Color
    sunAmbience: THREE.Color
    shadowFillColor: THREE.Color
    specularColor: THREE.Vector4
    lightingMultiplier: number
  }
}

export class MapDecals {
  readonly group = new THREE.Group()
  /** Type-2 patches — rendered into the normal buffer, not the frame. */
  readonly normalsGroup = new THREE.Group()
  readonly stats: MapDecalsStats = {
    instances: 0,
    textures: 0,
    normalInstances: 0,
    skippedTypes: new Map(),
    missing: [],
  }
  private readonly disposables: { dispose(): void }[] = []

  static async load(
    decals: ScmapDecal[],
    vfs: GameVfs,
    u: DecalSceneUniforms,
    s3tcSupported: boolean,
  ): Promise<MapDecals> {
    const out = new MapDecals()
    // Decals render between terrain and props/water.
    out.group.renderOrder = 1

    // Group by (texture pair, type) — one InstancedMesh per group.
    // Type 1 = albedo (TDecals), type 2 = normals (TDecalsNormals); the
    // other types (water masks/glow) stay counted as skipped.
    const groups = new Map<
      string,
      { type: number; albedo: string; spec: string; items: ScmapDecal[] }
    >()
    for (const d of decals) {
      if (d.type !== 1 && d.type !== 2) {
        out.stats.skippedTypes.set(d.type, (out.stats.skippedTypes.get(d.type) ?? 0) + 1)
        continue
      }
      const albedo = (d.textures[0] ?? '').replace(/^\//, '').toLowerCase()
      if (!albedo) continue
      const spec = (d.textures[1] ?? '').replace(/^\//, '').toLowerCase()
      const key = `${d.type}|${albedo}|${spec}`
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { type: d.type, albedo, spec, items: [] }))
      g.items.push(d)
    }
    if (groups.size === 0) return out

    // Terrain re-rasterization: 16x16 segments follow the height closely
    // enough for the largest decals (~77 m) at 1 m grid resolution.
    const quad = new THREE.PlaneGeometry(1, 1, 16, 16)
    quad.rotateX(-Math.PI / 2)
    quad.translate(0.5, 0.0, 0.5)
    out.disposables.push(quad)

    const texCache = new Map<string, THREE.Texture | null>()
    const loadTex = async (p: string): Promise<THREE.Texture | null> => {
      if (!p) return null
      if (!texCache.has(p)) {
        if (!vfs.exists(p)) {
          texCache.set(p, null)
          out.stats.missing.push(p)
        } else {
          const t = ddsToTexture(await vfs.read(p), s3tcSupported)
          // Decal samplers are CLAMP (render-details.md par. 3).
          t.wrapS = THREE.ClampToEdgeWrapping
          t.wrapT = THREE.ClampToEdgeWrapping
          texCache.set(p, t)
          out.disposables.push(t)
        }
      }
      return texCache.get(p) ?? null
    }

    const dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
    dummy.needsUpdate = true
    out.disposables.push(dummy)

    const m = new THREE.Matrix4()
    const step = new THREE.Matrix4()

    for (const g of groups.values()) {
      const albedoTex = await loadTex(g.albedo)
      if (!albedoTex) continue
      const specTex = await loadTex(g.spec)

      // cutOffLOD is near-constant per texture set; use the maximum so no
      // decal of the group disappears early.
      const cutOff = Math.max(...g.items.map((d) => d.cutOffLOD))

      if (g.type === 2) {
        // Normals decal (DecalsNormalsPS :1108, TDecalsNormals :1335):
        // texture 1 is the DXT5nm normal map, texture 2 the optional mask.
        // The patch renders into the normal buffer with SrcAlpha blending
        // on RG (colorWrite masks handled by writing 0 alpha-side factors).
        const material = new THREE.ShaderMaterial({
          vertexShader: DECAL_VS,
          fragmentShader: DECAL_NORMALS_FS,
          defines: { NORMALS_DECAL: true, ...(specTex ? { HAS_MASK: true } : {}) },
          uniforms: {
            decalNormalTex: { value: albedoTex },
            decalMaskTex: { value: specTex ?? dummy },
            heightTex: { value: u.heightTex },
            heightScale: { value: u.heightScale },
            hmUvScale: { value: u.hmUvScale },
            hmUvOffset: { value: u.hmUvOffset },
            mapSize: { value: u.mapSize },
            decalHeightOffset: { value: 0 },
            cutOffLOD: { value: cutOff },
          },
          // AlphaBlend_SrcAlpha_InvSrcAlpha_Write_RG: B/A of the buffer
          // stay untouched via zero alpha-blend factors; B is unused.
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
        // Per-instance Y rotation for the tangent->world rotation
        // (TangentMatrix): same angle the instance matrix uses (RY(-rot.y)).
        const geo = quad.clone()
        const rot = new Float32Array(g.items.length * 2)
        for (let i = 0; i < g.items.length; i++) {
          const a = -g.items[i]!.rotation[1]
          rot[i * 2] = Math.cos(a)
          rot[i * 2 + 1] = Math.sin(a)
        }
        geo.setAttribute('instRot', new THREE.InstancedBufferAttribute(rot, 2))
        out.disposables.push(geo)

        const mesh = new THREE.InstancedMesh(geo, material, g.items.length)
        for (let i = 0; i < g.items.length; i++) {
          const d = g.items[i]!
          m.makeTranslation(d.position[0], d.position[1], d.position[2])
          m.multiply(step.makeRotationY(-d.rotation[1]))
          m.multiply(step.makeRotationX(-d.rotation[0]))
          m.multiply(step.makeRotationZ(-d.rotation[2]))
          m.multiply(step.makeScale(d.scale[0], 1, d.scale[2]))
          mesh.setMatrixAt(i, m)
        }
        mesh.instanceMatrix.needsUpdate = true
        mesh.frustumCulled = false
        out.normalsGroup.add(mesh)
        out.disposables.push(material)
        out.stats.normalInstances += g.items.length
        continue
      }

      const defines: Record<string, boolean> = {}
      if (u.xpShader) defines.XP = true
      if (specTex) defines.HAS_SPEC = true

      const material = new THREE.ShaderMaterial({
        vertexShader: DECAL_VS,
        fragmentShader: DECAL_FS,
        defines,
        uniforms: {
          ...u.shadow,
          ...u.normalBuffer,
          decalAlbedo: { value: albedoTex },
          decalSpec: { value: specTex ?? dummy },
          heightTex: { value: u.heightTex },
          heightScale: { value: u.heightScale },
          hmUvScale: { value: u.hmUvScale },
          hmUvOffset: { value: u.hmUvOffset },
          hmTexel: { value: u.hmTexel },
          mapSize: { value: u.mapSize },
          decalHeightOffset: { value: 0 }, // terrain.fx:987 default
          waterRamp: { value: u.waterRamp ?? dummy },
          hasWater: { value: u.waterRamp ? 1 : 0 },
          waterElevation: { value: u.waterElevation },
          depthToG: { value: u.depthToG },
          sunDirection: { value: u.lighting.sunDirection },
          sunColor: { value: u.lighting.sunColor },
          sunAmbience: { value: u.lighting.sunAmbience },
          shadowFillColor: { value: u.lighting.shadowFillColor },
          specularColor: { value: u.lighting.specularColor },
          lightingMultiplier: { value: u.lighting.lightingMultiplier },
          cutOffLOD: { value: cutOff },
        },
        // technique TDecals (:1249-1251): SrcAlpha/InvSrcAlpha, depth test
        // LessEqual without write, decal bias — RGB only, the frame alpha
        // (glow buffer) stays untouched.
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

      const mesh = new THREE.InstancedMesh(quad, material, g.items.length)
      for (let i = 0; i < g.items.length; i++) {
        const d = g.items[i]!
        // Inverse DecalMatrix (decal space -> world): the row-vector chain
        // T(-pos)*RY*RX*RZ*S^-1 transposes/inverts into column-vector
        // T(pos)*RY(-y)*RX(-x)*RZ(-z)*S.
        m.makeTranslation(d.position[0], d.position[1], d.position[2])
        m.multiply(step.makeRotationY(-d.rotation[1]))
        m.multiply(step.makeRotationX(-d.rotation[0]))
        m.multiply(step.makeRotationZ(-d.rotation[2]))
        m.multiply(step.makeScale(d.scale[0], 1, d.scale[2]))
        mesh.setMatrixAt(i, m)
      }
      mesh.instanceMatrix.needsUpdate = true
      mesh.frustumCulled = false
      out.group.add(mesh)
      out.disposables.push(material)
      out.stats.textures++
      out.stats.instances += g.items.length
    }

    if (out.stats.missing.length > 0) {
      console.warn(
        `map decals: ${out.stats.missing.length} texture(s) missing: ` +
          out.stats.missing.slice(0, 5).join(', '),
      )
    }
    return out
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
    this.disposables.length = 0
    this.group.clear()
    this.normalsGroup.clear()
  }
}
