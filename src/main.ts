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
import { applyEmitterOverrides, emitterOverrideSignature } from './effects/emitterOverrides'
import { parseSca } from './formats/sca'
import { parseScmap } from './formats/scmap'
import { resolveMeshBlueprintLod, resolveUnitPaths } from './formats/unitPaths'
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
import { LuaSimClient, type LuaPropSnapshot, type MapPropSpawn, type SimLightParticle } from './sim/luaSimClient'
import { SANDBOX_SESSION, type SessionInfo } from './sim/session'
import type { HeightfieldData } from './sim/terrain'
import { Hud, type HudSource, type HudUnitInfo, type EcoSnapshot } from './ui/hud'
import { GameUi } from './ui/gameUi'
import type { TransportHoverInfo } from './ui/worldCommands'
import { BuildPreview } from './ui/buildPreview'
import {
  blueprintPlacement,
  canBuildStructureAt,
  skirtRect,
  type Placement,
  type PlacedStructure,
  type Validity,
} from './sim/ogrid'
import {
  boxSelectIds,
  mergeSelection,
  sameTypeIds,
  selectionBpData,
  type SameTypeUnit,
  type SelectionBpData,
  type SelectionCandidate,
} from './ui/boxSelection'
import {
  SELECT_PARAM_DEFAULTS,
  bracketThickness,
  createBracketGeometry,
  updateBracketGeometry,
  type BracketExtents,
  type SelectParams,
} from './ui/selectionBrackets'
import type { ScmapData } from './formats/scmap'
import {
  createUefBuildMaterials,
  createFactionBuildMaterials,
  type UnitTextures,
} from './viewer/unitMaterial'
import { OrderLineSystem, PARAMS, type OrderLineEntry } from './viewer/orderLines'
import { CommandFeedbackSystem, type BlipAssets } from './viewer/commandFeedback'
import { WorldMeshSystem } from './viewer/worldMeshes'
import { MeshEntitySystem, type MeshEntityAssets } from './viewer/meshEntities'
import { createPhaseShieldOverlay } from './viewer/unitMaterial'

const $ = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel)
  if (!el) throw new Error(`UI-Element fehlt: ${sel}`)
  return el
}

const logEl = $<HTMLPreElement>('#log')
const sourceLabel = $('#source-label')
const btnPickDir = $<HTMLButtonElement>('#btn-pick-dir')
const btnResume = $<HTMLButtonElement>('#btn-resume')
const btnFallback = $<HTMLButtonElement>('#btn-fallback')
const inputDir = $<HTMLInputElement>('#input-dir')
const unitPanel = $('#unit-panel')
const mapPanel = $('#map-panel')
const sandboxPanel = $('#sandbox-panel')
const startPanel = $('#start-panel')
const menuItems = [...document.querySelectorAll<HTMLButtonElement>('#menu .menu-item')]
const badgeUnits = $('#badge-units')
const badgeMaps = $('#badge-maps')
const btnCollapse = $<HTMLButtonElement>('#btn-collapse')
const btnSandboxStart = $<HTMLButtonElement>('#btn-sandbox-start')
const sandboxInfo = $('#sandbox-info')
const mapSelect = $<HTMLSelectElement>('#map-select')
const mapInfo = $('#map-info')
const unitSearch = $<HTMLInputElement>('#unit-search')
const unitSelect = $<HTMLSelectElement>('#unit-select')
const teamColorInput = $<HTMLInputElement>('#team-color')
const animSelect = $<HTMLSelectElement>('#anim-select')
const unitInfo = $('#unit-info')

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
    log(`${unitIds.length} Einheiten gefunden`)

    // Ab jetzt sind alle Menüpunkte erreichbar; die Zähler zeigen, was die
    // Spieldaten hergeben.
    for (const item of menuItems) item.disabled = false
    badgeUnits.textContent = String(unitIds.length)
    badgeUnits.hidden = false
    renderUnitList('')
    await populateMapList(src)

    const params = new URLSearchParams(location.search)
    // ?frontend — direkt ins echte Hauptmenü (menus/main.lua), ohne Umweg über
    // den Launcher. Derselbe Weg, den der Menüpunkt nimmt.
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
    log(`FEHLER: ${err instanceof Error ? err.message : err}`)
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
    log(`${mapSelect.options.length} Karten gefunden`)
  } catch (err) {
    log(`Karten-Liste nicht verfügbar: ${err instanceof Error ? err.message : err}`)
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
    // Wire audio in the FRONT END too — main.lua:231/236 starts the ambient loop
    // and the "Main_Menu" music, and the options dialog drives the sound-volume
    // sliders (SetVolume). Only the session start connected these before, so the
    // whole menu was silent and the menu sound options did nothing.
    if (!gameAudio) gameAudio = await GameAudio.create(vfs, log)
    if (gameAudio) {
      const audio = gameAudio
      gameUi.connectAudio(
        (bank, cue, id) => audio.play(bank, cue, id),
        (id) => audio.stop(id),
        (enabled) => audio.setWorldSoundsEnabled(enabled),
      )
      gameUi.connectVolume((cat, vol) => audio.setVolume(cat, vol))
    }
    setIngame(true)

    // GameUi.render() fängt Lua-Fehler selbst ab und meldet jeden genau einmal
    // (wie die Engine: CMauiControl::Frame → RunScript → Fehler loggen,
    // weiterlaufen). Die Schleife darf deshalb einfach weiterlaufen.
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
    log(`FEHLER im Hauptmenü: ${err instanceof Error ? err.message : err}`)
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
// Unit laden
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
): Promise<{ model: ScmModel; textures: UnitTextures; bp: BpObject; shader: string; scrolling: boolean } | null> {
  if (!vfs) return null
  const bp = parseBlueprint(await vfs.readText(`units/${id}/${id}_unit.bp`))

  const paths = resolveUnitPaths(id, bp, (p) => vfs!.exists(p))
  if (!paths) {
    log(`${id.toUpperCase()} hat kein Mesh (Platzhalter-Unit)`)
    return null
  }
  if (!vfs.exists(paths.mesh)) {
    log(`Mesh nicht gefunden für ${id.toUpperCase()}: ${paths.mesh}`)
    return null
  }
  const model = parseScm(await vfs.read(paths.mesh))

  const albedo = await loadFirstTexture(paths.albedo)
  const normals = await loadFirstTexture(paths.normals)
  const specTeam = await loadFirstTexture(paths.specTeam)
  const lookup = paths.shader === 'Seraphim' ? await loadFirstTexture(paths.lookup) : null

  if (!albedo) log(`Keine Albedo-Textur für ${id.toUpperCase()} — rendere grau`)
  const fallbackAlbedo = new THREE.DataTexture(new Uint8Array([140, 140, 145, 255]), 1, 1)
  fallbackAlbedo.needsUpdate = true

  return {
    model,
    textures: { albedo: albedo ?? fallbackAlbedo, normals, specTeam, lookup },
    bp,
    shader: paths.shader,
    scrolling: paths.scrolling,
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
    log(`FEHLER beim Laden von ${id}: ${err instanceof Error ? err.message : err}`)
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
    log(`FEHLER bei Animation: ${err instanceof Error ? err.message : err}`)
  }
}

// ---------------------------------------------------------------------------
// Karte laden
// ---------------------------------------------------------------------------

async function loadMap(folder: string): Promise<void> {
  if (!source || !vfs) return
  try {
    sandbox = null
    hud?.dispose()
    hud = null
    viewer.setRtsControls(false)
    log(`Lade Karte ${folder}…`)
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
      mapInfo.innerHTML = `<strong>${name}</strong><br>${desc}<br>Größe: <strong>${sizeStr}</strong>`
    }

    const scmapFile = files.find((f) => f.name.toLowerCase().endsWith('.scmap'))
    if (!scmapFile) {
      log(`Keine .scmap-Datei in maps/${folder}`)
      return
    }
    const raf = await source.open(`maps/${folder}/${scmapFile.name}`)
    const data = new Uint8Array(await raf.slice(0, raf.size))
    const scmap = parseScmap(data)
    currentScmap = scmap
    log(
      `${scmapFile.name}: ${scmap.width}×${scmap.height}, ` +
        `${scmap.strata.length} Texturlagen, Wasser ${scmap.water.hasWater ? 'ja' : 'nein'}`,
    )
    await viewer.setMap(scmap, vfs)
    log(`Karte ${folder} geladen`)
  } catch (err) {
    log(`FEHLER beim Laden der Karte: ${err instanceof Error ? err.message : err}`)
  }
}

// ---------------------------------------------------------------------------
// Sandbox
// ---------------------------------------------------------------------------

let sandbox: SandboxController | null = null
let hud: Hud | null = null
let gameUi: GameUi | null = null
/** Feeds the UI VM the cursor's world position (mCursorInfo.mMouseWorldPos). */
let setCursorWorld: ((x: number, y: number, z: number) => void) | null = null

type UiCameraBridge = (operation: string, ...args: (string | number | boolean)[]) => unknown

