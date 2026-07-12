import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { ScmModel } from '../formats/scm'
import { createUnitMaterial, type UnitTextures } from './unitMaterial'

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
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    })
  }

  setModel(model: ScmModel, textures: UnitTextures, teamColor: THREE.Color): void {
    if (this.current) {
      this.scene.remove(this.current)
      this.current.geometry.dispose()
      ;(this.current.material as THREE.Material).dispose()
      this.current = null
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(model.positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(model.normals, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(model.uv0, 2))
    geometry.setAttribute('scmUv1', new THREE.BufferAttribute(model.uv1, 2))
    geometry.setAttribute('scmTangent', new THREE.BufferAttribute(model.tangents, 3))
    geometry.setAttribute('scmBinormal', new THREE.BufferAttribute(model.binormals, 3))
    geometry.setIndex(new THREE.BufferAttribute(model.indices, 1))
    geometry.computeBoundingSphere()

    const material = createUnitMaterial(textures, teamColor)
    const mesh = new THREE.Mesh(geometry, material)
    this.scene.add(mesh)
    this.current = mesh

    this.frameObject(geometry)
  }

  setTeamColor(color: THREE.Color): void {
    if (!this.current) return
    const mat = this.current.material as THREE.ShaderMaterial
    ;(mat.uniforms.teamColor!.value as THREE.Color).copy(color)
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
