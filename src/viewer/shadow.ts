import * as THREE from 'three'
import SHADOW_TERM from './shaders/shadowTerm.glsl?raw'

// Register the shared shadow term as a shader chunk so receiver shaders
// can `#include <cfaShadow>` (three resolves includes for ShaderMaterial).
;(THREE.ShaderChunk as Record<string, string>).cfaShadow = SHADOW_TERM

/** The uniform set receiver materials share (same object references). */
export interface ShadowUniforms {
  cfaShadowMap: { value: THREE.Texture | null }
  cfaShadowMatrix: { value: THREE.Matrix4 }
  cfaShadowsEnabled: { value: number }
  cfaShadowSize: { value: number }
}

interface ShadowCaster {
  mesh: THREE.Mesh
  depthMaterial: THREE.Material
}

/**
 * The engine's shadow pass (H7): a depth render from an ortho camera along
 * the map's sun direction; every mesh technique with STAGE_DEPTH casts
 * (depthTechnique 'Depth' for solid units, 'DepthClip' for alpha-tested
 * foliage). Receivers sample the map with the ComputeShadowPCF term
 * (mesh.fx:477-529, see shadowTerm.glsl). Constants from the binary:
 * ren_ShadowSize = 1024, ren_ShadowBias = 0.005 (Cfile:421804/421811).
 *
 * Casters live on layer 1; the shadow pass renders the main scene with the
 * light camera's layer mask and each caster's material swapped for its
 * depth variant — no twin meshes, bones and instance buffers stay shared.
 */
export class ShadowRenderer {
  static readonly LAYER = 1

  private readonly target: THREE.WebGLRenderTarget
  private readonly lightCamera = new THREE.OrthographicCamera()
  private readonly casters: ShadowCaster[] = []
  readonly uniforms: ShadowUniforms

  constructor() {
    const size = 1024 // ren_ShadowSize
    const depthTexture = new THREE.DepthTexture(size, size)
    depthTexture.minFilter = THREE.NearestFilter
    depthTexture.magFilter = THREE.NearestFilter
    this.target = new THREE.WebGLRenderTarget(size, size, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
      depthTexture,
    })
    this.lightCamera.layers.set(ShadowRenderer.LAYER)
    this.uniforms = {
      cfaShadowMap: { value: depthTexture },
      cfaShadowMatrix: { value: new THREE.Matrix4() },
      cfaShadowsEnabled: { value: 0 },
      cfaShadowSize: { value: size },
    }
  }

  /**
   * Aim the light camera along the map sun over the map bounds; called
   * from setMap. maxHeight covers the tallest terrain plus unit headroom.
   */
  setupForMap(width: number, height: number, sunDirection: THREE.Vector3, maxHeight: number): void {
    const cx = width / 2
    const cz = height / 2
    const radius = Math.hypot(width, height) / 2 + maxHeight
    const dist = radius + maxHeight
    this.lightCamera.position
      .set(cx, 0, cz)
      .addScaledVector(sunDirection.clone().normalize(), dist)
    this.lightCamera.up.set(0, 1, 0)
    this.lightCamera.lookAt(cx, 0, cz)
    this.lightCamera.left = -radius
    this.lightCamera.right = radius
    this.lightCamera.top = radius
    this.lightCamera.bottom = -radius
    this.lightCamera.near = 1
    this.lightCamera.far = dist + radius
    this.lightCamera.updateProjectionMatrix()
    this.lightCamera.updateMatrixWorld(true)
    this.uniforms.cfaShadowMatrix.value.multiplyMatrices(
      this.lightCamera.projectionMatrix,
      this.lightCamera.matrixWorldInverse,
    )
    this.uniforms.cfaShadowsEnabled.value = 1
  }

  /** Register a caster: put it on the shadow layer with a depth variant. */
  register(mesh: THREE.Mesh, depthMaterial: THREE.Material): void {
    mesh.layers.enable(ShadowRenderer.LAYER)
    this.casters.push({ mesh, depthMaterial })
  }

  /** Render the depth map (call before the main scene render). */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene): void {
    if (this.uniforms.cfaShadowsEnabled.value < 0.5) return
    // Self-cleaning: drop casters that left the scene.
    for (let i = this.casters.length - 1; i >= 0; i--) {
      if (!this.casters[i]!.mesh.parent) this.casters.splice(i, 1)
    }
    const saved: (THREE.Material | THREE.Material[])[] = []
    for (const c of this.casters) {
      saved.push(c.mesh.material)
      c.mesh.material = c.depthMaterial
    }
    const scissor = renderer.getScissorTest()
    renderer.setScissorTest(false)
    renderer.setRenderTarget(this.target)
    renderer.setViewport(0, 0, this.target.width, this.target.height)
    renderer.clear()
    renderer.render(scene, this.lightCamera)
    renderer.setRenderTarget(null)
    renderer.setScissorTest(scissor)
    this.casters.forEach((c, i) => {
      c.mesh.material = saved[i] as THREE.Material
    })
  }

  reset(): void {
    this.uniforms.cfaShadowsEnabled.value = 0
    this.casters.length = 0
  }

  dispose(): void {
    this.reset()
    this.target.dispose()
  }
}
