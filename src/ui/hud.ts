import * as THREE from 'three'
import type { GameVfs } from '../vfs/vfs'
import type { UnitViewer } from '../viewer/unitViewer'
import type { SandboxController } from '../sandbox/sandbox'
import type { ScmapData } from '../formats/scmap'
import { ddsToDataUrl } from './ddsUrl'
import { parseDds } from '../formats/dds'
import { bgraToRgba, decodeDxt } from '../formats/dxt'

/**
 * In-Game-HUD im Stil des Originals, gebaut aus den Original-UI-Texturen
 * (textures.scd): Economy-Bar oben (Mass/Energy-Buttons + Balken),
 * Selektions-Panel unten (Unit-Icon, Name, HP), Order-Buttons
 * (move/stop/attack mit up/over/down-Zuständen) und Minimap (eingebettetes
 * Karten-Preview + Einheiten-Punkte, Klick = Kamera).
 */

const UI = 'textures/ui/common'

export class Hud {
  private readonly root: HTMLDivElement
  private readonly massValue: HTMLSpanElement
  private readonly massIncome: HTMLSpanElement
  private readonly massBar: HTMLDivElement
  private readonly energyValue: HTMLSpanElement
  private readonly energyIncome: HTMLSpanElement
  private readonly energyBar: HTMLDivElement
  private readonly selIcon: HTMLImageElement
  private readonly selName: HTMLDivElement
  private readonly selHealth: HTMLDivElement
  private readonly selHealthBar: HTMLDivElement
  private readonly selPanel: HTMLDivElement
  private readonly minimapCanvas: HTMLCanvasElement
  private minimapImage: ImageBitmap | null = null
  private readonly iconCache = new Map<string, string>()
  private readonly interval: number

  constructor(
    private readonly vfs: GameVfs,
    private readonly viewer: UnitViewer,
    private readonly controller: SandboxController,
    private readonly scmap: ScmapData,
  ) {
    this.root = document.createElement('div')
    this.root.id = 'hud'
    this.root.innerHTML = `
      <div id="hud-eco">
        <div class="eco-group">
          <img class="eco-icon" data-tex="mass" alt="Mass" />
          <div class="eco-info">
            <div class="eco-bar-back"><div class="eco-bar mass"></div></div>
            <div class="eco-numbers"><span class="eco-value">0</span><span class="eco-income">+0</span></div>
          </div>
        </div>
        <div class="eco-group">
          <img class="eco-icon" data-tex="energy" alt="Energy" />
          <div class="eco-info">
            <div class="eco-bar-back"><div class="eco-bar energy"></div></div>
            <div class="eco-numbers"><span class="eco-value">0</span><span class="eco-income">+0</span></div>
          </div>
        </div>
      </div>
      <div id="hud-minimap"><canvas width="216" height="216"></canvas></div>
      <div id="hud-selection" hidden>
        <img id="hud-sel-icon" alt="" />
        <div id="hud-sel-text">
          <div id="hud-sel-name"></div>
          <div id="hud-sel-hpbar-back"><div id="hud-sel-hpbar"></div></div>
          <div id="hud-sel-hp"></div>
        </div>
        <div id="hud-orders"></div>
      </div>
    `
    document.body.appendChild(this.root)

    const $ = <T extends HTMLElement>(sel: string): T => this.root.querySelector(sel) as T
    const ecoGroups = this.root.querySelectorAll('.eco-group')
    this.massValue = ecoGroups[0]!.querySelector('.eco-value')!
    this.massIncome = ecoGroups[0]!.querySelector('.eco-income')!
    this.massBar = ecoGroups[0]!.querySelector('.eco-bar')!
    this.energyValue = ecoGroups[1]!.querySelector('.eco-value')!
    this.energyIncome = ecoGroups[1]!.querySelector('.eco-income')!
    this.energyBar = ecoGroups[1]!.querySelector('.eco-bar')!
    this.selIcon = $('#hud-sel-icon')
    this.selName = $('#hud-sel-name')
    this.selHealth = $('#hud-sel-hp')
    this.selHealthBar = $('#hud-sel-hpbar')
    this.selPanel = $('#hud-selection')
    this.minimapCanvas = $('#hud-minimap canvas') as HTMLCanvasElement

    void this.loadStaticTextures()
    void this.buildOrderButtons()
    void this.buildMinimap()

    this.minimapCanvas.addEventListener('pointerdown', (e) => {
      const rect = this.minimapCanvas.getBoundingClientRect()
      const wx = ((e.clientX - rect.left) / rect.width) * this.scmap.width
      const wz = ((e.clientY - rect.top) / rect.height) * this.scmap.height
      this.viewer.focusOn(new THREE.Vector3(wx, this.viewer.heightAt(wx, wz), wz), 60)
    })

    this.interval = window.setInterval(() => this.update(), 100)
  }

