import * as THREE from 'three'
import { LIFEBAR_CONVARS, barGeometry, barRows, barSize } from './lifeBars'
import type { GameVfs } from '../vfs/vfs'
import type { UnitViewer } from '../viewer/unitViewer'
import type { ScmapData } from '../formats/scmap'
import { ddsToDataUrl } from './ddsUrl'
import { parseDds } from '../formats/dds'
import { bgraToRgba, decodeDxt } from '../formats/dxt'

/**
 * Was von der Weltansicht noch in TypeScript steht: NUR die strategischen Icons.
 *
 * Der Rest ist WEG — und zwar nicht ersetzt, sondern durch die Original-Lua
 * abgelöst:
 *   Ökonomie   → lua/ui/game/economy.lua
 *   Orders     → lua/ui/game/orders.lua
 *   Unit-View  → lua/ui/game/unitview.lua + unitviewDetail.lua
 *   Bau-Menü   → lua/ui/game/construction.lua
 *   MINIMAP    → lua/ui/game/minimap.lua — sie ist eine zweite WorldView
 *                (minimap.lua:115, `isMiniMap = true`), also ein echtes Control.
 *                Genau deshalb lässt sie sich im Original VERSCHIEBEN. Der
 *                TS-Nachbau hier war ein festgenageltes <canvas>; er ist
 *                gelöscht, seit die WorldView ein maui-Control ist.
 * Alles läuft in der UI-VM (src/ui/gameUi.ts) und rendert über den maui-Layer.
 *
 * Hier stand einmal eine Handkopie der `standardOrdersTable` samt Slot-Nummern
 * und eine nachgebaute Health-Leiste. Beides ist gelöscht: sobald die echte Lua
 * dieselbe Sache zeichnet, ist der TS-Nachbau kein „Fallback", sondern ein
 * zweiter, abweichender Zustand.
 *
 * NICHTS Neues hier anbauen. Auch die Icons gehören in die Engine (sie zeichnet
 * sie im Original selbst, ui_RenderIcons/ui_AlwaysRenderStrategicIcons).
 */

const FACTION_SKIN = 'uef'

/** Ökonomie-Momentaufnahme für die UI-VM (economy.lua rechnet daraus die Anzeige). */
export interface EcoSnapshot {
  mass: number
  massStorage: number
  massIncome: number
  massExpense: number
  energy: number
  energyStorage: number
  energyIncome: number
  energyExpense: number
  /**
   * Angeforderte Menge VOR der Drosselung (Original: lastUseRequested).
   * economy.lua schaltet die Ausgabe-Anzeige zwischen lastUseActual und
   * lastUseRequested um — ohne diesen Wert ist das nicht nachvollziehbar.
   */
  massRequested: number
  energyRequested: number
  /**
   * Reclaim income this beat (mass/energy per second) — the original's third
   * pair in GetEconomyTotals().reclaimed, kept separate from income (the engine
   * writes reclaim to storage AND a counter, Cfile:848614).
   */
  reclaimMass: number
  reclaimEnergy: number
}

/** Momentaufnahme einer Einheit für Minimap und strategische Icons. */
export interface HudUnitInfo {
  id: string
  name: string
  health: number
  maxHealth: number
  selected: boolean
  x: number
  z: number
  y: number
  army: number
  /** Own or allied (IsAlly with the focus army) — always gets a life bar. */
  ally: boolean
  /** Under the cursor — an enemy only shows a bar when hovered (or forced). */
  hovered: boolean
  strategicIcon: string
  fadeZoom: number
  /** Baufortschritt (1 = fertig) — für die Icons, NICHT für die Balken. */
  fraction: number
  /** Halbe Breite der Einheit (aus dem Blueprint). */
  halfWidth: number
  /** `LifeBarSize` (ogrids, 0 = ui_LifebarWidth). */
  lifeBarSize: number
  /** `LifeBarHeight` (ogrids, 0 = ui_lifebarHeight). */
  lifeBarHeight: number
  /** `LifeBarOffset` (ogrids), added to ui_LifebarOffset. */
  lifeBarOffset: number
  /** `LifeBarRender` — 1 for every unit, 0 for props (Cfile:655716). */
  lifeBarRender: boolean
  /** `Display.HideLifebars`. */
  hideLifebars: boolean
  /** UNITSTATE_BeingUpgraded — no bars while upgrading (Cfile:1284570). */
  beingUpgraded: boolean
  /** mShieldRatio / mFuelRatio (-1 = no fuel) / mWorkProgress. */
  shieldRatio: number
  fuelRatio: number
  workProgress: number
}

