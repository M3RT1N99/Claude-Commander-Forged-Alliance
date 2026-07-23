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
  /** ItemList / Edit / Scrollbar — was die Engine im Original selbst zeichnet. */
  list:
    | false
    | {
        // ItemList
        items?: string[]
        top?: number
        selection?: number
        rowHeight?: number
        fg?: string | false
        bg?: string | false
        selFg?: string | false
        selBg?: string | false
        showSelection?: boolean
        // Edit
        text?: string
        caret?: number
        // WorldView
        camera?: string
        miniMap?: boolean
        cartographic?: boolean
        resourceIcons?: boolean
        // Scrollbar
        axis?: string
        thumbStart?: number
        thumbEnd?: number
        background?: string | false
        thumbMiddle?: string | false
      }
}

/**
 * Eine Weltansicht, wie die Original-Lua sie hingelegt hat.
 *
 * Die 3D-Seite rendert in dieses Rechteck. Die Hauptansicht ist perspektivisch,
 * die Minimap kartografisch (Draufsicht) — `miniMap`/`cartographic` kommen aus
 * dem Control (minimap.lua:115 setzt `isMiniMap = true`).
 */
export interface WorldViewRect {
  id: number
  name: string
  left: number
  top: number
  width: number
  height: number
  camera: string
  miniMap: boolean
  cartographic: boolean
}

export class MauiRenderer {
  private readonly root: HTMLDivElement
  private readonly els = new Map<number, HTMLDivElement>()
  private readonly textures = new Map<string, string | 'pending'>()
  private lastWorldViews: WorldViewRect[] = []
  /**
   * Was zuletzt für ein Control im DOM stand.
   *
   * Der Grund: eine Zuweisung an `el.style.left` ist auch dann teuer, wenn sich
   * der Wert nicht ändert — der Browser invalidiert Layout und Style. Bei ~300
   * Controls × 6 Eigenschaften × 60 Bildern/s sind das 108.000 Schreibzugriffe
   * pro Sekunde, von denen sich fast keiner geändert hat. Die Bild-Zeit lag
   * dadurch bei 52 ms (≈19 fps).
   *
   * Die Original-Engine hat dieses Problem nicht (sie zeichnet auf die GPU, ohne
   * Layout-Baum). Das DOM ist unsere Zeichenfläche — also schreiben wir nur, was
   * sich wirklich geändert hat. Am Verhalten ändert das nichts.
   */
  private readonly lastCss = new Map<number, string>()

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

