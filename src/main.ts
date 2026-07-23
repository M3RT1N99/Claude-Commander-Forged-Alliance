import * as THREE from 'three'
import {
  FsaGameSource,
  FileListGameSource,
  HttpGameSource,
  loadDirHandle,
  saveDirHandle,
  type GameSource,
} from './vfs/gameSource'
import { GameVfs } from './vfs/vfs'
import { parseScm, type ScmModel } from './formats/scm'
import { ParticleSystem } from './viewer/particles'
import { TrailSystem, type TrailBpData } from './viewer/trails'
import { BeamSystem, type BeamBpData } from './viewer/beams'
import { GameAudio } from './ui/audio'
import { EmitterRuntime, type EmitterBpData } from './effects/emitterRuntime'
import { parseSca } from './formats/sca'
import { parseScmap } from './formats/scmap'
import { resolveUnitPaths } from './formats/unitPaths'
import {
  parseBlueprint,
  parseLuaAssignments,
  bpGet,
  stripLoc,
  type BpObject,
} from './formats/blueprint'
import { ddsToTexture } from './viewer/textures'
import { UnitViewer, type SceneUnit } from './viewer/unitViewer'
import { SandboxController, type SandboxUnitAssets } from './sandbox/sandbox'
import { LuaSimClient, type LuaPropSnapshot } from './sim/luaSimClient'
import { SANDBOX_SESSION, type SessionInfo } from './sim/session'
import type { HeightfieldData } from './sim/terrain'
import { Hud, type HudSource, type HudUnitInfo, type EcoSnapshot } from './ui/hud'
import { GameUi } from './ui/gameUi'
import { BuildPreview } from './ui/buildPreview'
import type { ScmapData } from './formats/scmap'
import {
  createUefBuildMaterials,
  createFactionBuildMaterials,
  type UnitTextures,
} from './viewer/unitMaterial'
import { OrderLineSystem, type OrderLineEntry } from './viewer/orderLines'
import { CommandFeedbackSystem, type BlipAssets } from './viewer/commandFeedback'

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`UI element missing: ${sel}`)
  return el
}

const logEl = $<HTMLPreElement>('#log')
const sourceLabel = $('#source-label')
const btnPickDir = $<HTMLButtonElement>('#btn-pick-dir')
const btnResume = $<HTMLButtonElement>('#btn-resume')
const btnFallback = $<HTMLButtonElement>('#btn-fallback')
const inputDir = $<HTMLInputElement>('#input-dir')
const unitPanel = $('#unit panel')
const mapPanel = $('#map-panel')
const sandboxPanel = $('#sandbox-panel')
const startPanel = $('#start-panel')
const menuItems = [...document.querySelectorAll<HTMLButtonElement>('#menu .menu-item')]
const badgeUnits = $('#badge units')
const badgeMaps = $('#badge-maps')
const btnCollapse = $<HTMLButtonElement>('#btn-collapse')
const btnSandboxStart = $<HTMLButtonElement>('#btn-sandbox-start')
const sandboxInfo = $('#sandbox-info')
const mapSelect = $<HTMLSelectElement>('#map-select')
const mapInfo = $('#map-info')
const unitSearch = $<HTMLInputElement>('#unit search')
const unitSelect = $<HTMLSelectElement>('#unit-select')
const teamColorInput = $<HTMLInputElement>('#team-color')
const animSelect = $<HTMLSelectElement>('#anim-select')
const unitInfo = $('#unit info')

function log(msg: string): void {
  logEl.textContent += msg + '\n'
  logEl.scrollTop = logEl.scrollHeight
  console.log('[CFA]', msg)
}

const viewer = new UnitViewer($<HTMLCanvasElement>('#viewport'))
let vfs: GameVfs | null = null
let source: GameSource | null = null
let unitIds: string[] = []
let currentModel: ScmModel | null = null

// ---------------------------------------------------------------------------
// Quellen-Verbindung
// ---------------------------------------------------------------------------

async function connect(src: GameSource): Promise<void> {
  try {
    source = src
    log(`Verbinde: ${src.label}`)
    log(viewer.s3tcSupported ? 'GPU: S3TC/DXT nativ' : 'GPU: DXT-Software-Dekodierung')
    vfs = await GameVfs.mount(src, log)
    sourceLabel.textContent = src.label

    unitIds = vfs
      .find((p) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(p))
      .map((p) => p.split('/')[1]!)
      .sort()
    log(`${unitIds.length} units found`)

    // From now on all menu items are accessible; the counters show what the
    // Spieldaten hergeben.
    for (const item of menuItems) item.disabled = false
    badgeUnits.textContent = String(unitIds.length)
    badgeUnits.hidden = false
    renderUnitList('')
    await populateMapList(src)

    const params = new URLSearchParams(location.search)
    // ?frontend — directly to the real main menu (menus/main.lua), without a detour
    // the launcher. The same path that the menu item takes.
    if (params.has('frontend')) {
      await startFrontEndUi()
      return
    }
    const wantedSandbox = params.get('sandbox')
    if (wantedSandbox) {
      await startSandbox(wantedSandbox)
      const extraSpawns = params.get('spawn')
      if (extraSpawns) {
        for (const id of extraSpawns.split(',')) await spawnViaLua(id.trim().toLowerCase())
      }
      if (params.has('luaspawn')) {
        await spawnViaLua(params.get('luaspawn') || 'uel0001')
      }
      return
    }
    const wantedMap = params.get('map')
    if (wantedMap) {
      setMode('maps')
      mapSelect.value = wantedMap
      await loadMap(wantedMap)
      return
    }
    const wanted = params.get('unit') ?? 'uel0001'
    setMode('units')
    if (unitIds.includes(wanted.toLowerCase())) {
      unitSelect.value = wanted.toLowerCase()
      await loadUnit(wanted.toLowerCase())
    }
  } catch (err) {
    log(`ERROR: ${err instanceof Error ? err.message : err}`)
  }
}

async function populateMapList(src: GameSource): Promise<void> {
  try {
    const entries = await src.list('maps')
    mapSelect.innerHTML = ''
    for (const e of entries.filter((e) => e.dir).sort((a, b) => a.name.localeCompare(b.name))) {
      const opt = document.createElement('option')
      opt.value = e.name
      opt.textContent = e.name
      mapSelect.appendChild(opt)
    }
    badgeMaps.textContent = String(mapSelect.options.length)
    badgeMaps.hidden = false
    log(`${mapSelect.options.length} cards found`)
  } catch (err) {
    log(`Card list not available: ${err instanceof Error ? err.message : err}`)
  }
}

type Mode = 'start' | 'units' | 'maps' | 'sandbox' | 'frontend'

function setMode(mode: Mode): void {
  for (const item of menuItems) item.classList.toggle('active', item.dataset.mode === mode)
  startPanel.hidden = mode !== 'start'
  unitPanel.hidden = mode !== 'units'
  mapPanel.hidden = mode !== 'maps'
  sandboxPanel.hidden = mode !== 'sandbox'
}

/**
 * Das echte Hauptmenü des Spiels.
 *
 * Nichts davon ist nachgebaut: `menus/main.lua` baut sich selbst, sobald die
 * Engine `uimain.StartFrontEndUI()` ruft (Cfile:1262476). Es läuft im Vollbild,
 * weil das Original-Layout gegen den Root-Frame rechnet — also gegen die
 * Fenstergröße.
 *
 * Die Frame-Pumpe ist hier Pflicht, nicht Kosmetik: die Einfahr-Animation, die
 * Knopf-Freigabe (main.lua:621) und der Lauftext hängen alle an `OnFrame`.
 */
let frontEndFrame = 0
async function startFrontEndUi(): Promise<void> {
  if (!vfs) return
  setMode('frontend')
  try {
    gameUi?.dispose()
    gameUi = await GameUi.create(vfs, await loadGameFonts(), log, 'frontend', conVarChanged)
    gameUi.attachEvents()
    setIngame(true)

    // GameUi.render() catches Lua errors itself and reports each one exactly once
    // (like the engine: CMauiControl::Frame → RunScript → log errors,
    // continue running). The loop can therefore simply continue to run.
    let last = performance.now()
    const tick = (now: number): void => {
      const delta = Math.min((now - last) / 1000, 0.1)
      last = now
      gameUi?.render(delta)
      frontEndFrame = requestAnimationFrame(tick)
    }
    cancelAnimationFrame(frontEndFrame)
    frontEndFrame = requestAnimationFrame(tick)
    log('Hauptmenü läuft (menus/main.lua)')
  } catch (err) {
    log(`ERROR in the main menu: ${err instanceof Error ? err.message : err}`)
    setIngame(false)
    setMode('start')
  }
}

function renderUnitList(filter: string): void {
  const f = filter.toLowerCase()
  unitSelect.innerHTML = ''
  for (const id of unitIds) {
    if (f && !id.includes(f)) continue
    const opt = document.createElement('option')
    opt.value = id
    opt.textContent = id.toUpperCase()
    unitSelect.appendChild(opt)
  }
}

// ---------------------------------------------------------------------------
// Load unit
// ---------------------------------------------------------------------------

function currentTeamColor(): THREE.Color {
  return new THREE.Color(teamColorInput.value)
}

async function loadTexture(path: string): Promise<THREE.Texture | null> {
  if (!vfs || !vfs.exists(path)) return null
  return ddsToTexture(await vfs.read(path), viewer.s3tcSupported)
}

async function loadFirstTexture(paths: string[]): Promise<THREE.Texture | null> {
  for (const p of paths) {
    const tex = await loadTexture(p)
    if (tex) return tex
  }
  return null
}

async function loadUnitAssets(
  id: string,
): Promise<{ model: ScmModel; textures: UnitTextures; bp: BpObject; shader: string } | null> {
  if (!vfs) return null
  const bp = parseBlueprint(await vfs.readText(`units/${id}/${id}_unit.bp`))

  const paths = resolveUnitPaths(id, bp, (p) => vfs!.exists(p))
  if (!paths) {
    log(`${id.toUpperCase()} has no mesh (placeholder unit)`)
    return null
  }
  if (!vfs.exists(paths.mesh)) {
    log(`Mesh not found for ${id.toUpperCase()}: ${paths.mesh}`)
    return null
  }
  const model = parseScm(await vfs.read(paths.mesh))

  const albedo = await loadFirstTexture(paths.albedo)
  const normals = await loadFirstTexture(paths.normals)
  const specTeam = await loadFirstTexture(paths.specTeam)
  const lookup = paths.shader === 'Seraphim' ? await loadFirstTexture(paths.lookup) : null

  if (!albedo) log(`No albedo texture for ${id.toUpperCase()} — render gray`)
  const fallbackAlbedo = new THREE.DataTexture(new Uint8Array([140, 140, 145, 255]), 1, 1)
  fallbackAlbedo.needsUpdate = true

  return {
    model,
    textures: { albedo: albedo ?? fallbackAlbedo, normals, specTeam, lookup },
    bp,
    shader: paths.shader,
  }
}

async function loadUnit(id: string): Promise<void> {
  if (!vfs) return
  try {
    sandbox = null
    hud?.dispose()
    hud = null
    viewer.setRtsControls(false)
    log(`Lade ${id.toUpperCase()}…`)
    const assets = await loadUnitAssets(id)
    if (!assets) return
    const { model, textures, bp } = assets
    showUnitInfo(id, bp)

    viewer.setModel(model, textures, currentTeamColor(), assets.shader)
    currentModel = model
    populateAnimList(id)
    log(
      `${id.toUpperCase()}: ${model.vertexCount} Vertices, ${model.indices.length / 3} Tris, ` +
        `${model.bones.length} Bones`,
    )

    const wantedAnim = new URLSearchParams(location.search).get('anim')
    if (wantedAnim) {
      const match = [...animSelect.options].find((o) =>
        o.value.toLowerCase().includes(wantedAnim.toLowerCase()),
      )
      if (match) {
        animSelect.value = match.value
        await playSelectedAnimation()
      }
    }
  } catch (err) {
    log(`ERROR loading ${id}: ${err instanceof Error ? err.message : err}`)
  }
}