/** Datenquelle — von der Lua-Engine (main.ts) bereitgestellt. */
export interface HudSource {
  units(): HudUnitInfo[]
}

export class Hud {
  private readonly root: HTMLDivElement
  private readonly refs = new Map<string, HTMLElement>()

  constructor(
    private readonly vfs: GameVfs,
    private readonly viewer: UnitViewer,
    private readonly source: HudSource,
  ) {
    this.root = document.createElement('div')
    this.root.id = 'hud'
    this.root.innerHTML = `<div id="bar-layer"></div><div id="strat-layer"></div>`
    document.body.appendChild(this.root)

    // Strategic Icons und Lebensbalken müssen der Kamera pro Frame folgen
    viewer.onUpdate(() => {
      this.updateStrategicIcons()
      this.updateLifeBars()
    })
  }

  /**
   * Sollen Lebensbalken gezeichnet werden? Das ist im Original eine
   * ENGINE-Einstellung, kein UI-Element: die Aktion `toggle_lifebars` (Alt-L,
   * defaultkeymap.lua:11) schaltet die ConVar `UI_RenderUnitBars`
   * (keyactions.lua:14). Wir lesen genau diese ConVar.
   */
  renderBars = true
  /**
   * ConVar `ui_ForceLifbarsOnEnemy` (Cfile:1285062, default false): when set,
   * enemy units always show a life bar; otherwise an enemy shows one only while
   * it is under the cursor (Cfile:1284554-1284570).
   */
  forceEnemyBars = false
  /** `fmod((tick + interp) * ui_FuelEmptyBlinkRate, 1)` (Cfile:1285384). */
  fuelBlinkPhase = 0

  /**
   * ConVar `ui_AlwaysRenderStrategicIcons` (Cfile:421748) — im Optionen-Dialog
   * schaltbar. Ist sie an, erscheinen die Icons auf JEDER Zoomstufe, nicht erst
   * ab `Display.Mesh.IconFadeInZoom` des Blueprints.
   */
  alwaysIcons = false
  /**
   * The two engine master switches for strategic icons (Cfile:1284579):
   * `ui_RenderIcons` (Cfile:421748, default true) hides the normal icons when
   * off; `ui_NisRenderIcons` (Cfile:421760, default true) hides ALL of them
   * (the NIS/cinematic master). The paused/toggle-overlay force (isBusy_37) is
   * not modelled — a documented reduction.
   */
  renderIcons = true
  nisRenderIcons = true

  // -------------------------------------------------------------------------
  // LEBENSBALKEN + BAU-FORTSCHRITT
  //
  // The engine draws these over the world too (not the Lua):
  // CWldSession::RenderStrategicIcons collects them (Cfile:1284551-1284575),
  // sub_85CD40 draws them (Cfile:1285245-1285580). The arithmetic lives in
  // src/ui/lifeBars.ts; this layer only places DOM elements.
  //
  // Up to THREE rows, 2 px apart, each a black background with a one-pixel
  // inset fill:
  //   1  health           green/yellow/red at 0.75 / 0.25 (Cfile:1285354)
  //   2  shield, else fuel or work progress (Cfile:1285364-1285442)
  //   3  only next to a shield: whichever of the two row 2 did not take
  //
  // NOTE the second row is NOT the unit's own build progress: the engine draws
  // mWorkProgress, i.e. what the unit is BUILDING (Cfile:1285481). Its own
  // mFractionComplete never appears in a bar.
  // -------------------------------------------------------------------------
  private readonly barPool: HTMLDivElement[] = []