  dispose(): void {
    clearInterval(this.interval)
    this.root.remove()
  }

  private async tex(path: string): Promise<string | null> {
    try {
      if (!this.vfs.exists(path)) return null
      return ddsToDataUrl(path, await this.vfs.read(path))
    } catch {
      return null
    }
  }

  private async loadStaticTextures(): Promise<void> {
    const icons = this.root.querySelectorAll<HTMLImageElement>('.eco-icon')
    const mass = await this.tex(`${UI}/game/resources/mass_btn_up.dds`)
    const energy = await this.tex(`${UI}/game/resources/energy_btn_up.dds`)
    if (mass) icons[0]!.src = mass
    if (energy) icons[1]!.src = energy

    // Original-Panel-Hintergründe
    const setBg = (el: HTMLElement | null, url: string | null, size = '100% 100%'): void => {
      if (el && url) {
        el.style.backgroundImage = `url(${url})`
        el.style.backgroundSize = size
      }
    }
    const eco = this.root.querySelector<HTMLElement>('#hud-eco')
    setBg(eco, await this.tex(`${UI}/game/resources/center_bmp_m.dds`))
    const sel = this.root.querySelector<HTMLElement>('#hud-selection')
    setBg(sel, await this.tex(`${UI}/game/mini-ui-unit-over/unit-over-back_bmp.dds`))
    const hpBack = this.root.querySelector<HTMLElement>('#hud-sel-hpbar-back')
    setBg(hpBack, await this.tex(`${UI}/game/unit-over/health-bars-back_bmp.dds`))
    for (const [sel2, path] of [
      ['.eco-bar-back', 'mass-bar-back_bmp'],
      ['.eco-bar.mass', 'mass-bar_bmp'],
      ['.eco-bar.energy', 'energy-bar_bmp'],
    ] as const) {
      for (const el of this.root.querySelectorAll<HTMLElement>(sel2)) {
        setBg(el, await this.tex(`${UI}/game/resources/${path}.dds`))
      }
    }

    // Minimap: Original-9-Slice-Rahmen
    const frame = this.root.querySelector<HTMLElement>('#hud-minimap')
    if (frame) {
      const piece = async (name: string): Promise<string | null> =>
        this.tex(`${UI}/game/mini-map-brd01/mini-map_brd_${name}.dds`)
      const [ul, um, ur, vl, vr, ll, lm, lr, mid] = await Promise.all([
        piece('ul'),
        piece('horz_um'),
        piece('ur'),
        piece('vert_l'),
        piece('vert_r'),
        piece('ll'),
        piece('lm'),
        piece('lr'),
        piece('m'),
      ])
      const corners: [string, string | null][] = [
        ['hud-mm-ul', ul],
        ['hud-mm-um', um],
        ['hud-mm-ur', ur],
        ['hud-mm-l', vl],
        ['hud-mm-r', vr],
        ['hud-mm-ll', ll],
        ['hud-mm-lm', lm],
        ['hud-mm-lr', lr],
      ]
      for (const [cls, url] of corners) {
        if (!url) continue
        const div = document.createElement('div')
        div.className = `mm-frame ${cls}`
        div.style.backgroundImage = `url(${url})`
        frame.appendChild(div)
      }
      if (mid) setBg(frame, mid)
    }
  }