function requireCameraNumber(value: string | number | boolean | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid UI camera ${label}`)
  }
  return value
}

;(globalThis as { __cfaUiCameraBridge?: UiCameraBridge }).__cfaUiCameraBridge = (operation, ...args) => {
  const camera = args[0]
  if (operation === 'get') {
    if (camera !== 'WorldCamera') return undefined
    const what = args[1]
    if (typeof what !== 'string') throw new Error('Invalid UI camera getter')
    return viewer.rtsCameraValue(what)
  }

  if (operation === 'set') {
    if (camera !== 'WorldCamera') return undefined
    const what = args[1]
    if (typeof what !== 'string') throw new Error('Invalid UI camera setter')
    const value = args[2]
    // A missing transition duration is 0 (instant) — the original Lua calls
    // `Camera:SetTargetZoom(zoom)` without one (zoomslider.lua:66). wasmoon
    // hands a Lua nil over as `undefined` OR as `null` depending on the path;
    // checking only for `undefined` threw "Invalid UI camera transition
    // duration" on every zoom click.
    const seconds = args[3] == null ? 0 : requireCameraNumber(args[3], 'transition duration')
    viewer.rtsSetCameraValue(what, typeof value === 'boolean' ? value : requireCameraNumber(value, what), seconds)
    return undefined
  }

  // Camera:MoveTo/SnapTo remains outside this verified target-box bridge. It
  // was already a no-op before the bridge existed, so do not turn it into an
  // unrelated UI boot failure while preserving the existing behavior.
  if (operation === 'move') return undefined

  if (camera !== 'WorldCamera') {
    throw new Error(`UI camera bridge has no rendered camera named ${String(camera)}`)
  }

  if (operation === 'targetBox') {
    viewer.rtsTargetBox(
      requireCameraNumber(args[1], 'minimum X'),
      requireCameraNumber(args[2], 'minimum Y'),
      requireCameraNumber(args[3], 'minimum Z'),
      requireCameraNumber(args[4], 'maximum X'),
      requireCameraNumber(args[5], 'maximum Y'),
      requireCameraNumber(args[6], 'maximum Z'),
      requireCameraNumber(args[7], 'transition duration'),
    )
    return undefined
  }

  if (operation === 'targetEntityBox') {
    const entityId = requireCameraNumber(args[1], 'entity id')
    const x = requireCameraNumber(args[2], 'entity X')
    const y = requireCameraNumber(args[3], 'entity Y')
    const z = requireCameraNumber(args[4], 'entity Z')
    const seconds = requireCameraNumber(args[5], 'transition duration')
    const unit = luaUnits.find((candidate) => candidate.id === entityId)
    if (unit) {
      const box = new THREE.Box3().setFromObject(unit.mesh)
      if (!box.isEmpty()) {
        // CameraImpl::TargetEntityBox expands only X/Z by cam_EntityBoxExpand = 20
        // before passing the mesh bounds to TargetBox (Cfile:1150097-1150133).
        viewer.rtsTargetBox(
          box.min.x - 20,
          box.min.y,
          box.min.z - 20,
          box.max.x + 20,
          box.max.y,
          box.max.z + 20,
          seconds,
        )
        return undefined
      }
    }
    // The UI's UserUnit position is Sim data and exists before asynchronous
    // mesh loading completes. The same single-unit box used by UIZoomTo keeps
    // focus functional until TargetEntityBox has render bounds available.
    viewer.rtsTargetBox(x - 20, y - 20, z - 20, x + 20, y + 20, z + 20, seconds)
    return undefined
  }

  if (operation === 'minimapTarget') {
    const clientX = requireCameraNumber(args[1], 'minimap X')
    const clientY = requireCameraNumber(args[2], 'minimap Y')
    const view = gameUi?.worldViews().find(
      (candidate) =>
        candidate.miniMap &&
        clientX >= candidate.left &&
        clientX < candidate.left + candidate.width &&
        clientY >= candidate.top &&
        clientY < candidate.top + candidate.height,
    )
    if (!view) throw new Error('Minimap input arrived without a matching rendered WorldView')
    viewer.rtsTargetFromMinimap(clientX, clientY, view)
    return undefined
  }

  throw new Error(`Unsupported UI camera bridge operation ${operation}`)
}

/**
 * Eine ConVar hat sich geändert (ConExecute in der UI-Lua) — die Engine erfährt
 * es. Kamera und Renderer LESEN diese Werte, genau wie die C++-Seite:
 * `ui_KeyboardPanSpeed` in der WorldView-Schleife, `cam_ZoomAmount` beim Zoomen.
 * Daran hängen die Regler im Optionen-Dialog.
 */
function conVarChanged(name: string, value: string | number | boolean): void {
  viewer.setConVar(name, value)
  // Die Lebensbalken sind eine ENGINE-Einstellung, kein UI-Element: die Aktion
  // `toggle_lifebars` (Alt-L, defaultkeymap.lua:11) schaltet die ConVar
  // `UI_RenderUnitBars` (keyactions.lua:14). Der Renderer liest sie — er
  // entscheidet nicht selbst, ob Balken erscheinen.
  if (!hud) return
  const an = value === true || value === 'true' || value === 1
  if (name.toLowerCase() === 'ui_renderunitbars') hud.renderBars = an
  // „Strategische Icons immer zeigen" ist ebenfalls eine ConVar der Engine
  // (ui_AlwaysRenderStrategicIcons, Cfile:421748) und im Optionen-Dialog
  // schaltbar. Ohne sie erscheinen die Icons erst ab Display.Mesh.IconFadeInZoom.
  if (name.toLowerCase() === 'ui_alwaysrenderstrategicicons') hud.alwaysIcons = an
  // The two strategic-icon master switches (Cfile:1284579): ui_NisRenderIcons
  // hides ALL icons, ui_RenderIcons hides the normal ones.
  if (name.toLowerCase() === 'ui_rendericons') hud.renderIcons = an
  if (name.toLowerCase() === 'ui_nisrendericons') hud.nisRenderIcons = an
  // Force enemy life bars on (Cfile:1285062) — otherwise enemies show a bar
  // only under the cursor.
  if (name.toLowerCase() === 'ui_forcelifbarsonenemy') hud.forceEnemyBars = an
}
let buildPreview: BuildPreview | null = null
let currentScmap: ScmapData | null = null
/** The map folder the sandbox is on — the Sim boots its session from it. */
let currentMapFolder: string | undefined
/** The map's water surface height, or undefined when the map has no water —
 *  a build (and its preview) is clamped up to it (GetSurfaceHeight). */
function mapWaterElevation(): number | undefined {
  return currentScmap?.water.hasWater ? currentScmap.water.elevation : undefined
}
let spawnPoint = new THREE.Vector3(20, 0, 20)
/** The unit id under the cursor (rollover) — drives the enemy life-bar rule. */
let rolloverUnitId: number | null = null
const sandboxAssetCache = new Map<string, SandboxUnitAssets>()

// --- Build-placement validity (the ghost's red/green) ------------------------
//
// canBuildStructureAt (src/sim/ogrid.ts) is the engine's own query; here we
// just feed it the data the main thread already holds: the heightfield, the
// water level, the map cell bounds and every placed structure's skirt. The
// blueprint of each placed unit is already cached (it was loaded to render it),
// so the per-blueprint placement is derived once and memoised.
const buildPlacementCache = new Map<string, Placement>()
function placementOf(bpId: string): Placement | null {
  const hit = buildPlacementCache.get(bpId)
  if (hit) return hit
  const assets = sandboxAssetCache.get(bpId)
  if (!assets) return null
  const p = blueprintPlacement(assets.bp)
  buildPlacementCache.set(bpId, p)
  return p
}
/** Placed immobile units whose skirts block new placement. */
function placedStructures(): PlacedStructure[] {
  const out: PlacedStructure[] = []
  for (const u of luaUnits) {
    const p = placementOf(u.bpId)
    if (!p || p.isMobile) continue
    const pos = u.mesh.position
    out.push({ skirt: skirtRect(p, pos.x, pos.z) })
  }
  return out
}
/** The ghost's verdict at a snapped centre (drives its tint). */
function buildValidity(bpId: string, cx: number, cz: number): Validity {
  const p = placementOf(bpId)
  if (!p || !currentScmap) return 'unknown'
  return canBuildStructureAt(p, cx, cz, {
    heightAt: (x, z) => viewer.heightAt(x, z),
    waterElevation: mapWaterElevation() ?? -10000,
    mapWidth: currentScmap.width,
    mapHeight: currentScmap.height,
    structures: placedStructures(),
  })
}

// --- Projektile: die fliegenden Schüsse der Sim, mit ihrem echten Mesh -------
//
// Die Engine rendert jede Sim-Entity (CUIWorldView) — auch Projektile, mit
// Mesh aus dem Blueprint (Display.Mesh.LODs, UniformScale; Shader TMeshGlow).
// Manche Projektile haben KEIN Mesh (nur Emitter) — die zeichnet erst das
// Partikelsystem; bis dahin sind sie unsichtbar, wie im Original ohne Effekte.
interface ProjectileAssets {
  model: ScmModel
  albedo: THREE.Texture | null
  scale: number
}
const projAssetCache = new Map<string, Promise<ProjectileAssets | null>>()
/** Shader names already reported as missing (report once, not per frame). */
const projSkipLogged = new Set<string>()
const projMeshes = new Map<number, THREE.Mesh>()
const projBaseScales = new Map<number, number>()
const projPending = new Set<number>()

function loadProjectileAssets(bpId: string): Promise<ProjectileAssets | null> {
  let p = projAssetCache.get(bpId)
  if (!p) {
    p = (async (): Promise<ProjectileAssets | null> => {
      if (!vfs) return null
      // bpId aus der Sim: '/projectiles/tdfgauss01/tdfgauss01_proj.bp'
      const path = bpId.replace(/^\//, '')
      // Projektile UND die Effekt-Entities (Trümmer beim Tod, Nuke-Controller:
      // /effects/entities/**_proj.bp — defaultexplosions.lua:285).
      const m = path.match(/^((?:projectiles|effects\/entities)\/[^/]+\/[^/]+)_proj\.bp$/)
      if (!m) return null
      const base = m[1]!
      if (!vfs.exists(path)) return null
      const bp = parseBlueprint(await vfs.readText(path))
      // The mesh is named IN THE BLUEPRINT (`Display.Mesh.LODs[n].MeshName`)
      // — that is how the engine reads it. Deriving it from the blueprint PATH
      // was a guess, and a wrong one for the build effects: the build cube
      // (`effects/entities/uefbuildeffect/uefbuildeffect03_proj.bp`) points at
      // `/meshes/generic/cube01_lod0.scm` and has no model of its own. The
      // path next to it stays as the fallback (weapon projectiles use it).
      const lodsRaw = bpGet(bp, 'Display.Mesh.LODs.1') ?? bpGet(bp, 'Display.Mesh.LODs')
      const lod = (Array.isArray(lodsRaw) ? lodsRaw[0] : lodsRaw) as BpObject | undefined
      // The shader is named in the blueprint. The projectile material here is
      // TMeshGlow (unlit, pure albedo) — exactly what the weapon projectiles
      // ask for. A blueprint naming a DIFFERENT shader (`UEFBuildCube`,
      // `AeonBuildPuddle`) does NOT get its mesh: with the wrong material a
      // white box would stand around the building. Those shaders are an open
      // step (docs/STATUS.md), not a footnote here.
      const shader = lod ? bpGet(lod, 'ShaderName') : undefined
      if (typeof shader === 'string' && /Build/i.test(shader)) {
        if (!projSkipLogged.has(shader)) {
          projSkipLogged.add(shader)
          log(`projectile shader ${shader} missing — ${bpId} stays invisible`)
        }
        return null
      }
      const lodMesh = lod ? bpGet(lod, 'MeshName') : undefined
      const meshPath =
        typeof lodMesh === 'string' && lodMesh.length > 0
          ? lodMesh.replace(/^\//, '').toLowerCase()
          : `${base}_lod0.scm`
      // KEIN Mesh ist bei vielen Projektilen die Wahrheit (ACU-Laser,
      // Maschinengewehr, Bau-Effekte): sie sind reine Emitter/Trail-Effekte
      // und werden erst mit dem Partikelsystem sichtbar.
      if (!vfs.exists(meshPath)) return null
      const model = parseScm(await vfs.read(meshPath))
      // The texture belongs to the MESH, not to the blueprint folder: if the
      // mesh lives elsewhere, so does its albedo.
      const meshBase = meshPath.replace(/_lod\d+\.scm$/i, '')
      const lodAlbedo = lod ? bpGet(lod, 'AlbedoName') : undefined
      const albedo = await loadFirstTexture(
        [
          typeof lodAlbedo === 'string' && lodAlbedo.length > 0 ? lodAlbedo.replace(/^\//, '').toLowerCase() : '',
          `${meshBase}_albedo.dds`,
          `${base}_albedo.dds`,
        ].filter((p) => p.length > 0),
      )
      const scale = bpGet(bp, 'Display.UniformScale')
      return { model, albedo, scale: typeof scale === 'number' && scale > 0 ? scale : 1 }
    })()
    projAssetCache.set(bpId, p)
  }
  return p
}

// --- Partikel: die Emitter der Sim, gespawnt nach den Original-Kurven --------
//
// Pro Sim-Tick tickt jede Emitter-Laufzeit (CEfxEmitter::Tick, 1:1 in
// src/effects/emitterRuntime.ts) und spawnt Partikel in die Batches des
// Partikelsystems (src/viewer/particles.ts — der particle.fx-Port). Emitter,
// die die Sim nicht mehr meldet, hören auf; ihre Partikel leben im
// Vertex-Shader weiter, wie im Original.
let particles: ParticleSystem | null = null
let trails: TrailSystem | null = null
let beams: BeamSystem | null = null
let orderLines: OrderLineSystem | null = null
let commandFeedback: CommandFeedbackSystem | null = null
let worldMeshes: WorldMeshSystem | null = null
let meshEntities: MeshEntitySystem | null = null
const blipAssetCache = new Map<string, Promise<BlipAssets | null>>()
const meshEntityAssetCache = new Map<string, Promise<MeshEntityAssets | null>>()

/** LOD0 of a mesh blueprint for a unit mesh swap (Unit:SetMesh). */
interface SwapAssets {
  model: ScmModel
  textures: UnitTextures
  /** SecondaryName -- the Seraphim shell's lookup (SeraphimPhaseShieldPS). */
  secondary: THREE.Texture | null
  shader: string
  scrolling: boolean
}
const swapAssetCache = new Map<string, Promise<SwapAssets | null>>()

/**
 * The swapped-in mesh's LOD0 as the unit path loads a unit's: the mesh
 * blueprint from the sim's registry, the SCM, the four textures plus the
 * SecondaryName. The lookups wrap (the shell scrolls and tiles them).
 */
async function loadSwapAssets(meshId: string): Promise<SwapAssets | null> {
  let p = swapAssetCache.get(meshId)
  if (!p) {
    p = (async (): Promise<SwapAssets | null> => {
      if (!vfs || !luaSim) return null
      const raw = (await luaSim.meshBlueprint(meshId)) as BpObject | null
      if (!raw) {
        log(`mesh swap ${meshId}: no such mesh blueprint in the sim`)
        return null
      }
      const paths = resolveMeshBlueprintLod(meshId, raw, (q) => vfs!.exists(q.toLowerCase()))
      if (!paths) {
        log(`mesh swap ${meshId}: LOD0 mesh missing`)
        return null
      }
      const model = parseScm(await vfs.read(paths.mesh.toLowerCase()))
      const lower = (l: string[]): string[] => l.map((x) => x.toLowerCase())
      const [albedo, normals, specTeam, lookup, secondary] = await Promise.all([
        loadFirstTexture(lower(paths.albedo)),
        loadFirstTexture(lower(paths.normals)),
        loadFirstTexture(lower(paths.specTeam)),
        loadFirstTexture(lower(paths.lookup)),
        loadFirstTexture(lower(paths.secondary)),
      ])
      if (!albedo) {
        log(`mesh swap ${meshId}: albedo missing`)
        return null
      }
      for (const t of [lookup, secondary]) {
        if (!t) continue
        t.wrapS = THREE.RepeatWrapping
        t.wrapT = THREE.RepeatWrapping
        t.needsUpdate = true
      }
      const lodsRaw = bpGet(raw, 'LODs')
      const lod = (Array.isArray(lodsRaw) ? lodsRaw[0] : lodsRaw) as BpObject | undefined
      return {
        model,
        textures: { albedo, normals, specTeam, lookup },
        secondary,
        shader: paths.shader,
        scrolling: lod !== undefined && bpGet(lod, 'Scrolling') === true,
      }
    })()
    swapAssetCache.set(meshId, p)
  }
  return p
}

/**
 * Put the swapped mesh on the unit's body. keepActor (shield.lua:478 passes
 * true): the unit's animator -- its bone palette -- stays and the new LOD0
 * is skinned against it (Unit::SetMesh skips the actor rebuild,
 * Cfile:954635-954717). A model with another bone count cannot ride that
 * palette; keepActor=false's rebuild is not modelled, the body then keeps
 * its geometry and only the material changes (logged). The technique's
 * P0 is the body pass: PhaseShield's NormalMappedPS(true,true,true,false,
 * 0,0) is Unit_HighFidelity's (mesh.fx:4721-4722 vs :5821-5822),
 * SeraphimPersonalShield's UnitFalloffPS(true) is Seraphim_HighFidelity's
 * (:5230-5231 vs :5856-5857); both add the shell pass P1.
 */
async function applySwap(u: LuaSceneUnit, meshId: string): Promise<void> {
  const assets = await loadSwapAssets(meshId)
  const sw = u.swap
  if (!assets || !sw || sw.meshId !== meshId || sw.applied) return
  const body = u.scene.mesh
  const skin = u.scene.animator.skinMatrices
  const sameSkeleton = assets.model.bones.length === u.scene.boneNames.length
  if (!sameSkeleton) {
    log(
      `mesh swap ${meshId}: ${assets.model.bones.length} bones against the body's ${u.scene.boneNames.length} -- geometry kept (keepActor=false is not modelled)`,
    )
  }
  const geometry = sameSkeleton ? viewer.scmGeometry(assets.model) : null
  const p0 =
    assets.shader === 'PhaseShield' ? 'Unit' : assets.shader === 'SeraphimPersonalShield' ? 'Seraphim' : assets.shader
  const old = body.material as THREE.ShaderMaterial
  const teamColor = (old.uniforms?.teamColor?.value as THREE.Color | undefined) ?? currentTeamColor()
  const material = viewer.unitMaterialFor(assets.textures, teamColor, skin, p0)
  if (material.uniforms.scrolling) material.uniforms.scrolling.value = assets.scrolling ? 1 : 0
  let overlay: THREE.ShaderMaterial | null = null
  let overlayMesh: THREE.Mesh | null = null
  if (assets.shader === 'PhaseShield' || assets.shader === 'SeraphimPersonalShield') {
    const shellLookup = assets.shader === 'PhaseShield' ? assets.textures.lookup : assets.secondary
    if (shellLookup) {
      overlay = createPhaseShieldOverlay(shellLookup, skin, body.scale.x)
      overlayMesh = new THREE.Mesh(geometry ?? body.geometry, overlay)
      overlayMesh.frustumCulled = false
      overlayMesh.renderOrder = 1
      body.add(overlayMesh)
    } else {
      log(`mesh swap ${meshId}: the shell's lookup texture is missing -- shell not drawn`)
    }
  }
  if (geometry) body.geometry = geometry
  body.material = material
  sw.body = material
  sw.geometry = geometry
  sw.overlay = overlay
  sw.overlayMesh = overlayMesh
  sw.applied = true
}

/** The unit wears its blueprint mesh again (the row dropped `mesh`). */
function undoSwap(u: LuaSceneUnit): void {
  const sw = u.swap
  if (!sw) return
  const body = u.scene.mesh
  if (sw.overlayMesh) body.remove(sw.overlayMesh)
  sw.overlay?.dispose()
  if (sw.body) {
    body.material = sw.normalMaterial
    sw.body.dispose()
  }
  if (sw.geometry) {
    body.geometry = sw.normalGeometry
    sw.geometry.dispose()
  }
  body.visible = true
  u.swap = undefined
}

/**
 * LOD0 of a mesh blueprint for a mesh entity: the blueprint from the sim
 * (the real LoadBlueprints registry), the SCM with the attributes the
 * shield shaders read (tangent/binormal for the normal-mapped domes), the
 * four textures with the WRAP addressing of mesh.fx's samplers (:162-210).
 */
async function loadMeshEntityAssets(bp: string): Promise<MeshEntityAssets | null> {
  let p = meshEntityAssetCache.get(bp)
  if (!p) {
    p = (async (): Promise<MeshEntityAssets | null> => {
      if (!vfs || !luaSim) return null
      const raw = (await luaSim.meshBlueprint(bp)) as BpObject | null
      if (!raw) {
        log(`mesh entity ${bp}: no such mesh blueprint in the sim`)
        return null
      }
      const paths = resolveMeshBlueprintLod(bp, raw, (q) => vfs!.exists(q.toLowerCase()))
      if (!paths) {
        log(`mesh entity ${bp}: LOD0 mesh missing`)
        return null
      }
      const model = parseScm(await vfs.read(paths.mesh.toLowerCase()))
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(model.positions, 3))
      geometry.setAttribute('normal', new THREE.BufferAttribute(model.normals, 3))
      geometry.setAttribute('uv', new THREE.BufferAttribute(model.uv0, 2))
      geometry.setAttribute('scmTangent', new THREE.BufferAttribute(model.tangents, 3))
      geometry.setAttribute('scmBinormal', new THREE.BufferAttribute(model.binormals, 3))
      geometry.setIndex(new THREE.BufferAttribute(model.indices, 1))
      const lower = (l: string[]): string[] => l.map((x) => x.toLowerCase())
      const [albedo, normals, specular, secondary] = await Promise.all([
        loadFirstTexture(lower(paths.albedo)),
        loadFirstTexture(lower(paths.normals)),
        loadFirstTexture(lower(paths.specTeam)),
        loadFirstTexture(lower(paths.secondary)),
      ])
      for (const t of [albedo, normals, specular, secondary]) {
        if (!t) continue
        t.wrapS = THREE.RepeatWrapping
        t.wrapT = THREE.RepeatWrapping
        t.needsUpdate = true
      }
      return { geometry, albedo, normals, specular, secondary, shader: paths.shader }
    })()
    meshEntityAssetCache.set(bp, p)
  }
  return p
}
let gameAudio: GameAudio | null = null
/** Sim loop handles (HSound analog) map into their own id space. */
const SIM_LOOP_HANDLE_BASE = 1_000_000_000
/** One-shot sim sounds get unique negative handles (fire and forget). */
let nextSimOneShotHandle = -1
const emitterRuntimes = new Map<number, EmitterRuntime>()
/** The override signature each runtime was built with (a change rebuilds it). */
const emitterOverrideSigs = new Map<number, string>()
const emitterBpData = new Map<string, EmitterBpData>()
const emitterBpPending = new Set<string>()
let lastEmitterTick = -1
let lastTickWall = 0

