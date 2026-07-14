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
    this.root.innerHTML = `<div id="strat-layer"></div>`
    document.body.appendChild(this.root)

    // Strategic Icons müssen der Kamera pro Frame folgen
    viewer.onUpdate(() => this.updateStrategicIcons())
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
      if (!u || dist < u.fadeZoom) {
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
