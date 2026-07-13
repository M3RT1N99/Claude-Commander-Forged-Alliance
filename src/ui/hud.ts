import * as THREE from 'three'
import type { GameVfs } from '../vfs/vfs'
import type { UnitViewer } from '../viewer/unitViewer'
import type { ScmapData } from '../formats/scmap'
import { ddsToDataUrl } from './ddsUrl'
import { parseDds } from '../formats/dds'
import { bgraToRgba, decodeDxt } from '../formats/dxt'

/**
 * In-Game-HUD 1:1 nach dem Original-„mini“-Layout (lua/ui/game/layouts/
 * economy_mini.lua, orders_mini.lua + unitview.lua, verifiziert gegen die
 * Original-Quellen in lua.scd):
 *
 * - Economy-Panel: Screen-(16,3), resources_panel_bmp 324×72; Mass-Gruppe
 *   (14,9) 296×25, Energy 4 px darunter; Storage-Balken 100×10 bei (30,2);
 *   Texte/Farben wie im Original (Mass #b7e75f, Energy #f7c70f).
 * - Orders-Panel: links 17, unten 0, order-panel_bmp 332×120; Raster 2×6 à
 *   50×50 zentriert (0,−1); Slots nach standardOrdersTable (Move=1, Attack=2,
 *   Patrol=3, Stop=4, Guard=5, Modus=6); verfügbar = Union der CommandCaps.
 * - Unit-View: links 17, 120 über Unterkante, build-over-back_bmp 332×116;
 *   Icon 48² (12,34), Name (16,14), Health-Balken 188×16 (66,35) mit
 *   healthbar_bg/green/yellow/red (>75 % grün, >25 % gelb, sonst rot).
 * - Texturen via SkinnableFile-Reihenfolge: Fraktions-Skin (uef) → common.
 */

const FACTION_SKIN = 'uef'

interface OrderDef {
  cap: string
  bitmap: string
  slot: number
  action?: (s: HudSource) => void
}

/**
 * Handkopie der standardOrdersTable (orders.lua) — genau das, was hier nicht
 * stehen duerfte. Bleibt nur, bis orders.lua wirklich laeuft (docs/PLAN-UI.md).
 *
 * Ohne `action` kann die Sim den Befehl noch nicht: solche Knoepfe werden
 * DEAKTIVIERT gerendert, statt so zu tun, als taeten sie etwas.
 */
const COMMON_ORDERS: OrderDef[] = [
  { cap: 'RULEUCC_Move', bitmap: 'move', slot: 1 },
  { cap: 'RULEUCC_Attack', bitmap: 'attack', slot: 2 },
  { cap: 'RULEUCC_Patrol', bitmap: 'patrol', slot: 3 },
  { cap: 'RULEUCC_Stop', bitmap: 'stop', slot: 4, action: (s) => s.stop() },
  { cap: 'RULEUCC_Guard', bitmap: 'guard', slot: 5 },
  { cap: 'RULEUCC_RetaliateToggle', bitmap: 'stand-ground', slot: 6 },
]

/** Ökonomie-Momentaufnahme fürs HUD. */
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

/** Momentaufnahme einer Einheit fürs HUD (Unit-Panel, Minimap, Strategic Icons). */
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

/** Datenquelle fürs HUD — von der Lua-Engine (main.ts) bereitgestellt. */
export interface HudSource {
  economy(): EcoSnapshot
  units(): HudUnitInfo[]
  selectedCaps(): ReadonlySet<string>
  stop(): void
}

export class Hud {
  private readonly root: HTMLDivElement
  private readonly refs = new Map<string, HTMLElement>()
  private readonly orderButtons: { def: OrderDef; img: HTMLImageElement; enabled: boolean }[] = []
  private readonly healthTex = new Map<string, string>()
  private readonly iconCache = new Map<string, string>()
  private minimapImage: ImageBitmap | null = null
  private readonly minimapCanvas: HTMLCanvasElement
  private readonly interval: number

