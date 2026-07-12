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
import { parseScm } from './formats/scm'
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
const modeTabs = $('#mode-tabs')
const tabUnits = $<HTMLButtonElement>('#tab-units')
const tabMaps = $<HTMLButtonElement>('#tab-maps')
const mapSelect = $<HTMLSelectElement>('#map-select')
const mapInfo = $('#map-info')
const unitSearch = $<HTMLInputElement>('#unit-search')
const unitSelect = $<HTMLSelectElement>('#unit-select')
const teamColorInput = $<HTMLInputElement>('#team-color')
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

function setMode(mode: 'units' | 'maps'): void {
  tabUnits.classList.toggle('active', mode === 'units')
  tabMaps.classList.toggle('active', mode === 'maps')
  unitPanel.hidden = mode !== 'units'
  mapPanel.hidden = mode !== 'maps'
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

async function loadUnit(id: string): Promise<void> {
  if (!vfs) return
  try {
    const base = `units/${id}/${id}`
    log(`Lade ${id.toUpperCase()}…`)

    const bp = parseBlueprint(await vfs.readText(`${base}_unit.bp`))
    showUnitInfo(id, bp)

    const meshPath = vfs.exists(`${base}_lod0.scm`) ? `${base}_lod0.scm` : null
    if (!meshPath) {
      log(`Kein LOD0-Mesh für ${id.toUpperCase()} gefunden`)
      return
    }
    const model = parseScm(await vfs.read(meshPath))

    const albedo =
      (await loadTexture(`${base}_albedo.dds`)) ?? (await loadTexture(`${base}_lod1_albedo.dds`))
    const normals =
      (await loadTexture(`${base}_normalsts.dds`)) ??
      (await loadTexture(`${base}_lod1_normalsts.dds`))
    const specTeam =
      (await loadTexture(`${base}_specteam.dds`)) ??
      (await loadTexture(`${base}_lod1_specteam.dds`))

    if (!albedo) {
      log(`Keine Albedo-Textur für ${id.toUpperCase()} — rendere grau`)
    }

    const fallbackAlbedo = new THREE.DataTexture(
      new Uint8Array([140, 140, 145, 255]),
      1,
      1,
    )
    fallbackAlbedo.needsUpdate = true

    viewer.setModel(
      model,
      { albedo: albedo ?? fallbackAlbedo, normals, specTeam },
      currentTeamColor(),
    )
    log(
      `${id.toUpperCase()}: ${model.vertexCount} Vertices, ${model.indices.length / 3} Tris, ` +
        `${model.bones.length} Bones`,
    )
  } catch (err) {
    log(`FEHLER beim Laden von ${id}: ${err instanceof Error ? err.message : err}`)
  }
}

// ---------------------------------------------------------------------------
// Karte laden
// ---------------------------------------------------------------------------

async function loadMap(folder: string): Promise<void> {
  if (!source || !vfs) return
  try {
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
tabUnits.addEventListener('click', () => setMode('units'))
tabMaps.addEventListener('click', () => setMode('maps'))
mapSelect.addEventListener('change', () => void loadMap(mapSelect.value))

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