/**
 * mesh.fx's `time`: the engine hands the mesh renderer sCurGameTick +
 * sDeltaFrame (MeshRenderer::Batch, Cfile:1212805-1212810) and sets the
 * shader variable to that sum modulo 36000 (ConfigureShader :1194898-
 * 1194903, flt_F57F08 :421818) -- game TICKS plus the frame's fraction of
 * the beat, not seconds. A mesh instance's material.x is the tick it was
 * created on (MeshInstance ctor :1193097, :1191960), the lifetime parameter
 * is raw ticks (the command feedback blips set mDuration * 10, :1281923).
 */
function meshShaderTime(): number {
  if (!luaSim) return 0
  const frac = Math.min((performance.now() - lastTickWall) / 100, 1)
  return (luaSim.gameTick + frac) % 36000
}

async function prepareEmitterBatch(bpId: string): Promise<void> {
  // `emitterBpPending` ist eine LAUFZEIT-Sperre gegen doppelte Ladevorgaenge,
  // kein Gedaechtnis. Sie wurde nie wieder geleert: ein fehlgeschlagener Ladeweg
  // (kein Blueprint, fehlende Textur) sperrte diese Id fuer den Rest der
  // Sitzung, und nach einem Kartenwechsel — bei dem `particles` neu entsteht —
  // galten ALLE frueher geladenen Ids weiter als „schon erledigt". Ergebnis:
  // ab der zweiten Sandbox keine Partikel, keine Trails, keine Strahlen.
  //
  // Deshalb: der Merker wird im `finally` wieder freigegeben, und die
  // Wiederholungssperre haengt am POSITIVEN Ergebnis (`emitterBpData`).
  if (emitterBpData.has(bpId) || emitterBpPending.has(bpId) || !luaSim || !particles) return
  emitterBpPending.add(bpId)
  try {
    await ladeEmitterBatch(bpId)
  } finally {
    emitterBpPending.delete(bpId)
  }
}

async function ladeEmitterBatch(bpId: string): Promise<void> {
  if (!luaSim || !particles) return
  const bp = (await luaSim.emitterBlueprint(bpId)) as
    | (EmitterBpData & { RepeatTexture?: string; TextureName?: string })
    | null
  if (!bp) return // kein Emitter-BP unter dieser Id — bleibt aus
  // Polytrails (TrailEmitterBlueprint: RepeatTexture statt Texture) sind eine
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

/**
 * A light particle (CEffectManagerImpl::CreateLightParticle,
 * Cfile:905874-906033) is one SWorldParticle in the same buffer as the
 * emitter particles: blend mode 3 (ADD), constant size, its ramp sampled
 * with t/lifetime, tagged "TLight" -- which selects particle.fx's TLight_*
 * technique: a FLAT quad (WorldVS(false, true), :1097) with the depth test
 * off (:1094). One batch per texture/ramp pair carries them.
 */
const LIGHT_BP: EmitterBpData = { Blendmode: 3, Flat: true, TextureFramecount: 1, TextureStripcount: 1 }
async function spawnLightParticle(l: SimLightParticle): Promise<void> {
  if (!particles) return
  const key = `light|${l.tex}|${l.ramp}`
  if (!particles.hasBatch(key)) {
    const texP = l.tex.replace(/^\//, '').toLowerCase()
    const rampP = l.ramp.replace(/^\//, '').toLowerCase()
    const [tex, ramp] = await Promise.all([loadFirstTexture([texP]), loadFirstTexture([rampP])])
    if (!tex || !ramp) {
      log(`Light particle: texture missing (${texP || '—'} / ${rampP || '—'})`)
      return
    }
    if (!particles) return
    particles.batchFor(key, LIGHT_BP, tex, ramp, false)
  }
  particles.add(key, {
    px: l.x,
    py: l.y,
    pz: l.z,
    angle: 0,
    beginSize: l.size,
    sizeRate: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    rotRate: 0,
    ax: 0,
    ay: 0,
    az: 0,
    birth: l.tick,
    lifetime: l.life,
    framerate: 0,
    frameSize: 1,
    texRow: 0,
    rampV: 0,
    rowHeight: 1,
    dragX: 0,
    dragY: 0,
    dragZ: 0,
  })
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
    // Polytrails: pro Tick ein Segment-Punkt an der gemeldeten Position.
    if (trails?.hasBp(e.bp)) {
      trails.point(e.id, e.bp, e.x, e.y, e.z, tick, e.scale)
      continue
    }
    // Beams: das Quad zwischen den Endpunkten nachziehen.
    if (beams?.hasBp(e.bp)) {
      beams.set(e.id, e.bp, e, tick)
      continue
    }
    // The Lua's parameter overrides ride the row; a runtime is built with
    // them (and rebuilt should they change -- the shipped Lua sets them in
    // the creating tick, so that never happens in play). The particle
    // BATCH (blend mode, frames, flat, drag shading) stays the blueprint's:
    // one batch per blueprint id (docs/STATUS.md).
    const sig = emitterOverrideSignature(e)
    let rt = emitterRuntimes.get(e.id)
    if (rt && emitterOverrideSigs.get(e.id) !== sig) {
      emitterRuntimes.delete(e.id)
      rt = undefined
    }
    if (!rt) {
      const bp = emitterBpData.get(e.bp)
      if (!bp || !particles.hasBatch(e.bp)) {
        // Blueprint/Texturen laden asynchron; der Emitter beginnt, sobald
        // sie da sind (einmal pro Typ — danach kommt alles aus dem Cache).
        void prepareEmitterBatch(e.bp)
        continue
      }
      rt = new EmitterRuntime(sig ? applyEmitterOverrides(bp, e) : bp)
      emitterRuntimes.set(e.id, rt)
      emitterOverrideSigs.set(e.id, sig)
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
    if (!seen.has(id)) {
      emitterRuntimes.delete(id)
      emitterOverrideSigs.delete(id)
    }
  }
}

/** Die Projektil-Meshes dem Sim-Zustand nachziehen (pro Frame, aus dem Cache). */
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
          // Der Schuss kann schon eingeschlagen sein, während das Mesh lud —
          // dann KEIN Geist in der Szene.
          if (!luaSim?.allProjectiles().some((q) => q.id === p.id)) return
          projMeshes.set(p.id, viewer.addProjectile(assets.model, assets.albedo, assets.scale))
          projBaseScales.set(p.id, assets.scale)
        })
      }
      continue
    }
    mesh.position.set(p.x, p.y, p.z)
    // Die Sim liefert (w,x,y,z) — three.js will (x,y,z,w).
    mesh.quaternion.set(p.qx, p.qy, p.qz, p.qw)
    const baseScale = projBaseScales.get(p.id) ?? 1
    mesh.scale.set(baseScale * p.sx, baseScale * p.sy, baseScale * p.sz)
  }
  for (const [id, mesh] of projMeshes) {
    if (!seen.has(id)) {
      projMeshes.delete(id)
      projBaseScales.delete(id)
      viewer.removeProjectile(mesh)
    }
  }
}

