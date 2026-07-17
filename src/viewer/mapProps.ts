import * as THREE from 'three'
import { parseScm } from '../formats/scm'
import { parseBlueprint, bpGet } from '../formats/blueprint'
import { resolvePropLods } from '../formats/unitPaths'
import type { ScmapProp } from '../formats/scmap'
import type { GameVfs } from '../vfs/vfs'
import { ddsToTexture } from './textures'
import type { MapLighting } from './unitMaterial'
import PROP_VS from './shaders/prop.vert.glsl?raw'
import PROP_FS from './shaders/prop.frag.glsl?raw'

/**
 * Map props (trees, rocks, map wrecks) — render-details.md par. 2: the SCMAP
 * prop list references `*_prop.bp` blueprints in env.scd; mesh/textures
 * resolve through the same prefix logic as units (blueprints.lua:170 +
 * RMeshBlueprintLOD::Init). ONE InstancedMesh per blueprint — SCMP_005
 * carries 46,971 props, individual meshes are not an option. Instance
 * matrix = 3x3 rotation basis * (scale * UniformScale), position straight
 * from the map file (already at terrain height).
 *
 * In the original, props are sim objects too (RECLAIMABLE, BlockPath) —
 * this is only the visual side; reclaim/blocking arrive with the sim's
 * feature system.
 */

/**
 * Legacy shader-name resolution (Mesh.cpp:2534-2583) — maps old blueprint
 * names onto the abstract mesh.fx techniques.
 */
const LEGACY_SHADER: Record<string, string> = {
  TMeshNoLighting: 'Flat',
  TMeshNoNormals: 'VertexNormal',
  TMeshAlpha: 'NormalMappedAlpha',
  TMeshGlow: 'NormalMappedGlow',
  TMeshTerrain: 'NormalMappedTerrain',
  Simple: 'Unit',
  Team: 'Unit',
  TMeshAlphaGlowFade: 'UnitBuild',
  TMeshMetalBuild: 'AeonBuild',
  TMeshShield: 'Shield',
  TMeshZFill: 'ShieldFill',
  TMeshAdd: 'Effect',
  TMeshExplosion: 'Explosion',
  TMeshCloud: 'Cloud',
  TMeshOuterCloud: 'OuterCloud',
  TMeshEMPNuke: 'NukeEMP',
  TMeshQuantumNuke: 'NukeQuantum',
  TMeshTemporalBubble: 'TemporalBubble',
}

export interface MapPropsStats {
  instances: number
  blueprints: number
  /** Blueprints whose assets could not be resolved (logged, not rendered). */
  missing: string[]
}

interface PropVariant {
  defines: { [key: string]: boolean }
  /** AlphaFunc-Greater reference (0-1); 0 = test disabled. */
  alphaRef: number
  /** SrcAlpha/InvSrcAlpha blending (VertexNormal technique, mesh.fx:3936). */
  blend: boolean
}

/**
 * Prop shader name -> render variant (prop.frag.glsl + material state),
 * per the mesh.fx techniques:
 *   NormalMappedAlpha (:4024-4037)  — alpha test 0x80, blending DISABLED
 *   VertexNormal      (:3934-3947)  — alpha test 0x23 WITH alpha blending
 *   NormalMappedTerrain (:4688-4699) — opaque, no test
 * The Undulating/Bloating variants additionally sway the vertices in the
 * original (tree movement, mesh.fx UndulatingNormalMappedVS) — that vertex
 * motion is still missing; lighting/alpha test match NormalMappedAlpha.
 */
function variantFor(shaderName: string): PropVariant {
  const resolved = LEGACY_SHADER[shaderName] ?? shaderName
  switch (resolved) {
    case 'NormalMappedAlpha':
    case 'UndulatingNormalMappedAlpha':
    case 'BloatingNormalMappedAlpha':
      return {
        defines: { NORMALMAPPED: true, PHONG: true, ALPHATEST: true },
        alphaRef: 0x80 / 255,
        blend: false,
      }
    case 'NormalMappedTerrain':
      return { defines: { NORMALMAPPED: true }, alphaRef: 0, blend: false }
    case 'VertexNormal':
    case 'Flat':
      return { defines: { ALPHATEST: true }, alphaRef: 0x23 / 255, blend: true }
    default:
      // Unit/Seraphim/Aeon props etc.: NormalMappedPS without alpha test is
      // the shared core (team color drops out for features, COLOR0 = white).
      return { defines: { NORMALMAPPED: true, PHONG: true }, alphaRef: 0, blend: false }
  }
}

export class MapProps {
  readonly group = new THREE.Group()
  readonly stats: MapPropsStats = { instances: 0, blueprints: 0, missing: [] }
  private readonly disposables: { dispose(): void }[] = []