  private updateLifeBars(): void {
    const layer = this.el('#bar-layer')
    const rootRect = this.root.getBoundingClientRect()
    const units = this.source.units()
    // ui_LifebarLOD is compared against the engine's zoom = the world width
    // spanned at the camera target (Cfile:1284418-1284425), not the camera
    // distance.
    const zoom = this.viewer.zoomOgrids()

    while (this.barPool.length < units.length) {
      const bar = document.createElement('div')
      bar.className = 'life-bar'
      // Three rows; each is a background with its own fill.
      bar.innerHTML =
        '<div class="bar-row"><div class="bar-fill"></div></div>'.repeat(3)
      layer.appendChild(bar)
      this.barPool.push(bar)
    }

    for (let i = 0; i < this.barPool.length; i++) {
      const bar = this.barPool[i]!
      const u = units[i]
      // ui_RenderUnitBars and ui_LifebarLOD = 200 (Cfile:1284552); the
      // blueprint can switch them off entirely (Display.HideLifebars,
      // LifeBarRender), and a unit being upgraded shows none.
      if (
        !this.renderBars ||
        !u ||
        zoom >= LIFEBAR_CONVARS.lod ||
        !u.lifeBarRender ||
        u.hideLifebars ||
        u.beingUpgraded ||
        // Enemy units get a bar only when hovered or forced (Cfile:1284554).
        !(u.ally || this.forceEnemyBars || u.hovered)
      ) {
        bar.style.display = 'none'
        continue
      }
      const anchor = this.viewer.worldToScreen(new THREE.Vector3(u.x, u.y, u.z))
      if (!anchor) {
        bar.style.display = 'none'
        continue
      }
      const ogridsPerPixel = this.viewer.ogridsPerPixel(u.x, u.y, u.z)
      const { width, height } = barSize(ogridsPerPixel, u.lifeBarSize, u.lifeBarHeight)
      if (width <= 0 || height <= 0) {
        bar.style.display = 'none'
        continue
      }
      // The engine lowers the view-space Y by (LifeBarOffset + ui_LifebarOffset)
      // BEFORE projecting (Cfile:1285331-1285334) and floors the result
      // (Cfile:1285341-1285342). One ogrid at that depth is `ogridsPerPixel`
      // pixels wide, so the offset in pixels is offset / ogridsPerPixel.
      const offsetPx = (u.lifeBarOffset + LIFEBAR_CONVARS.offset) / ogridsPerPixel
      const screenX = Math.floor(anchor.x - rootRect.left)
      const screenY = Math.floor(anchor.y - rootRect.top + offsetPx)

      const rows = barRows(
        {
          health: u.health,
          maxHealth: u.maxHealth,
          shieldRatio: u.shieldRatio,
          fuelRatio: u.fuelRatio,
          workProgress: u.workProgress,
        },
        this.fuelBlinkPhase,
      )
      bar.style.display = 'block'
      bar.style.transform = 'translate(0px, 0px)'
      const rowEls = bar.querySelectorAll<HTMLDivElement>('.bar-row')
      for (let r = 0; r < rowEls.length; r++) {
        const rowEl = rowEls[r]!
        const row = rows[r]
        if (!row) {
          rowEl.style.display = 'none'
          continue
        }
        const g = barGeometry(screenX, screenY, width, height, r, row.fraction)
        rowEl.style.display = 'block'
        rowEl.style.left = `${g.left}px`
        rowEl.style.top = `${g.top}px`
        rowEl.style.width = `${g.width}px`
        rowEl.style.height = `${g.height}px`
        const fill = rowEl.querySelector<HTMLDivElement>('.bar-fill')!
        fill.style.left = '1px'
        fill.style.top = '1px'
        fill.style.width = `${g.fillWidth}px`
        fill.style.height = `${g.fillHeight}px`
        fill.style.background = row.color
      }
    }
  }

  dispose(): void {
    this.root.remove()
  }

  // -------------------------------------------------------------------------
  // Strategic Icons (Original: sichtbar ab Display.Mesh.IconFadeInZoom,
  // Texturen /game/strategicicons/<StrategicIconName>_{rest,selected}.dds,
  // getönt mit der Armee-Farbe)
  // -------------------------------------------------------------------------

  private readonly stratPool: HTMLImageElement[] = []
  private readonly stratIconCache = new Map<string, string | 'pending'>()
  /** Army index -> icon color (ARGB hex from the armiesTable, see below). */
  private armyColors = new Map<number, string>()

  /**
   * The REAL army icon colors: gamecolors.lua ArmyColors, published per army
   * as `iconColor` by cfunc_GetArmiesTableL (Cfile:1267023-1267111) — the
   * engine tints the strategic icons with exactly this color. (An invented
   * color table lived here once and was removed; now the values come from
   * the session's armiesTable.)
   */
  setArmyColors(colors: Map<number, string>): void {
    this.armyColors = colors
    this.stratIconCache.clear()
  }

