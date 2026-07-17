import * as THREE from 'three'
import FULLSCREEN_VS from './shaders/fullscreen.vert.glsl?raw'
import BLOOM_COPY_FS from './shaders/bloomCopy.frag.glsl?raw'
import BLOOM_BLUR_FS from './shaders/bloomBlur.frag.glsl?raw'
import FRAME_COPY_FS from './shaders/frameCopy.frag.glsl?raw'

/**
 * The engine's glow/bloom chain (Moho::CBloomRenderer::DoBloom @0x7F5160):
 * the scene renders into a frame RT whose ALPHA carries the glow amount
 * (every mesh.fx technique writes it — spec.b + glowMinimum on units,
 * 0.01 + spec on TTerrain, the water mask at the very bottom of the
 * range), then:
 *
 *   1. TCopyGlowingStuff -> half-size glow buffer,
 *      c * sat((a - 0.02) * GlowCopyScale + GlowCopyAdd)
 *      (ren_BloomGlowCopyScale = 2.0)
 *   2. ren_BloomBlurCount (= 2) rounds of TBlurHorizontal + TBlurVertical
 *      (7-tap kernel from frame.fx:17-18, BlurScale =
 *      ren_BloomBlurKernelScale = 1.5)
 *   3. TFrame blit of the frame RT onto the back buffer, then TFrameAdd
 *      (One/One) adds the blurred glow.
 */
export class BloomPipeline {
  private sceneRT: THREE.WebGLRenderTarget
  private glowA: THREE.WebGLRenderTarget
  private glowB: THREE.WebGLRenderTarget
  private readonly quadScene = new THREE.Scene()
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly quad: THREE.Mesh
  private readonly copyMat: THREE.ShaderMaterial
  private readonly blurHMat: THREE.ShaderMaterial
  private readonly blurVMat: THREE.ShaderMaterial
  private readonly blitMat: THREE.ShaderMaterial
  private readonly addMat: THREE.ShaderMaterial

  constructor(width: number, height: number) {
    const rtOpts: THREE.RenderTargetOptions = {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      stencilBuffer: false,
    }
    this.sceneRT = new THREE.WebGLRenderTarget(width, height, rtOpts)
    const glowOpts = { ...rtOpts, depthBuffer: false }
    this.glowA = new THREE.WebGLRenderTarget(width >> 1, height >> 1, glowOpts)
    this.glowB = new THREE.WebGLRenderTarget(width >> 1, height >> 1, glowOpts)

    const uniforms = () => ({
      frameTex: { value: null as THREE.Texture | null },
      texelSize: { value: new THREE.Vector2() },
      glowCopyScale: { value: 2.0 }, // ren_BloomGlowCopyScale
      glowCopyAdd: { value: 0.0 },   // DoBloom amt parameter
    })
    this.copyMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VS,
      fragmentShader: BLOOM_COPY_FS,
      uniforms: uniforms(),
      depthTest: false,
      depthWrite: false,
    })
    this.blurHMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VS,
      fragmentShader: BLOOM_BLUR_FS,
      defines: { HORIZONTAL: true },
      uniforms: uniforms(),
      depthTest: false,
      depthWrite: false,
    })
    this.blurVMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VS,
      fragmentShader: BLOOM_BLUR_FS,
      uniforms: uniforms(),
      depthTest: false,
      depthWrite: false,
    })
    this.blitMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VS,
      fragmentShader: FRAME_COPY_FS,
      uniforms: uniforms(),
      depthTest: false,
      depthWrite: false,
    })
    // TFrameAdd (frame.fx:689): AlphaBlend_One_One
    this.addMat = new THREE.ShaderMaterial({
      vertexShader: FULLSCREEN_VS,
      fragmentShader: FRAME_COPY_FS,
      uniforms: uniforms(),
      depthTest: false,
      depthWrite: false,
      transparent: true,
      blending: THREE.CustomBlending,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
    })

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.blitMat)
    this.quad.frustumCulled = false
    this.quadScene.add(this.quad)
  }

  setSize(width: number, height: number): void {
    this.sceneRT.setSize(width, height)
    this.glowA.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1))
    this.glowB.setSize(Math.max(1, width >> 1), Math.max(1, height >> 1))
  }

  /** The render target the world views draw into. */
  get target(): THREE.WebGLRenderTarget {
    return this.sceneRT
  }

  private pass(
    renderer: THREE.WebGLRenderer,
    material: THREE.ShaderMaterial,
    source: THREE.Texture,
    dest: THREE.WebGLRenderTarget | null,
  ): void {
    material.uniforms.frameTex!.value = source
    ;(material.uniforms.texelSize!.value as THREE.Vector2).set(
      1 / this.glowA.width,
      1 / this.glowA.height,
    )
    this.quad.material = material
    renderer.setRenderTarget(dest)
    renderer.render(this.quadScene, this.quadCamera)
  }

  /** Copy -> blur x2 -> blit + additive glow onto the canvas. */
  composite(renderer: THREE.WebGLRenderer): void {
    const scissor = renderer.getScissorTest()
    renderer.setScissorTest(false)
    // Every pass is a full-screen replace — autoClear would wipe the blit
    // before the additive glow pass lands on top of it.
    const prevAutoClear = renderer.autoClear
    renderer.autoClear = false

    this.pass(renderer, this.copyMat, this.sceneRT.texture, this.glowA)
    for (let i = 0; i < 2; i++) { // ren_BloomBlurCount = 2
      this.pass(renderer, this.blurHMat, this.glowA.texture, this.glowB)
      this.pass(renderer, this.blurVMat, this.glowB.texture, this.glowA)
    }
    this.pass(renderer, this.blitMat, this.sceneRT.texture, null)
    this.pass(renderer, this.addMat, this.glowA.texture, null)

    renderer.autoClear = prevAutoClear
    renderer.setScissorTest(scissor)
  }

  dispose(): void {
    this.sceneRT.dispose()
    this.glowA.dispose()
    this.glowB.dispose()
    this.quad.geometry.dispose()
    for (const m of [this.copyMat, this.blurHMat, this.blurVMat, this.blitMat, this.addMat]) {
      m.dispose()
    }
  }
}
