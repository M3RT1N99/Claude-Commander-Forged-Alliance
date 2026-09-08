import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { ScmModel } from '../formats/scm'
import type { ScmapData } from '../formats/scmap'
import type { GameVfs } from '../vfs/vfs'
import { createUnitMaterial, createWreckageMaterial, type UnitTextures, type MapLighting } from './unitMaterial'
import { createTerrainMaterial } from './terrainMaterial'
import { createWaterMaterial } from './waterMaterial'
import { ddsToTexture, ddsToCubeTexture } from './textures'
import SKIRT_VS from './shaders/skirt.vert.glsl?raw'
import SKIRT_FS from './shaders/skirt.frag.glsl?raw'
import { parseDds } from '../formats/dds'
import { bgraToRgba, decodeDxt } from '../formats/dxt'
import { UnitAnimator } from '../anim/animator'
import { CameraShakeState, type CamShakeParams } from './cameraShake'
import type { ScaAnim } from '../formats/sca'
import { MapProps } from './mapProps'
import { MapDecals, type DecalSceneUniforms } from './mapDecals'
import { RuntimeDecals } from './runtimeDecals'
import { SkyDome } from './skyDome'
import { BloomPipeline } from './bloom'
import { ShadowRenderer } from './shadow'
import { TerrainNormalsPass } from './terrainNormals'
import DEPTH_UNIT_VS from './shaders/depthUnit.vert.glsl?raw'
import DEPTH_FS from './shaders/depth.frag.glsl?raw'

/** The nearest world object under the cursor — one depth-sorted raycast
 *  across units, wreck meshes and instanced map props (pickWorld). */
export type WorldPick =
  | { kind: 'unit'; unit: SceneUnit; distance: number }
  | { kind: 'wreck'; object: THREE.Object3D; distance: number }
  | { kind: 'mapProp'; mapIndex: number; distance: number }

/** Eine in die Szene gesetzte Einheit (Sandbox-Modus). */
export class SceneUnit {
  playing = false
  time = 0
  speed = 1

  constructor(
    readonly mesh: THREE.Mesh,
    readonly animator: UnitAnimator,
    readonly boneNames: string[],
  ) {}

  play(anim: ScaAnim | null, speed = 1): void {
    this.animator.setAnimation(anim, this.boneNames)
    this.playing = anim !== null
    this.speed = speed
    this.time = 0
    if (!anim) this.animator.update(0)
  }