  static async load(
    props: ScmapProp[],
    vfs: GameVfs,
    lighting: MapLighting,
    s3tcSupported: boolean,
  ): Promise<MapProps> {
    const out = new MapProps()
    if (props.length === 0) return out

    // One InstancedMesh per blueprint
    const byBp = new Map<string, ScmapProp[]>()
    for (const p of props) {
      const key = p.blueprintPath.toLowerCase().replace(/^\//, '')
      let list = byBp.get(key)
      if (!list) byBp.set(key, (list = []))
      list.push(p)
    }

    const grey = new THREE.DataTexture(new Uint8Array([140, 140, 145, 255]), 1, 1)
    grey.needsUpdate = true
    const flatNormal = new THREE.DataTexture(new Uint8Array([128, 128, 255, 128]), 1, 1)
    flatNormal.needsUpdate = true
    // Missing spec = BLACK: spec.b drives the glow (mesh.fx:2199) —
    // white would make every prop shine.
    const blackSpec = new THREE.DataTexture(new Uint8Array([0, 0, 0, 0]), 1, 1)
    blackSpec.needsUpdate = true
    out.disposables.push(grey, flatNormal, blackSpec)

    const texCache = new Map<string, THREE.Texture | null>()
    const loadTex = async (paths: string[]): Promise<THREE.Texture | null> => {
      for (const p of paths) {
        if (!texCache.has(p)) {
          if (!vfs.exists(p)) {
            texCache.set(p, null)
          } else {
            const t = ddsToTexture(await vfs.read(p), s3tcSupported)
            texCache.set(p, t)
            out.disposables.push(t)
          }
        }
        const hit = texCache.get(p)
        if (hit) return hit
      }
      return null
    }

    const basis = new THREE.Matrix4()
    const xAxis = new THREE.Vector3()
    const yAxis = new THREE.Vector3()
    const zAxis = new THREE.Vector3()

    for (const [bpPath, instances] of byBp) {
      try {
        if (!vfs.exists(bpPath)) {
          out.stats.missing.push(bpPath)
          continue
        }
        const bp = parseBlueprint(await vfs.readText(bpPath))
        const lods = resolvePropLods(bpPath, bp, (p) => vfs.exists(p))
        if (lods.length === 0) {
          out.stats.missing.push(bpPath)
          continue
        }

        const uniformScaleRaw = bpGet(bp, 'Display.UniformScale')
        const uniformScale =
          typeof uniformScaleRaw === 'number' && uniformScaleRaw > 0 ? uniformScaleRaw : 1

        // The instance transforms are shared by every LOD of the chain.
        const matrices: THREE.Matrix4[] = []
        for (const p of instances) {
          // The three vectors are the world directions of the local axes —
          // as columns they form the rotation matrix (makeBasis).
          xAxis.set(...p.rotationX)
          yAxis.set(...p.rotationY)
          zAxis.set(...p.rotationZ)
          basis.makeBasis(xAxis, yAxis, zAxis)
          matrices.push(
            new THREE.Matrix4()
              .copy(basis)
              .scale(
                new THREE.Vector3(
                  p.scale[0] * uniformScale,
                  p.scale[1] * uniformScale,
                  p.scale[2] * uniformScale,
                ),
              )
              .setPosition(p.position[0], p.position[1], p.position[2]),
          )
        }

        // One InstancedMesh per LOD; the shader draws only the band
        // (previous cutoff, own cutoff] — together that is Mesh::ComputeLOD.
        let near = 0
        for (const lod of lods) {
          const model = parseScm(await vfs.read(lod.mesh))

          const geometry = new THREE.BufferGeometry()
          geometry.setAttribute('position', new THREE.BufferAttribute(model.positions, 3))
          geometry.setAttribute('normal', new THREE.BufferAttribute(model.normals, 3))
          geometry.setAttribute('uv', new THREE.BufferAttribute(model.uv0, 2))
          geometry.setAttribute('scmUv1', new THREE.BufferAttribute(model.uv1, 2))
          geometry.setAttribute('scmTangent', new THREE.BufferAttribute(model.tangents, 3))
          geometry.setAttribute('scmBinormal', new THREE.BufferAttribute(model.binormals, 3))
          geometry.setIndex(new THREE.BufferAttribute(model.indices, 1))

          const variant = variantFor(lod.shader)
          const [albedo, normals, specTeam] = await Promise.all([
            loadTex(lod.albedo),
            variant.defines.NORMALMAPPED ? loadTex(lod.normals) : Promise.resolve(null),
            variant.defines.PHONG ? loadTex(lod.specTeam) : Promise.resolve(null),
          ])
          if (!albedo) console.warn(`map prop albedo missing: ${bpPath} (${lod.albedo[0]})`)

          const material = new THREE.ShaderMaterial({
            vertexShader: PROP_VS,
            fragmentShader: PROP_FS,
            defines: variant.defines,
            uniforms: {
              albedoMap: { value: albedo ?? grey },
              normalsMap: { value: normals ?? flatNormal },
              specTeamMap: { value: specTeam ?? blackSpec },
              sunDirection: { value: lighting.sunDirection },
              sunDiffuse: { value: lighting.sunColor },
              sunAmbient: { value: lighting.sunAmbience },
              shadowFill: { value: lighting.shadowFillColor },
              lightMultiplier: { value: lighting.lightingMultiplier },
              glowMultiplier: { value: 2.0 }, // mesh.fx:56
              lodCutoff: { value: lod.cutoff },
              lodNear: { value: near },
              alphaRef: { value: variant.alphaRef },
            },
            transparent: variant.blend,
            // Foliage cross planes are visible from both sides — like the
            // unit path we render SCM double-sided.
            side: THREE.DoubleSide,
          })

          const mesh = new THREE.InstancedMesh(geometry, material, matrices.length)
          for (let i = 0; i < matrices.length; i++) mesh.setMatrixAt(i, matrices[i]!)
          mesh.instanceMatrix.needsUpdate = true
          // Instances spread across the whole map; distance is cut by the
          // LOD band in the shader (Mesh::ComputeLOD).
          mesh.frustumCulled = false
          out.group.add(mesh)
          out.disposables.push(geometry, material)
          near = lod.cutoff
        }
        out.stats.blueprints++
        out.stats.instances += instances.length
      } catch (err) {
        out.stats.missing.push(bpPath)
        console.warn(`map prop failed: ${bpPath}: ${err instanceof Error ? err.message : err}`)
      }
    }

    if (out.stats.missing.length > 0) {
      console.warn(
        `map props: ${out.stats.missing.length} blueprint(s) not renderable: ` +
          out.stats.missing.slice(0, 5).join(', ') +
          (out.stats.missing.length > 5 ? ', …' : ''),
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