  private strategicIcon(name: string, state: 'rest' | 'selected', army: number): string | null {
    const key = `${name}|${state}|${army}`
    const cached = this.stratIconCache.get(key)
    if (cached && cached !== 'pending') return cached
    if (cached === 'pending') return null
    this.stratIconCache.set(key, 'pending')
    void this.skin(`/game/strategicicons/${name}_${state}.dds`).then((base) => {
      if (!base) {
        this.stratIconCache.delete(key)
        return
      }
      const argb = this.armyColors.get(army)
      if (!argb || argb.length < 8) {
        this.stratIconCache.set(key, base)
        return
      }
      // Tint: multiply the icon with the army color, keep the icon's alpha.
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = img.width
        c.height = img.height
        const ctx = c.getContext('2d')
        if (!ctx) {
          this.stratIconCache.set(key, base)
          return
        }
        ctx.drawImage(img, 0, 0)
        ctx.globalCompositeOperation = 'multiply'
        ctx.fillStyle = `#${argb.slice(2)}`
        ctx.fillRect(0, 0, c.width, c.height)
        ctx.globalCompositeOperation = 'destination-in'
        ctx.drawImage(img, 0, 0)
        this.stratIconCache.set(key, c.toDataURL())
      }
      img.onerror = () => this.stratIconCache.set(key, base)
      img.src = base
    })
    return null
  }

  private updateStrategicIcons(): void {
    const layer = this.el('#strat-layer')
    const rootRect = this.root.getBoundingClientRect()
    // The engine compares Display.Mesh.IconFadeInZoom against the zoom scalar Z
    // = the world width in ogrids spanned at the camera target (Cfile:1284422),
    // the SAME metric the bars use — NOT the camera distance. The fade threshold
    // is capped at GetMaxZoom()*0.89 so icons always appear before the camera
    // bottoms out at full zoom (Cfile:1284589-1284591).
    const zoom = this.viewer.zoomOgrids()
    const mz = this.viewer.rtsCameraValue('maxZoom')
    const maxZoom = typeof mz === 'number' ? mz : Infinity
    // Master switches: ui_NisRenderIcons off hides ALL, ui_RenderIcons off hides
    // the normal icons (Cfile:1284579).
    const iconsOff = !this.nisRenderIcons || !this.renderIcons
    const units = this.source.units()

    while (this.stratPool.length < units.length) {
      const img = document.createElement('img')
      img.className = 'strat-icon'
      layer.appendChild(img)
      this.stratPool.push(img)
    }

    for (let i = 0; i < this.stratPool.length; i++) {
      const img = this.stratPool[i]!
      const u = units[i]
      // No icon for a unit still under construction (engine !IsBeingBuilt,
      // Cfile:1284581); fade unless ui_AlwaysRenderStrategicIcons, comparing the
      // capped threshold min(IconFadeInZoom, maxZoom*0.89) against the zoom Z.
      const cap = u ? Math.min(u.fadeZoom, maxZoom * 0.88999999) : 0
      if (!u || iconsOff || u.fraction < 1 || (zoom < cap && !this.alwaysIcons)) {
        img.style.display = 'none'
        continue
      }
      const s = this.viewer.worldToScreen(new THREE.Vector3(u.x, u.y, u.z))
      if (!s) {
        img.style.display = 'none'
        continue
      }
      const url = this.strategicIcon(u.strategicIcon, u.selected ? 'selected' : 'rest', u.army)
      if (!url) {
        img.style.display = 'none'
        continue
      }
      if (img.dataset.url !== url) {
        img.src = url
        img.dataset.url = url
      }
      img.style.display = 'block'
      img.style.transform = `translate(${s.x - rootRect.left}px, ${s.y - rootRect.top}px) translate(-50%, -50%)`
    }
  }

  /** SkinnableFile: Fraktions-Skin zuerst, dann common. */
  private async skin(path: string): Promise<string | null> {
    for (const base of [`textures/ui/${FACTION_SKIN}`, 'textures/ui/common']) {
      const full = `${base}${path}`
      if (this.vfs.exists(full)) {
        try {
          return ddsToDataUrl(full, await this.vfs.read(full))
        } catch {
          return null
        }
      }
    }
    return null
  }

  private el(sel: string): HTMLElement {
    let e = this.refs.get(sel)
    if (!e) {
      e = this.root.querySelector(sel) as HTMLElement
      this.refs.set(sel, e)
    }
    return e
  }

}
