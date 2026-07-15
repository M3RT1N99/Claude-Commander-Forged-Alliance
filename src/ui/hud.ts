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
  // Auch das zeichnet im Original die ENGINE über der Welt (nicht die Lua): ein
  // Balken über jeder Einheit, so breit wie sie ist. Bei einer BAUSTELLE zeigt
  // er den Baufortschritt — deshalb sieht man im Original, wie ein Gebäude
  // wächst, statt dass es fertig dasteht.
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
      bar.innerHTML = '<div class="life-fill"></div>'
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
      const anteil = bauend
        ? u.fraction
        : u.maxHealth > 0
          ? Math.max(0, Math.min(1, u.health / u.maxHealth))
          : 0
      // Volle Einheiten ohne Schaden zeigen keinen Balken (wie im Original) —
      // eine Baustelle immer.
      if (!bauend && anteil >= 0.999 && !u.selected) {
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
      const fill = bar.firstElementChild as HTMLDivElement
      fill.style.width = `${anteil * 100}%`
      // Bau = blau (der Bau-Fortschritt), sonst grün→rot nach Gesundheit.
      fill.style.background = bauend
        ? '#3fa9f5'
        : anteil > 0.6
          ? '#3ad353'
          : anteil > 0.3
            ? '#e8d33a'
            : '#e84040'
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

  /**
   * Strategisches Icon, UNGEFÄRBT.
   *
   * Hier stand ein Canvas-'multiply'-Tinting mit einer erfundenen Farbtabelle
   * ({1:'#2a6dbb', 2:'#e23c2c'}). Im Original kommen die Armeefarben aus
   * /lua/gamecolors.lua (über GetArmiesTable). Eine zweite erfundene Farbe
   * ersetzt keine erste.
   */
  private strategicIcon(name: string, state: 'rest' | 'selected'): string | null {
    const key = `${name}|${state}`
    const cached = this.stratIconCache.get(key)
    if (cached && cached !== 'pending') return cached
    if (cached === 'pending') return null
    this.stratIconCache.set(key, 'pending')
    void this.skin(`/game/strategicicons/${name}_${state}.dds`).then((base) => {
      if (!base) this.stratIconCache.delete(key)
      else this.stratIconCache.set(key, base)
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
      const url = this.strategicIcon(u.strategicIcon, u.selected ? 'selected' : 'rest')
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