  constructor(
    private readonly vfs: GameVfs,
    private readonly viewer: UnitViewer,
    private readonly source: HudSource,
    private readonly scmap: ScmapData,
  ) {
    this.root = document.createElement('div')
    this.root.id = 'hud'
    this.root.innerHTML = `
      <div id="strat-layer"></div>
      <div id="eco-panel">
        <div class="eco-group" id="eco-mass">
          <img class="eco-icon" />
          <div class="eco-storage"><div class="eco-fill"></div></div>
          <span class="eco-cur"></span><span class="eco-max"></span>
          <span class="eco-rate"></span>
          <span class="eco-income"></span><span class="eco-expense"></span>
        </div>
        <div class="eco-group" id="eco-energy">
          <img class="eco-icon" />
          <div class="eco-storage"><div class="eco-fill"></div></div>
          <span class="eco-cur"></span><span class="eco-max"></span>
          <span class="eco-rate"></span>
          <span class="eco-income"></span><span class="eco-expense"></span>
        </div>
      </div>
      <div id="hud-minimap"><canvas width="216" height="216"></canvas></div>
      <div id="unitview-panel" hidden>
        <img id="uv-bracket" />
        <div id="uv-name"></div>
        <img id="uv-icon" />
        <div id="uv-health"><div id="uv-health-fill"></div><span id="uv-health-text"></span></div>
      </div>
      <div id="orders-panel">
        <div id="orders-grid"></div>
      </div>
    `
    document.body.appendChild(this.root)
    this.minimapCanvas = this.root.querySelector('canvas')!

    void this.build()

    this.minimapCanvas.addEventListener('pointerdown', (e) => {
      const rect = this.minimapCanvas.getBoundingClientRect()
      const wx = ((e.clientX - rect.left) / rect.width) * this.scmap.width
      const wz = ((e.clientY - rect.top) / rect.height) * this.scmap.height
      this.viewer.focusOn(new THREE.Vector3(wx, this.viewer.heightAt(wx, wz), wz), 60)
    })

    this.interval = window.setInterval(() => this.update(), 100)
    // Strategic Icons müssen der Kamera pro Frame folgen
    viewer.onUpdate(() => this.updateStrategicIcons())
  }

