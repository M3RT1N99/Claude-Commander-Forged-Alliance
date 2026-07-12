import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { ScmModel } from '../formats/scm'
import type { ScmapData } from '../formats/scmap'
import type { GameVfs } from '../vfs/vfs'
import { createUnitMaterial, type UnitTextures } from './unitMaterial'
import { createTerrainMaterial } from './terrainMaterial'
import { ddsToTexture } from './textures'
import { UnitAnimator } from '../anim/animator'
import type { ScaAnim } from '../formats/sca'

/**
 * Three.js-Szene für die Unit-Ansicht: Orbit-Kamera, Bodenraster und das
 * aktuell geladene SCM-Modell mit Original-Texturen.
 */
export class UnitViewer {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly camera: THREE.PerspectiveCamera
  private readonly controls: OrbitControls
  private current: THREE.Mesh | null = null
  private waterMesh: THREE.Mesh | null = null
  private animator: UnitAnimator | null = null
  private animPlaying = false
  private animTime = 0
  private readonly clock = new THREE.Clock()
  animationSpeed = 1
  readonly s3tcSupported: boolean

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.s3tcSupported = this.renderer.extensions.has('WEBGL_compressed_texture_s3tc')

    this.scene.background = new THREE.Color(0x10141c)
    this.scene.fog = new THREE.Fog(0x10141c, 60, 220)

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500)
    this.camera.position.set(8, 6, 10)

    this.controls = new OrbitControls(this.camera, canvas)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08

    const grid = new THREE.GridHelper(200, 100, 0x2a3550, 0x1a2233)
    this.scene.add(grid)

    const resize = () => {
      const w = canvas.clientWidth
      const h = canvas.clientHeight
      if (w === 0 || h === 0) return
      this.renderer.setSize(w, h, false)
      this.camera.aspect = w / h
      this.camera.updateProjectionMatrix()
    }
    new ResizeObserver(resize).observe(canvas)
    resize()

    this.renderer.setAnimationLoop(() => {
      const dt = this.clock.getDelta()
      if (this.animator && this.animPlaying) {
        this.animTime += dt * this.animationSpeed
        this.animator.update(this.animTime)
      }
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    })
  }

  private clearContent(): void {
    this.animator = null
    this.animPlaying = false
    if (this.current) {
      this.scene.remove(this.current)
      this.current.geometry.dispose()
      ;(this.current.material as THREE.Material).dispose()
      this.current = null
    }
    if (this.waterMesh) {
      this.scene.remove(this.waterMesh)
      this.waterMesh.geometry.dispose()
      ;(this.waterMesh.material as THREE.Material).dispose()
      this.waterMesh = null
    }
  }

  setModel(model: ScmModel, textures: UnitTextures, teamColor: THREE.Color): void {
    this.clearContent()

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(model.positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(model.normals, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(model.uv0, 2))
    geometry.setAttribute('scmUv1', new THREE.BufferAttribute(model.uv1, 2))
    geometry.setAttribute('scmTangent', new THREE.BufferAttribute(model.tangents, 3))
    geometry.setAttribute('scmBinormal', new THREE.BufferAttribute(model.binormals, 3))
    const boneIndex = new Float32Array(model.vertexCount)
    for (let i = 0; i < model.vertexCount; i++) boneIndex[i] = model.boneIndices[i * 4]!
    geometry.setAttribute('scmBoneIndex', new THREE.BufferAttribute(boneIndex, 1))
    geometry.setIndex(new THREE.BufferAttribute(model.indices, 1))
    geometry.computeBoundingSphere()

    this.animator = new UnitAnimator(model)
    this.animPlaying = false
    this.animTime = 0

    const material = createUnitMaterial(textures, teamColor, this.animator.skinMatrices)
    const mesh = new THREE.Mesh(geometry, material)
    // Skinning kann über die statische Bounding-Sphere hinausgehen
    mesh.frustumCulled = false
    this.scene.add(mesh)
    this.current = mesh

    this.frameObject(geometry)
  }

  /** Startet eine Animation auf dem aktuellen Modell (null = Bindpose). */
  playAnimation(anim: ScaAnim | null, boneNames: string[]): void {
    if (!this.animator) return
    this.animator.setAnimation(anim, boneNames)
    this.animTime = 0
    this.animPlaying = anim !== null
    if (!anim) this.animator.update(0)
  }

  async setMap(scmap: ScmapData, vfs: GameVfs): Promise<void> {
    this.clearContent()

    const { width, height } = scmap
    const hmW = width + 1
    const hmH = height + 1

    // Heightmap → Float-Textur (Roh-Werte; Skalierung im Shader)
    const heightData = new Float32Array(scmap.heightmap.length)
    for (let i = 0; i < scmap.heightmap.length; i++) heightData[i] = scmap.heightmap[i]!
    const heightTex = new THREE.DataTexture(heightData, hmW, hmH, THREE.RedFormat, THREE.FloatType)
    heightTex.minFilter = THREE.LinearFilter
    heightTex.magFilter = THREE.LinearFilter
    heightTex.needsUpdate = true

    const dummy = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1)
    dummy.needsUpdate = true

    const loadLayer = async (path: string): Promise<THREE.Texture> => {
      if (!path || !vfs.exists(path)) return dummy
      const tex = ddsToTexture(await vfs.read(path), this.s3tcSupported)
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      return tex
    }

    // Lower = Stratum 0, Upper = Stratum 9, dazwischen 8 Splat-Lagen
    const lower = scmap.strata[0]
    const upper = scmap.strata[9]
    const mid = scmap.strata.slice(1, 9)
    const [lowerTex, upperTex, ...midTex] = await Promise.all([
      loadLayer(lower?.albedoPath ?? ''),
      loadLayer(upper?.albedoPath ?? ''),
      ...mid.map((s) => loadLayer(s?.albedoPath ?? '')),
    ])

    const embedded = (dds: Uint8Array | null): THREE.Texture => {
      if (!dds) return dummy
      const tex = ddsToTexture(dds, this.s3tcSupported)
      tex.wrapS = THREE.ClampToEdgeWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      return tex
    }
    const maskA = embedded(scmap.textureMaskLowDds)
    const maskB = embedded(scmap.textureMaskHighDds)
    const utilityC = scmap.water.hasWater ? embedded(scmap.waterMapDds) : null
    const waterRamp =
      scmap.water.hasWater && scmap.water.texPathWaterRamp
        ? await loadLayer(scmap.water.texPathWaterRamp)
        : null

    const material = createTerrainMaterial({
      heightTex,
      heightScale: scmap.heightScale,
      hmWidth: hmW,
      hmHeight: hmH,
      mapWidth: width,
      mapHeight: height,
      maskA,
      maskB,
      layers: {
        lower: lowerTex ?? dummy,
        strata: midTex,
        upper: upperTex ?? dummy,
        lowerScale: lower?.albedoScale || 4,
        strataScales: mid.map((s) => s?.albedoScale || 4),
        upperScale: upper?.albedoScale || 4,
      },
      waterRamp,
      utilityC,
      lighting: {
        sunDirection: new THREE.Vector3(...scmap.lighting.sunDirection).normalize(),
        sunColor: new THREE.Color(...scmap.lighting.sunColor),
        sunAmbience: new THREE.Color(...scmap.lighting.sunAmbience),
        shadowFillColor: new THREE.Color(...scmap.lighting.shadowFillColor),
        specularColor: new THREE.Vector4(...scmap.lighting.specularColor),
        lightingMultiplier: scmap.lighting.lightingMultiplier,
      },
    })

    const geometry = buildTerrainGrid(width, height)
    const mesh = new THREE.Mesh(geometry, material)
    this.scene.add(mesh)
    this.current = mesh

    if (scmap.water.hasWater) {
      const waterGeo = new THREE.PlaneGeometry(width, height)
      waterGeo.rotateX(-Math.PI / 2)
      waterGeo.translate(width / 2, scmap.water.elevation, height / 2)
      const waterMat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(...scmap.water.surfaceColor),
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      })
      this.waterMesh = new THREE.Mesh(waterGeo, waterMat)
      this.scene.add(this.waterMesh)
    }

    this.frameObject(geometry)
  }

  setTeamColor(color: THREE.Color): void {
    if (!this.current) return
    const mat = this.current.material as THREE.ShaderMaterial
    ;(mat.uniforms.teamColor!.value as THREE.Color).copy(color)
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera
  }

  private frameObject(geometry: THREE.BufferGeometry): void {
    const sphere = geometry.boundingSphere
    if (!sphere) return
    const r = Math.max(sphere.radius, 0.5)
    const dist = (r / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.25
    const dir = new THREE.Vector3(0.7, 0.45, 1).normalize()
    this.camera.position.copy(sphere.center).addScaledVector(dir, dist)
    this.camera.near = Math.max(dist / 100, 0.01)
    this.camera.far = dist * 20 + 200
    this.camera.updateProjectionMatrix()
    this.controls.target.copy(sphere.center)
    this.controls.update()
  }
}

