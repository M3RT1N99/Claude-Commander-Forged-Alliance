import * as THREE from 'three'
import type { ScmapDecal } from '../formats/scmap'
import type { GameVfs } from '../vfs/vfs'
import { ddsToTexture } from './textures'
import DECAL_VS from './shaders/decal.vert.glsl?raw'
import DECAL_FS from './shaders/decal.frag.glsl?raw'

/**
 * Map albedo decals (type 1) — render-details.md par. 3. The original
 * re-rasterizes the terrain grid inside each decal's bounds and projects
 * it with DecalMatrix (CWldTerrainDecal.cpp:797-835, row-vector
 * convention):
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
 * Normals decals (type 2) blend into the deferred normal buffer
 * (DecalsNormalsPS :1108) — they need a normal render target and stay open.
 */
export interface MapDecalsStats {
  instances: number
  textures: number
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
  readonly stats: MapDecalsStats = {
    instances: 0,
    textures: 0,
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

    // Group by (albedo, spec) texture pair — one InstancedMesh per group.
    const groups = new Map<string, { albedo: string; spec: string; items: ScmapDecal[] }>()
    for (const d of decals) {
      if (d.type !== 1) {
        out.stats.skippedTypes.set(d.type, (out.stats.skippedTypes.get(d.type) ?? 0) + 1)
        continue
      }
      const albedo = (d.textures[0] ?? '').replace(/^\//, '').toLowerCase()
      if (!albedo) continue
      const spec = (d.textures[1] ?? '').replace(/^\//, '').toLowerCase()
      const key = `${albedo}|${spec}`
      let g = groups.get(key)
      if (!g) groups.set(key, (g = { albedo, spec, items: [] }))
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

      const defines: Record<string, boolean> = {}
      if (u.xpShader) defines.XP = true
      if (specTex) defines.HAS_SPEC = true

      // cutOffLOD is near-constant per texture set; use the maximum so no
      // decal of the group disappears early.
      const cutOff = Math.max(...g.items.map((d) => d.cutOffLOD))

      const material = new THREE.ShaderMaterial({
        vertexShader: DECAL_VS,
        fragmentShader: DECAL_FS,
        defines,
        uniforms: {
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
        // LessEqual without write, decal bias.
        transparent: true,
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
  }
}
