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
import { LuaSimClient } from './sim/luaSimClient'
import { SANDBOX_SESSION, type SessionInfo } from './sim/session'
import type { HeightfieldData } from './sim/terrain'
import { Hud, type HudSource, type HudUnitInfo, type EcoSnapshot } from './ui/hud'
import { GameUi } from './ui/gameUi'
import { BuildPreview } from './ui/buildPreview'
import type { ScmapData } from './formats/scmap'
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
): Promise<{ model: ScmModel; textures: UnitTextures; bp: BpObject; shader: string } | null> {
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
}
let buildPreview: BuildPreview | null = null
let currentScmap: ScmapData | null = null
let spawnPoint = new THREE.Vector3(20, 0, 20)
let massSpots: { x: number; z: number }[] = []
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
  if (!vfs || !source) return
  try {
    sandbox = null
    setMode('sandbox')
    setIngame(true)
    await loadMap(mapFolder)

    // Läuft schon eine Sim? Dann zurücksetzen, statt eine zweite ACU auf die
    // alte Sitzung zu stapeln (mit doppeltem Startvorrat aus
    // GiveInitialResources) — und mit dem Gelände der NEUEN Karte.
    if (luaSim && currentScmap) {
      luaUnits.length = 0
      knownSceneUnits.clear()
      await luaSim.reset({
        data: currentScmap.heightmap,
        width: currentScmap.width,
        height: currentScmap.height,
        scale: currentScmap.heightScale,
      })
      log('Lua-Sim zurückgesetzt (neue Karte)')
    }

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

      // Mass-Punkte aus den Markern
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

    // Die Maße des Auswahlrings kommen aus der Original-Datei
    // lua/renderselectparams.lua (die Engine liest genau sie, Cfile:1215033).
    await loadSelectParams()
    sandbox = new SandboxController(viewer)
    // massSpots werden NICHT mehr als erfundene Ringe gezeichnet. Sie bleiben
    // geparst (Struktur der Karte), bis der Session-Start sie als echte
    // Ressourcen-Vorkommen über ScenarioUtilities.lua anlegt und die Engine
    // ihre Original-Icons rendert.
    if (currentScmap) {
      hud = new Hud(vfs, viewer, hudSource)
    }

    // Die ECHTE lua/ui in einer zweiten Lua-VM (wie im Original: Sim und UI
    // haben getrennte States). Sie baut das Eco-Panel aus economy.lua — der
    // TS-Nachbau in hud.ts ist dafür raus.
    gameUi?.dispose()
    // Die SESSION geht in beide VMs: die Sim bekommt sie über setupSession
    // (ScenarioInfo + Brains), die UI über dieselben Angaben — GetArmiesTable()
    // und SessionGetScenarioInfo() sind die Engine-Sicht darauf. Ohne sie
    // knallen die Session-Globals ehrlich mit „no active session".
    const session: SessionInfo = { ...SANDBOX_SESSION, map: mapFolder }
    gameUi = await GameUi.create(vfs, await loadGameFonts(), log, 'game', conVarChanged, session)
    gameUi.attachEvents()
    // Der Pause-Reiter der Original-UI (tabs.lua:425/428) hält die WELT an —
    // die Sim, nicht die UI.
    gameUi.connectPause((paused) => {
      luaSim?.setPaused(paused)
      log(paused ? 'Session pausiert' : 'Session läuft weiter')
    })
    // Die Bau-Vorschau (Geistergebäude am Raster) — Engine-Rendering mit den
    // echten Blueprint-Modellen.
    buildPreview = new BuildPreview(viewer, loadSandboxAssets)
    // Die Naht, über die Befehle der UI in die Sim gehen. Ohne sie KNALLT jeder
    // Befehl — statt still zu verpuffen (ui-globals.lua: __uiSimCommand).
    gameUi.connectSim((name, ids, value) => {
      const v = value as { blueprint?: string; count?: number } | undefined
      if (name === 'UNITCOMMAND_BuildFactory' && v?.blueprint) {
        // Die Fabrik baut: die Einheit geht in ihre Warteschlange (die Sim spawnt
        // sie selbst, sobald sie an der Reihe ist).
        for (const id of ids) void luaSim?.factoryBuild(id, v.blueprint, v.count ?? 1)
        log(`Fabrik ${ids.join(',')}: ${v.count ?? 1}× ${v.blueprint}`)
        return
      }
      log(`Befehl an die Sim: ${name}(${ids.join(',')}) — noch kein Weg dorthin`)
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
    // ACU über die ECHTE Original-Lua-Sim spawnen (Engine-Pfad) statt als
    // SimWorld-Platzhalter. Nicht awaiten, damit die Karte sofort bedienbar ist
    // (die Lua-VM bootet einmalig im Hintergrund).
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
 * Selbsttest über die URL (`?selftest=ueb0101`): wählt die ACU und baut das
 * angegebene Gebäude neben ihr — über GENAU denselben Weg wie ein Klick
 * (SelectUnits → commandmode → worldClick). Damit ist der Browser-Pfad prüfbar,
 * ohne dass jemand mit der Maus danebentippt.
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
    // Was zeigt die Original-UI wirklich? Zählt, was im DOM ankommt — Bilder
    // inklusive. Ein Bitmap ohne Hintergrundbild ist eine fehlende Textur.
    const divs = [...document.querySelectorAll<HTMLDivElement>('#maui-root div')]
    const sichtbar = divs.filter((d) => d.style.display !== 'none')
    const bitmaps = sichtbar.filter((d) => d.dataset.kind === 'bitmap')
    const mitBild = bitmaps.filter((d) => d.style.backgroundImage.startsWith('url('))
    const ohneBild = bitmaps.filter((d) => !d.style.backgroundImage.startsWith('url('))
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
      return
    }
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
  // Die Einheit UNTER DEM CURSOR an die UI melden. Genau daraus baut
  // `unitview.lua` seine Rollover-Anzeige (GetRolloverInfo, unitview.lua:90) —
  // Name, Leben, Ökonomie der überfahrenen Einheit. Ohne diese Meldung zeigt
  // die Original-UI schlicht nichts an: sie WEISS nicht, worüber die Maus steht.
  if (sandbox && gameUi && luaSim) {
    const hit = viewer.pickUnit(e.clientX, e.clientY)
    const u = hit ? luaUnits.find((x) => x.scene === hit) : undefined
    gameUi.setRollover(u ? u.id : null)
  }
  // Bau-Modus: das Geistergebäude folgt dem Cursor — auf dem Raster, mit dem
  // die Sim es gleich setzt (src/ui/buildPreview.ts).
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

  // Was ein Linksklick in der Welt bedeutet, entscheidet die UI-Lua, nicht wir:
  // steht ein Command-Mode an (Bau-Icon geklickt, Move-Button gedrückt), ist der
  // Klick ein BEFEHL. Sonst ist er eine Auswahl.
  if (gameUi && gameUi.commandMode().mode !== false) {
    const hit = viewer.pickTerrain(e.clientX, e.clientY)
    if (hit) void issueWorldCommand(hit, e.shiftKey)
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
  // EndCommandMode(true)) — genau wie im Original.
  if (gameUi.commandMode().mode !== false) {
    gameUi.cancelCommandMode()
    buildPreview?.hide()
    log('Befehl abgebrochen')
    return
  }
  // Sonst: der Standardbefehl der Weltansicht auf die Auswahl (Move).
  const hit = viewer.pickTerrain(e.clientX, e.clientY)
  if (hit) void issueWorldCommand(hit, e.shiftKey)
})

/**
 * Klick in die Welt → Befehl. Die Geometrie (Snap, Höhe) rechnet die Engine, die
 * Bedeutung kommt aus commandmode.lua (src/ui/worldCommands.ts).
 */
async function issueWorldCommand(hit: { x: number; z: number }, queue: boolean): Promise<void> {
  if (!luaSim || !gameUi) return
  try {
    const msg = await gameUi.worldClick(luaSim, hit, (x, z) => viewer.heightAt(x, z), queue)
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
  selected: boolean
  name: string
  army: number
  strategicIcon: string
  fadeZoom: number
  caps: ReadonlySet<string>
  /** Der Szenen-Eintrag mit Skelett-Animator (für die Laufanimation). */
  scene: SceneUnit
  /** Halbachsen + Versatz des Auswahlrings (aus dem Blueprint, siehe ringExtents). */
  ringExtents: { x: number; z: number; ox: number; oz: number }
  /**
   * Läuft die Gehanimation gerade? Die SIM sagt, ob die Einheit fährt
   * (`moving` aus `__readAllUnitsJson`) — der Renderer spielt nur ab, was die
   * Sim meldet, er entscheidet nichts.
   */
  walking: boolean
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
    // Das Gelände geht MIT in den Boot: die Original-Lua liest GetSurfaceHeight
    // schon beim Erzeugen einer Unit, und die Engine liefert dafür keine stille
    // 0 mehr.
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
/** Welche Sim-Units bereits ein Modell in der Szene haben (Ladevorgang läuft asynchron). */
const knownSceneUnits = new Set<number>()

// Solange die Sim nicht läuft, gibt es nichts — keine erfundenen Startwerte.
// Vorrat und Lager entstehen ausschließlich in der Sim: das Lager aus den
// Storage*-Feldern der Units, der Startvorrat aus GiveInitialResources der ACU
// (uel0001_script.lua:159). Die 150/650/400/4000, die hier standen, waren frei
// erfunden — und haben die echten Werte im HUD überdeckt.
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
        // Baufortschritt (< 1 = Baustelle) und die halbe Breite der Einheit —
        // beides braucht die Lebensbalken-Schicht: der Balken schwebt über der
        // Einheit und zeigt bei einer Baustelle den Fortschritt statt der HP.
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

/** Die Werte aus `lua/renderselectparams.lua` (Original-Datei, kein Nachbau). */
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

/** Die Halbachsen des Auswahlrings einer Einheit (Weltmeter). */
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

/** Links-Klick: Lua-Unit unter dem Cursor auswählen (oder Auswahl leeren). */
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
  if (eco && gameUi) gameUi.beat(eco, states)

  // Neue Units aus der Sim (Baustelle, Fabrik-Produkt) bekommen ihr Modell. Die
  // Sim erzeugt sie; die Szene zieht nach — nicht umgekehrt.
  for (const s of states) {
    if (knownSceneUnits.has(s.id)) continue
    knownSceneUnits.add(s.id)
    void addLuaUnitToScene(s.id, s.name, { x: s.x, y: s.y, z: s.z })
  }

  for (const u of luaUnits) {
    const s = luaSim.state(u.id)
    if (!s) continue
    // Die Y-Koordinate kommt aus der SIM (motion.lua schreibt sie über
    // GetSurfaceHeight fort). Vorher rechnete der Renderer seine eigene Höhe —
    // zwei Wahrheiten, die dauerhaft auseinanderliefen.
    u.mesh.position.set(s.x, s.y, s.z)
    u.mesh.rotation.set(0, s.heading, 0)
    u.ring.visible = u.selected
    if (u.selected) {
      // Die Ellipse aus dem Blueprint (siehe ringExtents), am Heading gedreht,
      // um den Selection-Offset versetzt, auf ren_SelectionHeightFudge angehoben.
      const e = u.ringExtents
      const cos = Math.cos(s.heading)
      const sin = Math.sin(s.heading)
      u.ring.position.set(
        s.x + e.ox * cos + e.oz * sin,
        s.y + selectParams.heightFudge,
        s.z - e.ox * sin + e.oz * cos,
      )
      u.ring.rotation.set(0, s.heading, 0)
      u.ring.scale.set(e.x, 1, e.z)
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
): Promise<void> {
  knownSceneUnits.add(uid)
  const id = bpId.toLowerCase()
  const assets = await loadSandboxAssets(id)
  if (!assets) return
  const scene = viewer.addUnit(assets.model, assets.textures, currentTeamColor(), assets.shader)
  const scale = bpGet(assets.bp, 'Display.UniformScale')
  if (typeof scale === 'number' && scale > 0) scene.mesh.scale.setScalar(scale)
  scene.mesh.position.set(pos.x, pos.y, pos.z)
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
