import * as THREE from 'three'

/**
 * The click-feedback blips (the flag/crosshair flash when an order lands).
 * The Lua side is untouched: commandmode.lua:128-176 picks mesh, texture,
 * shader and duration per command type (commandmeshes.lua tables) and
 * calls AddCommandFeedbackBlip — our ui-globals.lua forwards the spec to
 * the sink main.ts connects here.
 *
 * Engine behavior being ported (cfunc_AddCommandFeedbackBlipL,
 * Cfile:1281690-1281960 + mesh.fx):
 *  - the mesh spawns at Position with identity orientation (SetStance,
 *    Cfile:1281933-1948) and lives duration seconds (mLifetimeParameter =
 *    duration * 10 ticks, Cfile:1281922; expiry per render frame in
 *    UpdateCommandFeedbackBlips, Cfile:1281647-1661)
 *  - technique CommandFeedback (mesh.fx:4848): scale animates 1.0 ->
 *    scaleTo over the lifetime (CommandFeedbackVS(0.7) :1915-1953;
 *    CommandFeedback2 grows to 1.1), alpha ramps to 0 (CommandFeedbackPS0
 *    fade, :2435-2439), SrcAlpha blend Write_RGB, no depth, no lighting,
 *    alpha test > 0x23
 *  - the distance-based enlargement (lodBasis, mesh.fx:1936) is not
 *    recovered from the decomp and is left out (named gap)
 */

/** Per-shader animation parameters (mesh.fx technique annotations). */
export const SHADER_PARAMS: Record<string, { scaleTo: number; fade: boolean }> = {
  CommandFeedback: { scaleTo: 0.7, fade: true }, // mesh.fx:4868
  CommandFeedback2: { scaleTo: 1.1, fade: true }, // mesh.fx:4918
  // mesh.fx:4890-4891: CommandFeedbackVS(0.7), CommandFeedbackPS0(false) --
  // the rally marker shrinks to 0.7 like a blip, but never fades.
  RallyPoint: { scaleTo: 0.7, fade: false },
}

/**
 * The feedback-family material (mesh.fx:4859-4866, shared by CommandFeedback,
 * CommandFeedback2 and RallyPoint): SrcAlpha/InvSrcAlpha writing RGB only
 * (the frame alpha is the glow buffer), no depth, alpha test > 0x23.
 */
export function createFeedbackMaterial(texture: THREE.Texture | null): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    map: texture ?? undefined,
    color: 0xffffff,
    transparent: true,
    blending: THREE.CustomBlending,
    blendSrc: THREE.SrcAlphaFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.ZeroFactor,
    blendDstAlpha: THREE.OneFactor,
    depthTest: false, // Depth_Disable (mesh.fx:4862)
    depthWrite: false,
    alphaTest: 0x23 / 255, // AlphaTest Greater 0x23 (mesh.fx:4864-4866)
    side: THREE.DoubleSide,
  })
}

export interface BlipAssets {
  geometry: THREE.BufferGeometry
  texture: THREE.Texture | null
}

interface ActiveBlip {
  mesh: THREE.Mesh
  material: THREE.MeshBasicMaterial
  spawn: number
  duration: number
  scaleTo: number
  fade: boolean
  baseScale: number
}

export class CommandFeedbackSystem {
  private readonly active: ActiveBlip[] = []

  constructor(
    private readonly addToScene: (obj: THREE.Object3D) => void,
    /** Resolves mesh + texture paths to renderable assets (cached by main). */
    private readonly loadAssets: (meshPath: string, texPath: string) => Promise<BlipAssets | null>,
  ) {}

  async spawn(opts: {
    meshPath: string
    texPath: string
    shaderName: string
    scale: number
    x: number
    y: number
    z: number
    duration: number
  }): Promise<void> {
    const assets = await this.loadAssets(opts.meshPath, opts.texPath)
    if (!assets) return
    const params = SHADER_PARAMS[opts.shaderName] ?? SHADER_PARAMS.CommandFeedback!
    const material = createFeedbackMaterial(assets.texture)
    const mesh = new THREE.Mesh(assets.geometry, material)
    mesh.position.set(opts.x, opts.y, opts.z)
    mesh.scale.setScalar(opts.scale)
    mesh.renderOrder = 9 // above terrain/decals, below selection rings
    mesh.frustumCulled = false
    this.addToScene(mesh)
    this.active.push({
      mesh,
      material,
      spawn: performance.now() / 1000,
      duration: opts.duration,
      scaleTo: params.scaleTo,
      fade: params.fade,
      baseScale: opts.scale,
    })
  }

  /** Per render frame: scale/alpha animation + expiry (frame seconds). */
  update(nowSeconds: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const b = this.active[i]!
      const t = Math.min((nowSeconds - b.spawn) / b.duration, 1)
      if (t >= 1) {
        b.mesh.parent?.remove(b.mesh)
        b.material.dispose()
        this.active.splice(i, 1)
        continue
      }
      // CommandFeedbackVS: position *= lerp(1, scaleTo, t)
      b.mesh.scale.setScalar(b.baseScale * (1 + (b.scaleTo - 1) * t))
      // CommandFeedbackPS0: alpha = saturate(color.a * (1 - t)) when fading
      b.material.opacity = b.fade ? 1 - t : 1
    }
  }

  dispose(): void {
    for (const b of this.active) {
      b.mesh.parent?.remove(b.mesh)
      b.material.dispose()
    }
    this.active.length = 0
  }
}
