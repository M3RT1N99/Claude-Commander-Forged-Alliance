import * as THREE from 'three'
import type { ScmapSkybox } from '../formats/scmap'
import type { GameVfs } from '../vfs/vfs'
import { ddsToTexture } from './textures'
import DOME_VS from './shaders/skyDome.vert.glsl?raw'
import ATMOSPHERE_FS from './shaders/skyAtmosphere.frag.glsl?raw'
import CIRRUS_FS from './shaders/skyCirrus.frag.glsl?raw'
import PLANET_VS from './shaders/skyPlanet.vert.glsl?raw'
import PLANET_FS from './shaders/skyPlanet.frag.glsl?raw'
import PLANET_GLOW_FS from './shaders/skyPlanetGlow.frag.glsl?raw'

/**
 * The map sky (M9) — SCMAP v60 skybox block driving the sky.fx passes:
 * Atmosphere (horizon/zenith gradient over a flat dome cap), Decal (the
 * "planet" billboards from an atlas) and Cirrus (four scrolling layers of
 * one texture). Pass order and states per sky.fx techniques (:274-353):
 * all draw without depth, atmosphere opaque, planets and cirrus SrcAlpha.
 *
 * Dome geometry per SkyDome::CreateDomeVertexBuffer (@0x818170):
 *   R = scale / cos(subHeight); yOff = R * sin(subHeight)
 *   ring phi = subHeight + row * (pi/2 - subHeight)/subDivHeight
 *   vertex = (cos(theta)*cos(phi)*R, sin(phi)*R - yOff, sin(theta)*cos(phi)*R)
 *   plus a single pole vertex; vertices carry theta for the horizon lookup.
 * The vertical offset (decompiled as a NAN artifact) is taken as
 * horizonHeight — ring 0 then sits exactly at the block's horizonHeight,
 * which is what AtmospherePS' horizonBegin expects.
 */
export class SkyDome {
  readonly group = new THREE.Group()
  private readonly disposables: { dispose(): void }[] = []
  private readonly timeUniforms: { value: number }[] = []

  static async load(sky: ScmapSkybox, vfs: GameVfs, s3tcSupported: boolean): Promise<SkyDome> {
    const out = new SkyDome()
    out.group.renderOrder = -10

    const loadTex = async (path: string, clamp: boolean): Promise<THREE.Texture | null> => {
      const p = path.replace(/^\//, '').toLowerCase()
      if (!p || !vfs.exists(p)) {
        if (p) console.warn(`sky texture missing: ${p}`)
        return null
      }
      const t = ddsToTexture(await vfs.read(p), s3tcSupported)
      if (clamp) {
        t.wrapS = THREE.ClampToEdgeWrapping
        t.wrapT = THREE.ClampToEdgeWrapping
      }
      out.disposables.push(t)
      return t
    }

    // --- dome geometry (shared by Atmosphere and Cirrus) ------------------
    const R = sky.scale / Math.cos(sky.subHeight)
    const yOff = R * Math.sin(sky.subHeight)
    const [cx, cy, cz] = sky.position
    const rows = sky.subDivHeight
    const segs = sky.subDivAx
    const positions: number[] = []
    const thetas: number[] = []
    for (let row = 0; row < rows; row++) {
      const phi = sky.subHeight + (row * (Math.PI / 2 - sky.subHeight)) / rows
      const ringR = Math.cos(phi) * R
      const ringY = Math.sin(phi) * R - yOff
      for (let x = 0; x <= segs; x++) {
        const theta = (x / segs) * Math.PI * 2
        positions.push(
          Math.cos(theta) * ringR + cx,
          ringY + cy + sky.horizonHeight,
          Math.sin(theta) * ringR + cz,
        )
        thetas.push(theta)
      }
    }
    // pole vertex (CreateDomeVertexBuffer tail)
    positions.push(cx, R - yOff + cy + sky.horizonHeight, cz)
    thetas.push(0)
    const pole = thetas.length - 1

    const indices: number[] = []
    const stride = segs + 1
    for (let row = 0; row < rows - 1; row++) {
      for (let x = 0; x < segs; x++) {
        const a = row * stride + x
        const b = a + 1
        const c = a + stride
        const d = c + 1
        indices.push(a, c, b, b, c, d)
      }
    }
    for (let x = 0; x < segs; x++) {
      const a = (rows - 1) * stride + x
      indices.push(a, pole, a + 1)
    }

    const dome = new THREE.BufferGeometry()
    dome.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3))
    dome.setAttribute('theta', new THREE.BufferAttribute(new Float32Array(thetas), 1))
    dome.setIndex(indices)
    out.disposables.push(dome)

    const cirrusUniforms = {
      time: { value: 0 },
      cirrusFrequency: {
        value: sky.cirrusLayers.map((l) => new THREE.Vector2(...l.frequency)),
      },
      cirrusSpeed: { value: sky.cirrusLayers.map((l) => l.speed) },
      cirrusDirection: {
        value: sky.cirrusLayers.map((l) => new THREE.Vector2(...l.direction)),
      },
    }