  update(dt: number): void {
    if (this.playing) {
      this.time += dt * this.speed
      this.animator.update(this.time)
    }
  }
}

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
  private skirtMesh: THREE.Mesh | null = null
  private mapProps: MapProps | null = null
  private mapDecals: MapDecals | null = null
  /** The runtime splats and decals (CreateSplat / CreateDecal), fed per beat by the session. */
  runtimeDecals: RuntimeDecals | null = null
  private skyDome: SkyDome | null = null

  /** Decal statistics of the loaded map (diagnosis via CDP). */
  decalStats(): MapDecals['stats'] | null {
    return this.mapDecals?.stats ?? null
  }

  /** Hide a map-prop instance whose sim prop died (reclaim/destroy). */
  hideMapProp(mapIndex: number): void {
    this.mapProps?.hideInstance(mapIndex)
  }

  private screenRay(clientX: number, clientY: number): THREE.Raycaster {
    const rect = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.camera)
    return raycaster
  }

  /** Pick a MAP prop instance under the cursor (scmap index) — reclaim
   *  targets tree/rock instances of the instanced renderer. */
  pickMapProp(clientX: number, clientY: number): number | null {
    if (!this.mapProps) return null
    return this.mapProps.pick(this.screenRay(clientX, clientY))?.mapIndex ?? null
  }

  /** Pick the nearest of the given scene objects (wreck meshes live in
   *  main); returns the hit root object or null. */
  pickAmong(clientX: number, clientY: number, objects: THREE.Object3D[]): THREE.Object3D | null {
    if (objects.length === 0) return null
    const hits = this.screenRay(clientX, clientY).intersectObjects(objects, true)
    const hit = hits[0]
    if (!hit) return null
    // Walk up to the registered root (wreck meshes may have child parts).
    let obj: THREE.Object3D | null = hit.object
    const roots = new Set(objects)
    while (obj && !roots.has(obj)) obj = obj.parent
    return obj
  }

  /**
   * ONE depth-sorted pick across units, wreck meshes and instanced map
   * props: the engine resolves a world click to the CLOSEST entity of
   * any kind under the cursor — not by category priority. Units come
   * from the scene list (visible only), wrecks from the caller
   * (individual meshes live in main), map props from the instanced
   * renderer.
   */
  pickWorld(clientX: number, clientY: number, wrecks: THREE.Object3D[]): WorldPick | null {
    const ray = this.screenRay(clientX, clientY)
    let best: WorldPick | null = null
    const unitHit = ray.intersectObjects(
      this.units.filter((u) => u.mesh.visible).map((u) => u.mesh),
      false,
    )[0]
    if (unitHit) {
      const unit = this.units.find((u) => u.mesh === unitHit.object)
      if (unit) best = { kind: 'unit', unit, distance: unitHit.distance }
    }
    if (wrecks.length > 0) {
      const hit = ray.intersectObjects(wrecks, true)[0]
      if (hit && (!best || hit.distance < best.distance)) {
        // Walk up to the registered root (wreck meshes may have child parts).
        let obj: THREE.Object3D | null = hit.object
        const roots = new Set(wrecks)
        while (obj && !roots.has(obj)) obj = obj.parent
        if (obj) best = { kind: 'wreck', object: obj, distance: hit.distance }
      }
    }
    const prop = this.mapProps?.pick(ray)
    if (prop && (!best || prop.distance < best.distance)) {
      best = { kind: 'mapProp', mapIndex: prop.mapIndex, distance: prop.distance }
    }
    return best
  }
  /** Glow/bloom chain (CBloomRenderer::DoBloom @0x7F5160). */
  private bloom: BloomPipeline | null = null
  /**
   * The loaded map's bloom amount (scmap `mBloom`) fed to DoBloom's GlowCopyAdd.
   * 0.0 until a map is set, matching the engine's no-terrain fallback
   * (Cfile:1212939).
   */
  private mapBloom = 0
  /** Shadow pass (H7): depth from the sun, ComputeShadowPCF receivers. */
  readonly shadow = new ShadowRenderer()
  /** Deferred normal pass (TerrainNormalsPS + TDecalsNormals into a
   *  screen-space RT; terrain/decal lighting reads it back). */
  private readonly terrainNormals = new TerrainNormalsPass(4, 4)
  /**
   * The engine's shader clock: game TICKS plus the frame's beat fraction.
   * mesh.fx `time` (MeshRenderer::Batch, Cfile:1212805-1212810), terrain.fx
   * `Time` (MediumFidelityTerrain::Func3 :1220731-1220732) and water2.fx
   * `Time` (the water renderers sub_80FC80 :1228809-1228810 and
   * HighFidelityWater::Func3 :1229395-1229396) are all fed sCurGameTick +
   * sDeltaFrame by the viewport render (:1212790-1212800).
   * A session sets it per frame (setShaderTime); the tools without a sim
   * run real time x 10 (sky.fx:160 counts the same ticks).
   */
  private shaderTicks: number | null = null
  setShaderTime(ticks: number): void {
    this.shaderTicks = ticks
  }
  /** Map '<default>' env cube — mesh.fx environmentSampler (Cfile:1189598). */
  private envCube: THREE.Texture | null = null
  /** The map's environment cube (mesh.fx environmentSampler) for materials built outside the viewer. */
  currentEnvCube(): THREE.Texture | null {
    return this.envCube
  }
  /** Named env cubes from the scmap list ('<aeon>', '<seraphim>', …). */
  private readonly envCubesByName = new Map<string, THREE.Texture>()
  /** Cybran 'Insect' aniso lookup (/textures/engine/insectlookup.dds). */
  private insectLookup: THREE.Texture | null = null
  private animator: UnitAnimator | null = null
  private animPlaying = false
  private animTime = 0
  private readonly clock = new THREE.Clock()
  animationSpeed = 1
  readonly s3tcSupported: boolean

  /** Sandbox: zusätzliche Einheiten, Hilfsobjekte + Update-Hooks */
  private readonly units: SceneUnit[] = []
  private readonly helpers: THREE.Object3D[] = []
  private readonly updateHooks: ((dt: number) => void)[] = []

  /** Heightfield der aktuellen Karte (für Sampling/Picking) */
  private heightfield: {
    data: Uint16Array
    width: number
    height: number
    scale: number
  } | null = null

  constructor(private readonly canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.s3tcSupported = this.renderer.extensions.has('WEBGL_compressed_texture_s3tc')

    // Clear with ALPHA 0 — the frame alpha is the glow buffer input
    // (frame.fx CopyGlowingPS); a background color of alpha 1 would make
    // the whole backdrop bloom.
    this.renderer.setClearColor(0x10141c, 0)
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
      // The shader clock in ticks (see shaderTicks): the session's, or real
      // time x 10 for the tools.
      const shaderTime = this.shaderTicks ?? this.clock.elapsedTime * 10
      // TTerrainGlow: the stratum1 lava layer scrolls with Time (terrain.fx
      // :510-514).
      const terrainMat = this.current?.material as THREE.ShaderMaterial | undefined
      if (terrainMat?.uniforms?.time) {
        terrainMat.uniforms.time.value = shaderTime
      }
      this.skyDome?.update(shaderTime)
      this.mapProps?.update(shaderTime)
      // Water wave layers scroll with Time (water2.fx WaterVS :315-318).
      const waterMat = this.waterMesh?.material as THREE.ShaderMaterial | undefined
      if (waterMat?.uniforms?.time) {
        waterMat.uniforms.time.value = shaderTime
      }
      if (this.animator && this.animPlaying) {
        this.animTime += dt * this.animationSpeed
        this.animator.update(this.animTime)
      }
      for (const hook of this.updateHooks) hook(dt)
      for (const unit of this.units) unit.update(dt)
      // CameraImpl::Frame runs for every camera every frame (RCamManager::Frame,
      // Cfile:1151593-1151610): the shake clock and sign advance whether or
      // not the RTS controls drive the camera.
      this.shake.frame(Math.max(dt, 0))
      if (this.rts.enabled) this.updateRtsCamera(dt)
      else this.controls.update()
      this.renderWorldViews()
    })
  }

  /**
   * Die Weltansichten der Original-Lua, mit ihren Rechtecken.
   *
   * Im Original ist die Weltansicht ein Control (CUIWorldView) — und die Minimap
   * ist DASSELBE Control, nur kartografisch (minimap.lua:115, isMiniMap = true).
   * Die Lua entscheidet, wo sie liegen; hier wird nur dorthin gerendert. Genau
   * deshalb kann man die Minimap im Original verschieben.
   */
  private worldViewRects: {
    left: number
    top: number
    width: number
    height: number
    cartographic: boolean
  }[] = []

  setWorldViews(
    views: { left: number; top: number; width: number; height: number; cartographic: boolean }[],
  ): void {
    this.worldViewRects = views
  }

  /** Die kartografische Kamera der Minimap: Draufsicht auf die ganze Karte. */
  private readonly mapCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 4000)

  private renderWorldViews(): void {
    const width = this.canvas.clientWidth
    const height = this.canvas.clientHeight
    const dpr = this.renderer.getPixelRatio()

    // Frame RT for the glow chain: the scene renders here (its ALPHA is
    // the glow amount), then BloomPipeline.composite blits + adds onto
    // the canvas (frame.fx TFrame / TFrameAdd).
    // Shadow depth prepass (light camera, layer-1 casters).
    this.shadow.render(this.renderer, this.scene)

    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    if (!this.bloom) {
      this.bloom = new BloomPipeline(size.x, size.y)
    } else if (this.bloom.target.width !== size.x || this.bloom.target.height !== size.y) {
      this.bloom.setSize(size.x, size.y)
    }

    // Deferred normal prepass (TerrainNormalsPS + TDecalsNormals): same
    // cameras/viewports as the main pass right below, one RT of the same
    // size — gl_FragCoord lines up 1:1 for the readers.
    if (this.terrainNormals.hasContent()) {
      if (
        this.terrainNormals.target.width !== size.x ||
        this.terrainNormals.target.height !== size.y
      ) {
        this.terrainNormals.setSize(size.x, size.y)
      }
      const prevClear = this.renderer.getClearColor(new THREE.Color())
      const prevAlpha = this.renderer.getClearAlpha()
      // Neutral buffer: n.xy = 0 (encoded 0.5) — flat "no stratum detail".
      this.renderer.setClearColor(new THREE.Color(0.5, 0.5, 0.0), 1)
      this.renderer.setRenderTarget(this.terrainNormals.target)
      // Same scissor discipline as the main pass: per-view autoClear must
      // only wipe its own rect.
      this.renderer.setScissorTest(false)
      this.renderer.clear()
      if (this.worldViewRects.length > 0) this.renderer.setScissorTest(true)
      this.forEachView(size, width, height, dpr, (cam) =>
        this.renderer.render(this.terrainNormals.scene, cam),
      )
      this.renderer.setScissorTest(false)
      this.renderer.setClearColor(prevClear, prevAlpha)
    }

    this.renderer.setRenderTarget(this.bloom.target)
    if (this.worldViewRects.length === 0) {
      this.renderer.setScissorTest(false)
    } else {
      this.renderer.setScissorTest(true)
      this.renderer.clear()
    }
    this.forEachView(size, width, height, dpr, (cam) => this.renderer.render(this.scene, cam))
    this.renderer.setScissorTest(false)
    this.renderer.setRenderTarget(null)
    this.renderer.setViewport(0, 0, width, height)
    // DoBloom's amt = the map's GetBloom() (Cfile:1212932/1212943).
    this.bloom.setGlowCopyAdd(this.mapBloom)
    this.bloom.composite(this.renderer)
  }

  /**
   * Run `draw` once per world view (or once full-surface without views),
   * with viewport/scissor/camera set up — the shared loop of the normal
   * prepass and the main pass (identical viewports keep gl_FragCoord
   * addresses aligned between their render targets).
   */
  private forEachView(
    size: THREE.Vector2,
    width: number,
    height: number,
    dpr: number,
    draw: (camera: THREE.Camera) => void,
  ): void {
    if (this.worldViewRects.length === 0) {
      this.renderer.setViewport(0, 0, size.x, size.y)
      draw(this.camera)
      return
    }
    for (const view of this.worldViewRects) {
      // Render-target viewports count in DEVICE pixels — scale the CSS
      // rects by the pixel ratio.
      const w = Math.max(1, Math.round(view.width * dpr))
      const h = Math.max(1, Math.round(view.height * dpr))
      const x = Math.round(view.left * dpr)
      // WebGL zählt von UNTEN, die UI von oben.
      const y = Math.round((height - view.top - view.height) * dpr)
      this.renderer.setViewport(x, y, w, h)
      this.renderer.setScissor(x, y, w, h)

      if (view.cartographic) {
        draw(this.mapCameraFor(w, h))
      } else {
        this.camera.aspect = w / h
        this.camera.updateProjectionMatrix()
        draw(this.camera)
      }
    }
  }

  /** Draufsicht auf die ganze Karte, in das Seitenverhältnis des Controls gepasst. */
  private mapCameraFor(w: number, h: number): THREE.OrthographicCamera {
    const hf = this.heightfield
    const mapW = hf ? hf.width : 256
    const mapH = hf ? hf.height : 256
    // Die Karte ganz zeigen, ohne sie zu verzerren.
    const scale = Math.max(mapW / w, mapH / h)
    const halfW = (w * scale) / 2
    const halfH = (h * scale) / 2
    const cam = this.mapCamera
    cam.left = -halfW
    cam.right = halfW
    cam.top = halfH
    cam.bottom = -halfH
    cam.near = 0.1
    cam.far = 4000
    cam.position.set(mapW / 2, 1000, mapH / 2)
    cam.up.set(0, 0, -1)
    cam.lookAt(mapW / 2, 0, mapH / 2)
    cam.updateProjectionMatrix()
    return cam
  }

  private clearContent(): void {
    this.animator = null
    this.animPlaying = false
    this.heightfield = null
    this.mapLighting = null
    // Werkzeug-Modus: der Viewer-Nebel kommt zurück (auf der Karte ist er aus).
    this.scene.fog = new THREE.Fog(0x10141c, 60, 220)
    this.updateHooks.length = 0
    for (const unit of this.units) {
      this.scene.remove(unit.mesh)
      unit.mesh.geometry.dispose()
      ;(unit.mesh.material as THREE.Material).dispose()
    }
    this.units.length = 0
    for (const helper of this.helpers) this.scene.remove(helper)
    this.helpers.length = 0
    if (this.current) {
      this.scene.remove(this.current)
      this.current.geometry.dispose()
      ;(this.current.material as THREE.Material).dispose()
      this.current = null
    }
    // The normal-pass copies (terrain normals mesh; the decal normals
    // group is disposed with mapDecals below).
    for (const child of [...this.terrainNormals.scene.children]) {
      this.terrainNormals.scene.remove(child)
      if (child instanceof THREE.Mesh) {
        ;(child.material as THREE.Material).dispose()
      }
    }
    if (this.waterMesh) {
      this.scene.remove(this.waterMesh)
      this.waterMesh.geometry.dispose()
      ;(this.waterMesh.material as THREE.Material).dispose()
      this.waterMesh = null
    }
    if (this.skirtMesh) {
      this.scene.remove(this.skirtMesh)
      this.skirtMesh.geometry.dispose()
      ;(this.skirtMesh.material as THREE.Material).dispose()
      this.skirtMesh = null
    }
    if (this.mapProps) {
      this.scene.remove(this.mapProps.group)
      this.mapProps.dispose()
      this.mapProps = null
    }
    if (this.mapDecals) {
      this.scene.remove(this.mapDecals.group)
      this.mapDecals.dispose()
      this.mapDecals = null
    }
    if (this.runtimeDecals) {
      this.scene.remove(this.runtimeDecals.group)
      this.terrainNormals.scene.remove(this.runtimeDecals.normalsGroup)
      this.runtimeDecals.dispose()
      this.runtimeDecals = null
    }
    if (this.skyDome) {
      this.scene.remove(this.skyDome.group)
      this.skyDome.dispose()
      this.skyDome = null
    }
    if (this.envCube) {
      this.envCube.dispose()
      this.envCube = null
    }
    for (const t of this.envCubesByName.values()) t.dispose()
    this.envCubesByName.clear()
    this.shadow.reset()
  }

  /** SCM → BufferGeometry mit allen Attributen des Unit-Shaders (UV1,
   *  Tangenten, Bone-Index) — von setModel, addUnit und addWreck geteilt. */
  /** The unit geometry of an SCM (the attributes unit.vert.glsl reads). */
  scmGeometry(model: ScmModel): THREE.BufferGeometry {
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
    return geometry
  }

  setModel(model: ScmModel, textures: UnitTextures, teamColor: THREE.Color, shader = 'Unit'): void {
    this.clearContent()

    const geometry = this.scmGeometry(model)
    geometry.computeBoundingSphere()

    this.animator = new UnitAnimator(model)
    this.animPlaying = false
    this.animTime = 0

    const material = createUnitMaterial(textures, teamColor, this.animator.skinMatrices, shader)
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

  // -------------------------------------------------------------------------
  // Sandbox-API
  // -------------------------------------------------------------------------

  /** Fügt eine Einheit zur Szene hinzu (Terrain bleibt bestehen). */
  addUnit(
    model: ScmModel,
    textures: UnitTextures,
    teamColor: THREE.Color,
    shader = 'Unit',
  ): SceneUnit {
    const geometry = this.scmGeometry(model)

    const animator = new UnitAnimator(model)
    // Auf der Karte rechnen Einheiten mit dem KARTEN-Licht (mesh.fx
    // ComputeLight, dieselben scmap-Werte wie das Terrain) — ohne Karte
    // (Unit-Viewer-Werkzeug) mit dem Werkzeug-Fallback.
    const material = createUnitMaterial(
      textures,
      teamColor,
      animator.skinMatrices,
      shader,
      this.mapLighting ?? undefined,
      shader === 'Aeon' ? this.envCubeFor('Aeon') : this.envCube,
      this.insectLookup,
      this.shadow.uniforms,
    )
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    this.scene.add(mesh)
    // Units cast (depthTechnique 'Depth') — the depth variant shares the
    // bone matrix array, so animation reaches the shadow map.
    this.shadow.register(
      mesh,
      new THREE.ShaderMaterial({
        vertexShader: DEPTH_UNIT_VS,
        fragmentShader: DEPTH_FS,
        defines: { MAX_BONES: Math.max(animator.skinMatrices.length, 1) },
        uniforms: { boneMatrices: { value: animator.skinMatrices } },
        side: THREE.DoubleSide,
      }),
    )

    const unit = new SceneUnit(mesh, animator, model.bones.map((b) => b.name))
    this.units.push(unit)
    return unit
  }

  /**
   * The unit body material for a mesh blueprint's LOD, built exactly as
   * addUnit builds it (map light, env cube, insect lookup, shadow
   * uniforms) -- for a mesh swapped in at runtime (Unit:SetMesh, the
   * personal shield's OwnerShieldMesh).
   */
  unitMaterialFor(
    textures: UnitTextures,
    teamColor: THREE.Color,
    skinMatrices: THREE.Matrix4[],
    shader: string,
  ): THREE.ShaderMaterial {
    return createUnitMaterial(
      textures,
      teamColor,
      skinMatrices,
      shader,
      this.mapLighting ?? undefined,
      shader === 'Aeon' ? this.envCubeFor('Aeon') : this.envCube,
      this.insectLookup,
      this.shadow.uniforms,
    )
  }

  /** Das Licht der geladenen Karte — gesetzt in setMap, gelesen von addUnit. */
  private mapLighting: MapLighting | null = null

  /** Das Karten-Licht für Materialien, die außerhalb entstehen (Baustellen). */
  get lighting(): MapLighting | null {
    return this.mapLighting
  }

  /** Prop rendering stats of the current map (null before setMap). */
  get propStats(): { instances: number; blueprints: number; missing: string[] } | null {
    return this.mapProps?.stats ?? null
  }

  /** Sky dome diagnosis: number of loaded passes (null = no dome). */
  get skyInfo(): { passes: number } | null {
    return this.skyDome ? { passes: this.skyDome.group.children.length } : null
  }

  /**
   * Env cube for a faction: the scmap's named entry ('<aeon>'/'<seraphim>')
   * if present, else the '<default>' cube.
   */
  envCubeFor(faction: string): THREE.Texture | null {
    return this.envCubesByName.get(`<${faction.toLowerCase()}>`) ?? this.envCube
  }

  /**
   * Ein PROJEKTIL in die Szene — bewusst NICHT über addUnit: es gehört nicht
   * in die Trefferliste (ein fliegender Schuss darf keinen Auswahl-Klick
   * fangen) und braucht kein Skinning. Der Projektil-Shader der Engine ist
   * TMeshGlow (unbeleuchtet, Albedo pur — z. B. TDFGauss01_proj.bp:32); der
   * Glow-Anteil kommt mit dem Partikelsystem.
   */
  addProjectile(model: ScmModel, albedo: THREE.Texture | null, scale: number): THREE.Mesh {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(model.positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(model.normals, 3))
    geometry.setAttribute('uv', new THREE.BufferAttribute(model.uv0, 2))
    geometry.setIndex(new THREE.BufferAttribute(model.indices, 1))
    const material = new THREE.MeshBasicMaterial(
      albedo ? { map: albedo } : { color: 0xffddaa },
    )
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.scale.setScalar(scale)
    this.scene.add(mesh)
    return mesh
  }

  removeProjectile(mesh: THREE.Mesh): void {
    this.scene.remove(mesh)
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
  }

  /**
   * Ein WRACK in die Szene (mesh.fx technique Wreckage): das Unit-Mesh mit dem
   * Wreckage-Material — im Vertex-Shader verbeult, Albedo mit Wrack-Noise,
   * Karten-Licht ohne Schatten. Nicht über addUnit: Wracks stehen (noch) nicht
   * in der Treffer-/Auswahlliste — die Reclaim-Interaktion ist ein eigener,
   * dokumentiert offener Schritt.
   */
  addWreck(
    model: ScmModel,
    textures: UnitTextures,
    noise: THREE.Texture,
    scale: number,
    /** The game tick the prop was created on (material.x, ticks). */
    creationTick: number,
  ): THREE.Mesh {
    const geometry = this.scmGeometry(model)
    const animator = new UnitAnimator(model)
    const material = createWreckageMaterial(
      textures,
      noise,
      animator.skinMatrices,
      creationTick,
      this.mapLighting ?? undefined,
    )
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.scale.setScalar(scale)
    this.scene.add(mesh)
    return mesh
  }

  /** Ein Wrack wieder entfernen (Reclaim/Zerstörung). */
  removeWreck(mesh: THREE.Mesh): void {
    this.scene.remove(mesh)
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
  }

  /**
   * Eine Einheit wieder aus der Szene nehmen — inklusive der TREFFERLISTE.
   *
   * Das ist der Punkt: `mesh.visible = false` reicht nicht. Der Raycaster von
   * three.js prüft `visible` NICHT (Mesh.raycast tut es nicht) — ein nur
   * unsichtbar gemachtes Modell fängt weiter jeden Klick ab. Genau daran ist die
   * Bau-Vorschau hängen geblieben: nach dem ersten Bau-Modus saß ein
   * unsichtbarer Geist in der Liste und verschluckte die Auswahl der ACU.
   */
  removeUnit(unit: SceneUnit): void {
    const i = this.units.indexOf(unit)
    if (i >= 0) this.units.splice(i, 1)
    this.scene.remove(unit.mesh)
    unit.mesh.geometry.dispose()
    ;(unit.mesh.material as THREE.Material).dispose()
  }

  /**
   * Ist ein Update-Hook registriert? `clearContent()` (Karten-/Unit-Wechsel)
   * wirft alle Hooks weg. Wer sich das nur in einem eigenen Flag merkt, hat nach
   * dem zweiten Karten-Ladevorgang keinen Hook mehr und wundert sich, warum sich
   * nichts mehr bewegt — genau das war der Fall.
   */
  hasUpdateHooks(): boolean {
    return this.updateHooks.length > 0
  }

  onUpdate(hook: (dt: number) => void): void {
    this.updateHooks.push(hook)
  }

  /** Hilfsobjekt (Auswahl-Ring o. Ä.) — wird beim Szenenwechsel entfernt. */
  /** Die Welt-Kamera — das Partikelsystem braucht ihre Achsen (Billboard). */
  get worldCamera(): THREE.Camera {
    return this.camera
  }

  addHelper(obj: THREE.Object3D): void {
    this.scene.add(obj)
    this.helpers.push(obj)
  }

  /** Ein Hilfsobjekt gezielt entfernen (z. B. der Ring einer toten Einheit). */
  removeHelper(obj: THREE.Object3D): void {
    const i = this.helpers.indexOf(obj)
    if (i >= 0) this.helpers.splice(i, 1)
    this.scene.remove(obj)
  }

  /**
   * Nächstgelegene getroffene Einheit unter dem Cursor (oder null).
   *
   * NUR SICHTBARE zählen: der Raycaster von three.js prüft `visible` selbst
   * nicht — ein ausgeblendetes Modell (Bau-Geist, Wrack in der Todes-Animation)
   * würde sonst weiter Klicks abfangen.
   */
  pickUnit(clientX: number, clientY: number): SceneUnit | null {
    if (this.units.length === 0) return null
    const rect = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.camera)
    const hits = raycaster.intersectObjects(
      this.units.filter((u) => u.mesh.visible).map((u) => u.mesh),
      false,
    )
    const hit = hits[0]
    if (!hit) return null
    return this.units.find((u) => u.mesh === hit.object) ?? null
  }

  /** Höhe der aktuellen Karte an Weltposition (bilinear), 0 ohne Karte. */
  heightAt(x: number, z: number): number {
    const hf = this.heightfield
    if (!hf) return 0
    const cx = Math.min(Math.max(x, 0), hf.width - 0.001)
    const cz = Math.min(Math.max(z, 0), hf.height - 0.001)
    const x0 = Math.floor(cx)
    const z0 = Math.floor(cz)
    const fx = cx - x0
    const fz = cz - z0
    const stride = hf.width + 1
    const h00 = hf.data[z0 * stride + x0]!
    const h10 = hf.data[z0 * stride + x0 + 1]!
    const h01 = hf.data[(z0 + 1) * stride + x0]!
    const h11 = hf.data[(z0 + 1) * stride + x0 + 1]!
    return ((h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz) * hf.scale
  }

  /**
   * Schnittpunkt eines Bildschirm-Klicks mit dem Terrain (Raymarch gegen das
   * Heightfield mit binärer Verfeinerung). null ohne Karte/Treffer.
   */
  pickTerrain(clientX: number, clientY: number): THREE.Vector3 | null {
    const hf = this.heightfield
    if (!hf) return null
    const rect = this.canvas.getBoundingClientRect()
    const ndc = new THREE.Vector2(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    )
    const raycaster = new THREE.Raycaster()
    raycaster.setFromCamera(ndc, this.camera)
    const origin = raycaster.ray.origin
    const dir = raycaster.ray.direction

    const maxDist = Math.max(hf.width, hf.height) * 3
    const step = 1
    let prevT = 0
    let prevAbove = origin.y - this.heightAt(origin.x, origin.z) > 0
    for (let t = step; t < maxDist; t += step) {
      const px = origin.x + dir.x * t
      const pz = origin.z + dir.z * t
      const py = origin.y + dir.y * t
      const above = py - this.heightAt(px, pz) > 0
      if (prevAbove && !above) {
        // binäre Verfeinerung zwischen prevT und t
        let lo = prevT
        let hi = t
        for (let i = 0; i < 20; i++) {
          const mid = (lo + hi) / 2
          const mx = origin.x + dir.x * mid
          const mz = origin.z + dir.z * mid
          const my = origin.y + dir.y * mid
          if (my - this.heightAt(mx, mz) > 0) lo = mid
          else hi = mid
        }
        const hit = new THREE.Vector3(
          origin.x + dir.x * hi,
          0,
          origin.z + dir.z * hi,
        )
        if (hit.x < 0 || hit.z < 0 || hit.x > hf.width || hit.z > hf.height) return null
        hit.y = this.heightAt(hit.x, hit.z)
        return hit
      }
      prevAbove = above
      prevT = t
    }
    return null
  }

  /** Kamera auf eine Position ausrichten (RTS-artige Nahansicht). */
  focusOn(pos: THREE.Vector3, distance = 40): void {
    if (this.rts.enabled) {
      this.rts.goalTarget.copy(pos)
      this.rts.goalDist = distance
      return
    }
    const dir = new THREE.Vector3(0.4, 0.75, 0.65).normalize()
    this.camera.position.copy(pos).addScaledVector(dir, distance)
    // Clipping an die neue Distanz anpassen (frameObject setzt near für
    // Karten-Totalen sehr hoch — Nahsicht würde sonst weggeclippt)
    this.camera.near = Math.max(distance / 100, 0.05)
    this.camera.far = Math.max(this.camera.far, distance * 50)
    this.camera.updateProjectionMatrix()
    this.controls.target.copy(pos)
    this.controls.update()
  }

  /**
   * RTS-Kamera nach SupCom-Vorbild: Ziel auf dem Terrain, Zoomdistanz
   * bestimmt die Höhe; der Pitch ist an den Zoom gekoppelt (weit draußen
   * fast senkrecht von oben, nah am Boden flach). Mausrad zoomt zum
   * Cursor, Kanten-Scroll/Pfeiltasten/Mitteltaste schieben, Leertaste +
   * Maus rotiert. Alles exponentiell geglättet wie im Original.
   */
  /**
   * Die ConVars der Engine (ConExecute setzt sie; die Original-Optionen füttern
   * sie über optionslogic). Die Kamera LIEST sie — genau wie die C++-Seite, die
   * ui_KeyboardPanSpeed und cam_ZoomAmount in ihren Schleifen abfragt.
   */
  private readonly conVars = new Map<string, string | number | boolean>(
    // Die Startwerte sind in der Engine EINKOMPILIERT — sie stehen dort, bevor
    // eine einzige Zeile Lua läuft (`float Moho::cam_ZoomAmount = 0.4;`). Genau
    // deshalb kann man in FA die Kamera schon bewegen, bevor die UI oben ist.
    // Sobald optionslogic.Apply(true) durchläuft, überschreibt es sie mit den
    // gespeicherten Optionen (ConExecute → __uiConSink → setConVar).
    //
    // Alle Werte aus der Decomp, keiner geraten:
    Object.entries({
      cam_ZoomAmount: 0.40000001, // Cfile:421825
      cam_NearZoom: 5.0, // Cfile: float Moho::cam_NearZoom = 5.0
      cam_NearFOV: 65.0, // Cfile:421821 — vertical FOV (deg) at near zoom
      cam_FarFOV: 60.0, // Cfile:421822 — vertical FOV (deg) at far zoom
      cam_NearPitch: 40.0, // Cfile:421823 — camera pitch (deg) at near zoom
      cam_FarPitch: 89.900002, // Cfile:421824 — pitch (deg) at far zoom (top-down)
      cam_PanSpeed: 1.0, // Cfile: float Moho::cam_PanSpeed = 1.0
      ui_KeyboardPanSpeed: 90.0, // Cfile:421739
      ui_KeyboardPanAccelerateMultiplier: 4.0, // Cfile:421740
      ui_KeyboardRotateSpeed: 10.0, // Cfile:421741
      ui_KeyboardRotateAccelerateMultiplier: 2.0, // Cfile:421742
      ui_ScreenEdgeScrollView: true, // Cfile:421730
      // The camera shake multiplier -- read every frame by the RTS camera
      // (func_CameraImplUpdateShake), so it must exist before the UI VM's
      // ConExecute pass reaches the viewer.
      cam_ShakeMult: 1.0, // Cfile:421830
    }),
  )
  /** STRG beschleunigt Schwenken und Drehen (Cfile:1300005-1300007). */
  private ctrlDown = false

  /** The camera's shake (CameraImpl::mCamShakeParams and friends). */
  private readonly shake = new CameraShakeState()
  /** This frame's shake offset — drawn once per frame (UpdateCoords is the
   *  only caller of func_CameraImplUpdateShake, Cfile:1150657). */
  private shakeOffset: [number, number, number] = [0, 0, 0]

  /** CameraImpl::CameraShake, fed by the sim's Entity:ShakeCamera. */
  cameraShake(p: CamShakeParams): void {
    this.shake.request(p)
  }

  private rts = {
    enabled: false,
    target: new THREE.Vector3(),
    dist: 40,
    yaw: 0,
    pitchOffset: 0,
    goalTarget: new THREE.Vector3(),
    goalDist: 40,
    nearDist: 40,
    maxZoomMult: 1,
    transition: null as null | {
      startTarget: THREE.Vector3
      startDist: number
      elapsed: number
      seconds: number
    },
    goalYaw: 0,
    panX: 0,
    panZ: 0,
  }

  setRtsControls(enabled: boolean): void {
    this.rts.enabled = enabled
    this.controls.enabled = !enabled
    this.rts.transition = null
    if (enabled) {
      this.rts.target.copy(this.controls.target)
      this.rts.goalTarget.copy(this.controls.target)
      const d = this.camera.position.distanceTo(this.controls.target)
      this.rts.dist = d
      this.rts.goalDist = d
      this.rts.nearDist = d
      this.rts.yaw = 0
      this.rts.goalYaw = 0
      this.rts.pitchOffset = 0
    }
  }

  /**
   * Log-zoom lerp fraction (0 at cam_NearZoom, 1 at the map's max zoom) — the
   * domain CalculateFarPitch / CalculateFOV use (Cfile:1151061-1151072):
   * t = (clamp(log(zoom), log(near), log(max)) - log(near)) / (log(max) - log(near)).
   */
  private camZoomT(zoom: number): number {
    const ln = Math.log(this.conVarNumber('cam_NearZoom'))
    const lm = Math.log(this.rtsMaxZoom())
    if (!(lm > ln)) return 0
    const lz = Math.min(Math.max(Math.log(Math.max(zoom, 1e-6)), ln), lm)
    return (lz - ln) / (lm - ln)
  }

  private rtsPitch(zoom: number): number {
    // Camera pitch is a log-zoom lerp between cam_NearPitch (40 deg) and
    // cam_FarPitch (89.9 deg) — CalculateFarPitch, Cfile:1151074-1151077 * DEG2RAD.
    // The old sqrt curve (0.6..1.45 rad = 34..83 deg) was invented and never
    // reached the near-top-down far view.
    const deg =
      this.camZoomT(zoom) * (this.conVarNumber('cam_FarPitch') - this.conVarNumber('cam_NearPitch')) +
      this.conVarNumber('cam_NearPitch')
    return Math.min(Math.max(deg * 0.017453292 + this.rts.pitchOffset, 0.1), 1.553)
  }

  private updateRtsCamera(dt: number): void {
    const r = this.rts
    // Dauer-Pan (Kanten-Scroll/Pfeiltasten). Die Rechnung steht in der Engine
    // (Moho::CameraImpl::CameraPan, Cfile:1149107):
    //
    //   schritt = (mTargetZoom / Viewport-Höhe) · cam_PanSpeed · eingabe
    //
    // und `eingabe` ist ±ui_KeyboardPanSpeed (CUIWorldView, Cfile:1300002-1300066),
    // bei gedrücktem STRG mal ui_KeyboardPanAccelerateMultiplier. Beides sind die
    // Optionen „Tastatur-Schwenkgeschwindigkeit" und ihr Beschleuniger
    // (options.lua:200-227) — vorher stand hier `r.dist * 0.9`, eine erfundene
    // Zahl, und die beiden Regler taten nichts.
    //
    // Die Engine multipliziert NICHT mit der Bildzeit — sie pant pro BILD. Das
    // ist kein Versehen von uns; es ist das bekannte Verhalten von FA.
    if (r.panX !== 0 || r.panZ !== 0) {
      let input = this.conVarNumber('ui_KeyboardPanSpeed')
      if (this.ctrlDown) input *= this.conVarNumber('ui_KeyboardPanAccelerateMultiplier')
      // Scale by the TARGET zoom (mTargetZoom), not the current animating dist,
      // so a pan during a simultaneous zoom matches the engine (CameraPan,
      // Cfile:1149107).
      const speed = (r.goalDist / this.canvas.clientHeight) * this.conVarNumber('cam_PanSpeed') * input
      const cos = Math.cos(r.yaw)
      const sin = Math.sin(r.yaw)
      r.goalTarget.x += (r.panX * cos - r.panZ * sin) * speed
      r.goalTarget.z += (r.panZ * cos + r.panX * sin) * speed
    }
    const hf = this.heightfield
    if (hf) {
      r.goalTarget.x = Math.min(Math.max(r.goalTarget.x, 0), hf.width)
      r.goalTarget.z = Math.min(Math.max(r.goalTarget.z, 0), hf.height)
    }
    r.goalTarget.y = this.heightAt(r.goalTarget.x, r.goalTarget.z)

    const transition = r.transition
    if (transition) {
      transition.elapsed += Math.max(dt, 0)
      const progress = Math.min(transition.elapsed / transition.seconds, 1)
      // TargetBox starts a timed CameraImpl move. The default camera has
      // ease-in/out enabled, so use the zero-tangent Hermite form and finish
      // exactly at the requested duration (CameraImpl::TimedMoveInit/TargetBox).
      const eased = progress * progress * (3 - 2 * progress)
      r.target.lerpVectors(transition.startTarget, r.goalTarget, eased)
      r.dist = transition.startDist + (r.goalDist - transition.startDist) * eased
      if (progress === 1) {
        r.target.copy(r.goalTarget)
        r.dist = r.goalDist
        r.transition = null
      }
      this.applyRtsCameraTransform(true)
      return
    }

    // exponentielle Glättung
    const k = 1 - Math.exp(-10 * dt)
    r.target.lerp(r.goalTarget, k)
    r.dist += (r.goalDist - r.dist) * k
    let dy = r.goalYaw - r.yaw
    while (dy > Math.PI) dy -= 2 * Math.PI
    while (dy < -Math.PI) dy += 2 * Math.PI
    r.yaw += dy * k

    this.applyRtsCameraTransform(true)
  }

  /**
   * \param frame true from the per-frame update: the shake offset is drawn
   *   then (UpdateCoords, Cfile:1150657); other callers (zoom setter, target
   *   box) reuse this frame's draw.
   */
  private applyRtsCameraTransform(frame = false): void {
    const r = this.rts
    const pitch = this.rtsPitch(r.dist)
    // Vertical FOV varies with zoom too: cam_NearFOV(65 deg) near, cam_FarFOV
    // (60 deg) far (CalculateFOV, Cfile:1150863-1150866). The old fixed 45 deg
    // was markedly more telephoto than the original at every zoom.
    const fov =
      this.camZoomT(r.dist) * (this.conVarNumber('cam_FarFOV') - this.conVarNumber('cam_NearFOV')) +
      this.conVarNumber('cam_NearFOV')
    if (Math.abs(this.camera.fov - fov) > 1e-3) this.camera.fov = fov
    const horiz = Math.cos(pitch) * r.dist
    // The shake offset is added to the eye after the basis is computed
    // (func_CameraImplUpdateShake, Cfile:1151445-1151452) — the camera
    // translates, its orientation stays.
    if (frame) this.shakeOffset = this.shake.offset(r.target.x, r.target.z, this.conVarNumber('cam_ShakeMult'))
    const [sx, sy, sz] = this.shakeOffset
    this.camera.position.set(
      r.target.x + Math.sin(r.yaw) * horiz + sx,
      r.target.y + Math.sin(pitch) * r.dist + sy,
      r.target.z + Math.cos(r.yaw) * horiz + sz,
    )
    this.camera.near = Math.max(r.dist / 100, 0.05)
    this.camera.far = Math.max(2000, r.dist * 10)
    this.camera.updateProjectionMatrix()
    this.camera.lookAt(r.target.x + sx, r.target.y + sy, r.target.z + sz)
  }

  /**
   * CameraImpl::TargetBox: focus the box center and set target zoom to its
   * largest horizontal extent (Cfile:1150045-1150092).
   */
  rtsTargetBox(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    seconds = 0,
  ): void {
    if (!this.rts.enabled) throw new Error('Cannot target an RTS camera while RTS controls are disabled')
    const r = this.rts
    r.goalTarget.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5)
    r.goalDist = Math.max(maxX - minX, maxZ - minZ)
    r.nearDist = r.goalDist
    if (seconds === 0) {
      r.transition = null
      r.goalTarget.y = this.heightAt(r.goalTarget.x, r.goalTarget.z)
      r.target.copy(r.goalTarget)
      r.dist = r.goalDist
      this.applyRtsCameraTransform()
    } else if (seconds > 0) {
      r.transition = {
        startTarget: r.target.clone(),
        startDist: r.dist,
        elapsed: 0,
        seconds,
      }
    }
  }

  /** CameraImpl::TargetLocation restores the camera's current near zoom. */
  rtsTargetLocation(x: number, z: number): void {
    if (!this.rts.enabled) throw new Error('Cannot target an RTS camera while RTS controls are disabled')
    this.rts.goalTarget.set(x, this.heightAt(x, z), z)
    this.rts.goalDist = this.rts.nearDist
  }

  /**
   * Minimap coordinates use the same orthographic framing as mapCameraFor.
   * TargetLocation subsequently clamps the camera focus to the playable map.
   */
  rtsTargetFromMinimap(
    clientX: number,
    clientY: number,
    rect: { left: number; top: number; width: number; height: number },
  ): void {
    const hf = this.heightfield
    if (!hf) throw new Error('Cannot target an RTS camera from the minimap without terrain')
    if (rect.width <= 0 || rect.height <= 0) throw new Error('Cannot target an RTS camera from an empty minimap')
    const scale = Math.max(hf.width / rect.width, hf.height / rect.height)
    const x = (clientX - rect.left - rect.width * 0.5) * scale + hf.width * 0.5
    const z = (clientY - rect.top - rect.height * 0.5) * scale + hf.height * 0.5
    this.rtsTargetLocation(x, z)
  }

  /** The CameraImpl scalar getters exposed to UI Lua. */
  rtsCameraValue(what: string): number | undefined {
    const r = this.rts
    if (!r.enabled) return undefined
    switch (what) {
      case 'zoom':
        return r.dist
      case 'targetZoom':
        return r.nearDist
      case 'minZoom':
        return this.conVarNumber('cam_NearZoom')
      case 'maxZoom':
        return this.rtsMaxZoom()
      // Der Brennpunkt kommt in DREI Abfragen, je eine Zahl.
      //
      // Alles, was kein Primitivwert ist, kommt in dieser wasmoon-Fassung als
      // `js_proxy`-USERDATA in Lua an — nachgemessen: ein Array UND ein
      // einfaches Objekt, beide userdata (ProxyTypeExtension hat Prioritaet 3,
      // TableTypeExtension 0). Auf userdata laufen `#p`, `ipairs(p)` und der
      // FA-Dialekt `for i, v in p do` ins Leere, und `pairs(p)` reisst die
      // UI-VM um. Zahlen kommen dagegen sauber an — also drei davon, und die
      // Tabelle baut die Lua-Seite selbst (moho.lua, GetFocusPosition).
      case 'focusX':
        return r.target.x
      case 'focusY':
        return r.target.y
      case 'focusZ':
        return r.target.z
      default:
        return undefined
    }
  }

  /** The CameraImpl scalar setters exposed to UI Lua. */
  rtsSetCameraValue(what: string, value: number | boolean, seconds = 0): void {
    if (!this.rts.enabled) throw new Error('Cannot set an RTS camera while RTS controls are disabled')
    const r = this.rts
    if (what === 'maxZoomMult') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new Error('Invalid RTS camera max zoom multiplier')
      }
      r.maxZoomMult = value
      return
    }
    if (what !== 'zoom' && what !== 'targetZoom') return
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error('Invalid RTS camera zoom')
    }
    r.nearDist = value
    r.goalDist = value
    if (seconds === 0) {
      r.dist = value
      this.applyRtsCameraTransform()
    }
  }

  private rtsMaxZoom(): number {
    return (this.heightfield ? Math.max(this.heightfield.width, this.heightfield.height) * 1.4 : 800) *
      this.rts.maxZoomMult
  }

  /** Aktuelle Kamera-Zoomdistanz (für Strategic-Icon-Schwellen). */
  /**
   * The engine's "zoom": `dot(cam.mViewport.d[1], (cameraTarget, 1))`, i.e. the
   * world width the viewport spans at the depth of the camera TARGET
   * (Cfile:1284418-1284425). ui_LifebarLOD (200) and IconFadeInZoom are
   * compared against exactly this — not against the camera distance.
   */
  zoomOgrids(): number {
    const target = this.rts.enabled ? this.rts.target : this.controls.target
    const rect = this.canvas.getBoundingClientRect()
    return this.ogridsPerPixel(target.x, target.y, target.z) * rect.width
  }

  getRtsDistance(): number {
    return this.rts.enabled
      ? this.rts.dist
      : this.camera.position.distanceTo(this.controls.target)
  }

  /**
   * Mausrad: Zoom zum Cursor.
   *
   * Die Formel kommt aus der Engine (Moho::CameraImpl::CameraZoom, Cfile:1149978):
   *
   *   v4 = cam_ZoomAmount * delta * -0.69314718 * 1.442695…   (= -ln2 · log2e = -1)
   *   mNearZoom *= 2^v4                                        (F2XM1/FSCALE)
   *   clamp auf [cam_NearZoom, GetMaxZoom()]
   *
   * also schlicht: `dist *= 2^(-cam_ZoomAmount · delta)`, geklemmt.
   *
   * Vorher stand hier `Math.pow(1.25, ±1)` — eine erfundene Zahl. Und weil
   * `cam_ZoomAmount` die Option „Empfindlichkeit des Zoomrads" IST
   * (options.lua:85-96 → ConExecute("cam_ZoomAmount " .. value/100)), tat der
   * Regler bis eben nichts.
   */
  rtsZoom(wheelDelta: number, clientX: number, clientY: number): void {
    if (!this.rts.enabled) return
    const r = this.rts
    const oldDist = r.goalDist
    const zoomAmount = this.conVarNumber('cam_ZoomAmount')
    const nearZoom = this.conVarNumber('cam_NearZoom')
    // Vorzeichen: `wheelDelta` ist das DOM-`deltaY` — POSITIV heißt Rad nach
    // UNTEN, und das zoomt HERAUS. Die Engine-Formel verkleinert die Distanz bei
    // positivem delta (`dist *= 2^(-cam_ZoomAmount · delta)`), also muss das
    // Rad-Delta gedreht werden. Ohne diese Drehung war das Zoomen invertiert.
    const delta = wheelDelta > 0 ? -1 : 1
    const factor = Math.pow(2, -zoomAmount * delta)
    // GetMaxZoom() ist in der Engine kartenabhängig; hier ist es die Kartengröße.
    const maxDist = this.rtsMaxZoom()
    r.goalDist = Math.min(Math.max(r.goalDist * factor, nearZoom), maxDist)
    r.nearDist = r.goalDist
    const cursor = this.pickTerrain(clientX, clientY)
    if (cursor) {
      const shift = 1 - r.goalDist / oldDist
      r.goalTarget.x += (cursor.x - r.goalTarget.x) * shift
      r.goalTarget.z += (cursor.z - r.goalTarget.z) * shift
    }
  }

  /**
   * Eine ConVar der Engine (ConExecute setzt sie, die Original-Optionen füttern
   * sie). Fehlt sie, ist das ein Fehler — kein Anlass, eine Zahl zu erfinden.
   */
  private conVarNumber(name: string): number {
    const value = this.conVars.get(name)
    if (typeof value !== 'number') {
      throw new Error(`Kamera: ConVar "${name}" ist nicht gesetzt (setzt sie ConExecute?)`)
    }
    return value
  }

  private conVarBool(name: string): boolean {
    const value = this.conVars.get(name)
    // Die Konsole liefert 0/1 (options.lua setzt Zahlen) oder true/false.
    if (typeof value === 'number') return value !== 0
    return value === true
  }

  /**
   * Die Engine erfährt von einer geänderten ConVar (ConExecute → __uiConSink).
   * Genau so liest die C++-Seite ihre Werte: sie fragt die Variable, wenn sie sie
   * braucht — sie bekommt sie nicht „übergeben".
   */
  setConVar(name: string, value: string | number | boolean): void {
    this.conVars.set(name, value)
  }

  /** STRG gedrückt? Beschleunigt Schwenken/Drehen (MAUI_KeyIsDown(MKEY_CONTROL)). */
  setCtrlDown(down: boolean): void {
    this.ctrlDown = down
  }

  /**
   * Darf der Bildschirmrand die Ansicht verschieben? Die Engine fragt das an
   * genau dieser Stelle (`Moho::ui_ScreenEdgeScrollView`, Cfile:1300036) — es ist
   * die Option „Bildschirmrand verschiebt Hauptansicht" (options.lua:170-184).
   * Solange die UI-VM nicht läuft, gilt der Engine-Default (true, Cfile:421730).
   */
  edgeScroll(): boolean {
    return this.conVars.has('ui_ScreenEdgeScrollView')
      ? this.conVarBool('ui_ScreenEdgeScrollView')
      : true
  }

  /** Dürfen die Pfeiltasten schwenken? (`ui_ArrowKeysScrollView`, options.lua:185-199) */
  arrowKeysPan(): boolean {
    return this.conVars.has('ui_ArrowKeysScrollView')
      ? this.conVarBool('ui_ArrowKeysScrollView')
      : true
  }

  /** Dauer-Pan setzen (-1/0/1 je Achse; Kanten-Scroll & Pfeiltasten). */
  rtsSetPan(x: number, z: number): void {
    this.rts.panX = x
    this.rts.panZ = z
  }

  /** Direktes Verschieben (Mitteltaste-Drag), pixelproportional. */
  rtsDragPan(dxPixels: number, dyPixels: number): void {
    if (!this.rts.enabled) return
    const r = this.rts
    const scale = (r.dist * 1.4) / this.canvas.clientHeight
    const cos = Math.cos(r.yaw)
    const sin = Math.sin(r.yaw)
    const dx = -dxPixels * scale
    const dz = -dyPixels * scale
    r.goalTarget.x += dx * cos - dz * sin
    r.goalTarget.z += dz * cos + dx * sin
  }

  /** Kamera drehen (Leertaste + Maus). */
  rotateAroundTarget(dxPixels: number, dyPixels: number): void {
    if (this.rts.enabled) {
      this.rts.goalYaw -= dxPixels * 0.006
      this.rts.pitchOffset = Math.min(
        Math.max(this.rts.pitchOffset - dyPixels * 0.004, -0.9),
        0.5,
      )
      return
    }
    const offset = this.camera.position.clone().sub(this.controls.target)
    const spherical = new THREE.Spherical().setFromVector3(offset)
    spherical.theta -= dxPixels * 0.005
    spherical.phi = Math.min(Math.max(spherical.phi - dyPixels * 0.005, 0.08), Math.PI / 2 - 0.02)
    offset.setFromSpherical(spherical)
    this.camera.position.copy(this.controls.target).add(offset)
    this.controls.update()
  }

  /** Weltposition → Canvas-Client-Koordinaten (null wenn hinter der Kamera). */
  /**
   * The world width ONE PIXEL spans at that world position — the engine's
   * `dot(cam.mViewport.d[2], (pos, 1))`, where `d[2] = d[0] / viewportWidth`
   * and `d[0]·pos` is the world width the viewport spans at that depth
   * (Cfile:522779-522802). The selection brackets keep their minimum pixel
   * size with it (Cfile:1215269), the life bars their size (Cfile:1285308).
   */
  ogridsPerPixel(x: number, y: number, z: number): number {
    const cam = this.camera
    const forward = cam.getWorldDirection(new THREE.Vector3())
    const depth = new THREE.Vector3(x, y, z).sub(cam.position).dot(forward)
    if (!(depth > 0)) return 0
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0) return 0
    const worldHeight = 2 * depth * Math.tan(((cam.fov * Math.PI) / 180) / 2)
    return (worldHeight * cam.aspect) / rect.width
  }

  worldToScreen(pos: THREE.Vector3): { x: number; y: number } | null {
    const p = pos.clone().project(this.camera)
    if (p.z > 1) return null
    const rect = this.canvas.getBoundingClientRect()
    return {
      x: rect.left + ((p.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - p.y) / 2) * rect.height,
    }
  }

  async setMap(scmap: ScmapData, vfs: GameVfs): Promise<void> {
    this.clearContent()

    // Das Karten-Licht — für Terrain UND Einheiten dieselben scmap-Werte
    // (mesh.fx ComputeLight); vorher rechneten die Einheiten mit erfundenen
    // Konstanten und wirkten dunkel/fremd in der Szene.
    this.mapLighting = {
      sunDirection: new THREE.Vector3(...scmap.lighting.sunDirection).normalize(),
      sunColor: new THREE.Color(...scmap.lighting.sunColor),
      sunAmbience: new THREE.Color(...scmap.lighting.sunAmbience),
      shadowFillColor: new THREE.Color(...scmap.lighting.shadowFillColor),
      lightingMultiplier: scmap.lighting.lightingMultiplier,
    }
    // The map's glow amount feeds DoBloom's GlowCopyAdd each frame (see render()).
    this.mapBloom = scmap.lighting.bloom
    // Kein Distanznebel auf der Karte: der Fog gehört zum Unit-Viewer-Werkzeug
    // (Bodenraster-Optik). Im Original gibt es keinen solchen Nebel — er
    // tönte MeshBasic-Objekte (Projektile, Ringe) jenseits ~220 m dunkelblau.
    this.scene.fog = null

    const { width, height } = scmap
    this.heightfield = {
      data: scmap.heightmap,
      width,
      height,
      scale: scmap.heightScale,
    }
    const hmW = width + 1
    const hmH = height + 1

    // Shadow pass: ortho light camera along the map sun. The frustum
    // covers the highest terrain plus unit headroom.
    let maxHeightRaw = 0
    for (let i = 0; i < scmap.heightmap.length; i++) {
      if (scmap.heightmap[i]! > maxHeightRaw) maxHeightRaw = scmap.heightmap[i]!
    }
    this.shadow.setupForMap(
      width,
      height,
      new THREE.Vector3(...scmap.lighting.sunDirection).normalize(),
      maxHeightRaw * scmap.heightScale + 50,
    )

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

    // Stratum normal maps (terrain.fx TerrainNormalsPS/XP): lower + strata
    // 0-7, blended with the same masks as the albedos. Missing paths stay
    // null — the material then skips that blend step.
    const loadNormal = async (path: string): Promise<THREE.Texture | null> => {
      if (!path || !vfs.exists(path)) return null
      const tex = ddsToTexture(await vfs.read(path), this.s3tcSupported)
      tex.wrapS = THREE.RepeatWrapping
      tex.wrapT = THREE.RepeatWrapping
      return tex
    }
    const nLower = scmap.normalStrata[0]
    const nMid = scmap.normalStrata.slice(1, 9)
    const [lowerNormalTex, ...midNormalTex] = await Promise.all([
      loadNormal(nLower?.albedoPath ?? ''),
      ...nMid.map((s) => loadNormal(s?.albedoPath ?? '')),
    ])

    const embedded = (dds: Uint8Array | null): THREE.Texture => {
      if (!dds) return dummy
      // Eingebettete Masken/Watermaps haben dieselbe Zeilen-Orientierung
      // wie die Heightmap (numerisch verifiziert: scripts/check-orientation.ts)
      const tex = ddsToTexture(dds, this.s3tcSupported)
      tex.wrapS = THREE.ClampToEdgeWrapping
      tex.wrapT = THREE.ClampToEdgeWrapping
      return tex
    }
    const maskA = embedded(scmap.textureMaskLowDds)
    const maskB = embedded(scmap.textureMaskHighDds)
    const depthToG = fitDepthToG(scmap)
    const waterRamp =
      scmap.water.hasWater && scmap.water.texPathWaterRamp
        ? await loadLayer(scmap.water.texPathWaterRamp)
        : null

    const terrainOptions = {
      terrainShader: scmap.terrainShader,
      shadow: this.shadow.uniforms,
      normalBuffer: this.terrainNormals.uniforms,
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
        strataEnabled: mid.map((s) => (s?.albedoPath ? 1 : 0)),
      },
      normals: {
        lower: lowerNormalTex,
        strata: midNormalTex,
        lowerScale: nLower?.albedoScale || 4,
        strataScales: nMid.map((s) => s?.albedoScale || 4),
      },
      waterRamp,
      waterElevation: scmap.water.elevation,
      depthToG,
      lighting: {
        sunDirection: new THREE.Vector3(...scmap.lighting.sunDirection).normalize(),
        sunColor: new THREE.Color(...scmap.lighting.sunColor),
        sunAmbience: new THREE.Color(...scmap.lighting.sunAmbience),
        shadowFillColor: new THREE.Color(...scmap.lighting.shadowFillColor),
        specularColor: new THREE.Vector4(...scmap.lighting.specularColor),
        lightingMultiplier: scmap.lighting.lightingMultiplier,
      },
    }
    const material = createTerrainMaterial(terrainOptions)

    const geometry = buildTerrainGrid(width, height)
    const mesh = new THREE.Mesh(geometry, material)
    this.scene.add(mesh)
    this.current = mesh

    // The deferred normal pass: a second mesh over the SAME grid renders
    // the blended stratum normal into the screen-space buffer
    // (TerrainNormalsPS); the main material reads it back.
    const normalsMesh = new THREE.Mesh(
      geometry,
      createTerrainMaterial(terrainOptions, 'normals'),
    )
    this.terrainNormals.scene.add(normalsMesh)

    // Decals: albedo (type 1, TDecals/TDecalsXP) into the frame, normals
    // (type 2, TDecalsNormals) into the normal buffer.
    const decalUniforms: DecalSceneUniforms = {
      heightTex,
      heightScale: scmap.heightScale,
      hmUvScale: new THREE.Vector2((hmW - 1) / hmW, (hmH - 1) / hmH),
      hmUvOffset: new THREE.Vector2(0.5 / hmW, 0.5 / hmH),
      hmTexel: new THREE.Vector2(1 / hmW, 1 / hmH),
      mapSize: new THREE.Vector2(width, height),
      waterRamp,
      waterElevation: scmap.water.elevation,
      depthToG,
      xpShader: scmap.terrainShader === 'TTerrainXP',
      shadow: this.shadow.uniforms,
      normalBuffer: this.terrainNormals.uniforms,
      lighting: {
        sunDirection: new THREE.Vector3(...scmap.lighting.sunDirection).normalize(),
        sunColor: new THREE.Color(...scmap.lighting.sunColor),
        sunAmbience: new THREE.Color(...scmap.lighting.sunAmbience),
        shadowFillColor: new THREE.Color(...scmap.lighting.shadowFillColor),
        specularColor: new THREE.Vector4(...scmap.lighting.specularColor),
        lightingMultiplier: scmap.lighting.lightingMultiplier,
      },
    }
    this.mapDecals = await MapDecals.load(scmap.decals, vfs, decalUniforms, this.s3tcSupported)
    this.scene.add(this.mapDecals.group)
    this.terrainNormals.scene.add(this.mapDecals.normalsGroup)
    // The runtime splats and decals (CreateSplat / CreateDecal) share the
    // terrain's uniforms and the map decals' techniques; the session feeds
    // them per beat (runtimeDecals.ts).
    this.runtimeDecals = new RuntimeDecals(decalUniforms, vfs, this.s3tcSupported, (x, z) => this.heightAt(x, z))
    this.scene.add(this.runtimeDecals.group)
    this.terrainNormals.scene.add(this.runtimeDecals.normalsGroup)
    if (this.mapDecals.stats.instances > 0 || this.mapDecals.stats.normalInstances > 0) {
      console.log(
        `map decals: ${this.mapDecals.stats.instances} albedo instances, ` +
          `${this.mapDecals.stats.normalInstances} normal instances, ` +
          `${this.mapDecals.stats.textures} texture sets` +
          (this.mapDecals.stats.skippedTypes.size > 0
            ? `, skipped ${[...this.mapDecals.stats.skippedTypes]
                .map(([t, n]) => `type${t}=${n}`)
                .join(' ')}`
            : ''),
      )
    }

    if (scmap.water.hasWater) {
      const waterGeo = new THREE.PlaneGeometry(width, height)
      waterGeo.rotateX(-Math.PI / 2)
      waterGeo.translate(width / 2, scmap.water.elevation, height / 2)

      // The four scrolling wave normal maps (water2.fx layers).
      const waves = await Promise.all(
        scmap.water.waveNormals.map(async (w) => ({
          texture: await loadLayer(w.path.replace(/^\//, '').toLowerCase()),
          movement: new THREE.Vector2(w.movementX, w.movementY),
          repeat: w.repeat,
        })),
      )
      // Baked water texture = UtilitySamplerC (R flatness, G depth, B mask,
      // A 1-foam) — embedded in the scmap like the splat masks.
      const waterMapTex = embedded(scmap.waterMapDds)
      // Sky cubemap for texCUBE(SkySampler, reflect(view, N)).
      const skyPath = scmap.water.texPathCubemap.replace(/^\//, '').toLowerCase()
      const skyCube = vfs.exists(skyPath)
        ? ddsToCubeTexture(await vfs.read(skyPath), this.s3tcSupported)
        : null
      if (!skyCube) console.warn(`water sky cube not found: ${skyPath}`)

      const waterMat = createWaterMaterial({
        heightTex,
        heightScale: scmap.heightScale,
        hmWidth: hmW,
        hmHeight: hmH,
        mapWidth: width,
        mapHeight: height,
        elevation: scmap.water.elevation,
        depthToG,
        colorLerpMin: scmap.water.colorLerpMin,
        colorLerpMax: scmap.water.colorLerpMax,
        surfaceColor: new THREE.Color(...scmap.water.surfaceColor),
        fresnelBias: scmap.water.fresnelBias,
        fresnelPower: scmap.water.fresnelPower,
        skyReflectionAmount: scmap.water.skyReflection,
        sunShininess: scmap.water.sunShininess,
        // The water block carries its OWN sun (water2.fx SunDirection). The
        // engine sends it RAW — water2 LoadShaderVars SetMem(SunDirection, 3,
        // a5+100) with no normalize (Cfile:1229482); normalizing here shifts the
        // glint whenever the map value is not unit-length.
        sunDirection: new THREE.Vector3(...scmap.water.sunDirection),
        // water2 pre-multiplies SunColor by SunReflectionAmount before handing
        // it to the shader (Cfile:1229484-1229491: v30 = sunColor.y * a5+124),
        // so the glint scales with the map's SunReflection (often ~5).
        sunColor: new THREE.Color(...scmap.water.sunColor).multiplyScalar(
          scmap.water.sunReflection,
        ),
        waterMap: waterMapTex,
        waves,
        skyCube: skyCube ?? dummy,
      })
      this.waterMesh = new THREE.Mesh(waterGeo, waterMat)
      // Water draws AFTER the decal patches (both are blended; the decals
      // belong to the terrain surface below the water plane).
      this.waterMesh.renderOrder = 2
      this.scene.add(this.waterMesh)
    }

    // Sky dome (sky.fx Atmosphere/Decal/Cirrus, M9) from the v60 skybox
    // block — draws first, without depth, behind everything.
    if (scmap.skybox) {
      this.skyDome = await SkyDome.load(scmap.skybox, vfs, this.s3tcSupported)
      this.scene.add(this.skyDome.group)
    }

    // Terrain skirt (terrain.fx TerrainSkirtPS :584): constant dark grey
    // outside the map. The engine builds the skirt strip on the C++ side
    // (HighFidelityTerrain::DrawTerrainSkirt :489); a large ground quad
    // under the map gives the same constant-grey surround.
    const skirtGeo = new THREE.PlaneGeometry(width * 9, height * 9)
    skirtGeo.rotateX(-Math.PI / 2)
    skirtGeo.translate(width / 2, -0.02, height / 2)
    this.skirtMesh = new THREE.Mesh(
      skirtGeo,
      new THREE.ShaderMaterial({ vertexShader: SKIRT_VS, fragmentShader: SKIRT_FS }),
    )
    this.scene.add(this.skirtMesh)

    // The map's environment cube — Moho::MeshEnvironment resolves the
    // '<default>' entry of the scmap envCubes list (engine default
    // /textures/environment/defaultenvcube.dds, Cfile:1189598). It feeds
    // the environmentSampler term of unit and prop materials.
    const envEntry =
      scmap.envCubes.find((e) => e.name === '<default>') ?? scmap.envCubes[0]
    const envPath = (envEntry?.path ?? '/textures/environment/defaultenvcube.dds')
      .replace(/^\//, '')
      .toLowerCase()
    if (vfs.exists(envPath)) {
      this.envCube = ddsToCubeTexture(await vfs.read(envPath), this.s3tcSupported)
    } else {
      console.warn(`env cube not found: ${envPath}`)
      this.envCube = null
    }
    // The named entries ('<aeon>', '<seraphim>') feed the faction shaders
    // (e.g. the SeraphimBuild environment term).
    for (const e of scmap.envCubes) {
      const p = e.path.replace(/^\//, '').toLowerCase()
      if (e.name !== '<default>' && vfs.exists(p)) {
        this.envCubesByName.set(e.name, ddsToCubeTexture(await vfs.read(p), this.s3tcSupported))
      }
    }
    // The Cybran 'Insect' unit shader needs its aniso lookup (Cfile:1194790).
    if (!this.insectLookup && vfs.exists('textures/engine/insectlookup.dds')) {
      this.insectLookup = ddsToTexture(
        await vfs.read('textures/engine/insectlookup.dds'),
        this.s3tcSupported,
      )
      this.insectLookup.wrapS = THREE.ClampToEdgeWrapping
      this.insectLookup.wrapT = THREE.ClampToEdgeWrapping
    }

    // Map props (trees, rocks) — one InstancedMesh per blueprint, lit with
    // the same scmap values as terrain and units (render-details.md par. 2).
    this.mapProps = await MapProps.load(
      scmap.props,
      vfs,
      this.mapLighting,
      this.s3tcSupported,
      this.envCube,
      this.shadow.uniforms,
    )
    this.scene.add(this.mapProps.group)
    for (const c of this.mapProps.casters) this.shadow.register(c.mesh, c.depthMaterial)
    if (this.mapProps.stats.instances > 0) {
      console.log(
        `map props: ${this.mapProps.stats.instances} instances, ` +
          `${this.mapProps.stats.blueprints} blueprints`,
      )
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
 * Fittet die Skalierung Welttiefe → Watermap-G per linearer Regression gegen
 * die gebackene Watermap der Karte (typisch ≈ 1/15, R² > 0,99). Der Shader
 * rechnet die Tiefe dann aus der Höhe — gleicher Verlauf wie das Original,
 * aber ohne DXT-Kompressionslöcher.
 */
function fitDepthToG(scmap: ScmapData): number {
  const FALLBACK = 1 / 15
  if (!scmap.water.hasWater || !scmap.waterMapDds) return FALLBACK
  try {
    const wm = parseDds(scmap.waterMapDds)
    const mip = wm.mips[0]!
    const rgba =
      wm.format === 'BGRA8'
        ? bgraToRgba(mip.data)
        : decodeDxt(mip.data, wm.width, wm.height, wm.format)

    const stride = scmap.width + 1
    let n = 0
    let sx = 0
    let sy = 0
    let sxx = 0
    let sxy = 0
    const step = Math.max(1, Math.floor(wm.width / 128))
    for (let wz = 0; wz < wm.height; wz += step) {
      for (let wx = 0; wx < wm.width; wx += step) {
        const x = Math.min(scmap.width - 1, Math.floor((wx / wm.width) * scmap.width))
        const z = Math.min(scmap.height - 1, Math.floor((wz / wm.height) * scmap.height))
        const depth = scmap.water.elevation - scmap.heightmap[z * stride + x]! * scmap.heightScale
        if (depth <= 0.1) continue
        const g = rgba[(wz * wm.width + wx) * 4 + 1]! / 255
        n++
        sx += depth
        sy += g
        sxx += depth * depth
        sxy += depth * g
      }
    }
    if (n < 50) return FALLBACK
    const a = (n * sxy - sx * sy) / (n * sxx - sx * sx)
    return a > 0.005 && a < 1 ? a : FALLBACK
  } catch {
    return FALLBACK
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