      // Nur schreiben, was sich geändert hat (siehe `lastCss`). Geometrie UND
      // Inhalt hängen an demselben Schlüssel: ändert sich nichts, fasst dieses
      // Bild das Element gar nicht an.
      //
      // Listen, Rahmen und Scrollbalken bleiben außen vor — ihr Inhalt steckt in
      // verschachtelten Daten, die kein billiger Schlüssel abbildet.
      const complex = c.kind === 'itemlist' || c.kind === 'border' || c.kind === 'scrollbar'
      // Die Textur wird ASYNCHRON geladen (DDS aus dem VFS). Deshalb steht ihre
      // aufgelöste URL MIT im Schlüssel: solange sie noch lädt, ist sie `null`,
      // und sobald sie da ist, ändert sich der Schlüssel — das Bild wird gesetzt.
      //
      // Ohne diesen Teil schreibt der Zwischenspeicher „noch nicht geladen" als
      // Endzustand fest, und die halbe Oberfläche bleibt leer. (Genau so
      // passiert, nachdem ich den Zwischenspeicher eingebaut hatte.)
      const url = c.kind === 'bitmap' && c.texture ? this.texture(c.texture) : null
      const css =
        `${c.hidden ? 1 : 0}|${c.left}|${c.top}|${c.width}|${c.height}|` +
        `${Math.round(c.depth)}|${c.alpha}|${c.texture}|${url}|${c.solidColor}|${c.text}|` +
        `${c.color}|${c.fontSize}|${c.fontFamily}|${c.centerH}`
      if (!complex && this.lastCss.get(c.id) === css) continue
      this.lastCss.set(c.id, css)

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
          el.style.backgroundImage = url ? `url(${url})` : 'none'
          el.style.backgroundSize = '100% 100%'
        } else if (c.solidColor) {
          el.style.background = argb(c.solidColor)
        }
      } else if (c.kind === 'border' && c.border) {
        this.drawBorder(el, c)
      } else if (c.kind === 'itemlist') {
        this.drawItemList(el, c)
      } else if (c.kind === 'edit') {
        const l = c.list || {}
        el.textContent = String(l.text ?? '')
        el.style.color = l.fg ? argb(String(l.fg)) : '#ffffff'
        el.style.background = l.bg ? argb(String(l.bg)) : 'transparent'
        el.style.fontSize = `${c.fontSize || 12}px`
        if (c.fontFamily) el.style.fontFamily = `"${c.fontFamily}"`
        el.style.lineHeight = `${c.height}px`
        el.style.whiteSpace = 'pre'
        el.style.overflow = 'hidden'
      } else if (c.kind === 'worldview') {
        // Die Welt zeichnet die 3D-Engine, nicht der maui-Renderer. Das Control
        // sagt nur, WO und WIE GROSS — hier bleibt ein Loch.
        el.style.background = 'none'
        el.textContent = ''
      } else if (c.kind === 'scrollbar') {
        this.drawScrollbar(el, c)
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
        // Auch den Zwischenspeicher: die IDs werden weitergezählt, aber ein
        // liegengebliebener Eintrag hielte sonst ewig Speicher.
        this.lastCss.delete(id)
      }
    }

    // Die Weltansichten merken — die 3D-Seite fragt sie pro Bild ab.
    this.lastWorldViews = controls
      .filter((c) => c.kind === 'worldview' && !c.hidden)
      .map((c) => ({
        id: c.id,
        name: c.name,
        left: c.left,
        top: c.top,
        width: c.width,
        height: c.height,
        camera: String((c.list && c.list.camera) || 'WorldCamera'),
        miniMap: Boolean(c.list && c.list.miniMap),
        cartographic: Boolean(c.list && c.list.cartographic),
      }))
  }

  /** Die Weltansichten der Original-Lua (Hauptansicht, Minimap) mit ihren Rechtecken. */
  worldViews(): WorldViewRect[] {
    return this.lastWorldViews
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

  /**
   * Die Zeilen einer ItemList. Im Original zeichnet die Engine sie (CMauiItemList
   * hält Zeilen, Auswahl und Scroll-Position selbst) — die Zahlen kommen also aus
   * dem Control, nicht aus der Lua: `top` ist die erste sichtbare Zeile,
   * `rowHeight` folgt aus der gesetzten Schrift (SetNewFont), die Farben aus
   * SetNewColors(fg, bg, selFg, selBg).
   */
  private drawItemList(el: HTMLDivElement, c: MauiControl): void {
    const l = c.list || {}
    const items = l.items ?? []
    const rowHeight = Math.max(1, l.rowHeight ?? 12)
    const top = l.top ?? 0
    const rows = Math.floor(c.height / rowHeight)

    el.style.background = l.bg ? argb(String(l.bg)) : 'transparent'
    el.style.overflow = 'hidden'
    el.textContent = ''
    for (let i = top; i < Math.min(items.length, top + rows); i++) {
      const row = document.createElement('div')
      const selected = l.showSelection !== false && l.selection === i
      row.textContent = items[i] ?? ''
      row.style.cssText =
        `position:absolute;left:0;right:0;height:${rowHeight}px;` +
        `top:${(i - top) * rowHeight}px;line-height:${rowHeight}px;white-space:pre;overflow:hidden;` +
        `font-size:${c.fontSize || 12}px;`
      if (c.fontFamily) row.style.fontFamily = `"${c.fontFamily}"`
      row.style.color = argb(String((selected ? l.selFg : l.fg) || l.fg || 'ffffff'))
      if (selected && l.selBg) row.style.background = argb(String(l.selBg))
      el.appendChild(row)
    }
  }

  /**
   * Der Scrollbar: Hintergrund + Thumb. Die Lage des Thumbs rechnet die Engine
   * NICHT selbst aus — sie fragt das Scrollable-Objekt (`GetScrollValues(axis)`
   * → rangeMin, rangeMax, visibleMin, visibleMax, Cfile:1124664). Genau diese
   * Anteile stehen im Snapshot.
   */
  private drawScrollbar(el: HTMLDivElement, c: MauiControl): void {
    const l = c.list || {}
    const vertical = (l.axis ?? 'Vert') === 'Vert'
    const start = Math.max(0, Math.min(1, l.thumbStart ?? 0))
    const end = Math.max(start, Math.min(1, l.thumbEnd ?? 1))

    const bgUrl = l.background ? this.texture(String(l.background)) : null
    el.style.backgroundImage = bgUrl ? `url(${bgUrl})` : 'none'
    el.style.backgroundSize = '100% 100%'
    el.style.overflow = 'hidden'

    if (el.children.length !== 1) {
      el.textContent = ''
      const thumb = document.createElement('div')
      thumb.style.position = 'absolute'
      el.appendChild(thumb)
    }
    const thumb = el.firstElementChild as HTMLDivElement
    const url = l.thumbMiddle ? this.texture(String(l.thumbMiddle)) : null
    thumb.style.backgroundImage = url ? `url(${url})` : 'none'
    thumb.style.backgroundSize = '100% 100%'
    if (!url) thumb.style.background = 'rgba(255,255,255,0.35)'
    if (vertical) {
      thumb.style.left = '0'
      thumb.style.right = '0'
      thumb.style.top = `${start * 100}%`
      thumb.style.height = `${Math.max(4, (end - start) * c.height)}px`
    } else {
      thumb.style.top = '0'
      thumb.style.bottom = '0'
      thumb.style.left = `${start * 100}%`
      thumb.style.width = `${Math.max(4, (end - start) * c.width)}px`
    }
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
