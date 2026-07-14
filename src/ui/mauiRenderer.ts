import type { LuaHost } from '../lua/host'
import type { GameVfs } from '../vfs/vfs'
import { ddsToDataUrl } from './ddsUrl'

/**
 * Der Renderer des maui-Layers: er zeichnet, was die Original-UI-Lua gebaut hat.
 *
 * Er entscheidet NICHTS über das Aussehen. Position, Größe, Tiefe, Farbe und
 * Text kommen aus den LazyVars der Controls (`__mauiSnapshot`), die die
 * Original-Lua gesetzt hat. Ein Control = ein absolut positioniertes `<div>`.
 *
 * `pointer-events: none` überall: der Hit-Test darf NICHT dem DOM überlassen
 * werden, sonst weicht das Bubbling vom Original ab (CMauiControl::HandleEvent,
 * Cfile:1124525 — liefert Lua `false`, geht das Event an den Parent hoch). Die
 * Ereignisse werden separat eingespeist.
 */
interface MauiControl {
  id: number
  kind: string
  name: string
  left: number
  top: number
  width: number
  height: number
  depth: number
  hidden: boolean
  alpha: number
  texture: string | false
  solidColor: string | false
  text: string | false
  color: string | false
  fontSize: number | false
  fontFamily: string | false
  /** Nur bei kind === 'border': der 9-Slice-Rahmen (vier Kanten, vier Ecken). */
  border:
    | false
    | {
        vertical: string | false
        horizontal: string | false
        upperLeft: string | false
        upperRight: string | false
        lowerLeft: string | false
        lowerRight: string | false
        borderWidth: number
        borderHeight: number
      }
  centerH: boolean
  centerV: boolean
}

export class MauiRenderer {
  private readonly root: HTMLDivElement
  private readonly els = new Map<number, HTMLDivElement>()
  private readonly textures = new Map<string, string | 'pending'>()

  constructor(
    private readonly host: LuaHost,
    private readonly vfs: GameVfs,
  ) {
    this.root = document.createElement('div')
    this.root.id = 'maui-root'
    this.root.style.cssText =
      'position:absolute;inset:0;overflow:hidden;pointer-events:none;user-select:none'
    document.body.appendChild(this.root)
  }

  dispose(): void {
    this.root.remove()
    this.els.clear()
  }

  /** Zieht den Zustand aus der UI-VM und schreibt ihn ins DOM. */
  update(deltaSeconds = 1 / 60): void {
    // Erst die Frame-Pumpe: die Engine ruft pro Bild OnFrame(delta) auf jedem
    // Control, das SetNeedsFrameUpdate(true) verlangt hat (Cfile:1118936).
    // Die Grids der Original-UI bauen darin ihr Layout auf.
    this.host.eval(`__mauiFrame(${deltaSeconds})`)
    // Der Snapshot kommt als JSON-STRING über eine JS-Funktion — er wird NICHT
    // aus Lua zurückgegeben. Jeder Rückgabewert bliebe im wasmoon-Registry
    // hängen (~78 kB pro Snapshot), und bei 60 Bildern/s lief die UI-VM nach
    // Minuten in ihre 2-GB-Grenze ("not enough memory"). Siehe LuaHost.pull().
    const controls = this.host.pull<MauiControl[]>('__mauiSnapshotJson()')
    if (controls.length === 0) return

    const seen = new Set<number>()
    for (const c of controls) {
      seen.add(c.id)
      let el = this.els.get(c.id)
      if (!el) {
        el = document.createElement('div')
        el.style.position = 'absolute'
        el.dataset.kind = c.kind
        el.dataset.name = c.name
        this.root.appendChild(el)
        this.els.set(c.id, el)
      }

      el.style.display = c.hidden ? 'none' : 'block'
      if (c.hidden) continue

      el.style.left = `${c.left}px`
      el.style.top = `${c.top}px`
      el.style.width = `${c.width}px`
      el.style.height = `${c.height}px`
      el.style.zIndex = String(Math.round(c.depth))
      el.style.opacity = String(c.alpha)

      if (c.kind === 'bitmap') {
        if (c.texture) {
          const url = this.texture(c.texture)
          el.style.backgroundImage = url ? `url(${url})` : 'none'
          el.style.backgroundSize = '100% 100%'
        } else if (c.solidColor) {
          el.style.background = argb(c.solidColor)
        }
      } else if (c.kind === 'border' && c.border) {
        this.drawBorder(el, c)
      } else if (c.kind === 'text') {
        el.textContent = c.text === false ? '' : String(c.text)
        el.style.color = c.color ? argb(c.color) : '#ffffff'
        el.style.fontSize = `${c.fontSize || 12}px`
        // Dieselbe Schrift, mit der die Lua ihr Layout gerechnet hat (die TTF
        // aus <GameDir>/fonts, per FontFace registriert). Eine Ersatzschrift
        // würde anders breit laufen als die Zahlen im Layout.
        if (c.fontFamily) el.style.fontFamily = `"${c.fontFamily}"`
        el.style.lineHeight = `${c.height}px`
        el.style.whiteSpace = 'pre'
        el.style.textAlign = c.centerH ? 'center' : 'left'
      }
    }

    for (const [id, el] of this.els) {
      if (!seen.has(id)) {
        el.remove()
        this.els.delete(id)
      }
    }
  }

