import * as THREE from 'three'
import NORMAL_BUFFER_CHUNK from './shaders/terrainNormalBuffer.glsl?raw'

// Register the buffer-reading side as a shader chunk so receiver shaders
// (terrain main pass, albedo decals) can `#include <cfaNormalBuffer>`.
;(THREE.ShaderChunk as Record<string, string>).cfaNormalBuffer = NORMAL_BUFFER_CHUNK

/** The uniform set reader materials share (same object references). */
export interface NormalBufferUniforms {
  cfaNormalBuffer: { value: THREE.Texture | null }
  cfaNormalBufferSize: { value: THREE.Vector2 }
}

/**
 * The deferred normal pass of the original renderer: TerrainNormalsPS
 * (terrain.fx:591) writes the blended stratum normal into a screen-space
 * buffer, TDecalsNormals (:1335, SrcAlpha/InvSrcAlpha Write_RG) blends the
 * normals decals in, and TerrainPS/DecalsPS read it back via
 * SampleScreen(NormalSampler, mTexSS) (:706/1178).
 *
 * Rendered with the SAME cameras/viewports as the main pass right before
 * it, so gl_FragCoord addresses line up 1:1. The buffer stores only the
 * two tangent components in RG (up is rebuilt on read — frame.fx BasisPS).
 */
export class TerrainNormalsPass {
  /** Terrain normals mesh + normals decal patches render here. */
  readonly scene = new THREE.Scene()
  readonly uniforms: NormalBufferUniforms
  target: THREE.WebGLRenderTarget

  constructor(width: number, height: number) {
    this.target = new THREE.WebGLRenderTarget(width, height, {
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthBuffer: true,
    })
    this.uniforms = {
      cfaNormalBuffer: { value: this.target.texture },
      cfaNormalBufferSize: { value: new THREE.Vector2(width, height) },
    }
  }

  setSize(width: number, height: number): void {
    this.target.setSize(width, height)
    this.uniforms.cfaNormalBuffer.value = this.target.texture
    this.uniforms.cfaNormalBufferSize.value.set(width, height)
  }

  /** Nothing to render → the main pass must not sample stale data. */
  hasContent(): boolean {
    return this.scene.children.length > 0
  }

  dispose(): void {
    this.target.dispose()
    this.scene.clear()
  }
}