function populateAnimList(id: string): void {
  if (!vfs) return
  animSelect.innerHTML = '<option value="">— Bindpose —</option>'
  const scas = vfs.find((p) => p.startsWith(`units/${id}/`) && p.endsWith('.sca')).sort()
  for (const path of scas) {
    const opt = document.createElement('option')
    opt.value = path
    opt.textContent = path.split('/').pop()!.replace('.sca', '').replace(`${id}_`, '')
    animSelect.appendChild(opt)
  }
}

async function playSelectedAnimation(): Promise<void> {
  if (!vfs || !currentModel) return
  const path = animSelect.value
  if (!path) {
    viewer.playAnimation(null, [])
    return
  }
  try {
    const anim = parseSca(await vfs.read(path))
    viewer.playAnimation(
      anim,
      currentModel.bones.map((b) => b.name),
    )
    log(`Animation: ${path.split('/').pop()} (${anim.numFrames} Frames, ${anim.duration.toFixed(2)}s)`)
  } catch (err) {
    log(`ERROR during animation: ${err instanceof Error ? err.message : err}`)
  }
}

// ---------------------------------------------------------------------------
// Load map
// ---------------------------------------------------------------------------

async function loadMap(folder: string): Promise<void> {
  if (!source || !vfs) return
  try {
    sandbox = null
    hud?.dispose()
    hud = null
    viewer.setRtsControls(false)
    log(`Loading card ${folder}…`)
    const files = await source.list(`maps/${folder}`)
    const scenarioFile = files.find((f) => f.name.toLowerCase().endsWith('_scenario.lua'))
    if (scenarioFile) {
      const raf = await source.open(`maps/${folder}/${scenarioFile.name}`)
      const text = new TextDecoder('utf-8').decode(await raf.slice(0, raf.size))
      const scenario = parseLuaAssignments(text)
      const info = scenario.ScenarioInfo
      const name = stripLoc(bpGet(info, 'name')) ?? folder
      const desc = stripLoc(bpGet(info, 'description')) ?? ''
      const size = bpGet(info, 'size')
      const sizeStr = Array.isArray(size) ? `${size[0]}×${size[1]}` : '?'
      mapInfo.innerHTML = `<strong>${name}</strong><br>${desc}<br>Size: <strong>${sizeStr}</strong>`
    }

    const scmapFile = files.find((f) => f.name.toLowerCase().endsWith('.scmap'))
    if (!scmapFile) {
      log(`No .scmap file in maps/${folder}`)
      return
    }
    const raf = await source.open(`maps/${folder}/${scmapFile.name}`)
    const data = new Uint8Array(await raf.slice(0, raf.size))
    const scmap = parseScmap(data)
    currentScmap = scmap
    log(
      `${scmapFile.name}: ${scmap.width}×${scmap.height}, ` +
        `${scmap.strata.length} texture layers, water ${scmap.water.hasWater ? 'ja' : 'nein'}`,
    )
    await viewer.setMap(scmap, vfs)
    log(`Card ${folder} loaded`)
  } catch (err) {
    log(`ERROR loading map: ${err instanceof Error ? err.message : err}`)
  }
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let sandbox: SandboxController | null = null
let hud: Hud | null = null
let gameUi: GameUi | null = null

/**
 * Eine ConVar hat sich geändert (ConExecute in der UI-Lua) — die Engine erfährt
 * es. Kamera und Renderer LESEN diese Werte, genau wie die C++-Seite:
 * `ui_KeyboardPanSpeed` in der WorldView-Schleife, `cam_ZoomAmount` beim Zoomen.
 * Daran hängen die Regler im Optionen-Dialog.
 */
function conVarChanged(name: string, value: string | number | boolean): void {
  viewer.setConVar(name, value)
  // The life bars are an ENGINE setting, not a UI element: the action
  // `toggle_lifebars` (Alt-L, defaultkeymap.lua:11) switches the ConVar
  // `UI_RenderUnitBars` (keyactions.lua:14). The renderer reads them - he
  // does not decide for itself whether bars appear.
  if (!hud) return
  const an = value === true || value === 'true' || value === 1
  if (name.toLowerCase() === 'ui_renderunitbars') hud.renderBars = an
  // “Always show strategic icons” is also a ConVar of the engine
  // (ui_AlwaysRenderStrategicIcons, Cfile:421748) and in the options dialog
  // switchable. Without it, the icons only appear from Display.Mesh.IconFadeInZoom.
  if (name.toLowerCase() === 'ui_alwaysrenderstrategicicons') hud.alwaysIcons = an
}
let buildPreview: BuildPreview | null = null
let currentScmap: ScmapData | null = null
let spawnPoint = new THREE.Vector3(20, 0, 20)
let massSpots: { x: number; z: number }[] = []
const sandboxAssetCache = new Map<string, SandboxUnitAssets>()

// --- Projectiles: the Sim's flying shots, with their real mesh -------
//
// The engine renders every sim entity (CUIWorldView) - including projectiles
// Mesh from the Blueprint (Display.Mesh.LODs, UniformScale; Shader TMeshGlow).
// Some projectiles have NO mesh (only emitters) - that's what draws them
// particle system; Until then they are invisible, as in the original without effects.
interface ProjectileAssets {
  model: ScmModel
  albedo: THREE.Texture | null
  scale: number
}
const projAssetCache = new Map<string, Promise<ProjectileAssets | null>>()
const projMeshes = new Map<number, THREE.Mesh>()
const projPending = new Set<number>()

function loadProjectileAssets(bpId: string): Promise<ProjectileAssets | null> {
  let p = projAssetCache.get(bpId)
  if (!p) {
    p = (async (): Promise<ProjectileAssets | null> => {
      if (!vfs) return null
      // bpId from the sim: '/projectiles/tdfgauss01/tdfgauss01_proj.bp'
      const path = bpId.replace(/^\//, '')
      // Projectiles AND the effect entities (debris upon death, nuke controller:
      // /effects/entities/**_proj.bp — defaultexplosions.lua:285).
      const m = path.match(/^((?:projectiles|effects\/entities)\/[^/]+\/[^/]+)_proj\.bp$/)
      if (!m) return null
      const base = m[1]!
      const meshPath = `${base}_lod0.scm`
      // NO mesh is the truth for many projectiles (ACU laser,
      // Machine Gun, Construction Effects): they are pure emitter/trail effects
      // and only become visible with the particle system.
      if (!vfs.exists(meshPath)) return null
      const model = parseScm(await vfs.read(meshPath))
      const albedo = await loadFirstTexture([`${base}_albedo.dds`])
      const bp = parseBlueprint(await vfs.readText(path))
      const scale = bpGet(bp, 'Display.UniformScale')
      return { model, albedo, scale: typeof scale === 'number' && scale > 0 ? scale : 1 }
    })()
    projAssetCache.set(bpId, p)
  }
  return p
}

// --- Particles: the Sim's emitters, spawned according to the original curves --------
//
// Each emitter runtime ticks per Sim tick (CEfxEmitter::Tick, 1:1 in
// src/effects/emitterRuntime.ts) and spawns particles into the batches of the
// particle system (src/viewer/particles.ts — the particle.fx port). emitter,
// those who no longer report the sim stop; their particles live in
// Vertex shader continues as in the original.
let particles: ParticleSystem | null = null
let trails: TrailSystem | null = null
let beams: BeamSystem | null = null
let orderLines: OrderLineSystem | null = null
let commandFeedback: CommandFeedbackSystem | null = null
const blipAssetCache = new Map<string, Promise<BlipAssets | null>>()
let gameAudio: GameAudio | null = null
const emitterRuntimes = new Map<number, EmitterRuntime>()
const emitterBpData = new Map<string, EmitterBpData>()
const emitterBpPending = new Set<string>()
let lastEmitterTick = -1
let lastTickWall = 0

async function prepareEmitterBatch(bpId: string): Promise<void> {
  if (emitterBpPending.has(bpId) || !luaSim || !particles) return
  emitterBpPending.add(bpId)
  const bp = (await luaSim.emitterBlueprint(bpId)) as
    | (EmitterBpData & { RepeatTexture?: string; TextureName?: string })
    | null
  if (!bp) return // no emitter BP under this ID - remains off
  // Polytrails (TrailEmitterBlueprint: RepeatTexture instead of Texture) are one
  // EIGENE Render-Familie (TPolyTrail_* — Ribbons, src/viewer/trails.ts).
  if (typeof bp.RepeatTexture === 'string') {
    const t = bp as TrailBpData
    const texP = (t.RepeatTexture ?? '').replace(/^\//, '').toLowerCase()
    const rampP = (t.RampTexture ?? '').replace(/^\//, '').toLowerCase()
    const [tex, ramp] = await Promise.all([loadFirstTexture([texP]), loadFirstTexture([rampP])])
    if (!tex || !ramp) {
      log(`Trail: Textur fehlt für ${bpId} (${texP || '—'} / ${rampP || '—'})`)
      return
    }
    trails?.registerBp(bpId, t, tex, ramp)
    return
  }
  // Beams (BeamBlueprint: TextureName) — eigene Render-Familie
  // (TBeam_OneTexture_*, src/viewer/beams.ts).
  if (typeof bp.TextureName === 'string') {
    const b = bp as BeamBpData
    const texP = (b.TextureName ?? '').replace(/^\//, '').toLowerCase()
    const tex = await loadFirstTexture([texP])
    if (!tex) {
      log(`Beam: Textur fehlt für ${bpId} (${texP || '—'})`)
      return
    }
    beams?.registerBp(bpId, b, tex)
    return
  }
  const texPath = (bp.Texture ?? '').replace(/^\//, '').toLowerCase()
  const rampPath = (bp.RampTexture ?? '').replace(/^\//, '').toLowerCase()
  const [tex, ramp] = await Promise.all([loadFirstTexture([texPath]), loadFirstTexture([rampPath])])
  if (!tex || !ramp) {
    log(`Partikel: Textur fehlt für ${bpId} (${texPath || '—'} / ${rampPath || '—'})`)
    return
  }
  emitterBpData.set(bpId, bp)
  particles?.batchFor(bpId, bp, tex, ramp)
}

/** Pro NEUEM Sim-Tick: alle gemeldeten Emitter einen Tick weiterdrehen. */
function updateEmitters(): void {
  if (!luaSim || !particles) return
  const tick = luaSim.gameTick
  if (tick <= lastEmitterTick) return
  lastEmitterTick = tick
  lastTickWall = performance.now()
  const seen = new Set<number>()
  for (const e of luaSim.allEmitters()) {
    seen.add(e.id)
    // Polytrails: one segment point per tick at the reported position.
    if (trails?.hasBp(e.bp)) {
      trails.point(e.id, e.bp, e.x, e.y, e.z, tick, e.scale)
      continue
    }
    // Beams: drag the quad between the end points.
    if (beams?.hasBp(e.bp)) {
      beams.set(e.id, e.bp, e, tick)
      continue
    }
    let rt = emitterRuntimes.get(e.id)
    if (!rt) {
      const bp = emitterBpData.get(e.bp)
      if (!bp || !particles.hasBatch(e.bp)) {
        // Blueprint/textures load asynchronously; the emitter starts as soon as
        // they are there (once per type - after that everything comes from the cache).
        void prepareEmitterBatch(e.bp)
        continue
      }
      rt = new EmitterRuntime(bp)
      emitterRuntimes.set(e.id, rt)
    }
    const spawns = rt.tick(
      {
        x: e.x,
        y: e.y,
        z: e.z,
        qw: e.qw,
        qx: e.qx,
        qy: e.qy,
        qz: e.qz,
        scale: e.scale,
        ox: e.ox,
        oy: e.oy,
        oz: e.oz,
        enabled: e.enabled,
      },
      tick,
    )
    for (const p of spawns) particles.add(e.bp, p)
  }
  for (const id of emitterRuntimes.keys()) {
    if (!seen.has(id)) emitterRuntimes.delete(id)
  }
}

/** Track the projectile meshes to the sim state (per frame, from cache). */
function updateProjectiles(): void {
  if (!luaSim) return
  const list = luaSim.allProjectiles()
  const seen = new Set<number>()
  for (const p of list) {
    seen.add(p.id)
    const mesh = projMeshes.get(p.id)
    if (!mesh) {
      if (!projPending.has(p.id)) {
        projPending.add(p.id)
        void loadProjectileAssets(p.bp).then((assets) => {
          projPending.delete(p.id)
          if (!assets) return
          // The shot may have hit while the mesh was loading —
          // then NO ghost in the scene.
          if (!luaSim?.allProjectiles().some((q) => q.id === p.id)) return
          projMeshes.set(p.id, viewer.addProjectile(assets.model, assets.albedo, assets.scale))
        })
      }
      continue
    }
    mesh.position.set(p.x, p.y, p.z)
    // The sim delivers (w,x,y,z) — three.js wants (x,y,z,w).
    mesh.quaternion.set(p.qx, p.qy, p.qz, p.qw)
  }
  for (const [id, mesh] of projMeshes) {
    if (!seen.has(id)) {
      projMeshes.delete(id)
      viewer.removeProjectile(mesh)
    }
  }
}

// --- Props: the wreckage of the sim, with the real wreckage shader ---------------
//
// Unit.OnKilled → CreateWreckageProp (unit.lua:1090) runs completely in the
// Original Lua: CreateProp + SetMesh(Display.MeshBlueprintWrecked) +
// SetScale(UniformScale) + AssociatedBP. The renderer draws the unit mesh
// with the wreckage material (mesh.fx:2334 — noise over albedo, dented in the VS).
const propMeshes = new Map<number, THREE.Mesh>()
const propPending = new Set<number>()
const propSkipLogged = new Set<string>()
let wreckNoise: Promise<THREE.Texture | null> | null = null
// The UEF construction grid (SecondaryName from ExtractBuildMeshBlueprint,
// lua/system/blueprints.lua:221) — loaded once, shared by all construction sites.
let uefBuildSpecular: Promise<THREE.Texture | null> | null = null

// Shared cache for the faction build textures (build speculars, the Cybran
// insect lookup, the Seraphim falloff ramp).
const buildTexCache = new Map<string, Promise<THREE.Texture | null>>()
function buildTexture(path: string, repeat: boolean): Promise<THREE.Texture | null> {
  let p = buildTexCache.get(path)
  if (!p) {
    p = loadFirstTexture([path]).then((t) => {
      if (t && repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping
      if (t && !repeat) t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping
      return t
    })
    buildTexCache.set(path, p)
  }
  return p
}

async function addPropMesh(p: LuaPropSnapshot): Promise<void> {
  const assets = await loadSandboxAssets(p.assoc!)
  // The noise is the SpecularName, the ExtractWreckageBlueprint
  // (lua/system/blueprints.lua:201) writes to EVERY wreck mesh BP.
  wreckNoise ??= loadFirstTexture(['env/common/props/wreckage_noise.dds']).then((t) => {
    // The shader samples UV * 5.15 with time offset — the texture must tile.
    if (t) t.wrapS = t.wrapT = THREE.RepeatWrapping
    return t
  })
  const noise = await wreckNoise
  propPending.delete(p.id)
  if (!assets || !noise) {
    if (!propSkipLogged.has(p.assoc!)) {
      propSkipLogged.add(p.assoc!)
      log(`Wrack: Assets fehlen für ${p.assoc} (${assets ? 'Noise' : 'Modell'})`)
    }
    return
  }
  // The prop can be gone again (reclaim) while the mesh was loading.
  if (!luaSim?.allProps().some((q) => q.id === p.id)) return
  const mesh = viewer.addWreck(assets.model, assets.textures, noise, p.scale, p.spawn / 10)
  mesh.position.set(p.x, p.y, p.z)
  mesh.rotation.set(0, p.heading, 0)
  propMeshes.set(p.id, mesh)
}

function updateProps(): void {
  if (!luaSim) return
  const seen = new Set<number>()
  for (const p of luaSim.allProps()) {
    seen.add(p.id)
    if (propMeshes.has(p.id) || propPending.has(p.id)) continue
    // Props without mesh/unit reference (map props come with the scmap parser
    // Tail): say blueprint once per blueprint, don't guess.
    if (!p.meshBp || !p.assoc) {
      if (!propSkipLogged.has(p.bp)) {
        propSkipLogged.add(p.bp)
        log(`Prop ohne Wrack-Mesh: ${p.bp} — bleibt unsichtbar (kein SetMesh/AssociatedBP)`)
      }
      continue
    }
    propPending.add(p.id)
    void addPropMesh(p)
  }
  for (const [id, mesh] of propMeshes) {
    if (!seen.has(id)) {
      propMeshes.delete(id)
      viewer.removeWreck(mesh)
    }
  }
}

async function loadSandboxAssets(id: string): Promise<SandboxUnitAssets | null> {
  const cached = sandboxAssetCache.get(id)
  if (cached) return cached
  if (!vfs) return null
  const assets = await loadUnitAssets(id)
  if (!assets) return null

  let walkAnim = null
  const walkPath = bpGet(assets.bp, 'Display.AnimationWalk')
  const walkCandidate =
    typeof walkPath === 'string' && walkPath ? walkPath : `units/${id}/${id}_a002.sca`
  if (vfs.exists(walkCandidate)) {
    walkAnim = parseSca(await vfs.read(walkCandidate))
  }

  const bundle: SandboxUnitAssets = { id, ...assets, walkAnim }
  sandboxAssetCache.set(id, bundle)
  return bundle
}

/**
 * Spielmodus: der Launcher-Rahmen (Menü, Seitenleiste, Titelzeile) verschwindet,
 * das Spiel bekommt den ganzen Bildschirm.
 *
 * Das ist keine Kosmetik. Die Original-UI rechnet ihr komplettes Layout gegen
 * den Root-Frame — und der ist die FENSTERGRÖSSE. Bliebe der Web-Rahmen stehen,
 * säße das Orders-Panel (links 17, unten 0) hinter der Seitenleiste. Im Original
 * füllt das Spiel den Bildschirm, also tut es das hier auch.
 */
function setIngame(on: boolean): void {
  if (document.body.classList.contains('ingame') === on) return
  document.body.classList.toggle('ingame', on)
  // The viewer is measured by the window, the UI VM by the root frame - both have to be
  // see the new place.
  window.dispatchEvent(new Event('resize'))
  gameUi?.resize(window.innerWidth, window.innerHeight)
}

async function startSandbox(mapFolder: string): Promise<void> {
  if (!vfs || !source) return
  try {
    sandbox = null
    setMode('sandbox')
    setIngame(true)
    await loadMap(mapFolder)

    // Is a sim already running? Then reset, instead of a second ACU on the
    // old session to stack (with double starting supply
    // GiveInitialResources) — and with the terrain of the NEW map.
    if (luaSim && currentScmap) {
      luaUnits.length = 0
      knownSceneUnits.clear()
      unitLerp.clear()
      await luaSim.reset({
        data: currentScmap.heightmap,
        width: currentScmap.width,
        height: currentScmap.height,
        scale: currentScmap.heightScale,
      })
      log('Lua-Sim zurückgesetzt (neue Karte)')
    }

    // Army 1 spawn point from the _save.lua
    const files = await source.list(`maps/${mapFolder}`)
    const saveFile = files.find((f) => f.name.toLowerCase().endsWith('_save.lua'))
    if (saveFile) {
      const raf = await source.open(`maps/${mapFolder}/${saveFile.name}`)
      const text = new TextDecoder('utf-8').decode(await raf.slice(0, raf.size))
      const save = parseLuaAssignments(text)
      const marker =
        bpGet(save, 'Scenario.MasterChain._MASTERCHAIN_.Markers.ARMY_1.position') ??
        bpGet(save, 'Scenario.MasterChain._MASTERCHAIN_.Markers.ARMY_2.position')
      if (Array.isArray(marker) && marker.length === 3 && marker.every((v) => typeof v === 'number')) {
        spawnPoint = new THREE.Vector3(marker[0] as number, marker[1] as number, marker[2] as number)
        log(`Spawn ARMY_1: ${spawnPoint.x.toFixed(0)}, ${spawnPoint.z.toFixed(0)}`)
      }

      // Measurement points from the markers
      const allMarkers = bpGet(save, 'Scenario.MasterChain._MASTERCHAIN_.Markers')
      if (allMarkers && typeof allMarkers === 'object' && !Array.isArray(allMarkers)) {
        const spots: { x: number; z: number }[] = []
        for (const m of Object.values(allMarkers)) {
          if (m && typeof m === 'object' && !Array.isArray(m)) {
            const mm = m as BpObject
            const pos = mm.position
            if (mm.type === 'Mass' && Array.isArray(pos) && typeof pos[0] === 'number') {
              spots.push({ x: pos[0] as number, z: pos[2] as number })
            }
          }
        }
        massSpots = spots
        log(`${spots.length} Mass-Punkte gefunden`)
      }
    }

    // The dimensions of the selection ring come from the original file
    // lua/renderselectparams.lua (the engine reads exactly them, Cfile:1215033).
    await loadSelectParams()
    sandbox = new SandboxController(viewer)
    // massSpots are NO longer drawn as made-up rings. They stay
    // parsed (structure of the map) until the session start it as real
    // Resource occurrences are created via ScenarioUtilities.lua and the engine
    // renders their original icons.
    if (currentScmap) {
      hud = new Hud(vfs, viewer, hudSource)
    }

    // The REAL lua/ui in a second Lua VM (like the original: Sim and UI
    // have separate states). She builds the Eco-Panel from economy.lua — the
    // TS replica in hud.ts is out for this.
    gameUi?.dispose()
    // The SESSION goes into both VMs: the sim gets it via setupSession
    // (ScenarioInfo + Brains), the UI has the same information — GetArmiesTable()
    // and SessionGetScenarioInfo() are the engine view of it. Without her
    // the session globals honestly say “no active session”.
    const session: SessionInfo = { ...SANDBOX_SESSION, map: mapFolder }
    gameUi = await GameUi.create(vfs, await loadGameFonts(), log, 'game', conVarChanged, session)
    gameUi.attachEvents()
    // Strategic icons are tinted with the army's iconColor from the
    // armiesTable (gamecolors.lua ArmyColors, Cfile:1267023-1267111).
    hud?.setArmyColors(gameUi.armyIconColors())
    // The audio output: the XACT banks from <FA>/sounds/ — StartSound in the
    // UI-VM ends up as PCM in the speaker (StopSound ends via the
    // Handle ID, e.g. B. the menu music at the start of the session).
    if (!gameAudio) gameAudio = await GameAudio.create(vfs, log)
    if (gameAudio) {
      const audio = gameAudio
      gameUi.connectAudio(
        (bank, cue, id) => audio.play(bank, cue, id),
        (id) => audio.stop(id),
      )
      // The volume options (options.lua:700-779 -> SetVolume) reach the
      // XACT category gains; boot-time values are replayed by connectVolume.
      gameUi.connectVolume((cat, vol) => audio.setVolume(cat, vol))
    }
    // The pause tab of the original UI (tabs.lua:425/428) pauses the WORLD —
    // the sim, not the UI.
    gameUi.connectPause((paused) => {
      luaSim?.setPaused(paused)
      log(paused ? 'Session pausiert' : 'Session läuft weiter')
    })
    // The construction preview (ghost buildings on the grid) — engine rendering with the
    // real blueprint models.
    buildPreview = new BuildPreview(viewer, loadSandboxAssets)
    // The particle system — fresh per session (setMap → clearContent throws
    // the helper meshes are gone, and so are the batches).
    particles?.dispose()
    particles = new ParticleSystem((mesh) => viewer.addHelper(mesh))
    trails?.dispose()
    trails = new TrailSystem((mesh) => viewer.addHelper(mesh))
    beams?.dispose()
    beams = new BeamSystem((mesh) => viewer.addHelper(mesh))
    // The command graph (order lines + waypoints, UICommandGraph): textures
    // and colors from commandgraphparams.lua, drawn for the selection.
    orderLines?.dispose()
    orderLines = new OrderLineSystem((o) => viewer.addHelper(o))
    // Click-feedback blips (commandmode.lua:128-176 picks mesh/texture/
    // shader per command; the engine port lives in commandFeedback.ts).
    commandFeedback?.dispose()
    commandFeedback = new CommandFeedbackSystem(
      (o) => viewer.addHelper(o),
      (meshPath, texPath) => {
        const key = `${meshPath}|${texPath}`
        let p = blipAssetCache.get(key)
        if (!p) {
          p = (async (): Promise<BlipAssets | null> => {
            if (!vfs) return null
            const mp = meshPath.replace(/^\//, '').toLowerCase()
            if (!vfs.exists(mp)) {
              log(`command blip mesh missing: ${mp}`)
              return null
            }
            const model = parseScm(await vfs.read(mp))
            const geometry = new THREE.BufferGeometry()
            geometry.setAttribute('position', new THREE.BufferAttribute(model.positions, 3))
            geometry.setAttribute('normal', new THREE.BufferAttribute(model.normals, 3))
            geometry.setAttribute('uv', new THREE.BufferAttribute(model.uv0, 2))
            geometry.setIndex(new THREE.BufferAttribute(model.indices, 1))
            const texture = await loadFirstTexture([texPath.replace(/^\//, '').toLowerCase()])
            return { geometry, texture }
          })()
          blipAssetCache.set(key, p)
        }
        return p
      },
    )
    {
      const cf = commandFeedback
      gameUi.connectCommandFeedback(
        (meshName, blueprintId, textureName, shaderName, uniformScale, x, y, z, duration) => {
          // BlueprintID branch (Cfile:1281792-1830): LOD0 mesh of the unit
          // blueprint, scale OVERRIDDEN by Display.UniformScale.
          void(async() => {
            let meshPath = meshName
            let texPath = textureName
            let scale = uniformScale
            if (!meshPath && blueprintId && vfs) {
              const id = blueprintId.toLowerCase()
              try {
                const bp = parseBlueprint(await vfs.readText(`units/${id}/${id}_unit.bp`))
                const paths = resolveUnitPaths(id, bp, (p) => vfs!.exists(p))
                if (!paths) return
                meshPath = paths.mesh
                texPath = texPath || paths.albedo[paths.albedo.length - 1]!
                const us = bpGet(bp, 'Display.UniformScale')
                if (typeof us === 'number' && us > 0) scale = us
              } catch {
                return
              }
            }
            if (!meshPath) return
            await cf.spawn({ meshPath, texPath, shaderName, scale, x, y, z, duration })
          })()
        },
      )
    }
    {
      const ol = orderLines
      void (async () => {
        const base = 'textures/ui/common/game'
        const [line, arrow, move, attack, repair] = await Promise.all([
          loadFirstTexture([`${base}/orderline/orderline_generic.dds`]),
          loadFirstTexture([`${base}/orderline/orderline_arrow04.dds`]),
          loadFirstTexture([`${base}/waypoints/move_btn_up.dds`]),
          loadFirstTexture([`${base}/waypoints/attack_btn_up.dds`]),
          loadFirstTexture([`${base}/waypoints/repair_btn_up.dds`]),
        ])
        const wps = new Map<string, THREE.Texture>()
        if (move) wps.set('move_btn_up', move)
        if (attack) wps.set('attack_btn_up', attack)
        if (repair) wps.set('repair_btn_up', repair)
        ol.setTextures(line, arrow, wps)
      })()
    }
    emitterRuntimes.clear()
    lastEmitterTick = -1
    // The seam through which UI commands go into the sim. Without them, everyone BANGS
    // Command - instead of just fizzling out (ui-globals.lua: __uiSimCommand).
    gameUi.connectSim((name, ids, value) => {
      // Engine SetLexical Behavior (Cfile:1381888-1381946): Enum names
      // are case-insensitive, the "UNITCOMMAND_" prefix is ​​optional —
      // GetUnitCommandFromCommandCap returns e.g. B. 'Stop' without a prefix.
      const cmd = name.replace(/^UNITCOMMAND_/i, '').toLowerCase()
      const v = value as { blueprint?: string; count?: number; index?: number } | undefined
      if (cmd === 'stop') {
        // The stop button (orders.lua:205): stop movement via the
        // Navigator (AbortMove) — the full command dispatch (task abort,
        // Empty Queue) is part of the open command dispatch block.
        for (const id of ids) luaSim?.stop(id)
        return
      }
      if (name === 'UNITCOMMAND_BuildFactory' && v?.blueprint) {
        // The factory builds: the unit goes into its queue (the Sim spawns
        // herself as soon as it is her turn).
        for (const id of ids) void luaSim?.factoryBuild(id, v.blueprint, v.count ?? 1)
        log(`Fabrik ${ids.join(',')}: ${v.count ?? 1}× ${v.blueprint}`)
        return
      }
      // Increase/DecreaseBuildCountInQueue of the original UI (right click on the
      // Queue icon takes away, left click puts on it — construction.lua:895/988).
      if ((name === 'ISSUE_IncreaseCommandCount' || name === 'ISSUE_DecreaseCommandCount') && v?.index !== undefined) {
        const delta = (name === 'ISSUE_IncreaseCommandCount' ? 1 : -1) * (v.count ?? 1)
        for (const id of ids) luaSim?.adjustBuildQueue(id, v.index, delta)
        return
      }
      log(`Command to the sim: ${name}(${ids.join(',')}) — noch kein Weg dorthin`)
    })
    // SimCallback (Ctrl-K-Selbstzerstörung, Kontrollgruppen, Diplomatie):
    // the UI calls a function from lua/simcallbacks.lua in the sim.
    gameUi.connectSimCallback((func, argsLua, unitIds) => {
      luaSim?.simCallback(func, argsLua, unitIds)
    })
    // RestartSession (Menü → Neustart, tabs.lua:218): Teardown + Neustart mit
    // the same session info (func_DoPreload, Cfile:1320748) — exactly that
    // Sandbox start path. Only this seam makes SessionCanRestart() true.
    gameUi.connectRestart(() => {
      log('RestartSession: Session startet neu')
      void startSandbox(mapFolder)
    })

    // Register both frame hooks in ONE place after loading the map
    // (setMap → clearContent throws away all hooks). You before or distributed to
    // was already the reason for this from the second
    // Sandbox start didn't move anything anymore.
    viewer.onUpdate(luaSimUpdate)
    viewer.onUpdate(() => {
      gameUi?.render()
      // The original Lua says WHERE the worldviews lie: the main view
      // (gamemain.lua:142) and the minimap (minimap.lua:115, cartographic).
      // The 3D page renders into exactly these rectangles — it doesn't specify them.
      if (gameUi) viewer.setWorldViews(gameUi.worldViews())
    })
    // ACU spawn via the REAL original Lua sim (engine path) instead of as
    // SimWorld placeholder. Do not await so that the card can be used immediately
    // (the Lua VM boots once in the background).
    void spawnViaLua('uel0001')
    const params = new URLSearchParams(location.search)
    const zoomParam = Number(params.get('zoom'))
    viewer.focusOn(spawnPoint, zoomParam > 0 ? zoomParam : 14)
    sandboxInfo.innerHTML =
      `Karte <strong>${mapFolder}</strong> — Klick auf Einheit = Auswahl, ` +
      `Bau-Icon + Klick aufs Terrain = Gebäude setzen, Rechtsklick = Bewegung`
    log(`Sandbox bereit auf ${mapFolder} (Sim: 10 Ticks/s)`)
    const selftest = params.get('selftest')
    if (selftest) void runSelftest(selftest)
  } catch (err) {
    log(`FEHLER Sandbox: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Self-test via the URL (`?selftest=ueb0101`): selects the ACU and builds that
 * specified buildings next to her — via EXACTLY the same path as a click
 * (SelectUnits → commandmode → worldClick). This allows the browser path to be checked
 * without anyone mistyping with the mouse.
 */
async function runSelftest(blueprintId: string): Promise<void> {
  const deadline = Date.now() + 60000
  while (luaUnits.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
  }
  const acu = luaUnits[0]
  if (!acu || !gameUi || !luaSim) {
    log('SELFTEST: keine ACU')
    return
  }
  try {
    gameUi.select([acu.id])
  } catch (err) {
    log(`SELFTEST: select scheitert — ${(err as Error).stack?.slice(0, 300)}`)
    return
  }
  log(`SELFTEST: ACU ${acu.id} ausgewählt`)
  await new Promise((r) => setTimeout(r, 800))
  {
    // What does the original UI really show? Counts what arrives in the DOM — images
    // including. "Without image" means: the bitmap WANTS a texture (backgroundImage
    // set, mauiRenderer:195), but it couldn't be resolved - AND it is
    // visible (alpha > 0). SolidColor bitmaps (`background` only) and Alpha 0
    // Placeholders are original behavior (window.lua:106-115 hides its
    // Resize handles exactly the same) — counting them always reported phantoms.
    const divs = [...document.querySelectorAll<HTMLDivElement>('#maui-root div')]
    const sichtbar = divs.filter((d) => d.style.display !== 'none')
    const bitmaps = sichtbar.filter((d) => d.dataset.kind === 'bitmap')
    const mitBild = bitmaps.filter((d) => d.style.backgroundImage.startsWith('url('))
    const ohneBild = bitmaps.filter(
      (d) => d.style.backgroundImage === 'none' && Number(d.style.opacity) > 0,
    )
    log(
      `SELFTEST-UI: ${sichtbar.length} sichtbare Controls | Bitmaps ${bitmaps.length} ` +
        `(${mitBild.length} mit Bild, ${ohneBild.length} ohne) | ` +
        `Texte ${sichtbar.filter((d) => d.dataset.kind === 'text').length}`,
    )
    for (const d of ohneBild.slice(0, 6)) {
      log(`SELFTEST-UI: ohne Bild → ${d.dataset.name} ${d.style.width}×${d.style.height}`)
    }
  }
  gameUi.startCommandMode('build', blueprintId)
  const s = luaSim.state(acu.id)
  if (!s) return

  // The construction preview must be BEFORE it is placed - and exactly where the building is
  // lands. The self-test checks both.
  const ziel = { x: s.x + 9, z: s.z + 9 }
  const fp = gameUi.footprint(blueprintId)
  await buildPreview?.show(blueprintId, ziel, fp)
  await new Promise((r) => setTimeout(r, 600))
  log(`SELFTEST: Bau-Vorschau ${buildPreview?.debugPosition() ?? 'FEHLT'} (Footprint ${fp[0]}×${fp[1]})`)

  // NO more re-select: since DoInitializing behind the first sync beat
  // lies (gameUi.beat), gamemain.OnFirstUpdate sees its avatars and the
  // 3-s fork calls SelectUnits(acu) instead of SelectUnits(nil). The choice remains
  // Still empty here, it's a FOUND - the self-test reports it.
  const auswahl = gameUi.selectionCount()
  if (auswahl === 0) log('SELF TEST: FOUND — selection empty before clicking (regression of the init order?)')
  log(`SELFTEST: vor dem Klick — commandMode=${JSON.stringify(gameUi.commandMode())}, Auswahl=${auswahl}`)
  await issueWorldCommand(ziel, false)

  // Is the building growing? The numbers come from the sim, not from here.
  let factoryId = 0
  for (let round = 0; round < 90 && factoryId === 0; round++) {
    await new Promise((r) => setTimeout(r, 1000))
    const site = luaSim.allStates().find((u) => u.name === blueprintId)
    const eco = luaSim.economySnapshot()
    if (!site) continue
    if (site.fraction < 1) {
      log(
        `SELFTEST: ${blueprintId} bei ${(site.fraction * 100).toFixed(0)} % ` +
          `(Masse ${eco?.mass.toFixed(0)}, Einheiten ${luaUnits.length})`,
      )
    } else {
      factoryId = site.id
      log(`SELFTEST: ${blueprintId} FERTIG — Lager ${eco?.massStorage.toFixed(0)}`)
    }
  }
  if (factoryId === 0) return

  // The factory produces: Selection → IssueBlueprintCommand (exactly the way
  // a click on the construction icon in the Original-construction.lua takes).
  gameUi.select([factoryId])
  gameUi.issueBlueprintCommand('UNITCOMMAND_BuildFactory', 'uel0101', 2)
  for (let round = 0; round < 60; round++) {
    await new Promise((r) => setTimeout(r, 1000))
    const tanks = luaSim.allStates().filter((u) => u.name === 'uel0101')
    if (tanks.length === 0) continue
    const done = tanks.filter((t) => t.fraction >= 1).length
    const e = luaSim.economySnapshot()
    log(
      `SELFTEST: Fabrik baut uel0101 — ${tanks.length} Stück, ${done} fertig ` +
        `(${(tanks[0]!.fraction * 100).toFixed(0)} %) — Masse ${e?.mass.toFixed(0)}/${e?.massStorage.toFixed(0)} `+
        `+${e?.massIncome.toFixed(1)} −${e?.massExpense.toFixed(1)}, Energie ${e?.energy.toFixed(0)} +${e?.energyIncome.toFixed(1)}`,
    )
    if (done >= 2) {
      log('SELFTEST: BEIDE PANZER FERTIG — die Techdemo läuft')
      await selftestKampf()
      return
    }
  }
  await selftestKampf()
}

/**
 * Kampf-Abschnitt des Selbsttests: ein Feind neben der ACU, die Waffen greifen
 * von selbst (Zielsuche der Sim) — geprüft wird, dass die PROJEKTILE den
 * Browser erreichen und als Meshes in der Szene stehen (projMeshes).
 */
async function selftestKampf(): Promise<void> {
  if (!luaSim) return
  const acu = luaUnits[0]
  if (!acu) return
  const s = luaSim.state(acu.id)
  if (!s) return
  try {
    // On the FREE side (the building site of the factory is at +9/+9): one
    // Tank in the middle of the building footprint will not fire.
    const feind = await luaSim.spawn('uel0201', { x: s.x - 14, y: s.y, z: s.z - 14 }, 2)
    // Plus an OWN tank: the Gauss Duel (TDFGauss01 has a mesh,
    // TDFGauss01_proj.bp:29) — the ACU laser is a pure emitter effect
    // and only visible with the particle system.
    const eigener = await luaSim.spawn('uel0201', { x: s.x - 8, y: s.y, z: s.z - 8 }, 1)
    log(`SELFTEST-KAMPF: Feind ${feind} + eigener Panzer ${eigener} — Gauss-Duell`)
  } catch (err) {
    log(`SELFTEST-KAMPF: Spawn scheitert — ${(err as Error).message}`)
    return
  }
  let maxProj = 0
  let maxMeshes = 0
  for (let round = 0; round < 45; round++) {
    await new Promise((r) => setTimeout(r, 500))
    maxProj = Math.max(maxProj, luaSim.allProjectiles().length)
    maxMeshes = Math.max(maxMeshes, projMeshes.size)
    const feindLebt = luaSim.allStates().some((u) => u.army === 2)
    if (!feindLebt && maxProj > 0) break
  }
  log(
    maxMeshes > 0
      ? `SELFTEST-KAMPF: Projektile sichtbar — max. ${maxProj} gemeldet, ${maxMeshes} Mesh(es) in der Szene`
      : `SELFTEST-KAMPF: KEIN Projektil-Mesh (gemeldet: ${maxProj}) — der Sichtweg ist unterbrochen`,
  )
  // The loser's WRECK: Unit.OnKilled → CreateWreckageProp runs in the
  // original Lua; What matters here is that it arrives as a mesh with wreckage shader.
  for (let round = 0; round < 10 && propMeshes.size === 0; round++) {
    await new Promise((r) => setTimeout(r, 500))
  }
  const nProps = luaSim.allProps().length
  log(
    propMeshes.size > 0
      ? `SELFTEST-WRACK: ${nProps} Prop(s) gemeldet, ${propMeshes.size} Wrack-Mesh(es) in der Szene`
      : `SELFTEST-WRACK: KEIN Wrack-Mesh (gemeldet: ${nProps}) — der Props-Sichtweg ist unterbrochen`,
  )
  // The particle system: muzzle flash/impacts/construction glow must be used as
  // Instances ended up in the batches.
  const nPartikel = particles?.totalParticles() ?? 0
  log(
    nPartikel > 0
      ? `SELFTEST-PARTIKEL: ${nPartikel} Partikel gespawnt — das Partikelsystem lebt`
      : 'SELFTEST-PARTIKEL: KEIN Partikel gespawnt — Emitter-Kette prüfen',
  )
  const nTrails = trails?.totalTrails() ?? 0
  log(
    nTrails > 0
      ? `SELFTEST-TRAILS: ${nTrails} Poly-Trail(s) im Bild — die Spuren leben`
      : 'SELFTEST-TRAILS: kein Poly-Trail entstanden (im Gauss-Duell erwartbar: gauss_cannon_polytrail)',
  )
  // Beams: the build beam (build_beam_01) ran during the build phase; here
  // counts maxBeams throughout the entire self-test (combat usually doesn't have any).
  log(`SELFTEST-BEAMS: max. ${maxBeamsGesehen} Beam(s) gleichzeitig im Bild`)
  const nCues = gameAudio?.playedCount ?? -1
  log(
    nCues > 0
      ? `SELFTEST-AUDIO: ${nCues} Cue(s) als PCM abgespielt — die XACT-Kette lebt`
      : `SELFTEST-AUDIO: keine Cue abgespielt (${nCues < 0 ? 'kein AudioContext' : 'Kette prüfen'})`,
  )
}

/** Höchststand gleichzeitiger Beams — gepflegt in luaSimUpdate. */
let maxBeamsGesehen = 0

// --- SupCom control ------------------------------------------------------
// Linksklick = Auswahl, Links-Drag = Box-Selektion, Rechtsklick = Move
// (Shift = Warteschlange), Leertaste + Maus = Kamera drehen
const viewportEl = $<HTMLCanvasElement>('#viewport')
const selectBox = $('#select-box')
let boxStart: { x: number; y: number } | null = null
let spaceHeld = false

viewportEl.addEventListener('pointerdown', (e) => {
  if (e.button === 0 && sandbox && !spaceHeld) {
    boxStart = { x: e.clientX, y: e.clientY }
  }
})

window.addEventListener('pointermove', (e) => {
  if (spaceHeld && sandbox) {
    viewer.rotateAroundTarget(e.movementX, e.movementY)
  }
  // Report the unit to the UI UNDER THE CURSOR. That's exactly what builds from
  // `unitview.lua` seine Rollover-Anzeige (GetRolloverInfo, unitview.lua:90) —
  // Name, life, economy of the unit being run over. Without this message shows
  // The original UI simply has nothing to do with it: it doesn't KNOW what the mouse is on.
  if (sandbox && gameUi && luaSim) {
    const hit = viewer.pickUnit(e.clientX, e.clientY)
    const u = hit ? luaUnits.find((x) => x.scene === hit) : undefined
    gameUi.setRollover(u ? u.id : null)
  }
  // Construction mode: the ghost building follows the cursor — on the grid, with the
  // the sim sets it the same (src/ui/buildPreview.ts).
  if (sandbox && gameUi && buildPreview) {
    const cm = gameUi.commandMode()
    if (cm.mode === 'build' || cm.mode === 'buildanchored') {
      const hit = viewer.pickTerrain(e.clientX, e.clientY)
      if (hit && cm.name) {
        void buildPreview.show(cm.name, hit, gameUi.footprint(cm.name))
      } else {
        buildPreview.hide()
      }
    } else {
      buildPreview.hide()
    }
  }
  if (boxStart && sandbox) {
    const w = Math.abs(e.clientX - boxStart.x)
    const h = Math.abs(e.clientY - boxStart.y)
    if (w > 4 || h > 4) {
      selectBox.hidden = false
      selectBox.style.left = `${Math.min(e.clientX, boxStart.x)}px`
      selectBox.style.top = `${Math.min(e.clientY, boxStart.y)}px`
      selectBox.style.width = `${w}px`
      selectBox.style.height = `${h}px`
    }
  }
})

window.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !boxStart) return
  const start = boxStart
  boxStart = null
  selectBox.hidden = true
  const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y)
  if (moved > 5 || !luaSim) return

  // What a left click means in the world is decided by the UI Lua, not us:
  // If a command mode is active (construction icon clicked, move button pressed), that is
  // Click COMMAND. Otherwise it is a selection.
  if (gameUi && gameUi.commandMode().mode !== false) {
    const hit = viewer.pickTerrain(e.clientX, e.clientY)
    if (hit) void issueWorldCommand(hit, e.shiftKey, zielUnter(e.clientX, e.clientY))
    return
  }
  if (luaUnits.length > 0) {
    const luaMsg = selectLua(e.clientX, e.clientY)
    if (luaMsg) log(luaMsg)
  }
})

viewportEl.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (!luaSim || !gameUi) return
  // Rechtsklick im Command-Mode bricht ihn ab (commandmode.lua:113
  // EndCommandMode(true)) — just like the original.
  if (gameUi.commandMode().mode !== false) {
    gameUi.cancelCommandMode()
    buildPreview?.hide()
    log('Befehl abgebrochen')
    return
  }
  // Otherwise the view's default order for the selection: Move onto
  // terrain, Attack on an enemy unit, Repair on an own unfinished one.
  const hit = viewer.pickTerrain(e.clientX, e.clientY)
  if (hit) void issueWorldCommand(hit, e.shiftKey, zielUnter(e.clientX, e.clientY))
})

/**
 * The unit under the cursor, classified for the command dispatch: an ENEMY
 * turns the default click into Attack, an OWN UNFINISHED structure into
 * Repair (resume construction).
 */
function zielUnter(clientX: number, clientY: number): { enemy?: number; repair?: number } {
  const picked = viewer.pickUnit(clientX, clientY)
  if (!picked || !luaSim) return {}
  const u = luaUnits.find((x) => x.scene === picked)
  if (!u) return {}
  if (u.army !== 1) return { enemy: u.id }
  const s = luaSim.state(u.id)
  // Repair target: unfinished (resume construction) OR finished but
  // damaged (HP repair — same CBuildTaskHelper, Cfile:815445).
  if (s && (s.fraction < 1 || s.health < s.maxHealth)) return { repair: u.id }
  return {}
}

/**
 * Klick in die Welt → Befehl. Die Geometrie (Snap, Höhe) rechnet die Engine, die
 * Bedeutung kommt aus commandmode.lua (src/ui/worldCommands.ts).
 */
async function issueWorldCommand(
  hit: { x: number; z: number },
  queue: boolean,
  ziel: { enemy?: number; repair?: number } = {},
): Promise<void> {
  if (!luaSim || !gameUi) return
  try {
    const msg = await gameUi.worldClick(luaSim, hit, (x, z) => viewer.heightAt(x, z), queue, ziel)
    if (msg) log(msg)
    // Set (or given an order) → the spirit has served its purpose until the next one
    // Build mode starts.
    if (gameUi.commandMode().mode === false) buildPreview?.hide()
  } catch (err) {
    log(`ERROR Command: ${err instanceof Error ? err.message : err}`)
  }
  // The resulting construction site receives its model via the generic follow-up
  // luaSimUpdate — the sim reports it in the next beat.
}

window.addEventListener('keydown', (e) => {
  if (
    e.code === 'Space' &&
    sandbox &&
    !(e.target instanceof HTMLInputElement) &&
    !(e.target instanceof HTMLSelectElement)
  ) {
    spaceHeld = true
    e.preventDefault()
  }
  // ESC exits game mode and brings the launcher back. A
  // Transition path: as soon as the real main menu is running (lua/ui/menus/main.lua),
  // ESC belongs to the original UI.
  if (e.code === 'Escape' && document.body.classList.contains('ingame')) {
    // In the main menu, ESC actually belongs to the original UI (uimain.SetEscapeHandler,
    // main.lua:805) — until the key travel stops (M3), it brings up the launcher
    // back. The image pump must stop, otherwise the menu will calculate
    // Hintergrund weiter.
    if (frontEndFrame) {
      cancelAnimationFrame(frontEndFrame)
      frontEndFrame = 0
      gameUi?.dispose()
      gameUi = null
      setMode('start')
    }
    setIngame(false)
    log('Launcher (ESC) — the sandbox continues to run')
  }
})

// The window size changes → the root frame of the UI VM follows suit, otherwise
// the original UI remains at the same size as before.
window.addEventListener('resize', () => {
  gameUi?.resize(window.innerWidth, window.innerHeight)
})
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceHeld = false
})

// --- Original camera: wheel zoom to cursor, middle button pan, ------------
// --- Edge scroll and arrow keys ---------------------------------------
let midDrag = false
const keyPan = { x: 0, z: 0 }
const edgePan = { x: 0, z: 0 }

function applyPan(): void {
  viewer.rtsSetPan(
    Math.max(-1, Math.min(1, keyPan.x + edgePan.x)),
    Math.max(-1, Math.min(1, keyPan.z + edgePan.z)),
  )
}

viewportEl.addEventListener(
  'wheel',
  (e) => {
    if (!sandbox) return
    e.preventDefault()
    viewer.rtsZoom(e.deltaY, e.clientX, e.clientY)
  },
  { passive: false },
)

viewportEl.addEventListener('pointerdown', (e) => {
  if (e.button === 1 && sandbox) {
    midDrag = true
    e.preventDefault()
  }
})
window.addEventListener('pointerup', (e) => {
  if (e.button === 1) midDrag = false
})
viewportEl.addEventListener('auxclick', (e) => e.preventDefault())

window.addEventListener('pointermove', (e) => {
  if (!sandbox) return
  if (midDrag) viewer.rtsDragPan(e.movementX, e.movementY)
  // Edge scroll within the viewport — but only if the option is there
  // allowed. The engine asks `ui_ScreenEdgeScrollView` at exactly this point
  // (Cfile:1300036, in WorldView loop); that is the option
  // „Bildschirmrand verschiebt Hauptansicht" (options.lua:170-184).
  if (!viewer.edgeScroll()) {
    edgePan.x = 0
    edgePan.z = 0
    applyPan()
    return
  }
  const rect = viewportEl.getBoundingClientRect()
  const m = 14
  const inside =
    e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom
  edgePan.x = inside ? (e.clientX < rect.left + m ? -1 : e.clientX > rect.right - m ? 1 : 0) : 0
  edgePan.z = inside ? (e.clientY < rect.top + m ? -1 : e.clientY > rect.bottom - m ? 1 : 0) : 0
  applyPan()
})

window.addEventListener('keydown', (e) => {
  // CTRL speeds up panning and rotating — the engine asks for it
  // MAUI_KeyIsDown(MKEY_CONTROL) (Cfile:1300005) and multiplied by
  // ui_KeyboardPanAccelerateMultiplier. This is the “Accelerated” option
  // Schwenkgeschwindigkeit" (options.lua:214-227).
  viewer.setCtrlDown(e.ctrlKey)
  if (!sandbox || e.target instanceof HTMLInputElement) return
  // The arrow keys only pan if the option allows it
  // (ui_ArrowKeysScrollView, options.lua:185-199).
  if (!viewer.arrowKeysPan()) return
  if (e.code === 'ArrowLeft') keyPan.x = -1
  else if (e.code === 'ArrowRight') keyPan.x = 1
  else if (e.code === 'ArrowUp') keyPan.z = -1
  else if (e.code === 'ArrowDown') keyPan.z = 1
  else return
  e.preventDefault()
  applyPan()
})
window.addEventListener('keyup', (e) => {
  viewer.setCtrlDown(e.ctrlKey)
  if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') keyPan.x = 0
  if (e.code === 'ArrowUp' || e.code === 'ArrowDown') keyPan.z = 0
  applyPan()
})

function showUnitInfo(id: string, bp: BpObject): void {
  const name = stripLoc(bpGet(bp, 'General.UnitName')) ?? ''
  const desc = stripLoc(bpGet(bp, 'Description')) ?? ''
  const faction = bpGet(bp, 'General.FactionName') ?? '?'
  const health = bpGet(bp, 'Defense.MaxHealth') ?? '?'
  const buildTime = bpGet(bp, 'Economy.BuildTime') ?? '?'
  unitInfo.innerHTML = `
    <strong>${name || id.toUpperCase()}</strong><br>
    ${desc}<br>
    Faction: <strong>${faction}</strong> ·
    HP: <strong>${health}</strong> ·
    Construction time: <strong>${buildTime}</strong>
  `
}

// ---------------------------------------------------------------------------
// UI-Events
// ---------------------------------------------------------------------------

btnPickDir.addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: 'cfa-game-dir', mode: 'read' })
    await saveDirHandle(handle)
    await connect(new FsaGameSource(handle))
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      log(`ERROR: ${err instanceof Error ? err.message : err}`)
    }
  }
})

btnResume.addEventListener('click', async () => {
  const handle = await loadDirHandle()
  if (!handle) {
    log('ERROR: Saved directory can no longer be read - please select again')
    return
  }
  // Chrome's permission prompt offers "Allow on every visit" — once the
  // user picks that, the next reload connects without any click.
  const perm = await handle.requestPermission({ mode: 'read' })
  if (perm === 'granted') {
    btnResume.hidden = true
    await connect(new FsaGameSource(handle))
  } else {
    log('Zugriff abgelehnt — bitte das Verzeichnis neu wählen')
  }
})

btnFallback.addEventListener('click', () => inputDir.click())
inputDir.addEventListener('change', () => {
  if (inputDir.files && inputDir.files.length > 0) {
    void connect(new FileListGameSource(inputDir.files))
  }
})

unitSearch.addEventListener('input', () => renderUnitList(unitSearch.value))
unitSelect.addEventListener('change', () => void loadUnit(unitSelect.value))
teamColorInput.addEventListener('input', () => viewer.setTeamColor(currentTeamColor()))
animSelect.addEventListener('change', () => void playSelectedAnimation())
for (const item of menuItems) {
  item.addEventListener('click', () => {
    const mode = item.dataset.mode as Mode
    if (mode === 'frontend') {
      void startFrontEndUi()
      return
    }
    setMode(mode)
  })
}
// Collapse sidebar (more space for the sandbox). The viewer measures himself
// on the window - fire `resize` once after folding it down so that it follows suit.
btnCollapse.addEventListener('click', () => {
  const collapsed = document.body.classList.toggle('sidebar-collapsed')
  btnCollapse.textContent = collapsed ? '⟩ Seitenleiste' : '⟨ Seitenleiste'
  window.dispatchEvent(new Event('resize'))
})
mapSelect.addEventListener('change', () => void loadMap(mapSelect.value))
btnSandboxStart.addEventListener('click', () => {
  void startSandbox(mapSelect.value || 'SCMP_037')
})
// The previous spawn menu (buttons per unit) is deliberately GONE: units are created
// in the game like in SCFA — via the ACU's build menu and the factory. For testing
// there are the URL parameters ?spawn=<ids> and ?selftest=<bp>.

// Engine Sim (Original Lua): Units are spawned via their real Unit.lua,
// ticked/moved per beat and selectable/rendered here.
interface LuaSceneUnit {
  id: number
  bpId: string
  mesh: THREE.Object3D
  ring: THREE.Mesh
  selected: boolean
  name: string
  army: number
  strategicIcon: string
  fadeZoom: number
  caps: ReadonlySet<string>
  /** The scene entry with skeleton animator (for the walking animation). */
  scene: SceneUnit
  /** Semi-axes + selection ring offset (from the blueprint, see ringExtents). */
  ringExtents: { x: number; z: number; ox: number; oz: number }
  /**
   * Läuft die Gehanimation gerade? Die SIM sagt, ob die Einheit fährt
   * (`moving` aus `__readAllUnitsJson`) — der Renderer spielt nur ab, was die
   * Sim meldet, er entscheidet nichts.
   */
  walking: boolean
  /**
   * BAUSTELLE (mesh.fx technique UEFBuild): solange fraction < 1 trägt das
   * Mesh die Build-Materialien; bei Fertigstellung kommt das normale
   * Unit-Material zurück und das Overlay verschwindet.
   */
  build?: {
    base: THREE.ShaderMaterial
    /** Seraphim has no overlay pass (single-pass technique). */
    overlay: THREE.ShaderMaterial | null
    overlayMesh: THREE.Mesh | null
    normalMaterial: THREE.Material
  }
}
let luaSim: LuaSimClient | null = null
/**
 * Der Boot der Sim wird über das PROMISE gemerkt, nicht über das Ergebnis.
 * `if (!luaSim) luaSim = await create()` prüft vor dem await — zwei nebenläufige
 * Spawns (Sandbox-ACU + ?luaspawn=) sahen beide null und starteten je einen
 * Worker: zwei Lua-VMs, zwei 10-Hz-Beats, Units, die sich gegenseitig nicht sehen.
 */
let luaSimBoot: Promise<LuaSimClient> | null = null

async function getLuaSim(): Promise<LuaSimClient> {
  if (!luaSimBoot) {
    if (!currentScmap) throw new Error('Sim ohne Karte: kein Gelände, kein Spawn')
    log('Boote Original-Lua-Sim (Lua-VM)…')
    // The terrain goes along with MIT: the original Lua reads GetSurfaceHeight
    // already when creating a unit, and the engine does not provide any silent information for this
    // 0 more.
    const terrain: HeightfieldData = {
      data: currentScmap.heightmap,
      width: currentScmap.width,
      height: currentScmap.height,
      scale: currentScmap.heightScale,
    }
    luaSimBoot = LuaSimClient.create(vfs!, terrain, (lvl, msg) => {
      if (lvl === 'WARN') log(`Lua-WARN: ${msg.slice(0, 80)}`)
    }).then((sim) => {
      luaSim = sim
      log('Lua-Sim bereit')
      return sim
    })
  }
  return luaSimBoot
}
const luaUnits: LuaSceneUnit[] = []
/** Which Sim Units already have a model in the scene (loading process is asynchronous). */
const knownSceneUnits = new Set<number>()

// Beat interpolation (M6): the last and current SIM state per unit —
// the renderer fades in between within 100 ms of a beat.
interface UnitLerp {
  px: number
  py: number
  pz: number
  ph: number
  cx: number
  cy: number
  cz: number
  ch: number
}
const unitLerp = new Map<number, UnitLerp>()
let lastLerpTick = -1
let lastLerpWall = 0

// As long as the sim isn't running, there's nothing - no invented starting values.
// Supplies and warehouses are created exclusively in the Sim: the warehouse from the
// Storage* fields of the units, the starting supply from GiveInitialResources of the ACU
// (uel0001_script.lua:159). The 150/650/400/4000 that were standing here were free
// invented — and covered up the real values ​​in the HUD.
const EMPTY_ECO: EcoSnapshot = {
  mass: 0, massStorage: 0, massIncome: 0, massExpense: 0,
  energy: 0, energyStorage: 0, energyIncome: 0, energyExpense: 0,
  massRequested: 0, energyRequested: 0,
}

/**
 * Die Schriften des Spiels: `<GameDir>/fonts/*.ttf` — lose Dateien, kein Archiv,
 * deshalb über die GameSource und nicht über das VFS.
 *
 * `lua/skins/skins.lua:22-26` verlangt "Arial" und "Zeroes Three"; die Engine
 * misst Text mit genau diesen Dateien (Cfile:1146720). Ohne sie hätte die
 * Original-Lua keine Textmaße — und rechnete ihr halbes Layout falsch.
 */
async function loadGameFonts(): Promise<Uint8Array[]> {
  if (!source) return []
  const out: Uint8Array[] = []
  try {
    for (const entry of await source.list('fonts')) {
      if (!/\.ttf$/i.test(entry.name)) continue
      const raf = await source.open(`fonts/${entry.name}`)
      out.push(new Uint8Array(await raf.slice(0, raf.size)))
    }
  } catch (err) {
    log(`Schriften: ${err instanceof Error ? err.message : err}`)
  }
  return out
}

/** RULEUCC_* capabilities from General.CommandCaps (determines the order buttons). */
function readCaps(bp: BpObject): ReadonlySet<string> {
  const caps = new Set<string>()
  const raw = bpGet(bp, 'General.CommandCaps')
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (v === true) caps.add(k)
  }
  return caps
}

// Data source for minimap and strategic icons. Economics, Orders, Unit View
// and build menu are no longer there - they show the real lua/ui
// (src/ui/gameUi.ts).
const hudSource: HudSource = {
  units(): HudUnitInfo[] {
    if (!luaSim) return []
    const out: HudUnitInfo[] = []
    for (const u of luaUnits) {
      const s = luaSim.state(u.id)
      if (!s) continue
      out.push({
        id: u.bpId, name: u.name, health: s.health, maxHealth: s.maxHealth, selected: u.selected,
        x: s.x, y: s.y, z: s.z, army: u.army, strategicIcon: u.strategicIcon, fadeZoom: u.fadeZoom,
        // Construction progress (< 1 = construction site) and half the width of the unit —
        // The life bar layer needs both: the bar floats above the
        // Unit and shows progress instead of HP on a construction site.
        fraction: s.fraction,
        halfWidth: u.ringExtents.x,
      })
    }
    return out
  },
}

/**
 * Der Auswahlring — ein Kreis mit Radius 1, der pro Einheit SKALIERT wird.
 *
 * Die Maße stehen im Blueprint, nicht im Renderer (Cfile:1215195-1215210):
 *
 *   halbX = SelectionSizeX > 0 ? SelectionSizeX · ren_UnitSelectionScale
 *                              : Kollisions-Extent · ren_SelectionSizeFudge
 *
 * dazu der Versatz `SelectionCenterOffsetX/Z` und die Höhe
 * `ren_SelectionHeightFudge`. Die drei ConVars kommen aus der Original-Datei
 * `lua/renderselectparams.lua` (die Engine liest genau sie, Cfile:1215033) —
 * kein geschätzter Wert.
 *
 * Vorher war der Ring ein fester Kreis mit Radius 1: um eine ACU zu groß, um
 * eine Fabrik viel zu klein.
 */
const luaRingGeo = (() => {
  const g = new THREE.RingGeometry(0.85, 1, 48)
  g.rotateX(-Math.PI / 2)
  return g
})()

/** The values ​​from `lua/renderselectparams.lua` (original file, not a replica). */
let selectParams = { sizeFudge: 1.85, heightFudge: 0.12, unitScale: 0.75 }
async function loadSelectParams(): Promise<void> {
  if (!vfs || !vfs.exists('lua/renderselectparams.lua')) return
  const text = new TextDecoder('utf-8').decode(await vfs.read('lua/renderselectparams.lua'))
  const p = parseLuaAssignments(text)
  const num = (k: string, fallback: number): number => {
    const v = bpGet(p, `RenderSelectParams.${k}`)
    return typeof v === 'number' ? v : fallback
  }
  selectParams = {
    sizeFudge: num('ren_SelectionSizeFudge', 1.85),
    heightFudge: num('ren_SelectionHeightFudge', 0.12),
    unitScale: num('ren_UnitSelectionScale', 0.75),
  }
}

/** The semi-axes of the selection ring of a unit (world meter). */
function ringExtents(bp: BpObject): { x: number; z: number; ox: number; oz: number } {
  const n = (path: string): number => {
    const v = bpGet(bp, path)
    return typeof v === 'number' ? v : 0
  }
  const selX = n('SelectionSizeX')
  const selZ = n('SelectionSizeZ')
  return {
    x: selX > 0 ? selX * selectParams.unitScale : (n('SizeX') / 2) * selectParams.sizeFudge,
    z: selZ > 0 ? selZ * selectParams.unitScale : (n('SizeZ') / 2) * selectParams.sizeFudge,
    ox: n('SelectionCenterOffsetX'),
    oz: n('SelectionCenterOffsetZ'),
  }
}

/** Left-click: Select Lua unit under the cursor (or empty selection). */
/**
 * Selektion. Das Picking (Bildschirmpunkt → Unit) ist Engine-Arbeit; die
 * AUSWAHL selbst gehört der UI: `SelectUnits` in der UI-VM ruft
 * `gamemain.OnSelectionChanged`, und daraus speisen sich orders.lua,
 * construction.lua und unitview.lua (Cfile:1294170).
 */
function selectLua(clientX: number, clientY: number): string | null {
  const hit = viewer.pickUnit(clientX, clientY)
  let name: string | null = null
  const ids: number[] = []
  for (const u of luaUnits) {
    u.selected = hit != null && hit.mesh === u.mesh
    if (u.selected) {
      name = u.name
      ids.push(u.id)
    }
  }
  gameUi?.select(ids)
  return name ? `Ausgewählt: ${name}` : null
}

/** Whether at least one Lua unit is selected. */
function hasLuaSelection(): boolean {
  return luaUnits.some((u) => u.selected)
}

// Adopts position/heading + selection ring of the Lua units per frame from the
// Worker state cache — the beat runs in the worker thread, here only
// rendered (no VM call, no freeze).
function luaSimUpdate(): void {
  if (!luaSim) return
  // The sim state goes into the UI VM; the original _BeatFunction (economy.lua:251)
  // the display calculates from this.
  const eco = luaSim.economySnapshot()
  const states = luaSim.allStates()
  if (eco && gameUi) gameUi.beat(eco, states, luaSim.gameTick)

  // New units from the sim (construction site, factory product) get their model. The
  // Sim creates them; the scene follows suit — not the other way around.
  for (const s of states) {
    if (knownSceneUnits.has(s.id)) continue
    knownSceneUnits.add(s.id)
    // Making mistakes LOUD: a silently rejected promise left units without
    // Model back (life bar without mesh underneath) — without a log line.
    addLuaUnitToScene(s.id, s.name, { x: s.x, y: s.y, z: s.z }, s.fraction < 1).catch((e) => {
      log(`FEHLER Modell für ${s.name} (Unit ${s.id}): ${e instanceof Error ? e.message : e}`)
    })
  }

  // DEAD units leave the scene: the sim no longer reports them (OnDestroy
  // after the DeathThread), her wreck is already there as a prop. Previously stayed
  // the dead mesh stood forever - and covered exactly the wreck that was on
  // same place (scene debug: Unit 34 visible on the
  // wreck position, although long since dead). ONLY if the sim already has states
  // reported - before the first beat the list is empty, and the fresh
  // Otherwise the spawned ACU would be removed immediately.
  if (states.length > 0) {
    for (let i = luaUnits.length - 1; i >= 0; i--) {
      const u = luaUnits[i]!
      if (luaSim.state(u.id)) continue
      viewer.removeUnit(u.scene)
      viewer.removeHelper(u.ring)
      unitLerp.delete(u.id)
      luaUnits.splice(i, 1)
    }
  }

  // The flying projectiles — the engine draws each sim entity.
  updateProjectiles()

  // The props (wrecks) — they are also sim entities with their own mesh.
  updateProps()

  // The emitters: spawn per new Sim tick, the particle clock per frame
  // (uTime = Sim tick + frame share; the curves count in ticks).
  updateEmitters()
  if (luaSim) {
    const frac = Math.min((performance.now() - lastTickWall) / 100, 1)
    const uTime = luaSim.gameTick + frac
    particles?.update(uTime, viewer.worldCamera)
    trails?.update(uTime)
    beams?.update(uTime)
    maxBeamsGesehen = Math.max(maxBeamsGesehen, beams?.totalBeams() ?? 0)
  }

  // BEAT INTERPOLATION: the sim ticks at 10 Hz, the image at 60+ — the engine
  // draws entities interpolated between two beats (otherwise each one will stutter
  // Movement in 100 ms increments). With the NEW beat, the previous target value
  // to the starting value; Within the beat, alpha 0→1 runs over the wall clock.
  if (luaSim.gameTick !== lastLerpTick) {
    lastLerpTick = luaSim.gameTick
    lastLerpWall = performance.now()
    for (const u of luaUnits) {
      const s = luaSim.state(u.id)
      if (!s) continue
      const l = unitLerp.get(u.id)
      if (!l) {
        unitLerp.set(u.id, { px: s.x, py: s.y, pz: s.z, ph: s.heading, cx: s.x, cy: s.y, cz: s.z, ch: s.heading })
      } else {
        l.px = l.cx
        l.py = l.cy
        l.pz = l.cz
        l.ph = l.ch
        l.cx = s.x
        l.cy = s.y
        l.cz = s.z
        l.ch = s.heading
        // Jump (spawn/teleport/reset): do not slide across the map.
        if (Math.hypot(l.cx - l.px, l.cz - l.pz) > 5) {
          l.px = l.cx
          l.py = l.cy
          l.pz = l.cz
          l.ph = l.ch
        }
      }
    }
  }
  const lerpAlpha = Math.min((performance.now() - lastLerpWall) / 100, 1)

  // The command graph: order lines + waypoints for the SELECTED units'
  // active orders (UICommandGraph; params from commandgraphparams.lua).
  const orderEntries: OrderLineEntry[] = []

  for (const u of luaUnits) {
    const s = luaSim.state(u.id)
    if (!s) continue
    // The Y coordinate comes from the SIM (motion.lua overwrites it
    // GetSurfaceHeight). Before, the renderer calculated its own height —
    // two truths that permanently diverged.
    const l = unitLerp.get(u.id)
    let x = s.x
    let y = s.y
    let z = s.z
    let heading = s.heading
    if (l) {
      x = l.px + (l.cx - l.px) * lerpAlpha
      y = l.py + (l.cy - l.py) * lerpAlpha
      z = l.pz + (l.cz - l.pz) * lerpAlpha
      // Rotation via the SHORT path (−π..π), otherwise every turn spins once
      // falsch herum.
      const dh = ((l.ch - l.ph + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
      heading = l.ph + dh * lerpAlpha
    }
    u.mesh.position.set(x, y, z)
    u.mesh.rotation.set(0, heading, 0)
    // The army comes from the sim (spawn-time value in addLuaUnitToScene was
    // always 1) — without this, an enemy under the cursor never triggered
    // Attack and its icon carried the wrong tint.
    u.army = s.army
    if (u.selected && s.orders) {
      // The whole command queue as a polyline: unit -> wp1 -> wp2 ...
      // (the original graph draws every queued command, Cfile:1248392ff).
      let px = x
      let py = y
      let pz = z
      s.orders.forEach((o, i) => {
        const ty = viewer.heightAt(o.x, o.z)
        orderEntries.push({
          unitId: u.id,
          seg: i,
          type: o.t,
          from: { x: px, y: py, z: pz },
          to: { x: o.x, y: ty, z: o.z },
        })
        px = o.x
        py = ty
        pz = o.z
      })
    }
    u.ring.visible = u.selected
    if (u.selected) {
      // The ellipse from the blueprint (see ringExtents), rotated at the heading,
      // offset by the selection offset, raised to ren_SelectionHeightFudge.
      const e = u.ringExtents
      const cos = Math.cos(heading)
      const sin = Math.sin(heading)
      u.ring.position.set(
        x + e.ox * cos + e.oz * sin,
        y + selectParams.heightFudge,
        z - e.ox * sin + e.oz * cos,
      )
      u.ring.rotation.set(0, heading, 0)
      u.ring.scale.set(e.x, 1, e.z)
    }

    // TURRET AIMING: the sim's CAimManipulator state (yaw/pitch per aim
    // bone) turns the turret bones in the render skeleton.
    if (s.turrets && s.turrets.length > 0) {
      const overrides: { boneIndex: number; yaw: number; pitch: number }[] = []
      for (const t of s.turrets) {
        const yi = u.scene.boneNames.findIndex((n) => n.toLowerCase() === t.b.toLowerCase())
        if (yi >= 0) overrides.push({ boneIndex: yi, yaw: t.y, pitch: 0 })
        if (t.pb && t.p) {
          const pi = u.scene.boneNames.findIndex((n) => n.toLowerCase() === t.pb!.toLowerCase())
          if (pi >= 0 && pi !== yi) overrides.push({ boneIndex: pi, yaw: 0, pitch: t.p })
          else if (pi === yi && overrides.length > 0) overrides[overrides.length - 1]!.pitch = t.p
        }
      }
      u.scene.animator.setAimOverrides(overrides)
    } else {
      u.scene.animator.setAimOverrides([])
    }

    // CONSTRUCTION SITE: the build technique lives from three uniforms - construction progress
    // (material.y), unit age and world time in seconds (mesh.fx `time`).
    // When completed, the normal unit material returns.
    if (u.build) {
      const sek = (luaSim.gameTick + lerpAlpha) / 10
      if (s.fraction >= 1) {
        if (u.build.overlayMesh) u.mesh.remove(u.build.overlayMesh)
        u.build.overlay?.dispose()
        ;(u.scene.mesh as THREE.Mesh).material = u.build.normalMaterial
        u.build.base.dispose()
        u.build = undefined
      } else {
        const age = sek - s.born / 10
        u.build.base.uniforms.fraction!.value = s.fraction
        u.build.base.uniforms.unitAge!.value = age
        if (u.build.base.uniforms.time) u.build.base.uniforms.time.value = sek
        if (u.build.overlay) {
          u.build.overlay.uniforms.fraction!.value = s.fraction
          u.build.overlay.uniforms.unitAge!.value = age
        }
      }
    }

    // The RUNNING ANIMATION. The sim says if the unit is running (`moving` comes out
    // `__readAllUnitsJson`, fed by the navigator) — the renderer plays them
    // then off. The animation itself is the original SCA of the blueprint
    // (`Display.AnimationWalk`, loaded into loadSandboxAssets); her
    // Speed ​​is also there (`Display.AnimationWalkRate`).
    //
    // So far it has been LOADED and never started: each unit glided motionless
    // via the map.
    if (s.moving !== u.walking) {
      u.walking = s.moving
      const assets = sandboxAssetCache.get(u.bpId)
      const anim = assets?.walkAnim ?? null
      if (anim) {
        const rate = bpGet(assets!.bp, 'Display.AnimationWalkRate')
        u.scene.play(s.moving ? anim : null, typeof rate === 'number' && rate > 0 ? rate : 1)
      }
    }
  }

  orderLines?.update(orderEntries)
  commandFeedback?.update(performance.now() / 1000)
}

/**
 * Modell + Auswahlring einer Sim-Unit in die Szene bringen.
 *
 * Die Sim ist die Wahrheit: sie hat die Unit bereits erzeugt (ACU beim Start,
 * Baustelle beim Bau-Befehl, später die Fabrik-Produktion). Hier entsteht nur
 * ihr sichtbares Gegenstück.
 */
async function addLuaUnitToScene(
  uid: number,
  bpId: string,
  pos: { x: number; y: number; z: number },
  /** Construction site (fraction < 1): starts with the build materials (UEFBuild). */
  building = false,
): Promise<void> {
  knownSceneUnits.add(uid)
  const id = bpId.toLowerCase()
  const assets = await loadSandboxAssets(id)
  if (!assets) return
  const scene = viewer.addUnit(assets.model, assets.textures, currentTeamColor(), assets.shader)
  const scale = bpGet(assets.bp, 'Display.UniformScale')
  if (typeof scale === 'number' && scale > 0) scene.mesh.scale.setScalar(scale)
  scene.mesh.position.set(pos.x, pos.y, pos.z)

  // BUILD SITE: the faction's build technique (lua/system/blueprints.lua:210
  // gives every build mesh the shader '<Faction>Build' and the secondary
  // '/textures/effects/<Faction>BuildSpecular.dds'). All four factions are
  // ported: UEFBuild (mesh.fx:5627), AeonBuild (:5349), CybranBuild
  // (:5491), SeraphimBuild (:5580).
  let build: LuaSceneUnit['build']
  if (building) {
    const faction = bpGet(assets.bp, 'General.FactionName')
    const attach = (mats: {
      base: THREE.ShaderMaterial
      overlay: THREE.ShaderMaterial | null
    }): void => {
      const normalMaterial = scene.mesh.material as THREE.Material
      scene.mesh.material = mats.base
      let overlayMesh: THREE.Mesh | null = null
      if (mats.overlay) {
        overlayMesh = new THREE.Mesh(scene.mesh.geometry, mats.overlay)
        overlayMesh.frustumCulled = false
        overlayMesh.renderOrder = 1
        scene.mesh.add(overlayMesh)
      }
      build = { base: mats.base, overlay: mats.overlay, overlayMesh, normalMaterial }
    }
    if (faction === 'UEF') {
      uefBuildSpecular ??= loadFirstTexture(['textures/effects/uefbuildspecular.dds']).then((t) => {
        if (t) t.wrapS = t.wrapT = THREE.RepeatWrapping
        return t
      })
      const gitter = await uefBuildSpecular
      if (gitter) {
        const mats = createUefBuildMaterials(
          assets.textures,
          gitter,
          currentTeamColor(),
          scene.animator.skinMatrices,
          viewer.lighting ?? undefined,
        )
        attach(mats)
      }
    } else if (faction === 'Aeon' || faction === 'Cybran' || faction === 'Seraphim') {
      const spec = await buildTexture(
        `textures/effects/${faction.toLowerCase()}buildspecular.dds`,
        true,
      )
      const insect =
        faction === 'Cybran' ? await buildTexture('textures/engine/insectlookup.dds', false) : null
      const falloff =
        faction === 'Seraphim'
          ? await buildTexture('textures/environment/falloff_seraphim_lookup.dds', false)
          : null
      if (spec) {
        attach(
          createFactionBuildMaterials(
            faction,
            assets.textures,
            spec,
            insect,
            falloff,
            currentTeamColor(),
            scene.animator.skinMatrices,
            viewer.lighting ?? undefined,
            viewer.envCubeFor(faction),
          ),
        )
      } else if (!propSkipLogged.has(`build:${faction}`)) {
        propSkipLogged.add(`build:${faction}`)
        log(`build specular missing for ${faction} — site shows the finished material`)
      }
    }
  }
  const ring = new THREE.Mesh(
    luaRingGeo,
    new THREE.MeshBasicMaterial({ color: 0x44ff66, transparent: true, opacity: 0.9, depthTest: false }),
  )
  ring.visible = false
  ring.renderOrder = 10
  viewer.addHelper(ring)
  const strat = bpGet(assets.bp, 'StrategicIconName')
  const fade = bpGet(assets.bp, 'Display.Mesh.IconFadeInZoom')
  const name =
    stripLoc(bpGet(assets.bp, 'General.UnitName')) ??
    stripLoc(bpGet(assets.bp, 'Description')) ??
    id.toUpperCase()
  luaUnits.push({
    id: uid,
    bpId: id,
    mesh: scene.mesh,
    ring,
    selected: false,
    name,
    army: 1,
    strategicIcon: typeof strat === 'string' ? strat : 'icon_land_generic',
    fadeZoom: typeof fade === 'number' && fade > 0 ? fade : 130,
    caps: readCaps(assets.bp),
    scene,
    walking: false,
    ringExtents: ringExtents(assets.bp as BpObject),
    build,
  })
}

async function spawnViaLua(id: string): Promise<void> {
  if (!vfs) return
  try {
    const sim = await getLuaSim()
    // Exactly on the spawn marker on the map. The previous offset was +6/+6
    // invented; invented In the original, the ACU is on the ARMY_n marker.
    const x = spawnPoint.x
    const z = spawnPoint.z
    const y = viewer.heightAt(x, z)
    const uid = await sim.spawn(id, { x, y, z }, 1)
    await addLuaUnitToScene(uid, id, { x, y, z })
    log(`✓ ${id.toUpperCase()} über die Original-Unit.lua gespawnt — Linksklick wählt`)
  } catch (err) {
    log(`FEHLER Lua-Spawn: ${err instanceof Error ? err.message : err}`)
  }
}

// Debug view of the scene (DEV only): which Sim unit belongs to which mesh,
// Where is it located, is it visible — for troubleshooting using DevTools/CDP.
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__cfaSzene = () =>
    luaUnits.map((u) => ({
      id: u.id,
      bp: u.bpId,
      pos: u.mesh.position.toArray().map((v) => Math.round(v * 10) / 10),
      visible: u.mesh.visible,
      scale: Math.round(u.mesh.scale.x * 1000) / 1000,
    }))
  // The props (wrecks) of the scene — same view as __cfaScene.
  ;(window as unknown as Record<string, unknown>).__cfaProps = () =>
    [...propMeshes.entries()].map(([id, m]) => ({
      id,
      pos: m.position.toArray().map((v) => Math.round(v * 10) / 10),
      visible: m.visible,
      scale: Math.round(m.scale.x * 1000) / 1000,
    }))
  // Tilt the RTS camera (sky/horizon acceptance shots via CDP).
  ;(window as unknown as Record<string, unknown>).__cfaKippen = (dyPixels: number) => {
    viewer.rotateAroundTarget(0, dyPixels)
    return 'ok'
  }
  // Map/prop diagnosis: parsed prop count vs. rendered instances (CDP).
  ;(window as unknown as Record<string, unknown>).__cfaMapInfo = () => ({
    props: currentScmap?.props.length ?? -1,
    skybox: currentScmap?.skybox !== null,
    sky: viewer.skyInfo,
    stats: viewer.propStats,
  })
  // Aim the camera at a point in the world via CDP (view without mouse).
  ;(window as unknown as Record<string, unknown>).__cfaFokus = (x: number, z: number, dist = 30) => {
    viewer.focusOn(new THREE.Vector3(x, viewer.heightAt(x, z), z), dist)
    return 'ok'
  }
  // Evaluate Lua in the UI VM (troubleshooting keyboard/keymap paths).
  ;(window as unknown as Record<string, unknown>).__cfaUiEval = (code: string) =>
    gameUi ? gameUi.debugEval(code) : 'keine UI'
  // Issue a move command (movement/interpolation decreases via CDP).
  ;(window as unknown as Record<string, unknown>).__cfaMove = (id: number, x: number, z: number) => {
    luaSim?.move(id, x, z)
    return 'ok'
  }
  // Select a unit like a click would (selection-dependent visuals via CDP).
  ;(window as unknown as Record<string, unknown>).__cfaSelect = (id: number) => {
    for (const u of luaUnits) u.selected = u.id === id
    gameUi?.select([id])
    return 'ok'
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  log('Claude Commander: Forged Alliance — Unit-Viewer')

  if (!('showDirectoryPicker' in window)) {
    btnPickDir.hidden = true
    btnFallback.hidden = false
    log('Hinweis: Browser ohne File System Access API — Fallback-Auswahl aktiv')
  }

  const params = new URLSearchParams(location.search)
  if (params.has('http') && import.meta.env.DEV) {
    await connect(new HttpGameSource())
    return
  }

  const stored = await loadDirHandle()
  if (stored) {
    // The handle survives reloads in IndexedDB; whether the BROWSER still
    // grants access decides how much the user has to do:
    //  - 'granted' (Chrome remembers the permission, e.g. "Allow on every
    //    visit" in the prompt): connect fully automatically.
    //  - 'prompt': the File System Access API requires ONE user gesture
    //    (requestPermission) — so reconnecting becomes the PRIMARY button
    //    and the picker moves to second place; no folder dialog needed.
    const perm = await stored.queryPermission({ mode: 'read' })
    if (perm === 'granted') {
      log(`Gemerktes Spielverzeichnis: ${stored.name} — verbinde…`)
      await connect(new FsaGameSource(stored))
    } else {
      btnResume.hidden = false
      btnResume.classList.add('primary')
      btnResume.textContent = `Weiter mit »${stored.name}«`
      btnPickDir.classList.remove('primary')
      btnPickDir.textContent = 'Anderes Verzeichnis wählen…'
    }
  }
}

void init()