    // --- Atmosphere pass --------------------------------------------------
    // SkyDome.cpp:158 names the fixed horizon lookup texture.
    const horizonLookup = await loadTex('/textures/environment/horizonlookup.dds', true)
    if (horizonLookup) {
      horizonLookup.minFilter = THREE.NearestFilter // POINT sampler, sky.fx:38-39
      horizonLookup.magFilter = THREE.NearestFilter
      const atmosphere = new THREE.ShaderMaterial({
        vertexShader: DOME_VS,
        fragmentShader: ATMOSPHERE_FS,
        uniforms: {
          ...cirrusUniforms,
          horizonLookup: { value: horizonLookup },
          horizonBegin: { value: cy + sky.horizonHeight },
          horizonEnd: { value: cy + sky.zenithHeight },
          horizonColor: { value: new THREE.Color(...sky.horizonColor) },
          skyColor: { value: new THREE.Color(...sky.zenithColor) },
        },
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(dome, atmosphere)
      mesh.frustumCulled = false
      mesh.renderOrder = -12
      out.group.add(mesh)
      out.disposables.push(atmosphere)
      out.timeUniforms.push(cirrusUniforms.time)
    }

    // --- Planet billboards (sky.fx Decal pass) ----------------------------
    const atlas = await loadTex(sky.albedo, true)
    if (atlas && sky.planets.length > 0) {
      const quad = new THREE.InstancedBufferGeometry()
      quad.setAttribute(
        'corner',
        new THREE.BufferAttribute(new Float32Array([-1, -1, 1, -1, 1, 1, -1, 1]), 2),
      )
      // three needs a position attribute for draw range bookkeeping
      quad.setAttribute(
        'position',
        new THREE.BufferAttribute(new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), 3),
      )
      quad.setIndex([0, 2, 1, 0, 3, 2])
      const n = sky.planets.length
      const pos = new Float32Array(n * 4)
      const size = new Float32Array(n * 2)
      const uv = new Float32Array(n * 4)
      sky.planets.forEach((p, i) => {
        pos.set([...p.position, p.rotation], i * 4)
        size.set(p.scale, i * 2)
        uv.set(p.uv, i * 4)
      })
      quad.setAttribute('planetPos', new THREE.InstancedBufferAttribute(pos, 4))
      quad.setAttribute('planetSize', new THREE.InstancedBufferAttribute(size, 2))
      quad.setAttribute('planetUv', new THREE.InstancedBufferAttribute(uv, 4))
      quad.instanceCount = n
      const planetMat = new THREE.ShaderMaterial({
        vertexShader: PLANET_VS,
        fragmentShader: PLANET_FS,
        uniforms: { planetAtlas: { value: atlas } },
        transparent: true,
        // Decal pass P0: SrcAlpha Write_RGB (sky.fx:297) — keep frame alpha
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const planets = new THREE.Mesh(quad, planetMat)
      planets.frustumCulled = false
      planets.renderOrder = -11
      out.group.add(planets)
      out.disposables.push(quad, planetMat)

      // Pass P1 (DecalGlowPS :243, Write_A): the glow atlas feeds the
      // frame alpha (bloom) — RGB stays via the blend factors.
      const glowAtlas = await loadTex(sky.glow, true)
      if (glowAtlas) {
        const glowMat = new THREE.ShaderMaterial({
          vertexShader: PLANET_VS,
          fragmentShader: PLANET_GLOW_FS,
          uniforms: {
            planetGlowAtlas: { value: glowAtlas },
            decalGlowMultiplier: { value: sky.decalGlowMultiplier },
          },
          transparent: true,
          blending: THREE.CustomBlending,
          blendSrc: THREE.ZeroFactor,
          blendDst: THREE.OneFactor,
          blendSrcAlpha: THREE.OneFactor,
          blendDstAlpha: THREE.ZeroFactor,
          depthTest: false,
          depthWrite: false,
          side: THREE.DoubleSide,
        })
        const glowMesh = new THREE.Mesh(quad, glowMat)
        glowMesh.frustumCulled = false
        glowMesh.renderOrder = -10.5
        out.group.add(glowMesh)
        out.disposables.push(glowMat)
      }
    }

    // --- Cirrus pass ------------------------------------------------------
    const cirrusTex = await loadTex(sky.cirrusTexture, false)
    if (cirrusTex && sky.cirrusLayers.length === 4) {
      const cirrus = new THREE.ShaderMaterial({
        vertexShader: DOME_VS,
        fragmentShader: CIRRUS_FS,
        uniforms: {
          ...cirrusUniforms,
          cirrusMap: { value: cirrusTex },
          cirrusMultiplier: { value: sky.cirrusMultiplier },
          cirrusColor: { value: new THREE.Color(...sky.cirrusColor) },
        },
        transparent: true,
        // Cirrus pass: SrcAlpha Write_RGB (sky.fx:344) — keep frame alpha
        blending: THREE.CustomBlending,
        blendSrc: THREE.SrcAlphaFactor,
        blendDst: THREE.OneMinusSrcAlphaFactor,
        blendSrcAlpha: THREE.ZeroFactor,
        blendDstAlpha: THREE.OneFactor,
        depthTest: false,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      const mesh = new THREE.Mesh(dome, cirrus)
      mesh.frustumCulled = false
      mesh.renderOrder = -10
      out.group.add(mesh)
      out.disposables.push(cirrus)
      out.timeUniforms.push(cirrusUniforms.time)
    }

    return out
  }

  /** Advance the cirrus scroll — sky.fx:160 counts in ticks (10 per second). */
  update(elapsedSeconds: number): void {
    for (const u of this.timeUniforms) u.value = elapsedSeconds * 10
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
    this.disposables.length = 0
    this.group.clear()
  }
}