  dispose(): void {
    clearInterval(this.interval)
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
   * /lua/gamecolors.lua (über GetArmiesTable) — die Datei wird importiert,
   * sobald die UI-VM steht (docs/PLAN-UI.md, Schritt 3). Eine zweite erfundene
   * Farbe ersetzt keine erste.
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

  private async build(): Promise<void> {
    const setBg = (el: HTMLElement, url: string | null): void => {
      if (url) {
        el.style.backgroundImage = `url(${url})`
        el.style.backgroundSize = '100% 100%'
      }
    }

    // --- Economy (economy_mini.lua) ---------------------------------------
    setBg(this.el('#eco-panel'), await this.skin('/game/resource-panel/resources_panel_bmp.dds'))
    for (const [group, res, iconW, iconLeft] of [
      ['#eco-mass', 'mass', 44, -8],
      ['#eco-energy', 'energy', 36, -4],
    ] as const) {
      const icon = this.root.querySelector<HTMLImageElement>(`${group} .eco-icon`)!
      const url = await this.skin(`/game/resources/${res}_btn_up.dds`)
      if (url) icon.src = url
      icon.style.width = `${iconW}px`
      icon.style.left = `${iconLeft}px`
      setBg(
        this.el(`${group} .eco-storage`),
        await this.skin('/game/resource-mini-bars/mini-energy-bar-back_bmp.dds'),
      )
      setBg(
        this.el(`${group} .eco-fill`),
        await this.skin(`/game/resource-bars/mini-${res}-bar_bmp.dds`),
      )
    }

    // --- Orders (orders_mini.lua) ------------------------------------------
    setBg(this.el('#orders-panel'), await this.skin('/game/orders-panel/order-panel_bmp.dds'))
    const grid = this.el('#orders-grid')
    const empty = await this.skin('/game/orders/basic-empty_bmp.dds')
    for (let slot = 1; slot <= 12; slot++) {
      const cell = document.createElement('div')
      cell.className = 'order-slot'
      const def = COMMON_ORDERS.find((o) => o.slot === slot)
      if (def) {
        const img = document.createElement('img')
        const up = await this.skin(`/game/orders/${def.bitmap}_btn_up.dds`)
        const over = await this.skin(`/game/orders/${def.bitmap}_btn_over.dds`)
        const down = await this.skin(`/game/orders/${def.bitmap}_btn_down.dds`)
        const dis = await this.skin(`/game/orders/${def.bitmap}_btn_dis.dds`)
        if (up) img.src = up
        img.dataset.up = up ?? ''
        img.dataset.dis = dis ?? up ?? ''
        const entry = { def, img, enabled: false }
        img.addEventListener('pointerenter', () => entry.enabled && over && (img.src = over))
        img.addEventListener('pointerleave', () => entry.enabled && up && (img.src = up))
        img.addEventListener('pointerdown', () => entry.enabled && down && (img.src = down))
        img.addEventListener('pointerup', () => {
          if (!entry.enabled) return
          if (over) img.src = over
          def.action?.(this.source)
        })
        this.orderButtons.push(entry)
        cell.appendChild(img)
      } else if (empty) {
        const img = document.createElement('img')
        img.src = empty
        cell.appendChild(img)
      }
      grid.appendChild(cell)
    }

    // --- Unit-View (unitview.lua) --------------------------------------------
    setBg(
      this.el('#unitview-panel'),
      await this.skin('/game/unit-build-over-panel/build-over-back_bmp.dds'),
    )
    const bracket = this.root.querySelector<HTMLImageElement>('#uv-bracket')!
    const bracketUrl = await this.skin('/game/unit-build-over-panel/bracket-unit_bmp.dds')
    if (bracketUrl) bracket.src = bracketUrl
    setBg(this.el('#uv-health'), await this.skin('/game/unit-build-over-panel/healthbar_bg.dds'))
    for (const color of ['green', 'yellow', 'red']) {
      const url = await this.skin(`/game/unit-build-over-panel/healthbar_${color}.dds`)
      if (url) this.healthTex.set(color, url)
    }

    // --- Minimap-Preview ---------------------------------------------------------
    try {
      const dds = parseDds(this.scmap.previewDds)
      const mip = dds.mips[0]!
      const rgba =
        dds.format === 'BGRA8'
          ? bgraToRgba(mip.data)
          : decodeDxt(mip.data, mip.width, mip.height, dds.format)
      this.minimapImage = await createImageBitmap(
        new ImageData(new Uint8ClampedArray(rgba), mip.width, mip.height),
      )
    } catch {
      this.minimapImage = null
    }
    const framePiece = async (name: string): Promise<string | null> =>
      this.skin(`/game/mini-map-brd01/mini-map_brd_${name}.dds`)
    const frame = this.el('#hud-minimap')
    for (const [cls, name] of [
      ['hud-mm-ul', 'ul'],
      ['hud-mm-um', 'horz_um'],
      ['hud-mm-ur', 'ur'],
      ['hud-mm-l', 'vert_l'],
      ['hud-mm-r', 'vert_r'],
      ['hud-mm-ll', 'll'],
      ['hud-mm-lm', 'lm'],
      ['hud-mm-lr', 'lr'],
    ] as const) {
      const url = await framePiece(name)
      if (!url) continue
      const div = document.createElement('div')
      div.className = `mm-frame ${cls}`
      div.style.backgroundImage = `url(${url})`
      frame.appendChild(div)
    }
  }

  private async unitIcon(id: string): Promise<string | null> {
    const cached = this.iconCache.get(id)
    if (cached) return cached
    const url = await this.skin(`/icons/units/${id.toUpperCase()}_icon.dds`)
    if (url) this.iconCache.set(id, url)
    return url
  }

  private update(): void {
    // Economy — Werte aus der Sim (Rate-Farben wie economy.lua: positiv
    // grün, negativ mit Vorrat gelb, negativ ohne Vorrat rot)
    const army: EcoSnapshot = this.source.economy()
    for (const [group, cur, max, income, expense] of [
      ['#eco-mass', army.mass, army.massStorage, army.massIncome, army.massExpense],
      ['#eco-energy', army.energy, army.energyStorage, army.energyIncome, army.energyExpense],
    ] as const) {
      const net = income - expense
      this.el(`${group} .eco-cur`).textContent = Math.floor(cur).toString()
      this.el(`${group} .eco-max`).textContent = Math.floor(max).toString()
      // max ist 0, solange die ACU ihr Lager noch nicht registriert hat —
      // (cur / 0) * 100 ist NaN und ergibt `width: NaN%`.
      const fillPct = max > 0 ? Math.min(100, (cur / max) * 100) : 0
      this.el(`${group} .eco-fill`).style.width = `${fillPct}%`
      const rate = this.el(`${group} .eco-rate`)
      rate.textContent = `${net >= 0 ? '+' : ''}${net.toFixed(0)}`
      rate.style.color = net >= 0 ? '#b7e75f' : cur > 1 ? '#ffff00' : '#ff0000'
      this.el(`${group} .eco-income`).textContent = `+${income.toFixed(1)}`
      this.el(`${group} .eco-expense`).textContent = `-${expense.toFixed(1)}`
    }

    // Orders — verfügbar = Union der CommandCaps der Auswahl (Original)
    const caps = this.source.selectedCaps()
    for (const b of this.orderButtons) {
      // Aktiv nur, wenn die Unit die Cap HAT *und* die Sim den Befehl ausfuehren
      // kann. Move/Attack/Patrol/Guard/Retaliate haben noch keine action — sie
      // werden deaktiviert gerendert (die _dis-Bitmap gibt es), statt so zu tun,
      // als taeten sie etwas. Sie kommen mit orders.lua wieder (docs/PLAN-UI.md).
      const enabled = caps.has(b.def.cap) && b.def.action !== undefined
      if (enabled !== b.enabled) {
        b.enabled = enabled
        b.img.src = enabled ? b.img.dataset.up! : b.img.dataset.dis!
        b.img.style.cursor = enabled ? 'pointer' : 'default'
      }
    }

    // Unit-View
    const units = this.source.units()
    const selected = units.filter((u) => u.selected)
    const panel = this.el('#unitview-panel')
    if (selected.length === 0) {
      panel.hidden = true
    } else {
      panel.hidden = false
      const first = selected[0]!
      this.el('#uv-name').textContent =
        selected.length > 1 ? `${selected.length} Einheiten` : first.name
      const hp = selected.reduce((a, u) => a + u.health, 0)
      const maxHp = selected.reduce((a, u) => a + u.maxHealth, 0)
      const ratio = maxHp > 0 ? hp / maxHp : 0
      const fill = this.el('#uv-health-fill')
      fill.style.width = `${ratio * 100}%`
      const tex = this.healthTex.get(ratio > 0.75 ? 'green' : ratio > 0.25 ? 'yellow' : 'red')
      if (tex) {
        fill.style.backgroundImage = `url(${tex})`
        fill.style.backgroundSize = '100% 100%'
      }
      this.el('#uv-health-text').textContent = `${Math.ceil(hp)} / ${Math.ceil(maxHp)}`
      void this.unitIcon(first.id).then((url) => {
        const icon = this.root.querySelector<HTMLImageElement>('#uv-icon')!
        if (url) icon.src = url
      })
    }

    // Minimap
    const ctx = this.minimapCanvas.getContext('2d')!
    const w = this.minimapCanvas.width
    const h = this.minimapCanvas.height
    ctx.clearRect(0, 0, w, h)
    if (this.minimapImage) ctx.drawImage(this.minimapImage, 0, 0, w, h)
    for (const u of units) {
      ctx.fillStyle = u.army === 1 ? '#3d8bff' : '#e23c2c'
      const x = (u.x / this.scmap.width) * w
      const y = (u.z / this.scmap.height) * h
      ctx.fillRect(x - 2, y - 2, u.selected ? 5 : 4, u.selected ? 5 : 4)
      if (u.selected) {
        ctx.strokeStyle = '#ffffff'
        ctx.strokeRect(x - 3.5, y - 3.5, 7, 7)
      }
    }
  }
}
