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
import { parseSca } from './formats/sca'
import { parseScmap } from './formats/scmap'
import {
  parseBlueprint,
  parseLuaAssignments,
  bpGet,
  stripLoc,
  type BpObject,
} from './formats/blueprint'
import { ddsToTexture } from './viewer/textures'
import { UnitViewer } from './viewer/unitViewer'
import { SandboxController, type SandboxUnitAssets } from './sandbox/sandbox'
import type { UnitTextures } from './viewer/unitMaterial'

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
const modeTabs = $('#mode-tabs')
const tabUnits = $<HTMLButtonElement>('#tab-units')
const tabMaps = $<HTMLButtonElement>('#tab-maps')
const tabSandbox = $<HTMLButtonElement>('#tab-sandbox')
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

    unitPanel.hidden = false
    modeTabs.hidden = false
    renderUnitList('')
    await populateMapList(src)

    const params = new URLSearchParams(location.search)
    const wantedSandbox = params.get('sandbox')
    if (wantedSandbox) {
      await startSandbox(wantedSandbox)
      const extraSpawns = params.get('spawn')
      if (extraSpawns && sandbox) {
        for (const id of extraSpawns.split(',')) await sandboxSpawn(id.trim().toLowerCase())
      }
      const move = params.get('move')
      if (move && sandbox) {
        const [dx, dz] = move.split(',').map(Number)
        sandbox.selectFirst()
        sandbox.moveSelectedTo(spawnPoint.x + (dx || 0), spawnPoint.z + (dz || 0))
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
    log(`${mapSelect.options.length} Karten gefunden`)
  } catch (err) {
    log(`Karten-Liste nicht verfügbar: ${err instanceof Error ? err.message : err}`)
  }
}

function setMode(mode: 'units' | 'maps' | 'sandbox'): void {
  tabUnits.classList.toggle('active', mode === 'units')
  tabMaps.classList.toggle('active', mode === 'maps')
  tabSandbox.classList.toggle('active', mode === 'sandbox')
  unitPanel.hidden = mode !== 'units'
  mapPanel.hidden = mode !== 'maps'
  sandboxPanel.hidden = mode !== 'sandbox'
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

async function loadUnitAssets(
  id: string,
): Promise<{ model: ScmModel; textures: UnitTextures; bp: BpObject } | null> {
  if (!vfs) return null
  const base = `units/${id}/${id}`
  const bp = parseBlueprint(await vfs.readText(`${base}_unit.bp`))

  if (!vfs.exists(`${base}_lod0.scm`)) {
    log(`Kein LOD0-Mesh für ${id.toUpperCase()} gefunden`)
    return null
  }
  const model = parseScm(await vfs.read(`${base}_lod0.scm`))

  const albedo =
    (await loadTexture(`${base}_albedo.dds`)) ?? (await loadTexture(`${base}_lod1_albedo.dds`))
  const normals =
    (await loadTexture(`${base}_normalsts.dds`)) ??
    (await loadTexture(`${base}_lod1_normalsts.dds`))
  const specTeam =
    (await loadTexture(`${base}_specteam.dds`)) ??
    (await loadTexture(`${base}_lod1_specteam.dds`))

  if (!albedo) log(`Keine Albedo-Textur für ${id.toUpperCase()} — rendere grau`)
  const fallbackAlbedo = new THREE.DataTexture(new Uint8Array([140, 140, 145, 255]), 1, 1)
  fallbackAlbedo.needsUpdate = true

  return { model, textures: { albedo: albedo ?? fallbackAlbedo, normals, specTeam }, bp }
}

async function loadUnit(id: string): Promise<void> {
  if (!vfs) return
  try {
    sandbox = null
    viewer.setRtsControls(false)
    log(`Lade ${id.toUpperCase()}…`)
    const assets = await loadUnitAssets(id)
    if (!assets) return
    const { model, textures, bp } = assets
    showUnitInfo(id, bp)

    viewer.setModel(model, textures, currentTeamColor())
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
let spawnPoint = new THREE.Vector3(20, 0, 20)
const sandboxAssetCache = new Map<string, SandboxUnitAssets>()

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

async function sandboxSpawn(id: string): Promise<void> {
  if (!sandbox) return
  const assets = await loadSandboxAssets(id)
  if (!assets) return
  // versetzt um den Spawn-Punkt platzieren (goldener Winkel)
  const n = sandbox.unitCount
  const angle = n * 2.4
  const radius = 2 + n * 1.2
  const x = spawnPoint.x + Math.sin(angle) * radius
  const z = spawnPoint.z + Math.cos(angle) * radius
  sandbox.spawn(assets, x, z, currentTeamColor())
  log(`Spawn: ${id.toUpperCase()} (${sandbox.unitCount} Einheiten)`)
}

async function startSandbox(mapFolder: string): Promise<void> {
  if (!vfs || !source) return
  try {
    sandbox = null
    setMode('sandbox')
    await loadMap(mapFolder)

    // Spawn-Punkt der Armee 1 aus der _save.lua
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
    }

    sandbox = new SandboxController(viewer)
    const acu = await loadSandboxAssets('uel0001')
    if (acu) {
      sandbox.spawn(acu, spawnPoint.x, spawnPoint.z, currentTeamColor())
      sandbox.selectFirst()
    }
    viewer.focusOn(spawnPoint, 14)
    $('#sandbox-spawns').hidden = false
    sandboxInfo.innerHTML =
      `Karte <strong>${mapFolder}</strong> — Klick auf Einheit = Auswahl, ` +
      `Klick aufs Terrain = Bewegung (Shift = Warteschlange)`
    log(`Sandbox bereit auf ${mapFolder} (Sim: 10 Ticks/s)`)
  } catch (err) {
    log(`FEHLER Sandbox: ${err instanceof Error ? err.message : err}`)
  }
}

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
  if (!sandbox) return
  const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y)
  const msg =
    moved > 5
      ? sandbox.boxSelect(start.x, start.y, e.clientX, e.clientY)
      : sandbox.clickSelect(e.clientX, e.clientY)
  if (msg) log(msg)
})

viewportEl.addEventListener('contextmenu', (e) => {
  e.preventDefault()
  if (!sandbox) return
  const msg = sandbox.commandMove(e.clientX, e.clientY, e.shiftKey)
  if (msg) log(msg)
})

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
})
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') spaceHeld = false
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
  if (!handle) return
  const perm = await handle.requestPermission({ mode: 'read' })
  if (perm === 'granted') {
    btnResume.hidden = true
    await connect(new FsaGameSource(handle))
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
tabUnits.addEventListener('click', () => setMode('units'))
tabMaps.addEventListener('click', () => setMode('maps'))
tabSandbox.addEventListener('click', () => setMode('sandbox'))
mapSelect.addEventListener('change', () => void loadMap(mapSelect.value))
btnSandboxStart.addEventListener('click', () => {
  void startSandbox(mapSelect.value || 'SCMP_037')
})
for (const btn of document.querySelectorAll<HTMLButtonElement>('#sandbox-spawns .spawn')) {
  btn.addEventListener('click', () => void sandboxSpawn(btn.dataset.unit!))
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
    const perm = await stored.queryPermission({ mode: 'read' })
    if (perm === 'granted') {
      await connect(new FsaGameSource(stored))
    } else {
      btnResume.hidden = false
      btnResume.textContent = `Erneut verbinden: ${stored.name}`
    }
  }
}

void init()
