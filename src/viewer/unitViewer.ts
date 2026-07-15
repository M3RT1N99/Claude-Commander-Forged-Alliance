import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { ScmModel } from '../formats/scm'
import type { ScmapData } from '../formats/scmap'
import type { GameVfs } from '../vfs/vfs'
import { createUnitMaterial, type UnitTextures } from './unitMaterial'
import { createTerrainMaterial } from './terrainMaterial'
import { createWaterMaterial } from './waterMaterial'
import { ddsToTexture } from './textures'
import { parseDds } from '../formats/dds'
import { bgraToRgba, decodeDxt } from '../formats/dxt'
import { UnitAnimator } from '../anim/animator'
import type { ScaAnim } from '../formats/sca'

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
      for (const hook of this.updateHooks) hook(dt)
      for (const unit of this.units) unit.update(dt)
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

    // Keine WorldView (Unit-Viewer, Karten-Viewer): die ganze Fläche.
    if (this.worldViewRects.length === 0) {
      this.renderer.setScissorTest(false)
      this.renderer.setViewport(0, 0, width, height)
      this.renderer.render(this.scene, this.camera)
      return
    }

    this.renderer.setScissorTest(true)
    this.renderer.clear()
    for (const view of this.worldViewRects) {
      const w = Math.max(1, Math.round(view.width))
      const h = Math.max(1, Math.round(view.height))
      const x = Math.round(view.left)
      // WebGL zählt von UNTEN, die UI von oben.
      const y = Math.round(height - view.top - view.height)
      this.renderer.setViewport(x, y, w, h)
      this.renderer.setScissor(x, y, w, h)

      if (view.cartographic) {
        this.renderer.render(this.scene, this.mapCameraFor(w, h))
      } else {
        this.camera.aspect = w / h
        this.camera.updateProjectionMatrix()
        this.renderer.render(this.scene, this.camera)
      }
    }
    this.renderer.setScissorTest(false)
    void dpr
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
    if (this.waterMesh) {
      this.scene.remove(this.waterMesh)
      this.waterMesh.geometry.dispose()
      ;(this.waterMesh.material as THREE.Material).dispose()
      this.waterMesh = null
    }
  }

  setModel(model: ScmModel, textures: UnitTextures, teamColor: THREE.Color, shader = 'Unit'): void {
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

    const animator = new UnitAnimator(model)
    const material = createUnitMaterial(textures, teamColor, animator.skinMatrices, shader)
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    this.scene.add(mesh)

    const unit = new SceneUnit(mesh, animator, model.bones.map((b) => b.name))
    this.units.push(unit)
    return unit
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
  addHelper(obj: THREE.Object3D): void {
    this.scene.add(obj)
    this.helpers.push(obj)
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
      cam_PanSpeed: 1.0, // Cfile: float Moho::cam_PanSpeed = 1.0
      ui_KeyboardPanSpeed: 90.0, // Cfile:421739
      ui_KeyboardPanAccelerateMultiplier: 4.0, // Cfile:421740
      ui_KeyboardRotateSpeed: 10.0, // Cfile:421741
      ui_KeyboardRotateAccelerateMultiplier: 2.0, // Cfile:421742
      ui_ScreenEdgeScrollView: true, // Cfile:421730
    }),
  )
  /** STRG beschleunigt Schwenken und Drehen (Cfile:1300005-1300007). */
  private ctrlDown = false

  private rts = {
    enabled: false,
    target: new THREE.Vector3(),
    dist: 40,
    yaw: 0,
    pitchOffset: 0,
    goalTarget: new THREE.Vector3(),
    goalDist: 40,
    goalYaw: 0,
    panX: 0,
    panZ: 0,
  }

  setRtsControls(enabled: boolean): void {
    this.rts.enabled = enabled
    this.controls.enabled = !enabled
    if (enabled) {
      this.rts.target.copy(this.controls.target)
      this.rts.goalTarget.copy(this.controls.target)
      const d = this.camera.position.distanceTo(this.controls.target)
      this.rts.dist = d
      this.rts.goalDist = d
      this.rts.yaw = 0
      this.rts.goalYaw = 0
      this.rts.pitchOffset = 0
    }
  }

  private rtsPitch(dist: number): number {
    // Original-Gefühl: oberhalb ~60 Einheiten Draufsicht, darunter kippen
    const t = Math.min(Math.max((dist - 6) / 54, 0), 1)
    const base = 0.6 + (1.45 - 0.6) * Math.sqrt(t)
    return Math.min(Math.max(base + this.rts.pitchOffset, 0.35), 1.5)
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
      const speed = (r.dist / this.canvas.clientHeight) * this.conVarNumber('cam_PanSpeed') * input
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

    // exponentielle Glättung
    const k = 1 - Math.exp(-10 * dt)
    r.target.lerp(r.goalTarget, k)
    r.dist += (r.goalDist - r.dist) * k
    let dy = r.goalYaw - r.yaw
    while (dy > Math.PI) dy -= 2 * Math.PI
    while (dy < -Math.PI) dy += 2 * Math.PI
    r.yaw += dy * k

    const pitch = this.rtsPitch(r.dist)
    const horiz = Math.cos(pitch) * r.dist
    this.camera.position.set(
      r.target.x + Math.sin(r.yaw) * horiz,
      r.target.y + Math.sin(pitch) * r.dist,
      r.target.z + Math.cos(r.yaw) * horiz,
    )
    this.camera.near = Math.max(r.dist / 100, 0.05)
    this.camera.far = Math.max(2000, r.dist * 10)
    this.camera.updateProjectionMatrix()
    this.camera.lookAt(r.target)
  }

  /** Aktuelle Kamera-Zoomdistanz (für Strategic-Icon-Schwellen). */
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
    const maxDist = this.heightfield
      ? Math.max(this.heightfield.width, this.heightfield.height) * 1.4
      : 800
    r.goalDist = Math.min(Math.max(r.goalDist * factor, nearZoom), maxDist)
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

    const { width, height } = scmap
    this.heightfield = {
      data: scmap.heightmap,
      width,
      height,
      scale: scmap.heightScale,
    }
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
        strataEnabled: mid.map((s) => (s?.albedoPath ? 1 : 0)),
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
    })

    const geometry = buildTerrainGrid(width, height)
    const mesh = new THREE.Mesh(geometry, material)
    this.scene.add(mesh)
    this.current = mesh

    if (scmap.water.hasWater) {
      const waterGeo = new THREE.PlaneGeometry(width, height)
      waterGeo.rotateX(-Math.PI / 2)
      waterGeo.translate(width / 2, scmap.water.elevation, height / 2)
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
        sunDirection: new THREE.Vector3(...scmap.lighting.sunDirection).normalize(),
        sunColor: new THREE.Color(...scmap.lighting.sunColor),
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
