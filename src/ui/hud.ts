import * as THREE from 'three'
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
  strategicIcon: string
  fadeZoom: number
  /** Baufortschritt (1 = fertig). Unter 1 zeigt der Balken den BAU, nicht die HP. */
  fraction: number
  /** Halbe Breite der Einheit (aus dem Blueprint) — so breit ist ihr Balken. */
  halfWidth: number
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
   * ConVar `ui_AlwaysRenderStrategicIcons` (Cfile:421748) — im Optionen-Dialog
   * schaltbar. Ist sie an, erscheinen die Icons auf JEDER Zoomstufe, nicht erst
   * ab `Display.Mesh.IconFadeInZoom` des Blueprints.
   */
  alwaysIcons = false

  // -------------------------------------------------------------------------
  // LEBENSBALKEN + BAU-FORTSCHRITT
  //
  // Auch das zeichnet im Original die ENGINE über der Welt (nicht die Lua).
  // Belegt aus der Decomp (Cfile:1284551-1284575): Balken erscheinen nur für
  // AUSGEWÄHLTE Einheiten und die Einheit unter dem Cursor (dazu die ConVar
  // ui_ForceLifbarsOnEnemy), unterhalb der Zoom-Grenze ui_LifebarLOD (200,
  // Cfile:421758), nie bei Display.HideLifebars und nie während eines Upgrades.
  //
  // Zwei getrennte Balken, wie im Original zu sehen:
  //   oben   LEBEN         (der echte Gesundheitsstand — er wächst beim Bau mit)
  //   unten  BAU-FORTSCHRITT in GELB (nur solange FractionComplete < 1)
  // -------------------------------------------------------------------------
  private readonly barPool: HTMLDivElement[] = []

  private updateLifeBars(): void {
    const layer = this.el('#bar-layer')
    const rootRect = this.root.getBoundingClientRect()
    const units = this.source.units()
    const dist = this.viewer.getRtsDistance()

    while (this.barPool.length < units.length) {
      const bar = document.createElement('div')
      bar.className = 'life-bar'
      // Zwei Zeilen: Leben oben, Bau-Fortschritt (gelb) darunter.
      bar.innerHTML =
        '<div class="bar-row"><div class="life-fill"></div></div>' +
        '<div class="bar-row build-row"><div class="build-fill"></div></div>'
      layer.appendChild(bar)
      this.barPool.push(bar)
    }

    for (let i = 0; i < this.barPool.length; i++) {
      const bar = this.barPool[i]!
      const u = units[i]
      // Weit weg übernehmen die strategischen Icons (fadeZoom) — dann ist der
      // Balken im Original ebenfalls weg.
      if (!this.renderBars || !u || dist >= u.fadeZoom) {
        bar.style.display = 'none'
        continue
      }
      const s = this.viewer.worldToScreen(new THREE.Vector3(u.x, u.y + 1, u.z))
      if (!s) {
        bar.style.display = 'none'
        continue
      }
      const bauend = u.fraction < 1
      const leben =
        u.maxHealth > 0 ? Math.max(0, Math.min(1, u.health / u.maxHealth)) : 0
      // Volle, nicht ausgewählte Einheiten zeigen keinen Balken (Decomp:
      // Auswahl/Hover-Bedingung, Cfile:1284556-1284575) — eine Baustelle immer.
      if (!bauend && leben >= 0.999 && !u.selected) {
        bar.style.display = 'none'
        continue
      }
      // So breit wie die Einheit: ihre halbe Breite mal 2, in Bildschirm-Pixel
      // umgerechnet über einen zweiten projizierten Punkt.
      const rand = this.viewer.worldToScreen(new THREE.Vector3(u.x + u.halfWidth, u.y + 1, u.z))
      const breite = rand ? Math.max(16, Math.abs(rand.x - s.x) * 2) : 24

      bar.style.display = 'block'
      bar.style.width = `${breite}px`
      bar.style.transform =
        `translate(${s.x - rootRect.left}px, ${s.y - rootRect.top}px) translate(-50%, -100%)`

      // Oben: das LEBEN — auch während des Baus (die HP wachsen mit dem
      // Fortschritt, unit.lua schreibt sie hoch). Ampel-Stufen; die exakte
      // Farbtreppe der Engine steckt in einer nicht dekompilierbaren
      // Zeichenfunktion — Grün/Gelb/Rot ist die beobachtete Reihenfolge.
      const lifeFill = bar.querySelector<HTMLDivElement>('.life-fill')!
      lifeFill.style.width = `${leben * 100}%`
      lifeFill.style.background =
        leben > 0.6 ? '#3ad353' : leben > 0.3 ? '#e8d33a' : '#e84040'

      // Unten: der BAU-FORTSCHRITT in GELB — nur solange gebaut wird. Genau so
      // zeigt es das Original: beide Balken übereinander, der Bau-Balken darunter.
      const buildRow = bar.querySelector<HTMLDivElement>('.build-row')!
      buildRow.style.display = bauend ? 'block' : 'none'
      if (bauend) {
        const buildFill = bar.querySelector<HTMLDivElement>('.build-fill')!
        buildFill.style.width = `${u.fraction * 100}%`
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
    const dist = this.viewer.getRtsDistance()
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
      if (!u || (dist < u.fadeZoom && !this.alwaysIcons)) {
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