  /**
   * Der 9-Slice-Rahmen: vier Kanten + vier Ecken, die MITTE bleibt frei.
   *
   * So beschreibt es die Original-Lua selbst (border.lua:9-12: „Border textures
   * assume a texture border of 1", „Adjacent corner textures must have matching
   * widths and heights"). Die Kantenstärke kommt nicht aus einer Zahl im Skript,
   * sondern aus den Texturmaßen: `BorderWidth` = Breite der vertical-Kachel,
   * `BorderHeight` = Höhe der horizontal-Kachel (Cfile:1122728/1122748).
   *
   * Der Rahmen liegt AUSSERHALB des Controls — deshalb sitzen die Kacheln bei
   * negativen Offsets. Die Kanten kacheln (repeat), die Ecken nicht.
   */
  private drawBorder(el: HTMLDivElement, c: MauiControl): void {
    const b = c.border
    if (!b) return
    const bw = b.borderWidth || 0
    const bh = b.borderHeight || 0
    el.style.background = 'none'
    el.style.overflow = 'visible'

    // Acht Kacheln als Kinder — sie folgen dem Control, also einmal anlegen.
    if (el.children.length !== 8) {
      el.textContent = ''
      for (let i = 0; i < 8; i++) {
        const tile = document.createElement('div')
        tile.style.position = 'absolute'
        el.appendChild(tile)
      }
    }
    const tiles = [...el.children] as HTMLDivElement[]
    const put = (
      i: number,
      tex: string | false,
      css: Partial<CSSStyleDeclaration>,
      repeat: string,
    ): void => {
      const t = tiles[i]!
      const url = tex ? this.texture(tex) : null
      t.style.backgroundImage = url ? `url(${url})` : 'none'
      t.style.backgroundRepeat = repeat
      t.style.backgroundSize = repeat === 'no-repeat' ? '100% 100%' : 'auto'
      Object.assign(t.style, css)
    }

    // Ecken (fest), dann Kanten (gekachelt) — genau die sechs Texturen, die
    // SetNewTextures bekommt.
    put(0, b.upperLeft, { left: `${-bw}px`, top: `${-bh}px`, width: `${bw}px`, height: `${bh}px` }, 'no-repeat')
    put(1, b.upperRight, { right: `${-bw}px`, top: `${-bh}px`, width: `${bw}px`, height: `${bh}px` }, 'no-repeat')
    put(2, b.lowerLeft, { left: `${-bw}px`, bottom: `${-bh}px`, width: `${bw}px`, height: `${bh}px` }, 'no-repeat')
    put(3, b.lowerRight, { right: `${-bw}px`, bottom: `${-bh}px`, width: `${bw}px`, height: `${bh}px` }, 'no-repeat')
    put(4, b.horizontal, { left: '0', top: `${-bh}px`, width: '100%', height: `${bh}px` }, 'repeat-x')
    put(5, b.horizontal, { left: '0', bottom: `${-bh}px`, width: '100%', height: `${bh}px` }, 'repeat-x')
    put(6, b.vertical, { left: `${-bw}px`, top: '0', width: `${bw}px`, height: '100%' }, 'repeat-y')
    put(7, b.vertical, { right: `${-bw}px`, top: '0', width: `${bw}px`, height: '100%' }, 'repeat-y')
  }

  /** DDS aus dem VFS als Data-URL (asynchron nachgeladen, dann gecacht). */
  private texture(path: string): string | null {
    const key = path.replace(/^\/+/, '').toLowerCase()
    const hit = this.textures.get(key)
    if (hit && hit !== 'pending') return hit
    if (hit === 'pending') return null
    this.textures.set(key, 'pending')
    void (async () => {
      if (!this.vfs.exists(key)) {
        this.textures.delete(key)
        return
      }
      const url = ddsToDataUrl(key, await this.vfs.read(key))
      if (url) this.textures.set(key, url)
      else this.textures.delete(key)
    })()
    return null
  }
}

/** FA-Farben sind 'aarrggbb' (oder 'rrggbb'). */
function argb(color: string): string {
  const c = String(color).replace(/^#/, '')
  if (c.length === 8) {
    const a = parseInt(c.slice(0, 2), 16) / 255
    return `rgba(${parseInt(c.slice(2, 4), 16)},${parseInt(c.slice(4, 6), 16)},${parseInt(c.slice(6, 8), 16)},${a})`
  }
  return `#${c}`
}