// --- Props: die Wracks der Sim, mit dem echten Wreckage-Shader ---------------
//
// Unit.OnKilled → CreateWreckageProp (unit.lua:1090) läuft komplett in der
// Original-Lua: CreateProp + SetMesh(Display.MeshBlueprintWrecked) +
// SetScale(UniformScale) + AssociatedBP. Der Renderer zeichnet das Unit-Mesh
// mit dem Wreckage-Material (mesh.fx:2334 — Noise über Albedo, verbeult im VS).
const propMeshes = new Map<number, THREE.Mesh>()
const propPending = new Set<number>()
const propSkipLogged = new Set<string>()
let wreckNoise: Promise<THREE.Texture | null> | null = null
// Das UEF-Bau-Gitter (SecondaryName aus ExtractBuildMeshBlueprint,
// lua/system/blueprints.lua:221) — einmal geladen, von allen Baustellen geteilt.
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
  // Das Noise ist der SpecularName, den ExtractWreckageBlueprint
  // (lua/system/blueprints.lua:201) in JEDES Wrack-Mesh-BP schreibt.
  wreckNoise ??= loadFirstTexture(['env/common/props/wreckage_noise.dds']).then((t) => {
    // Der Shader sampelt UV * 5.15 mit Zeit-Offset — die Textur muss kacheln.
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
  // Das Prop kann schon wieder weg sein (Reclaim), während das Mesh lud.
  if (!luaSim?.allProps().some((q) => q.id === p.id)) return
  // material.x of the wreck: the tick it was created on (WreckagePS shifts
  // the specular lookup by frac(0.01 * material.x), mesh.fx:2344-2345).
  const mesh = viewer.addWreck(assets.model, assets.textures, noise, p.scale, p.spawn)
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
    // Props ohne Mesh/Unit-Bezug (Karten-Props kommen mit dem scmap-Parser-
    // Schwanz): einmal je Blueprint sagen, nicht raten.
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
  // Der Viewer bemisst sich am Fenster, die UI-VM am Root-Frame — beide müssen
  // den neuen Platz sehen.
  window.dispatchEvent(new Event('resize'))
  gameUi?.resize(window.innerWidth, window.innerHeight)
}

async function startSandbox(mapFolder: string): Promise<void> {
  currentMapFolder = mapFolder
  if (!vfs || !source) return
  try {
    sandbox = null
    setMode('sandbox')
    setIngame(true)
    await loadMap(mapFolder)
    // The game WorldCamera is an RTS camera. Enable it before the original UI
    // starts, because gamemain.lua immediately calls UIZoomTo during setup.
    viewer.setRtsControls(true)

    // Läuft schon eine Sim? Dann zurücksetzen, statt eine zweite ACU auf die
    // alte Sitzung zu stapeln (mit doppeltem Startvorrat aus
    // GiveInitialResources) — und mit dem Gelände der NEUEN Karte.
    if (luaSim && currentScmap) {
      luaUnits.length = 0
      knownSceneUnits.clear()
      unitLerp.clear()
      await luaSim.reset(
        {
          data: currentScmap.heightmap,
          width: currentScmap.width,
          height: currentScmap.height,
          scale: currentScmap.heightScale,
          terrainType: currentScmap.terrainTypeData,
        },
        mapPropSpawns(),
        mapWaterElevation(),
        // Der Kartenordner MUSS mit: ohne ihn faehrt der Reset ohne Sitzung,
        // und die zweite Sandbox steht ohne ACUs und ohne Lagerstaetten da.
        currentMapFolder,
      )
      log('Lua-Sim zurückgesetzt (neue Karte)')
    }

    // Die `_save.lua` wird hier NICHT mehr gelesen.
    //
    // Sie gehoert in die Sim: `SetupSession()` macht `doscript` darauf
    // (siminit.lua:91-98), `InitializeStartLocation` holt den ARMY_n-Marker
    // heraus und schreibt ihn nach `SetArmyStart`
    // (scenarioutilities.lua:1026-1033), und `CreateResources()` legt aus
    // denselben Markern die Massevorkommen an. Vorher stand hier ein
    // TS-Parser, der dieselbe Datei ein zweites Mal las und dabei die Haelfte
    // nachbaute — der Spawn-Punkt kommt jetzt aus `sim.armyStarts`.

    // Die Maße des Auswahlrings kommen aus der Original-Datei
    // lua/renderselectparams.lua (die Engine liest genau sie, Cfile:1215033).
    await loadSelectParams()
    sandbox = new SandboxController(viewer)
    // Die Massepunkte werden hier nicht mehr geparst: `CreateResources()` legt
    // sie im Sitzungsstart als echte Lagerstaetten an (schook/lua/simInit.lua:18,
    // scenarioutilities.lua:389) — auf SCMP_009 sind das 108 Masse- und 8
    // Hydrokohlenstoff-Vorkommen.
    if (currentScmap) {
      hud = new Hud(vfs, viewer, hudSource)
    }

    // Die ECHTE lua/ui in einer zweiten Lua-VM (wie im Original: Sim und UI
    // haben getrennte States). Sie baut das Eco-Panel aus economy.lua — der
    // TS-Nachbau in hud.ts ist dafür raus.
    // Die Bildschleife des Hauptmenues anhalten, BEVOR die Sitzung ihre eigene
    // bekommt: sonst laufen beide, und `gameUi.render()` wird zweimal pro Bild
    // gerufen (einmal aus dieser rAF-Schleife, einmal aus `viewer.onUpdate`).
    if (frontEndFrame) {
      cancelAnimationFrame(frontEndFrame)
      frontEndFrame = 0
    }
    gameUi?.dispose()
    // Die SESSION geht in beide VMs: die Sim bekommt sie über setupSession
    // (ScenarioInfo + Brains), die UI über dieselben Angaben — GetArmiesTable()
    // und SessionGetScenarioInfo() sind die Engine-Sicht darauf. Ohne sie
    // knallen die Session-Globals ehrlich mit „no active session".
    const session: SessionInfo = { ...SANDBOX_SESSION, map: mapFolder }
    gameUi = await GameUi.create(vfs, await loadGameFonts(), log, 'game', conVarChanged, session)
    gameUi.attachEvents()
    // Strategic icons are tinted with the army's iconColor from the
    // armiesTable (gamecolors.lua ArmyColors, Cfile:1267023-1267111).
    hud?.setArmyColors(gameUi.armyIconColors())
    // Die Audio-Ausgabe: die XACT-Banks aus <FA>/sounds/ — StartSound in der
    // UI-VM landet als PCM im Lautsprecher (StopSound beendet über die
    // Handle-ID, z. B. die Menümusik beim Sitzungsstart).
    if (!gameAudio) gameAudio = await GameAudio.create(vfs, log)
    if (gameAudio) {
      const audio = gameAudio
      gameUi.connectAudio(
        (bank, cue, id) => audio.play(bank, cue, id),
        (id) => audio.stop(id),
        (enabled) => audio.setWorldSoundsEnabled(enabled),
      )
      // The volume options (options.lua:700-779 -> SetVolume) reach the
      // XACT category gains; boot-time values are replayed by connectVolume.
      gameUi.connectVolume((cat, vol) => audio.setVolume(cat, vol))
    }
    // Der Pause-Reiter der Original-UI (tabs.lua:425/428) hält die WELT an —
    // die Sim, nicht die UI.
    gameUi.connectPause((paused) => {
      luaSim?.setPaused(paused)
      log(paused ? 'Session pausiert' : 'Session läuft weiter')
    })
    // Die Bau-Vorschau (Geistergebäude am Raster) — Engine-Rendering mit den
    // echten Blueprint-Modellen.
    buildPreview = new BuildPreview(viewer, loadSandboxAssets)
    // Red/green validity: the same query the engine's ghost uses.
    buildPreview.setValidityProvider(buildValidity)
    // Das Partikelsystem — frisch pro Sitzung (setMap → clearContent wirft
    // die Helper-Meshes weg, also auch die Batches).
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
    const loadBlipAssets = (meshPath: string, texPath: string): Promise<BlipAssets | null> => {
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
    }
    // BlueprintID branch of a feedback blip / world mesh (Cfile:1281792-1830,
    // 1296154-1296180): LOD0 mesh and albedo of the unit blueprint, the scale
    // OVERRIDDEN by Display.UniformScale.
    const resolveBlueprintMesh = async (
      blueprintId: string,
    ): Promise<{ meshPath: string; texPath: string; scale: number } | null> => {
      if (!vfs) return null
      const id = blueprintId.toLowerCase()
      try {
        const bp = parseBlueprint(await vfs.readText(`units/${id}/${id}_unit.bp`))
        const paths = resolveUnitPaths(id, bp, (p) => vfs!.exists(p))
        if (!paths) return null
        const us = bpGet(bp, 'Display.UniformScale')
        return {
          meshPath: paths.mesh,
          texPath: paths.albedo[paths.albedo.length - 1]!,
          scale: typeof us === 'number' && us > 0 ? us : 1,
        }
      } catch {
        return null
      }
    }
    commandFeedback = new CommandFeedbackSystem((o) => viewer.addHelper(o), loadBlipAssets)
    // The UI's world meshes (rally markers, tutorial arrows): the same
    // assets and material family, persistent and steered by the UI VM.
    worldMeshes?.dispose()
    worldMeshes = new WorldMeshSystem((o) => viewer.addHelper(o), loadBlipAssets, resolveBlueprintMesh, meshShaderTime)
    // The mesh entities of the sim (the shield domes): drawn with the
    // mesh.fx shield techniques, visibility by the focus army's relation.
    meshEntities?.dispose()
    meshEntities = new MeshEntitySystem(
      (o) => viewer.addHelper(o),
      (o) => viewer.removeHelper(o),
      loadMeshEntityAssets,
      () => viewer.currentEnvCube(),
      (army) => (gameUi ? gameUi.armyRelation(army) : army === focusArmy() ? 'focus' : 'enemy'),
      log,
      meshShaderTime,
    )
    ;(window as unknown as { __cfaMeshEntities?: () => { alive: number; drawn: number } }).__cfaMeshEntities = () => ({
      alive: meshEntities?.count() ?? 0,
      drawn: meshEntities?.drawn() ?? 0,
    })
    ;(window as unknown as { __cfaWorldMeshes?: () => number }).__cfaWorldMeshes = () =>
      worldMeshes?.count() ?? 0
    {
      const wm = worldMeshes
      gameUi.connectWorldMeshes((rows) => wm.sync(rows))
    }
    {
      const cf = commandFeedback
      gameUi.connectCommandFeedback(
        (meshName, blueprintId, textureName, shaderName, uniformScale, x, y, z, duration) => {
          void (async () => {
            let meshPath = meshName
            let texPath = textureName
            let scale = uniformScale
            if (!meshPath && blueprintId) {
              const bp = await resolveBlueprintMesh(blueprintId)
              if (!bp) return
              meshPath = bp.meshPath
              texPath = texPath || bp.texPath
              scale = bp.scale
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
        const [line, arrow, move, attack, repair, patrol, guard, reclaim] = await Promise.all([
          loadFirstTexture([`${base}/orderline/orderline_generic.dds`]),
          loadFirstTexture([`${base}/orderline/orderline_arrow04.dds`]),
          loadFirstTexture([`${base}/waypoints/move_btn_up.dds`]),
          loadFirstTexture([`${base}/waypoints/attack_btn_up.dds`]),
          loadFirstTexture([`${base}/waypoints/repair_btn_up.dds`]),
          loadFirstTexture([`${base}/waypoints/patrol_btn_up.dds`]),
          loadFirstTexture([`${base}/waypoints/guard_btn_up.dds`]),
          loadFirstTexture([`${base}/waypoints/reclaim_btn_up.dds`]),
        ])
        const wps = new Map<string, THREE.Texture>()
        if (move) wps.set('move_btn_up', move)
        if (attack) wps.set('attack_btn_up', attack)
        if (repair) wps.set('repair_btn_up', repair)
        if (patrol) wps.set('patrol_btn_up', patrol)
        if (guard) wps.set('guard_btn_up', guard)
        if (reclaim) wps.set('reclaim_btn_up', reclaim)
        ol.setTextures(line, arrow, wps)
      })()
    }
    // ALLE Emitter-Zwischenspeicher, nicht nur die Laufzeitzustaende: die
    // Partikel-Systeme entstehen mit der neuen Karte neu, also stehen die
    // Batches dort nicht mehr — ein `emitterBpData`-Treffer wuerde dann auf
    // etwas verweisen, das es nicht mehr gibt, und `emitterBpPending` wuerde
    // das Nachladen fuer immer verhindern.
    emitterRuntimes.clear()
    emitterBpData.clear()
    emitterBpPending.clear()
    lastEmitterTick = -1
    // Die Naht, über die Befehle der UI in die Sim gehen. Ohne sie KNALLT jeder
    // Befehl — statt still zu verpuffen (ui-globals.lua: __uiSimCommand).
    gameUi.connectSim((name, ids, value) => {
      // SetLexical-Verhalten der Engine (Cfile:1381888-1381946): Enum-Namen
      // sind case-insensitiv, das "UNITCOMMAND_"-Praefix ist optional —
      // GetUnitCommandFromCommandCap liefert z. B. 'Stop' ohne Praefix.
      const cmd = name.replace(/^UNITCOMMAND_/i, '').toLowerCase()
      const v = value as { blueprint?: string; count?: number; index?: number } | undefined
      if (cmd === 'stop') {
        // Der Stop-Knopf (orders.lua:205): Bewegungsabbruch über den
        // Navigator (AbortMove) — der volle Befehls-Dispatch (Task-Abbruch,
        // Queue leeren) ist Teil des offenen Command-Dispatch-Blocks.
        for (const id of ids) luaSim?.stop(id)
        return
      }
      if (name === 'UNITCOMMAND_BuildFactory' && v?.blueprint) {
        // Die Fabrik baut: die Einheit geht in ihre Warteschlange (die Sim spawnt
        // sie selbst, sobald sie an der Reihe ist).
        for (const id of ids) void luaSim?.factoryBuild(id, v.blueprint, v.count ?? 1)
        log(`Fabrik ${ids.join(',')}: ${v.count ?? 1}× ${v.blueprint}`)
        return
      }
      // Increase/DecreaseBuildCountInQueue der Original-UI (Rechtsklick aufs
      // Queue-Icon nimmt weg, Linksklick legt drauf — construction.lua:895/988).
      if ((name === 'ISSUE_IncreaseCommandCount' || name === 'ISSUE_DecreaseCommandCount') && v?.index !== undefined) {
        const delta = (name === 'ISSUE_IncreaseCommandCount' ? 1 : -1) * (v.count ?? 1)
        for (const id of ids) luaSim?.adjustBuildQueue(id, v.index, delta)
        return
      }
      // The fire-state buttons (orders.lua:526 / ToggleFireState): the UI asks
      // the sim driver (cfunc_SetFireStateL -> ProcessInfo(entityId,
      // "SetFireState", value)); value is the EFireState number.
      if (cmd === 'setfirestate' && typeof value === 'number') {
        for (const id of ids) luaSim?.setFireState(id, value)
        return
      }
      // ToggleScriptBit (orders.lua: shield/weapon/stealth/intel/cloak toggles):
      // the UI binding has already retained only units whose current bit equals
      // curState. ProcessInfo carries only the bit index and the sim flips it.
      if (cmd === 'togglescriptbit' && typeof value === 'number') {
        for (const id of ids) luaSim?.toggleScriptBit(id, value)
        return
      }
      if (cmd === 'setautomode' && typeof value === 'boolean') {
        for (const id of ids) luaSim?.setAutoMode(id, value)
        return
      }
      if (cmd === 'setautosurfacemode' && typeof value === 'boolean') {
        for (const id of ids) luaSim?.setAutoSurfaceMode(id, value)
        return
      }
      // The Dive button (orders.lua:241 DiveOrderBehavior -> IssueCommand
      // 'Dive'): UNITCOMMAND_Dive with the UI's clear flag (true by default,
      // cfunc_IssueCommandL Cfile:1265527) -- the sim's __dispatchDive.
      if (cmd === 'dive') {
        const clear = (value as { clear?: boolean } | undefined)?.clear !== false
        for (const id of ids) luaSim?.dive(id, clear)
        return
      }
      // UNITCOMMAND_Upgrade (construction.lua:876 IssueBlueprintCommand): the
      // structure builds its successor (General.UpgradesTo) on its own spot.
      // Same seam as every other order — IssueUpgrade in the sim VM
      // (cfunc_IssueUpgradeL, Cfile:1011315).
      if (cmd === 'upgrade' && v?.blueprint) {
        for (const id of ids) luaSim?.upgrade(id, v.blueprint)
        log(`upgrade ${ids.join(',')} → ${v.blueprint}`)
        return
      }
      // SetPaused (cfunc_SetPausedL "Pause builders in this list"): a SEPARATE
      // per-unit path — NOT the whole-world session pause (that freezes the
      // entire sim). value is the boolean; the sim halts production + demand.
      if (cmd === 'setpaused' && typeof value === 'boolean') {
        for (const id of ids) luaSim?.setUnitPaused(id, value)
        return
      }
      log(`Befehl an die Sim: ${name}(${ids.join(',')}) — noch kein Weg dorthin`)
    })
    // The UI VM selects on its own for control groups (UI_ApplySelectionSet),
    // UI_SelectByCategory and UI_ExpandCurrentSelection. The brackets live on
    // the 3D side, so it follows that selection here.
    gameUi.connectSelection((ids) => {
      const wanted = new Set(ids)
      for (const u of luaUnits) u.selected = wanted.has(u.id)
    })
    // `UI_SelectByCategory +inview` asks the camera which units are on screen
    // (GetArmyUnitsInFrustum, Cfile:866323) — worldToScreen answers it.
    gameUi.connectInView((id) => {
      const u = luaUnits.find((x) => x.id === id)
      if (!u) return false
      const p = viewer.worldToScreen(u.mesh.position)
      if (!p) return false
      const r = viewportEl.getBoundingClientRect()
      return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
    })
    setCursorWorld = gameUi.connectCursorWorld()
    // SimCallback (Ctrl-K-Selbstzerstörung, Kontrollgruppen, Diplomatie):
    // die UI ruft eine Funktion aus lua/simcallbacks.lua in der Sim.
    gameUi.connectSimCallback((func, argsLua, unitIds) => {
      luaSim?.simCallback(func, argsLua, unitIds)
    })
    // RestartSession (Menü → Neustart, tabs.lua:218): Teardown + Neustart mit
    // denselben Session-Infos (func_DoPreload, Cfile:1320748) — exakt der
    // Sandbox-Startpfad. Erst diese Naht macht SessionCanRestart() wahr.
    gameUi.connectRestart(() => {
      log('RestartSession: Session startet neu')
      void startSandbox(mapFolder)
    })

    // Beide Frame-Hooks an EINER Stelle registrieren, nach dem Karten-Laden
    // (setMap → clearContent wirft alle Hooks weg). Sie vorher oder verteilt zu
    // setzen war schon einmal die Ursache dafür, dass sich ab dem zweiten
    // Sandbox-Start nichts mehr bewegte.
    viewer.onUpdate(luaSimUpdate)
    viewer.onUpdate(() => {
      gameUi?.render()
      // Die Original-Lua sagt, WO die Weltansichten liegen: die Hauptansicht
      // (gamemain.lua:142) und die Minimap (minimap.lua:115, kartografisch).
      // Die 3D-Seite rendert in genau diese Rechtecke — sie legt sie nicht fest.
      if (gameUi) viewer.setWorldViews(gameUi.worldViews())
    })
    // KEIN TS-Spawn mehr. Die ACUs setzt die Karte selbst: `BeginSession()`
    // laeuft ihr `OnPopulate` (siminit.lua:145), fuer SCMP_009 also
    // `ScenarioUtils.InitializeArmies()` (SCMP_009_script.lua:3-5). Der
    // Sitzungsstart passiert im Worker-Boot; hier wird nur noch dorthin
    // geschaut, wo die Sim die Armee hingestellt hat.
    const params = new URLSearchParams(location.search)
    const zoomParam = Number(params.get('zoom'))
    void getLuaSim().then((sim) => {
      const start = sim.armyStarts.find((s) => s.army === 1)
      if (start) {
        spawnPoint = new THREE.Vector3(start.x, viewer.heightAt(start.x, start.z), start.z)
        log(`ARMY_1 steht bei ${start.x.toFixed(0)}, ${start.z.toFixed(0)} (Marker der Karte)`)
      }
      viewer.focusOn(spawnPoint, zoomParam > 0 ? zoomParam : 14)
    })
    sandboxInfo.innerHTML =
      `Karte <strong>${mapFolder}</strong> — Klick auf Einheit = Auswahl, ` +
      `Bau-Icon + Klick aufs Terrain = Gebäude setzen, Rechtsklick = Bewegung`
    log(`Sandbox bereit auf ${mapFolder} (Sim: 10 Ticks/s)`)
    // DEV-only debug bridge for headless CDP diagnosis: it exposes the scene
    // units, their screen positions, the selection and the command mode so a
    // driver can issue precise clicks. Never present in a production build.
    if (import.meta.env.DEV) {
      ;(window as unknown as { __cfa: unknown }).__cfa = {
        units: () =>
          luaUnits.map((u) => {
            const p = viewer.worldToScreen(u.mesh.position)
            const r = viewportEl.getBoundingClientRect()
            return {
              id: u.id,
              bp: u.bpId,
              army: u.army,
              selected: u.selected,
              swap: u.swap ? { mesh: u.swap.meshId, applied: u.swap.applied, shell: !!u.swap.overlay } : null,
              sx: p ? Math.round(r.left + p.x) : null,
              sy: p ? Math.round(r.top + p.y) : null,
            }
          }),
        commandMode: () => gameUi?.commandMode() ?? null,
        selection: () => (gameUi ? gameUi.debugEval('return __uiSelectionJson()') : '[]'),
        // A complete unit at a ground point (the self-test's own spawn path)
        // and the camera onto a point -- for headless diagnosis of things the
        // self-test scenario does not reach (a finished shield generator).
        spawn: (id: string, x: number, z: number, army = 1) =>
          luaSim?.spawn(id, { x, y: viewer.heightAt(x, z), z }, army) ?? Promise.resolve(-1),
        lookAt: (x: number, z: number) => viewer.rtsTargetLocation(x, z),
        meshEntities: () => luaSim?.allMeshEntities() ?? [],
        meshEntityDebug: () => meshEntities?.debug() ?? [],
        meshEntityObjects: () => meshEntities?.objects() ?? [],
        decals: () => viewer.runtimeDecals?.stats() ?? null,
        decalDebug: () => viewer.runtimeDecals?.debug() ?? [],
        decalObjects: () => viewer.runtimeDecals?.objects() ?? [],
        screenOf: (x: number, y: number, z: number) => {
          const p = viewer.worldToScreen(new THREE.Vector3(x, y, z))
          const r = viewportEl.getBoundingClientRect()
          return p ? [Math.round(r.left + p.x), Math.round(r.top + p.y)] : null
        },
        simEval: (lua: string) => luaSim?.debugEval(lua) ?? Promise.resolve(null),
      }
    }
    const selftest = params.get('selftest')
    if (selftest) void runSelftest(selftest)
  } catch (err) {
    log(`FEHLER Sandbox: ${err instanceof Error ? err.message : err}`)
  }
}

/**
 * Selbsttest über die URL (`?selftest=ueb0101`): wählt die ACU und baut das
 * angegebene Gebäude neben ihr — über GENAU denselben Weg wie ein Klick
 * (SelectUnits → commandmode → worldClick). Damit ist der Browser-Pfad prüfbar,
 * ohne dass jemand mit der Maus danebentippt.
 */
/**
 * Die Funde des Selbsttests — er hat sie immer BERECHNET und dann nur
 * protokolliert. „SELFTEST-KAMPF: KEIN Projektil-Mesh", „KEIN Wrack-Mesh",
 * „keine Cue abgespielt": alles Zeilen im Log, kein `throw`, kein Exit-Code,
 * kein Signal, das ein Treiber lesen könnte. CLAUDE.md nannte diesen Selbsttest
 * als Ende-zu-Ende-Gate — mechanisch existierte dieses Gate nicht.
 *
 * `selftestBefund(ok, text)` zählt jetzt mit. Am Ende steht das Ergebnis im
 * `document.title` (`SELFTEST-OK` / `SELFTEST-FAIL:N`) und in
 * `window.__selftest`, damit `scripts/shot.ts` über CDP danach fragen kann,
 * statt Logzeilen zu lesen.
 */
let selftestFunde: string[] = []
function selftestBefund(ok: boolean, text: string): void {
  log(text)
  if (!ok) selftestFunde.push(text)
}
function selftestErgebnis(): void {
  const n = selftestFunde.length
  const status = n === 0 ? 'SELFTEST-OK' : `SELFTEST-FAIL:${n}`
  document.title = status
  ;(window as unknown as { __selftest?: unknown }).__selftest = {
    status,
    failures: n,
    findings: [...selftestFunde],
  }
  log(
    n === 0
      ? 'SELFTEST: BESTANDEN — kein Fund'
      : `SELFTEST: ${n} FUND(E) — ${selftestFunde.join(' | ')}`,
  )
}

async function runSelftest(blueprintId: string): Promise<void> {
  selftestFunde = []
  const deadline = Date.now() + 60000
  while (luaUnits.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200))
  }
  const acu = luaUnits[0]
  if (!acu || !gameUi || !luaSim) {
    selftestBefund(false, 'SELFTEST: keine ACU')
    selftestErgebnis()
    return
  }
  try {
    gameUi.select([acu.id])
  } catch (err) {
    // Ein Abbruch ist ein Fund, kein Grund still auszusteigen: ohne dieses
    // Urteil endete der Selbsttest hier mit einem Logeintrag und ohne Ergebnis.
    selftestBefund(false, `SELFTEST: select scheitert — ${(err as Error).stack?.slice(0, 300)}`)
    selftestErgebnis()
    return
  }
  log(`SELFTEST: ACU ${acu.id} ausgewählt`)
  await new Promise((r) => setTimeout(r, 800))
  {
    // Was zeigt die Original-UI wirklich? Zählt, was im DOM ankommt — Bilder
    // inklusive. „Ohne Bild" heißt: das Bitmap WILL eine Textur (backgroundImage
    // gesetzt, mauiRenderer:195), sie ließ sich aber nicht auflösen — UND es ist
    // sichtbar (Alpha > 0). SolidColor-Bitmaps (nur `background`) und Alpha-0-
    // Platzhalter sind Original-Verhalten (window.lua:106-115 versteckt seine
    // Resize-Griffe genau so) — sie zu zählen meldete ewig Phantome.
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

  // Die Bau-Vorschau muss VOR dem Setzen stehen — und exakt dort, wo das Gebäude
  // landet. Beides prüft der Selbsttest.
  const ziel = { x: s.x + 9, z: s.z + 9 }
  const fp = gameUi.footprint(blueprintId)
  await buildPreview?.show(blueprintId, ziel, fp)
  await new Promise((r) => setTimeout(r, 600))
  log(`SELFTEST: Bau-Vorschau ${buildPreview?.debugPosition() ?? 'FEHLT'} (Footprint ${fp[0]}×${fp[1]})`)

  // KEIN Re-Select mehr: seit DoInitializing hinter dem ersten Sync-Beat
  // liegt (gameUi.beat), sieht gamemain.OnFirstUpdate seine Avatare und der
  // 3-s-Fork ruft SelectUnits(acu) statt SelectUnits(nil). Bleibt die Auswahl
  // hier trotzdem leer, ist das ein FUND — der Selftest meldet ihn.
  const auswahl = gameUi.selectionCount()
  selftestBefund(auswahl !== 0, auswahl === 0
    ? 'SELFTEST: FUND — Auswahl vor dem Klick leer (Regression der Init-Reihenfolge?)'
    : 'SELFTEST: Auswahl steht vor dem Klick')
  log(`SELFTEST: vor dem Klick — commandMode=${JSON.stringify(gameUi.commandMode())}, Auswahl=${auswahl}`)
  await issueWorldCommand(ziel, false)

  // Wächst der Bau? Die Zahlen kommen aus der Sim, nicht von hier.
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

  // Die Fabrik produziert: Auswahl → IssueBlueprintCommand (genau der Weg, den
  // ein Klick aufs Bau-Icon in der Original-construction.lua nimmt).
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
        `(${(tanks[0]!.fraction * 100).toFixed(0)} %) — Masse ${e?.mass.toFixed(0)}/${e?.massStorage.toFixed(0)} ` +
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
    // Auf die FREIE Seite (der Bauplatz der Fabrik liegt bei +9/+9): ein
    // Panzer mitten im Gebäude-Footprint kommt nicht zum Schuss.
    const feind = await luaSim.spawn('uel0201', { x: s.x - 14, y: s.y, z: s.z - 14 }, 2)
    // Dazu ein EIGENER Panzer: das Gauss-Duell (TDFGauss01 hat ein Mesh,
    // TDFGauss01_proj.bp:29) — der ACU-Laser ist ein reiner Emitter-Effekt
    // und erst mit dem Partikelsystem sichtbar.
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
  selftestBefund(
    maxMeshes > 0,
    maxMeshes > 0
      ? `SELFTEST-KAMPF: Projektile sichtbar — max. ${maxProj} gemeldet, ${maxMeshes} Mesh(es) in der Szene`
      : `SELFTEST-KAMPF: KEIN Projektil-Mesh (gemeldet: ${maxProj}) — der Sichtweg ist unterbrochen`,
  )
  // Das WRACK des Verlierers: Unit.OnKilled → CreateWreckageProp läuft in der
  // Original-Lua; hier zählt, dass es als Mesh mit Wreckage-Shader ankommt.
  for (let round = 0; round < 10 && propMeshes.size === 0; round++) {
    await new Promise((r) => setTimeout(r, 500))
  }
  const nProps = luaSim.allProps().length
  selftestBefund(
    propMeshes.size > 0,
    propMeshes.size > 0
      ? `SELFTEST-WRACK: ${nProps} Prop(s) gemeldet, ${propMeshes.size} Wrack-Mesh(es) in der Szene`
      : `SELFTEST-WRACK: KEIN Wrack-Mesh (gemeldet: ${nProps}) — der Props-Sichtweg ist unterbrochen`,
  )
  // Das Partikelsystem: Mündungsfeuer/Einschläge/Bau-Glow müssen als
  // Instanzen in den Batches gelandet sein.
  const nPartikel = particles?.totalParticles() ?? 0
  selftestBefund(
    nPartikel > 0,
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
  // Beams: der Bau-Strahl (build_beam_01) lief während der Bau-Phase; hier
  // zählt maxBeams über den ganzen Selftest (der Kampf hat meist keine).
  log(`SELFTEST-BEAMS: max. ${maxBeamsGesehen} Beam(s) gleichzeitig im Bild`)
  const nCues = gameAudio?.playedCount ?? -1
  selftestBefund(
    nCues > 0,
    nCues > 0
      ? `SELFTEST-AUDIO: ${nCues} Cue(s) als PCM abgespielt — die XACT-Kette lebt`
      : `SELFTEST-AUDIO: keine Cue abgespielt (${nCues < 0 ? 'kein AudioContext' : 'Kette prüfen'})`,
  )
  // Der Kampf ist der letzte Abschnitt: hier faellt das Urteil.
  selftestErgebnis()
}

/** Höchststand gleichzeitiger Beams — gepflegt in luaSimUpdate. */
let maxBeamsGesehen = 0

// --- SupCom-Steuerung ------------------------------------------------------
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
  // Die Einheit UNTER DEM CURSOR an die UI melden. Genau daraus baut
  // `unitview.lua` seine Rollover-Anzeige (GetRolloverInfo, unitview.lua:90) —
  // Name, Leben, Ökonomie der überfahrenen Einheit. Ohne diese Meldung zeigt
  // die Original-UI schlicht nichts an: sie WEISS nicht, worüber die Maus steht.
  if (sandbox && gameUi && luaSim) {
    const hit = viewer.pickUnit(e.clientX, e.clientY)
    const u = hit ? luaUnits.find((x) => x.scene === hit) : undefined
    gameUi.setRollover(u ? u.id : null)
    // The hovered unit also drives the enemy life-bar rule: an enemy shows a
    // bar only when hovered or ui_ForceLifbarsOnEnemy (Cfile:1284560-1284566).
    rolloverUnitId = u ? u.id : null
  }
  // The cursor's world position — the engine keeps it per frame in
  // CWldSession::mCursorInfo.mMouseWorldPos; `UI_SelectByCategory +nearest`
  // measures against it (Cfile:866617-866685).
  if (sandbox && setCursorWorld) {
    const hit = viewer.pickTerrain(e.clientX, e.clientY)
    if (hit) setCursorWorld(hit.x, hit.y ?? 0, hit.z)
  }
  // Bau-Modus: das Geistergebäude folgt dem Cursor — auf dem Raster, mit dem
  // die Sim es gleich setzt (src/ui/buildPreview.ts).
  if (sandbox && gameUi && buildPreview) {
    const cm = gameUi.commandMode()
    if (cm.mode === 'build' || cm.mode === 'buildanchored') {
      const hit = viewer.pickTerrain(e.clientX, e.clientY)
      if (hit && cm.name) {
        void buildPreview.show(cm.name, hit, gameUi.footprint(cm.name), mapWaterElevation())
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
  if (!luaSim) return

  // Was ein Linksklick in der Welt bedeutet, entscheidet die UI-Lua, nicht wir:
  // steht ein Command-Mode an (Bau-Icon geklickt, Move-Button gedrückt), ist der
  // Klick ein BEFEHL. Sonst ist er eine Auswahl.
  if (gameUi && gameUi.commandMode().mode !== false) {
    if (moved > 5) return
    const hit = viewer.pickTerrain(e.clientX, e.clientY)
    if (hit) void issueWorldCommand(hit, e.shiftKey, zielUnter(e.clientX, e.clientY))
    return
  }
  if (luaUnits.length === 0) return
  // Dragged = box selection (SelectionDragger). A static click is one of:
  //   Ctrl-click         — REPLACE selection with all same-type units,
  //   Ctrl+Shift-click   — toggle the same-type set (add, or remove if the
  //                        clicked unit is already selected),
  //   double-click       — select all same-type units in view,
  //   plain/Shift click  — single-unit selection (DragRelease semantics).
  let luaMsg: string | null
  if (moved > 5) {
    luaMsg = boxSelect(start.x, start.y, e.clientX, e.clientY, e.shiftKey)
  } else if (e.ctrlKey) {
    luaMsg = selectSameType(e.clientX, e.clientY, e.shiftKey ? 'toggle' : 'replace')
  } else if (e.detail >= 2) {
    luaMsg = selectSameType(e.clientX, e.clientY, 'replace')
  } else {
    luaMsg = selectLua(e.clientX, e.clientY, e.shiftKey)
  }
  if (luaMsg) log(luaMsg)
})

viewportEl.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (!luaSim || !gameUi) return
  // Rechtsklick im Command-Mode bricht ihn ab (commandmode.lua:113
  // EndCommandMode(true)) — genau wie im Original.
  if (gameUi.commandMode().mode !== false) {
    gameUi.cancelCommandMode()
    buildPreview?.hide()
    log('Befehl abgebrochen')
    return
  }
  // Otherwise the view's default order for the selection: Move onto
  // terrain, Attack on an enemy unit, Repair on an own unfinished one,
  // Guard on an own healthy one, Reclaim on a wreck or map prop.
  const hit = viewer.pickTerrain(e.clientX, e.clientY)
  if (hit) void issueWorldCommand(hit, e.shiftKey, zielUnter(e.clientX, e.clientY))
})

/**
 * The world object under the cursor, classified for the command dispatch:
 * an ENEMY unit turns the default click into Attack, an OWN UNFINISHED
 * structure into Repair (resume construction), an OWN HEALTHY unit into
 * Guard (assist, dispatch 0x0F), a wreck or map prop into Reclaim
 * (dispatch 0x13).
 */
function zielUnter(clientX: number, clientY: number): {
  enemy?: number
  /** The enemy is reclaimable (being built) — a non-attacking selection
   *  reclaims it instead of doing nothing (Cfile:1240271). */
  enemyReclaimable?: boolean
  repair?: number
  own?: number
  /** The own unit under the cursor as the transport predicates see it. */
  ownHover?: TransportHoverInfo
  /** A wreck prop under the cursor (sim prop id) — reclaim target. */
  reclaimProp?: number
  /** A map prop (tree/rock) under the cursor — its scmap instance index. */
  reclaimMapProp?: number
} {
  if (!luaSim) return {}
  // ONE depth-sorted raycast across units, wrecks and instanced map props —
  // the engine picks the CLOSEST entity of any kind under the cursor.
  const hit = viewer.pickWorld(clientX, clientY, [...propMeshes.values()])
  if (!hit) return {}
  if (hit.kind === 'unit') {
    const u = luaUnits.find((x) => x.scene === hit.unit)
    if (!u) return {}
    // The player is army 1 in the sandbox. NOTE: the engine's target
    // classification treats ALLIES like own units (repair/guard), not enemies
    // (Cfile:1240320) — with no allied army in the sandbox this never differs,
    // but a real session would need the UI VM's IsAlly here.
    if (u.army !== 1) {
      // A being-built enemy is RECLAIMABLE (v52 = IsBeingBuilt||RECLAIMABLE,
      // Cfile:1240220): a selection that cannot attack it reclaims it. The
      // RECLAIMABLE-category case for finished units is a residual (the picker
      // does not mirror blueprint categories).
      const es = luaSim.state(u.id)
      return { enemy: u.id, enemyReclaimable: !!es && es.fraction < 1 }
    }
    const s = luaSim.state(u.id)
    const bp = sandboxAssetCache.get(u.bpId)?.bp
    const cats = bpGet(bp, 'Categories')
    const isCat = (c: string): boolean => Array.isArray(cats) && cats.includes(c)
    // The own unit as the transport right-click predicates see it
    // (func_RightClickWithTransport / func_RightClickTransport, worldCommands.ts):
    // its CallTransport cap, the categories they test, Air.CanFly, its layer.
    const ownHover: TransportHoverInfo = {
      canCallTransport: bpGet(bp, 'General.CommandCaps.RULEUCC_CallTransport') === true,
      isTransportation: isCat('TRANSPORTATION'),
      isTeleportation: isCat('TELEPORTATION'),
      isFerryBeacon: isCat('FERRYBEACON'),
      isAirStaging: isCat('AIRSTAGINGPLATFORM'),
      isExperimental: isCat('EXPERIMENTAL'),
      isCommand: isCat('COMMAND'),
      canTransportCommander: isCat('CANTRANSPORTCOMMANDER'),
      canFly: bpGet(bp, 'Air.CanFly') === true,
      layer: s?.layer ?? 'Land',
      beingBuilt: !!s && s.fraction < 1,
    }
    // The engine's default-order precedence (Cfile:1240337-1240397):
    //   1. UNFINISHED own/allied unit -> Repair (resume construction).
    //   2. otherwise -> Guard (dispatch 0x0F). A FINISHED but DAMAGED unit is
    //      Guard, NOT Repair: the guard task itself repairs a damaged target
    //      (globals.lua guardProcess), so Guard wins and repair follows from it.
    // Classifying a finished damaged unit as Repair (as before) inverted this.
    if (s && s.fraction < 1) {
      // The engine excludes an immobile FACTORY/SILO from the being-built Repair
      // branch (v36 = 0, Cfile:1240342-1240350): it falls through to Guard, a
      // permanent assist that keeps feeding the factory's queue after it
      // finishes. Only a mobile unit or a non-factory/non-silo structure resumes
      // construction via a one-shot Repair.
      if (placementOf(u.bpId)?.isMobile || (!isCat('FACTORY') && !isCat('SILO'))) {
        return { repair: u.id }
      }
      return { own: u.id, ownHover }
    }
    return { own: u.id, ownHover }
  }
  if (hit.kind === 'wreck') {
    // Props are reclaim targets (dispatch 0x13) — reverse-map the wreck
    // mesh to its sim prop id.
    for (const [id, mesh] of propMeshes) {
      if (mesh === hit.object) return { reclaimProp: id }
    }
    return {}
  }
  return { reclaimMapProp: hit.mapIndex }
}

/**
 * Klick in die Welt → Befehl. Die Geometrie (Snap, Höhe) rechnet die Engine, die
 * Bedeutung kommt aus commandmode.lua (src/ui/worldCommands.ts).
 */
async function issueWorldCommand(
  hit: { x: number; z: number },
  queue: boolean,
  ziel: {
    enemy?: number
    enemyReclaimable?: boolean
    repair?: number
    own?: number
    ownHover?: TransportHoverInfo
    reclaimProp?: number
    reclaimMapProp?: number
  } = {},
): Promise<void> {
  if (!luaSim || !gameUi) return
  try {
    const msg = await gameUi.worldClick(
      luaSim,
      hit,
      (x, z) => viewer.heightAt(x, z),
      queue,
      ziel,
      mapWaterElevation(),
      buildValidity,
    )
    if (msg) log(msg)
    // Gesetzt (oder Befehl erteilt) → der Geist hat ausgedient, bis der nächste
    // Bau-Modus startet.
    if (gameUi.commandMode().mode === false) buildPreview?.hide()
  } catch (err) {
    log(`FEHLER Befehl: ${err instanceof Error ? err.message : err}`)
  }
  // Die entstandene Baustelle bekommt ihr Modell über den generischen Nachzug in
  // luaSimUpdate — die Sim meldet sie im nächsten Beat.
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
  // Ctrl+K — Selbstzerstörung der Auswahl: feuert dieselbe SimCallback wie die
  // Original-UI (confirmunitdestroy.lua:24 -> selfdestruct.lua), also 5-Sekunden-
  // Countdown und dann Kill; nochmaliges Drücken bricht ab. Kein Web-Sonderweg —
  // der echte Sim-Pfad übernimmt.
  if (
    e.code === 'KeyK' &&
    e.ctrlKey &&
    sandbox &&
    gameUi &&
    !(e.target instanceof HTMLInputElement) &&
    !(e.target instanceof HTMLSelectElement)
  ) {
    e.preventDefault()
    const n = gameUi.selfDestructSelection()
    log(n > 0 ? `Selbstzerstörung: ${n} Einheit(en) (5 s Countdown)` : 'Selbstzerstörung: keine Auswahl')
  }
  // ESC verlässt den Spielmodus und bringt den Launcher zurück. Ein
  // Übergangsweg: sobald das echte Hauptmenü läuft (lua/ui/menus/main.lua),
  // gehört ESC der Original-UI.
  if (e.code === 'Escape' && document.body.classList.contains('ingame')) {
    // Im Hauptmenü gehört ESC eigentlich der Original-UI (uimain.SetEscapeHandler,
    // main.lua:805) — bis der Tasten-Weg steht (M3), bringt es den Launcher
    // zurück. Die Bild-Pumpe muss dabei aufhören, sonst rechnet das Menü im
    // Hintergrund weiter.
    if (frontEndFrame) {
      cancelAnimationFrame(frontEndFrame)
      frontEndFrame = 0
      gameUi?.dispose()
      gameUi = null
      setMode('start')
    }
    setIngame(false)
    log('Launcher (ESC) — die Sandbox läuft weiter')
  }
})

// Die Fenstergröße ändert sich → der Root-Frame der UI-VM zieht nach, sonst
// bleibt die Original-UI auf der Größe von vorhin stehen.
window.addEventListener('resize', () => {
  gameUi?.resize(window.innerWidth, window.innerHeight)
})
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceHeld = false
})