  private async buildOrderButtons(): Promise<void> {
    const orders: { name: string; action: () => void; enabled: boolean }[] = [
      { name: 'move', action: () => {}, enabled: true },
      { name: 'stop', action: () => this.controller.stopSelected(), enabled: true },
      { name: 'attack', action: () => {}, enabled: false },
      { name: 'patrol', action: () => {}, enabled: false },
    ]
    const container = this.root.querySelector('#hud-orders')!
    for (const order of orders) {
      const state = order.enabled ? 'up' : 'dis'
      const up = await this.tex(`${UI}/game/orders/${order.name}_btn_${state}.dds`)
      const over = order.enabled
        ? await this.tex(`${UI}/game/orders/${order.name}_btn_over.dds`)
        : null
      const down = order.enabled
        ? await this.tex(`${UI}/game/orders/${order.name}_btn_down.dds`)
        : null
      if (!up) continue
      const btn = document.createElement('img')
      btn.className = 'order-btn'
      btn.src = up
      btn.title = order.name
      if (order.enabled) {
        btn.addEventListener('pointerenter', () => over && (btn.src = over))
        btn.addEventListener('pointerleave', () => (btn.src = up))
        btn.addEventListener('pointerdown', () => down && (btn.src = down))
        btn.addEventListener('pointerup', () => {
          btn.src = over ?? up
          order.action()
        })
      }
      container.appendChild(btn)
    }
  }

  private async buildMinimap(): Promise<void> {
    try {
      const dds = parseDds(this.scmap.previewDds)
      const mip = dds.mips[0]!
      const rgba =
        dds.format === 'BGRA8'
          ? bgraToRgba(mip.data)
          : decodeDxt(mip.data, mip.width, mip.height, dds.format)
      const img = new ImageData(new Uint8ClampedArray(rgba), mip.width, mip.height)
      this.minimapImage = await createImageBitmap(img)
    } catch {
      this.minimapImage = null
    }
  }

  private async unitIcon(id: string): Promise<string | null> {
    const cached = this.iconCache.get(id)
    if (cached) return cached
    const url = await this.tex(`${UI}/icons/units/${id}_icon.dds`)
    if (url) this.iconCache.set(id, url)
    return url
  }

  private update(): void {
    // Economy
    const army = this.controller.world.army(1)
    this.massValue.textContent = Math.floor(army.mass).toString()
    this.massIncome.textContent = `+${army.massIncome.toFixed(1)}`
    this.massBar.style.width = `${Math.min(100, (army.mass / army.massStorage) * 100)}%`
    this.energyValue.textContent = Math.floor(army.energy).toString()
    this.energyIncome.textContent = `+${army.energyIncome.toFixed(1)}`
    this.energyBar.style.width = `${Math.min(100, (army.energy / army.energyStorage) * 100)}%`

    // Auswahl
    const units = this.controller.hudUnits()
    const selected = units.filter((u) => u.selected)
    if (selected.length === 0) {
      this.selPanel.hidden = true
    } else {
      this.selPanel.hidden = false
      const first = selected[0]!
      this.selName.textContent =
        selected.length > 1 ? `${selected.length} Einheiten` : `${first.name}`
      const hp = selected.reduce((a, u) => a + u.health, 0)
      const maxHp = selected.reduce((a, u) => a + u.maxHealth, 0)
      this.selHealth.textContent = `${Math.ceil(hp)} / ${Math.ceil(maxHp)}`
      const ratio = maxHp > 0 ? hp / maxHp : 0
      this.selHealthBar.style.width = `${ratio * 100}%`
      this.selHealthBar.style.background =
        ratio > 0.66 ? '#3fbf3f' : ratio > 0.33 ? '#d8c02a' : '#c43a2a'
      void this.unitIcon(first.id).then((url) => {
        if (url) this.selIcon.src = url
      })
    }

    // Minimap
    const ctx = this.minimapCanvas.getContext('2d')!
    const w = this.minimapCanvas.width
    const h = this.minimapCanvas.height
    ctx.clearRect(0, 0, w, h)
    if (this.minimapImage) {
      ctx.drawImage(this.minimapImage, 0, 0, w, h)
    } else {
      ctx.fillStyle = '#0a0e14'
      ctx.fillRect(0, 0, w, h)
    }
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