/**
 * Terrain-Grid 0..width × 0..height in der XZ-Ebene; die Höhe kommt im
 * Vertex-Shader aus der Heightmap-Textur. Auflösung wird bei großen Karten
 * halbiert/geviertelt — die Höhendetails bleiben durch das Textur-Sampling
 * voll erhalten.
 */
function buildTerrainGrid(width: number, height: number): THREE.BufferGeometry {
  const maxSegs = 512
  const step = Math.max(1, Math.ceil(Math.max(width, height) / maxSegs))
  const segsX = Math.ceil(width / step)
  const segsZ = Math.ceil(height / step)

  const vertsX = segsX + 1
  const vertsZ = segsZ + 1
  const positions = new Float32Array(vertsX * vertsZ * 3)
  const uvs = new Float32Array(vertsX * vertsZ * 2)

  for (let z = 0; z < vertsZ; z++) {
    for (let x = 0; x < vertsX; x++) {
      const i = z * vertsX + x
      const wx = Math.min(x * step, width)
      const wz = Math.min(z * step, height)
      positions[i * 3] = wx
      positions[i * 3 + 1] = 0
      positions[i * 3 + 2] = wz
      uvs[i * 2] = wx / width
      uvs[i * 2 + 1] = wz / height
    }
  }

  const indices = new Uint32Array(segsX * segsZ * 6)
  let p = 0
  for (let z = 0; z < segsZ; z++) {
    for (let x = 0; x < segsX; x++) {
      const i00 = z * vertsX + x
      const i10 = i00 + 1
      const i01 = i00 + vertsX
      const i11 = i01 + 1
      indices[p++] = i00
      indices[p++] = i01
      indices[p++] = i10
      indices[p++] = i10
      indices[p++] = i01
      indices[p++] = i11
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2))
  geometry.setIndex(new THREE.BufferAttribute(indices, 1))
  geometry.computeBoundingSphere()
  return geometry
}