// --- Original-Kamera: Rad-Zoom zum Cursor, Mitteltasten-Pan, ------------
// --- Kanten-Scroll und Pfeiltasten ---------------------------------------
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
  // Kanten-Scroll innerhalb des Viewports — aber nur, wenn die Option es
  // erlaubt. Die Engine fragt an genau dieser Stelle `ui_ScreenEdgeScrollView`
  // (Cfile:1300036, in der WorldView-Schleife); das ist die Option
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
  // STRG beschleunigt Schwenken und Drehen — die Engine fragt dafür
  // MAUI_KeyIsDown(MKEY_CONTROL) (Cfile:1300005) und multipliziert mit
  // ui_KeyboardPanAccelerateMultiplier. Das ist die Option „Beschleunigte
  // Schwenkgeschwindigkeit" (options.lua:214-227).
  viewer.setCtrlDown(e.ctrlKey)
  if (!sandbox || e.target instanceof HTMLInputElement) return
  // Die Pfeiltasten schwenken nur, wenn die Option es erlaubt
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
    Fraktion: <strong>${faction}</strong> ·
    HP: <strong>${health}</strong> ·
    Bauzeit: <strong>${buildTime}</strong>
  `
}

// ---------------------------------------------------------------------------
// UI-Events
// ---------------------------------------------------------------------------

btnPickDir.addEventListener('click', async () => {
  // Belt and braces: even if this button is visible (stale build, shimmed
  // API), a missing picker must fall back to the <input webkitdirectory>
  // flow instead of erroring out.
  if (typeof window.showDirectoryPicker !== 'function') {
    log('Note: this browser/context has no File System Access API — opening the file picker instead')
    inputDir.click()
    return
  }
  try {
    const handle = await window.showDirectoryPicker({ id: 'cfa-game-dir', mode: 'read' })
    await saveDirHandle(handle)
    await connect(new FsaGameSource(handle))
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      log(`FEHLER: ${err instanceof Error ? err.message : err}`)
    }
  }
})

btnResume.addEventListener('click', async () => {
  const handle = await loadDirHandle()
  if (!handle) {
    log('FEHLER: gemerktes Verzeichnis nicht mehr lesbar — bitte neu wählen')
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
// Seitenleiste einklappen (mehr Platz für die Sandbox). Der Viewer bemisst sich
// am Fenster — nach dem Umklappen einmal `resize` feuern, damit er nachzieht.
btnCollapse.addEventListener('click', () => {
  const collapsed = document.body.classList.toggle('sidebar-collapsed')
  btnCollapse.textContent = collapsed ? '⟩ Seitenleiste' : '⟨ Seitenleiste'
  window.dispatchEvent(new Event('resize'))
})
mapSelect.addEventListener('change', () => void loadMap(mapSelect.value))
btnSandboxStart.addEventListener('click', () => {
  void startSandbox(mapSelect.value || 'SCMP_037')
})
// Das frühere Spawn-Menü (Buttons je Unit) ist bewusst WEG: Einheiten entstehen
// im Spiel wie in SCFA — über das Bau-Menü der ACU und die Fabrik. Für Tests
// gibt es die URL-Parameter ?spawn=<ids> und ?selftest=<bp>.

// Engine-Sim (Original-Lua): Units werden über ihre echte Unit.lua gespawnt,
// pro Beat getickt/bewegt und hier selektierbar/gerendert.
interface LuaSceneUnit {
  id: number
  bpId: string
  mesh: THREE.Object3D
  ring: THREE.Mesh
  /** A flyer's pose of the previous and the current beat (the row's
   *  `orient`), slerped between beats like the heading. */
  prevOrient?: THREE.Quaternion
  lastOrient?: THREE.Quaternion
  lastOrientBeat?: number
  selected: boolean
  name: string
  army: number
  strategicIcon: string
  fadeZoom: number
  caps: ReadonlySet<string>
  /** Der Szenen-Eintrag mit Skelett-Animator (für die Laufanimation). */
  scene: SceneUnit
  /** Half extents + offsets of the selection box (blueprint, see ringExtents). */
  ringExtents: BracketExtents
  /** What box selection needs from the blueprint (src/ui/boxSelection.ts). */
  select: SelectionBpData
  /** What the unit bars need from the blueprint (src/ui/lifeBars.ts). */
  bars: { size: number; height: number; offset: number; render: boolean; hide: boolean }
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
  /**
   * A runtime mesh swap (Unit:SetMesh -- the personal shield's
   * OwnerShieldMesh, shield.lua:478): the row's `mesh` names the blueprint,
   * the body takes its LOD0 geometry, textures and technique; PhaseShield
   * and SeraphimPersonalShield add the shell pass. '' hides the body
   * (Entity::SetMesh(''), mMesh = 0). Undone when the row drops the field.
   */
  swap?: {
    meshId: string
    /** The tick the swap was seen: material.x of the new mesh instance. */
    since: number
    applied: boolean
    body: THREE.Material | null
    geometry: THREE.BufferGeometry | null
    overlay: THREE.ShaderMaterial | null
    overlayMesh: THREE.Mesh | null
    normalMaterial: THREE.Material
    normalGeometry: THREE.BufferGeometry
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

/**
 * The scmap map props for the sim boot (Sim::Setup creates one prop per
 * entry, Cfile:1072041-1072105). The index doubles as the stable id the
 * instanced renderer uses to hide reclaimed instances.
 */
function mapPropSpawns(): MapPropSpawn[] {
  if (!currentScmap) return []
  return currentScmap.props.map((p, index) => ({
    index,
    bp: p.blueprintPath,
    x: p.position[0],
    y: p.position[1],
    z: p.position[2],
    heading: Math.atan2(p.rotationX[2], p.rotationX[0]),
  }))
}

async function getLuaSim(): Promise<LuaSimClient> {
  if (!luaSimBoot) {
    if (!currentScmap) throw new Error('Sim ohne Karte: kein Gelände, kein Spawn')
    log('Boote Original-Lua-Sim (Lua-VM)…')
    // Das Gelände geht MIT in den Boot: die Original-Lua liest GetSurfaceHeight
    // schon beim Erzeugen einer Unit, und die Engine liefert dafür keine stille
    // 0 mehr.
    const terrain: HeightfieldData = {
      data: currentScmap.heightmap,
      width: currentScmap.width,
      height: currentScmap.height,
      scale: currentScmap.heightScale,
      // The terrain-type layer goes with it: GetTerrainType read the default
      // type for every position while the browser sent the heights alone.
      terrainType: currentScmap.terrainTypeData,
    }
    luaSimBoot = LuaSimClient.create(
      vfs!,
      terrain,
      (lvl, msg) => {
        // WARN mit voller Laenge: eine abgeschnittene Fehlermeldung hat in
        // dieser Sitzung eine Stunde gekostet.
        if (lvl === 'WARN') log(`Lua-WARN: ${msg.slice(0, 400)}`)
        // Der Sitzungsstart dauert; was er tut, gehoert ins Log. Die SPEW-Flut
        // der Original-Lua („Loading module …") bleibt draussen.
        else if (/^(NUM PROPS|Sim:|Sitzungsstart|BeginSession)/.test(msg)) log(msg)
      },
      mapWaterElevation(),
      mapPropSpawns(),
      // Mit dem Kartenordner faehrt im Worker der ECHTE Sitzungsstart:
      // SetupSession -> OnCreateArmyBrain -> BeginSession -> OnPopulate.
      currentMapFolder,
    ).then((sim) => {
      luaSim = sim
      log('Lua-Sim bereit')
      return sim
    })
  }
  return luaSimBoot
}
const luaUnits: LuaSceneUnit[] = []
/** Welche Sim-Units bereits ein Modell in der Szene haben (Ladevorgang läuft asynchron). */
const knownSceneUnits = new Set<number>()

// Beat-Interpolation (M6): je Unit der letzte und der aktuelle Sim-Zustand —
// der Renderer blendet innerhalb der 100 ms eines Beats dazwischen.
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

// Solange die Sim nicht läuft, gibt es nichts — keine erfundenen Startwerte.
// Vorrat und Lager entstehen ausschließlich in der Sim: das Lager aus den
// Storage*-Feldern der Units, der Startvorrat aus GiveInitialResources der ACU
// (uel0001_script.lua:159). Die 150/650/400/4000, die hier standen, waren frei
// erfunden — und haben die echten Werte im HUD überdeckt.
const EMPTY_ECO: EcoSnapshot = {
  mass: 0, massStorage: 0, massIncome: 0, massExpense: 0,
  energy: 0, energyStorage: 0, energyIncome: 0, energyExpense: 0,
  massRequested: 0, energyRequested: 0,
  reclaimMass: 0, reclaimEnergy: 0,
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

/** RULEUCC_*-Fähigkeiten aus General.CommandCaps (bestimmt die Order-Buttons). */
function readCaps(bp: BpObject): ReadonlySet<string> {
  const caps = new Set<string>()
  const raw = bpGet(bp, 'General.CommandCaps')
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) if (v === true) caps.add(k)
  }
  return caps
}

// Datenquelle für Minimap und strategische Icons. Ökonomie, Orders, Unit-View
// und Bau-Menü stehen NICHT mehr drin — die zeigt die echte lua/ui an
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
        // Own/allied units always get a life bar; an enemy only when hovered or
        // ui_ForceLifbarsOnEnemy (Cfile:1284554-1284570). The sandbox has one
        // army, so ally is always true here — a real session needs the UI VM's
        // IsAlly for actual alliances.
        ally: u.army === focusArmy(),
        hovered: u.id === rolloverUnitId,
        // Baufortschritt (< 1 = Baustelle) und die halbe Breite der Einheit —
        // beides braucht die Lebensbalken-Schicht: der Balken schwebt über der
        // Einheit und zeigt bei einer Baustelle den Fortschritt statt der HP.
        fraction: s.fraction,
        halfWidth: u.ringExtents.x,
        // The bar geometry comes from the BLUEPRINT (REntityBlueprint
        // mLifeBar*, Cfile:646995-646998), the values from the sim.
        lifeBarSize: u.bars.size,
        lifeBarHeight: u.bars.height,
        lifeBarOffset: u.bars.offset,
        lifeBarRender: u.bars.render,
        hideLifebars: u.bars.hide,
        beingUpgraded: s.beingUpgraded === true,
        shieldRatio: s.shieldRatio ?? 0,
        // mFuelRatio defaults to -1 = "no fuel" (Cfile:772265), not 0.
        fuelRatio: -1,
        workProgress: s.workProgress ?? 0,
      })
    }
    return out
  },
}

/**
 * The selection marker — FOUR textured bracket quads, not a ring
 * (`func_DrawSelectionBrackets`, Cfile:1215114-1215433; the maths and the
 * texture atlas live in src/ui/selectionBrackets.ts). The green circle that
 * used to sit here was invented: the engine has no ring asset at all, only
 * `selection_brackets_*.dds` and `selection.dds` for the drag rectangle.
 */
const bracketMaterial = new THREE.MeshBasicMaterial({
  transparent: true,
  depthTest: false,
  side: THREE.DoubleSide,
  // ren_SelectColor = 0xFFFFFFFF: the texture carries the colour.
  color: 0xffffff,
})
let bracketTextureLoaded = false
async function loadBracketTexture(): Promise<void> {
  if (bracketTextureLoaded) return
  bracketTextureLoaded = true
  const tex = await loadFirstTexture([
    'textures/ui/common/game/selection/selection_brackets_player.dds',
  ])
  if (tex) {
    bracketMaterial.map = tex
    bracketMaterial.needsUpdate = true
  } else {
    log('selection_brackets_player.dds missing — selection stays untextured')
  }
}

/** Die Werte aus `lua/renderselectparams.lua` (Original-Datei, kein Nachbau). */
let selectParams: SelectParams = { ...SELECT_PARAM_DEFAULTS }
async function loadSelectParams(): Promise<void> {
  if (!vfs || !vfs.exists('lua/renderselectparams.lua')) return
  const text = new TextDecoder('utf-8').decode(await vfs.read('lua/renderselectparams.lua'))
  const p = parseLuaAssignments(text)
  const num = (k: string, fallback: number): number => {
    const v = bpGet(p, `RenderSelectParams.${k}`)
    return typeof v === 'number' ? v : fallback
  }
  // All SIX keys of the file, not three: the bracket size and its minimum
  // pixel size decide how thick the marker is (Cfile:1215259-1215270).
  selectParams = {
    sizeFudge: num('ren_SelectionSizeFudge', SELECT_PARAM_DEFAULTS.sizeFudge),
    heightFudge: num('ren_SelectionHeightFudge', SELECT_PARAM_DEFAULTS.heightFudge),
    unitScale: num('ren_UnitSelectionScale', SELECT_PARAM_DEFAULTS.unitScale),
    bracketMinPixelSize: num('ren_SelectBracketMinPixelSize', SELECT_PARAM_DEFAULTS.bracketMinPixelSize),
    bracketSize: num('ren_SelectBracketSize', SELECT_PARAM_DEFAULTS.bracketSize),
    selectColor: num('ren_SelectColor', SELECT_PARAM_DEFAULTS.selectColor),
  }
}

/**
 * The bar fields of REntityBlueprint (Cfile:646995-646998): LifeBarSize (1.0),
 * LifeBarHeight (0.1), LifeBarOffset (0.0), LifeBarRender (0 for entities, but
 * the RUnitBlueprint constructor sets it to 1 for every unit, Cfile:655716) —
 * plus Display.HideLifebars, which switches the bars off per blueprint.
 */
function barBpData(bp: BpObject): LuaSceneUnit['bars'] {
  const n = (path: string, fallback: number): number => {
    const v = bpGet(bp, path)
    return typeof v === 'number' ? v : fallback
  }
  return {
    size: n('LifeBarSize', 1),
    height: n('LifeBarHeight', 0.1),
    offset: n('LifeBarOffset', 0),
    // Every unit renders bars; only props do not.
    render: bpGet(bp, 'LifeBarRender') !== false,
    hide: bpGet(bp, 'Display.HideLifebars') === true,
  }
}

/** Die Halbachsen der Auswahl-Box einer Einheit (Weltmeter). */
function ringExtents(bp: BpObject): BracketExtents {
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
    oy: n('SelectionCenterOffsetY'),
    oz: n('SelectionCenterOffsetZ'),
    // Display.SelectionThickness (Cfile:1215259) — 0 means ren_SelectBracketSize.
    thickness: n('Display.SelectionThickness') || n('SelectionThickness'),
  }
}

/** Links-Klick: Lua-Unit unter dem Cursor auswählen (oder Auswahl leeren). */
/**
 * Selektion. Das Picking (Bildschirmpunkt → Unit) ist Engine-Arbeit; die
 * AUSWAHL selbst gehört der UI: `SelectUnits` in der UI-VM ruft
 * `gamemain.OnSelectionChanged`, und daraus speisen sich orders.lua,
 * construction.lua und unitview.lua (Cfile:1294170).
 */
/** The army the player selects for (GetFocusArmy). 1 in the sandbox. */
function focusArmy(): number {
  return gameUi ? gameUi.focusArmy() : 1
}

/** Is this own living unit inside the visible viewport? (GetArmyUnitsInFrustum) */
function unitInView(u: LuaSceneUnit): boolean {
  const s = luaSim?.state(u.id)
  if (!s || s.dead) return false
  const p = viewer.worldToScreen(u.mesh.position)
  if (!p) return false
  const r = viewportEl.getBoundingClientRect()
  return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
}

function selectLua(clientX: number, clientY: number, additive = false): string | null {
  const hit = viewer.pickUnit(clientX, clientY)
  // The engine only selects SELECTABLE units — the focus army's own units
  // (CanSelectUnit, Cfile:865830). A click on an enemy unit selects nothing:
  // before this filter, enemy units were selectable and fed the order/build
  // panel from the ENEMY blueprint.
  const hits = hit ? luaUnits.filter((u) => u.mesh === hit.mesh && u.army === focusArmy()) : []
  return applySelection(hits, additive)
}

/**
 * Select every focus-army unit of the SAME blueprint as the one under the
 * cursor — the engine's double-click and Ctrl-click behaviour
 * (HandleDoubleClickSelection, Cfile:865E20; Ctrl-click same-type,
 * Cfile:1291547-1291681). `mode`:
 *   'replace' — double-click / Ctrl-click: the same-type set becomes the whole
 *               selection (Ctrl-click REPLACES, it does not add).
 *   'toggle'  — Ctrl-Shift-click: remove the same-type set if the clicked unit
 *               is already selected, otherwise add it.
 */
function selectSameType(clientX: number, clientY: number, mode: 'replace' | 'toggle'): string | null {
  const army = focusArmy()
  const hit = viewer.pickUnit(clientX, clientY)
  const clicked = hit ? luaUnits.find((u) => u.mesh === hit.mesh && u.army === army) : undefined
  const candidates: SameTypeUnit[] = luaUnits.map((u) => ({
    id: u.id,
    bpId: u.bpId,
    army: u.army,
    inView: unitInView(u),
  }))
  const current = luaUnits.filter((u) => u.selected).map((u) => u.id)
  const ids = new Set(
    sameTypeIds(clicked ? clicked.bpId : null, army, candidates, current, mode, clicked?.selected ?? false),
  )
  return applySelection(
    luaUnits.filter((u) => ids.has(u.id)),
    false,
  )
}

/**
 * Apply a selection — the one place where `selected`, the original UI and the
 * Shift semantics come together.
 *
 * Shift follows `DragRelease` (Cfile:1289882-1289946): if the hit set is
 * ALREADY fully selected it is DESELECTED (`v5 >= size(a1)` →
 * SetSelection(selection \ hits)), otherwise it is added (SetSelection(∪)).
 */
function applySelection(hits: LuaSceneUnit[], additive: boolean): string | null {
  const current = luaUnits.filter((u) => u.selected).map((u) => u.id)
  const next = new Set(mergeSelection(current, hits.map((u) => u.id), additive))
  const ids: number[] = []
  let name: string | null = null
  for (const u of luaUnits) {
    u.selected = next.has(u.id)
    if (u.selected) {
      ids.push(u.id)
      if (name === null) name = u.name
    }
  }
  gameUi?.select(ids)
  if (name === null) return null
  return ids.length > 1 ? `selected: ${ids.length} units` : `selected: ${name}`
}

/**
 * DRAG-BOX SELECTION — `Moho::SelectionDragger::DragRelease` (Cfile:863870).
 * Only the two engine parts live here: the candidate filter (own focus army,
 * alive — Cfile:1290158) and the PROJECTION of the selection box. WHICH of
 * them ends up selected is decided by `src/ui/boxSelection.ts`, straight from
 * the decompilation (hit test, priority buckets, Shift semantics).
 *
 * The box is the MESH bounding box whose half extents are multiplied by
 * `SelectionMeshScaleX/Y/Z` (Cfile:1290063-1290071) — not the selection ring
 * (`SelectionSizeX/Z`, a different field). The original's drag volume is the
 * frustum slice of the rectangle; projected box against rectangle is the same
 * test.
 */
function boxSelect(x0: number, y0: number, x1: number, y1: number, additive: boolean): string | null {
  if (!luaSim) return null
  const rect = {
    minX: Math.min(x0, x1),
    maxX: Math.max(x0, x1),
    minY: Math.min(y0, y1),
    maxY: Math.max(y0, y1),
  }
  const box = new THREE.Box3()
  const corner = new THREE.Vector3()
  const center = new THREE.Vector3()
  const half = new THREE.Vector3()
  const focusArmy = gameUi ? gameUi.focusArmy() : 1
  const candidates: SelectionCandidate[] = []
  const byId = new Map<number, LuaSceneUnit>()
  for (const u of luaUnits) {
    if (u.army !== focusArmy) continue
    const s = luaSim.state(u.id)
    if (!s || s.dead) continue
    // Step 2: `IsMobile(u) || !IsUnitState(u, 37)` (Cfile:1290062) — the
    // successor growing on a building is NOT box-selectable; the box keeps
    // selecting the working original.
    if (!u.select.mobile && s.beingUpgraded === true) continue
    box.setFromObject(u.mesh)
    if (box.isEmpty()) continue
    box.getCenter(center)
    box.getSize(half).multiplyScalar(0.5)
    half.x *= u.select.meshScale.x
    half.y *= u.select.meshScale.y
    half.z *= u.select.meshScale.z
    let minX = Infinity
    let maxX = -Infinity
    let minY = Infinity
    let maxY = -Infinity
    for (let i = 0; i < 8; i++) {
      corner.set(
        center.x + (i & 1 ? half.x : -half.x),
        center.y + (i & 2 ? half.y : -half.y),
        center.z + (i & 4 ? half.z : -half.z),
      )
      const p = viewer.worldToScreen(corner)
      if (!p) continue
      if (p.x < minX) minX = p.x
      if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y
      if (p.y > maxY) maxY = p.y
    }
    byId.set(u.id, u)
    candidates.push({
      id: u.id,
      screen: minX > maxX ? null : { minX, maxX, minY, maxY },
      priority: u.select.priority,
      lowSelectPrio: u.select.lowSelectPrio,
      beingBuilt: s.fraction < 1,
    })
  }
  const ids = boxSelectIds(candidates, rect, additive)
  const hits: LuaSceneUnit[] = []
  for (const id of ids) {
    const u = byId.get(id)
    if (u) hits.push(u)
  }
  return applySelection(hits, additive)
}

/** Ob mindestens eine Lua-Unit selektiert ist. */
function hasLuaSelection(): boolean {
  return luaUnits.some((u) => u.selected)
}

// Übernimmt Position/Heading + Auswahlring der Lua-Units pro Frame aus dem
// Worker-Zustands-Cache — der Beat läuft im Worker-Thread, hier wird nur
// gerendert (kein VM-Aufruf, kein Freeze).
function luaSimUpdate(): void {
  if (!luaSim) return
  // Der Sim-Zustand geht in die UI-VM; die Original-_BeatFunction (economy.lua:251)
  // rechnet daraus die Anzeige.
  const eco = luaSim.economySnapshot()
  const states = luaSim.allStates()
  if (eco && gameUi) gameUi.beat(eco, states, luaSim.gameTick, luaSim.getArmyRestrictions())

  // Map props whose sim prop died (reclaimed/destroyed): hide the instance
  // in the instanced renderer — map props are not per-beat serialized.
  for (const idx of luaSim.drainRemovedMapProps()) viewer.hideMapProp(idx)

  // Sim->user audio (SAudioRequest analog): weapon fire one-shots and the
  // units' ambient loops. Loop handles live in their own id space so they
  // never collide with the UI-VM's sound handles.
  if (gameAudio) {
    for (const r of luaSim.drainAudioRequests()) {
      // World sounds always play and keep their handles; DisableWorldSounds mutes
      // the World bus in GameAudio (Cfile:1346188) — instantly silencing loops
      // already playing and restoring them on EnableWorldSounds — instead of
      // suppressing starts here (which would strand a loop started while muted).
      if (r.t === 2) gameAudio.stop(SIM_LOOP_HANDLE_BASE + r.h)
      else if (r.t === 1) gameAudio.play(r.bank, r.cue, SIM_LOOP_HANDLE_BASE + r.h)
      else gameAudio.play(r.bank, r.cue, nextSimOneShotHandle--)
    }
  }

  // Sim->user camera shakes (Entity:ShakeCamera -> Sim::mSyncCamShake): every
  // entry reaches the camera's CameraShake (Cfile:1327867).
  for (const s of luaSim.drainCamShakes()) viewer.cameraShake(s)

  // Light particles (CreateLightParticle -> the particle buffer,
  // Cfile:906023): one flat, additive, depth-test-free quad each
  // (TLight_ADD, particle.fx:1089-1099).
  for (const l of luaSim.drainLights()) void spawnLightParticle(l)

  // Splats and decals (CreateSplat / CreateSplatOnBone / CreateDecal): the
  // beat's adds and removals as the render thread's sync hands them over
  // (AddDecals / RemoveDecals, Cfile:1327849-1327850), then ProcessRemovals'
  // fade step for this tick (:1327851).
  const runtimeDecals = viewer.runtimeDecals
  if (runtimeDecals) {
    for (const d of luaSim.drainDecalAdds()) runtimeDecals.add(d)
    for (const id of luaSim.drainDecalRemovals()) runtimeDecals.remove(id)
    runtimeDecals.beat(luaSim.gameTick)
  } else {
    luaSim.drainDecalAdds()
    luaSim.drainDecalRemovals()
  }

  // Neue Units aus der Sim (Baustelle, Fabrik-Produkt) bekommen ihr Modell. Die
  // Sim erzeugt sie; die Szene zieht nach — nicht umgekehrt.
  for (const s of states) {
    if (knownSceneUnits.has(s.id)) continue
    knownSceneUnits.add(s.id)
    // Fehler LAUT machen: ein still verworfenes Promise ließ Einheiten ohne
    // Modell zurück (Lebensbalken ohne Mesh darunter) — ohne eine Log-Zeile.
    addLuaUnitToScene(s.id, s.name, { x: s.x, y: s.y, z: s.z }, s.fraction < 1).catch((e) => {
      log(`FEHLER Modell für ${s.name} (Unit ${s.id}): ${e instanceof Error ? e.message : e}`)
    })
  }

  // TOTE Units verlassen die Szene: die Sim meldet sie nicht mehr (OnDestroy
  // nach dem DeathThread), ihr Wrack steht als Prop bereits da. Vorher blieb
  // das tote Mesh ewig stehen — und verdeckte exakt das Wrack, das an
  // derselben Stelle entsteht (Szene-Debug: Unit 34 visible auf der
  // Wrack-Position, obwohl längst gestorben). NUR wenn die Sim schon Zustände
  // gemeldet hat — vor dem ersten Beat ist die Liste leer, und die frisch
  // gespawnte ACU würde sonst sofort wieder entfernt.
  if (states.length > 0) {
    for (let i = luaUnits.length - 1; i >= 0; i--) {
      const u = luaUnits[i]!
      if (luaSim.state(u.id)) continue
      // A swapped-in mesh (the personal shield shell) goes with the unit.
      undoSwap(u)
      viewer.removeUnit(u.scene)
      viewer.removeHelper(u.ring)
      unitLerp.delete(u.id)
      luaUnits.splice(i, 1)
    }
  }

  // Die fliegenden Projektile — die Engine zeichnet jede Sim-Entity.
  updateProjectiles()

  // Die Props (Wracks) — auch sie sind Sim-Entities mit eigenem Mesh.
  updateProps()

  // Die Emitter: pro neuem Sim-Tick spawnen, pro Frame die Partikel-Uhr
  // stellen (uTime = Sim-Tick + Frame-Anteil; die Kurven zählen in Ticks).
  updateEmitters()

  // The mesh entities (shield domes and shells): the sim's registry per
  // beat -- after updateEmitters, which stamps lastTickWall for the new
  // tick, so a mesh created this frame gets its creation tick right.
  meshEntities?.sync(luaSim.allMeshEntities())
  if (luaSim) {
    const frac = Math.min((performance.now() - lastTickWall) / 100, 1)
    const uTime = luaSim.gameTick + frac
    particles?.update(uTime, viewer.worldCamera)
    trails?.update(uTime)
    beams?.update(uTime)
    maxBeamsGesehen = Math.max(maxBeamsGesehen, beams?.totalBeams() ?? 0)
  }

  // BEAT-INTERPOLATION: die Sim tickt mit 10 Hz, das Bild mit 60+ — die Engine
  // zeichnet Entities zwischen zwei Beats interpoliert (sonst ruckelt jede
  // Bewegung im 100-ms-Raster). Beim NEUEN Beat wird der bisherige Zielwert
  // zum Startwert; innerhalb des Beats läuft alpha 0→1 über die Wanduhr.
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
        // Sprung (Spawn/Teleport/Reset): nicht über die Karte gleiten.
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
    // Die Y-Koordinate kommt aus der SIM (motion.lua schreibt sie über
    // GetSurfaceHeight fort). Vorher rechnete der Renderer seine eigene Höhe —
    // zwei Wahrheiten, die dauerhaft auseinanderliefen.
    const l = unitLerp.get(u.id)
    let x = s.x
    let y = s.y
    let z = s.z
    let heading = s.heading
    if (l) {
      x = l.px + (l.cx - l.px) * lerpAlpha
      y = l.py + (l.cy - l.py) * lerpAlpha
      z = l.pz + (l.cz - l.pz) * lerpAlpha
      // Drehung über den KURZEN Weg (−π..π), sonst wirbelt jede Wende einmal
      // falsch herum.
      const dh = ((l.ch - l.ph + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
      heading = l.ph + dh * lerpAlpha
    }
    u.mesh.position.set(x, y, z)
    if (s.orient) {
      // A flyer carries its whole pose (banking, pitch): the quaternion,
      // slerped from the previous beat's like the heading above.
      const cur = new THREE.Quaternion(s.orient[0]!, s.orient[1]!, s.orient[2]!, s.orient[3]!)
      const prev = u.prevOrient
      if (prev && l) {
        u.mesh.quaternion.slerpQuaternions(prev, cur, lerpAlpha)
      } else {
        u.mesh.quaternion.copy(cur)
      }
      if (!u.lastOrientBeat || u.lastOrientBeat !== luaSim?.gameTick) {
        u.prevOrient = u.prevOrient ? u.prevOrient.copy(u.lastOrient ?? cur) : (u.lastOrient ?? cur).clone()
        u.lastOrient = cur
        u.lastOrientBeat = luaSim?.gameTick
      }
    } else {
      u.mesh.rotation.set(0, heading, 0)
    }
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
    if (u.selected && s.fcmds) {
      // An immobile FACTORY's command list is drawn beside its own queue as a
      // second polyline from the unit (UICommandGraph::CreateMeshes,
      // Cfile:1245537-1245575): the rally line.
      let px = x
      let py = y
      let pz = z
      s.fcmds.forEach((o, i) => {
        if (!(o.t in PARAMS)) return
        // The polyline key is unitId * 4096 + seg (orderLines.ts); the unit's
        // own queue takes seg 0..499 (its 500-entry cap), the factory list
        // 1000..4095 -- the engine caps neither list, the key space does.
        if (1000 + i >= 4096) return
        orderEntries.push({
          unitId: u.id,
          seg: 1000 + i,
          type: o.t,
          from: { x: px, y: py, z: pz },
          to: { x: o.x, y: o.y ?? viewer.heightAt(o.x, o.z), z: o.z },
        })
        px = o.x
        py = o.y ?? viewer.heightAt(o.x, o.z)
        pz = o.z
      })
    }
    u.ring.visible = u.selected
    if (u.selected) {
      // Four bracket quads on the corners of the selection box. The thickness
      // is world-sized but never thinner than ren_SelectBracketMinPixelSize
      // pixels, so it needs the world width of ONE PIXEL at the unit's depth
      // (the engine's dot(mViewport.d[2], pos), Cfile:1215269).
      const halfEdge = bracketThickness(u.ringExtents, viewer.ogridsPerPixel(x, y, z), selectParams)
      updateBracketGeometry(
        u.ring.geometry,
        x,
        y,
        z,
        // The unit's full render orientation — yaw-only today (the sim sends
        // heading), so the brackets stay flat; when the sim carries a full
        // orientation the same call tilts them (Cfile:1215184).
        u.mesh.quaternion,
        u.ringExtents,
        halfEdge,
        selectParams,
      )
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

    // HIDDEN BONES: Unit:HideBone/ShowBone (CAniPoseBone::mVisible) -- the
    // ACU's upgrade pods, factory build arms. The sim sends the names; the
    // renderer collapses those bones' geometry.
    const hiddenNames = s.hidden ?? []
    const hiddenIdx: number[] = []
    for (const name of hiddenNames) {
      const bi = u.scene.boneNames.findIndex((n) => n.toLowerCase() === name.toLowerCase())
      if (bi >= 0) hiddenIdx.push(bi)
    }
    u.scene.animator.setHiddenBones(hiddenIdx)

    // CONSTRUCTION SITE: the build technique lives on three uniforms -- the
    // build fraction (material.y), the unit's age and mesh.fx `time`, the
    // one shader clock in game ticks (meshShaderTime: MeshRenderer::Batch,
    // Cfile:1212805-1212810; material.x is the creation tick, :1191960).
    // On completion the ordinary unit material returns.
    if (u.build) {
      const shaderTime = meshShaderTime()
      if (s.fraction >= 1) {
        if (u.build.overlayMesh) u.mesh.remove(u.build.overlayMesh)
        u.build.overlay?.dispose()
        ;(u.scene.mesh as THREE.Mesh).material = u.build.normalMaterial
        u.build.base.dispose()
        u.build = undefined
      } else {
        const age = shaderTime - s.born
        u.build.base.uniforms.fraction!.value = s.fraction
        u.build.base.uniforms.unitAge!.value = age
        if (u.build.base.uniforms.time) u.build.base.uniforms.time.value = shaderTime
        if (u.build.overlay) {
          u.build.overlay.uniforms.fraction!.value = s.fraction
          u.build.overlay.uniforms.unitAge!.value = age
        }
      }
    }

    // MESH SWAP (Unit:SetMesh): the row names the mesh blueprint when it is
    // not the unit's own, '' when there is none. A construction site is the
    // build path above (its build mesh is the same SetMesh, driven by the
    // fraction there), so swaps are followed once the site is complete.
    if (!u.build) {
      const wanted = s.mesh
      if (wanted !== u.swap?.meshId) {
        undoSwap(u)
        if (wanted !== undefined) {
          const body = u.scene.mesh
          u.swap = {
            meshId: wanted,
            since: luaSim.gameTick,
            applied: false,
            body: null,
            geometry: null,
            overlay: null,
            overlayMesh: null,
            normalMaterial: body.material as THREE.Material,
            normalGeometry: body.geometry,
          }
          if (wanted === '') {
            body.visible = false
            u.swap.applied = true
          } else {
            void applySwap(u, wanted).catch((e) => {
              log(`mesh swap ${wanted}: ${e instanceof Error ? e.message : String(e)}`)
            })
          }
        }
      }
      if (u.swap?.overlay) u.swap.overlay.uniforms.unitAge!.value = meshShaderTime() - u.swap.since
    }

    // TEXTURE SCROLL: the entity's mScroll1 -> mScroll2 interpolated with the
    // beat interpolant (CUIWorldMesh::GetInterpolatedScroll, Cfile:1297389-
    // 1297393), fed to the unit material (mesh.fx material.zw).
    if (s.scroll && !u.build) {
      const mat = (u.scene.mesh as THREE.Mesh).material as THREE.ShaderMaterial
      const sc = mat.uniforms.scroll
      if (sc) {
        const [s1x = 0, s1y = 0, s2x = 0, s2y = 0] = s.scroll
        ;(sc.value as THREE.Vector2).set(s1x + (s2x - s1x) * lerpAlpha, s1y + (s2y - s1y) * lerpAlpha)
      }
    }

    // Die LAUFANIMATION. Die Sim sagt, ob die Einheit fährt (`moving` kommt aus
    // `__readAllUnitsJson`, gespeist vom Navigator) — der Renderer spielt sie
    // dann ab. Die Animation selbst ist die Original-SCA des Blueprints
    // (`Display.AnimationWalk`, geladen in loadSandboxAssets); ihre
    // Geschwindigkeit steht ebenfalls dort (`Display.AnimationWalkRate`).
    //
    // Bisher wurde sie GELADEN und nie gestartet: jede Einheit glitt bewegungslos
    // über die Karte.
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
  // Every engine shader clock counts game ticks (meshShaderTime above): the
  // viewer's terrain/water/prop/sky clock and the two mesh systems.
  viewer.setShaderTime(meshShaderTime())
  worldMeshes?.update(meshShaderTime())
  meshEntities?.update(meshShaderTime())
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
  /** Baustelle (fraction < 1): startet mit den Build-Materialien (UEFBuild). */
  building = false,
): Promise<void> {
  knownSceneUnits.add(uid)
  const id = bpId.toLowerCase()
  const assets = await loadSandboxAssets(id)
  if (!assets) return
  const scene = viewer.addUnit(assets.model, assets.textures, currentTeamColor(), assets.shader)
  // The LOD's Scrolling flag (mesh.fx anim.w, Cfile:1191018): only such
  // meshes scroll their tread bands.
  {
    const mat = scene.mesh.material as THREE.ShaderMaterial
    if (mat.uniforms.scrolling) mat.uniforms.scrolling.value = assets.scrolling ? 1 : 0
  }
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
  void loadBracketTexture()
  const ring = new THREE.Mesh(createBracketGeometry(), bracketMaterial)
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
    select: selectionBpData(assets.bp as BpObject),
    bars: barBpData(assets.bp as BpObject),
    build,
  })
}

async function spawnViaLua(id: string): Promise<void> {
  if (!vfs) return
  try {
    const sim = await getLuaSim()
    // Exakt auf den Spawn-Marker der Karte. Der frühere Versatz von +6/+6 war
    // erfunden; im Original steht die ACU auf dem ARMY_n-Marker.
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

// Debug-Sicht auf die Szene (nur DEV): welcher Sim-Unit gehört welches Mesh,
// wo steht es, ist es sichtbar — für die Fehlersuche per DevTools/CDP.
if (import.meta.env.DEV) {
  // Kartenwechsel OHNE Neuladen — der Weg durch `luaSim.reset()`, den ein
  // Reload gerade nicht nimmt. Nur so laesst sich headless pruefen, dass die
  // zweite Sandbox ihre ACUs, ihre Lagerstaetten und ihre Startpositionen
  // bekommt.
  ;(window as unknown as Record<string, unknown>).__cfaSandbox = (name: string) => {
    void startSandbox(name)
    return 'startet ' + name
  }
  ;(window as unknown as Record<string, unknown>).__cfaSzene = () =>
    luaUnits.map((u) => ({
      id: u.id,
      bp: u.bpId,
      pos: u.mesh.position.toArray().map((v) => Math.round(v * 10) / 10),
      visible: u.mesh.visible,
      scale: Math.round(u.mesh.scale.x * 1000) / 1000,
    }))
  // Die Props (Wracks) der Szene — gleiche Sicht wie __cfaSzene.
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
  // Decal diagnosis: albedo/normal instance counts + skipped types (CDP).
  ;(window as unknown as Record<string, unknown>).__cfaDecals = () => {
    const s = viewer.decalStats()
    if (!s) return null
    return {
      instances: s.instances,
      normalInstances: s.normalInstances,
      textures: s.textures,
      skipped: [...s.skippedTypes.entries()],
      missing: s.missing.length,
    }
  }
  // Map/prop diagnosis: parsed prop count vs. rendered instances (CDP).
  ;(window as unknown as Record<string, unknown>).__cfaMapInfo = () => ({
    props: currentScmap?.props.length ?? -1,
    skybox: currentScmap?.skybox !== null,
    sky: viewer.skyInfo,
    stats: viewer.propStats,
  })
  // Kamera per CDP auf einen Weltpunkt richten (Sicht-Abnahmen ohne Maus).
  ;(window as unknown as Record<string, unknown>).__cfaFokus = (x: number, z: number, dist = 30) => {
    viewer.focusOn(new THREE.Vector3(x, viewer.heightAt(x, z), z), dist)
    return 'ok'
  }
  // The particle batches with their counts (light particles included) for
  // CDP probes of the effect pipeline.
  ;(window as unknown as Record<string, unknown>).__cfaParticleBatches = () => (particles ? particles.batchCounts() : {})
  // Lua in der UI-VM auswerten (Fehlersuche der Tastatur-/Keymap-Wege).
  ;(window as unknown as Record<string, unknown>).__cfaUiEval = (code: string) =>
    gameUi ? gameUi.debugEval(code) : 'keine UI'
  // Einen Move-Befehl absetzen (Bewegungs-/Interpolations-Abnahmen per CDP).
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
  // The scmap prop spawns near a point — find a tree to reclaim via CDP.
  ;(window as unknown as Record<string, unknown>).__cfaMapProps = (x: number, z: number, r = 20) =>
    mapPropSpawns()
      .filter((p) => Math.abs(p.x - x) < r && Math.abs(p.z - z) < r)
      .slice(0, 40)
  // Probe what a click at this screen point would pick (map prop index).
  ;(window as unknown as Record<string, unknown>).__cfaPickMapProp = (x: number, y: number) =>
    viewer.pickMapProp(x, y)
  // Probe the wreck under this screen point (sim prop id) — same picking
  // path zielUnter uses for the reclaim default click.
  ;(window as unknown as Record<string, unknown>).__cfaPickWreck = (x: number, y: number) => {
    const hit = viewer.pickAmong(x, y, [...propMeshes.values()])
    if (!hit) return null
    for (const [id, mesh] of propMeshes) if (mesh === hit) return id
    return null
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  log('Claude Commander: Forged Alliance — Unit-Viewer')

  if (location.protocol === 'file:') {
    // Workers, WASM and the File System Access API all need an http(s)
    // origin — a double-clicked dist/index.html can never work.
    log('ERROR: this page cannot run from file:// — serve it locally (npm run dev or npm run preview)')
  }

  // typeof check, not `in`: a property that exists but is not callable (seen
  // in the wild — user report "showDirectoryPicker is not a function") must
  // also route to the fallback picker.
  if (typeof window.showDirectoryPicker !== 'function') {
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
