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
    // Command-mode cursor bridge (Cursor:SetNewTexture -> __uiSetCursorTexture,
    // moho.lua:1300). Declared `false` until the engine (us) supplies it.
    host.setGlobal('__uiSetCursorTexture', (path: string, hx: number, hy: number) =>
      this.setCursorTexture(path, hx, hy),
    )
  }

  /** The DDS key of the cursor frame currently being applied (guards stale async decodes). */
  private cursorKey = ''

  /**
   * Apply a skin cursor to the mouse (the command-mode cursor: Move/Attack/Build,
   * skins.lua:170-… via UIUtil.GetCursor). Decodes the DDS (cached like every
   * bitmap) and sets it as the DOM cursor with its hotspot; the animated cursors
   * arrive as a stream of `<name>-NN.dds` frames from the cursor thread. An empty
   * path clears back to the default arrow. Applied to document.body because the
   * maui overlay is pointer-events:none — the world/canvas under it shows it.
   */
  setCursorTexture(path: string, hotspotX: number, hotspotY: number): void {
    if (!path) {
      this.cursorKey = ''
      document.body.style.cursor = ''
      return
    }
    const key = path.replace(/^\/+/, '').toLowerCase()
    this.cursorKey = key
    const apply = (url: string): void => {
      if (this.cursorKey !== key) return // a newer frame/mode superseded this decode
      document.body.style.cursor = `url("${url}") ${Math.round(hotspotX)} ${Math.round(hotspotY)}, auto`
    }
    const hit = this.textures.get(key)
    if (typeof hit === 'string' && hit !== 'pending' && hit !== 'failed') {
      apply(hit)
      return
    }
    if (hit === 'failed') return
    this.textures.set(key, 'pending')
    void (async () => {
      try {
        if (!this.vfs.exists(key)) {
          this.textures.set(key, 'failed')
          return
        }
        const url = ddsToDataUrl(key, await this.vfs.read(key))
        this.textures.set(key, url ?? 'failed')
        if (url) apply(url)
      } catch {
        this.textures.set(key, 'failed')
      }
    })()
  }

  dispose(): void {
    this.root.remove()
    this.els.clear()
    document.body.style.cursor = ''
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
        this.drawEdit(el, c)
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
   * Der 9-Slice-Rahmen: vier Ecken + vier Kanten, die MITTE bleibt frei.
   *
   * Original-Lua (border.lua:9-12: „Border textures assume a texture border of
   * 1", „Adjacent corner textures must have matching widths and heights"). Die
   * Kantenstärke kommt aus den Texturmaßen: `BorderWidth` = Breite der
   * vertical-Kachel, `BorderHeight` = Höhe der horizontal-Kachel
   * (Cfile:1122728/1122748).
   *
   * `CMauiBorder::Draw` (Cfile:1122837-1123057) zeichnet alle neun Slices
   * INNERHALB des Control-Rects [Left,Right]×[Top,Bottom] — der Border-Control
   * hat SELBST die äußeren Maße, die Stärke frisst nach INNEN (border.lua setzt
   * die Ränder auf die Außengrenzen). Die Ecken sitzen also bei [0,bw]/[0,bh]
   * bzw. an der Innenkante, nicht bei negativen Offsets. bw/bh werden gerundet
   * (func_round, Cfile:1122842/1122844).
   *
   * Kanten: die Engine STRECKT jede Kantentextur über ihre Spanne (UV 0..1,
   * nicht kacheln), nur ZWISCHEN den Ecken ([Left+bw,Right-bw] / [Top+bh,B-bh])
   * und nur, wenn die Spanne größer als die doppelte Stärke ist
   * (Cfile:1122951/1123005). Die untere Kante ist vertikal gespiegelt (UV.y an
   * der Außenkante 0), die rechte horizontal (Cfile:1122983/1123034).
   */
  private drawBorder(el: HTMLDivElement, c: MauiControl): void {
    const b = c.border
    if (!b) return
    const bw = Math.round(b.borderWidth || 0)
    const bh = Math.round(b.borderHeight || 0)
    const w = c.width
    const h = c.height
    el.style.background = 'none'
    // Slices live INSIDE the rect now, so clip anything past the edges.
    el.style.overflow = 'hidden'

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
    const put = (i: number, tex: string | false, css: Partial<CSSStyleDeclaration>): void => {
      const t = tiles[i]!
      const url = tex ? this.texture(tex) : null
      // Reset any stale offset/flip from a previous layout before restyling.
      t.style.left = t.style.right = t.style.top = t.style.bottom = ''
      t.style.transform = ''
      t.style.display = 'block'
      t.style.backgroundImage = url ? `url(${url})` : 'none'
      t.style.backgroundRepeat = 'no-repeat'
      t.style.backgroundSize = '100% 100%' // stretch (UV 0..1), never tile
      Object.assign(t.style, css)
    }

    // Corners: always drawn, inside the rect (Cfile:1122850-1122950).
    put(0, b.upperLeft, { left: '0', top: '0', width: `${bw}px`, height: `${bh}px` })
    put(1, b.upperRight, { left: `${w - bw}px`, top: '0', width: `${bw}px`, height: `${bh}px` })
    put(2, b.lowerLeft, { left: '0', top: `${h - bh}px`, width: `${bw}px`, height: `${bh}px` })
    put(3, b.lowerRight, { left: `${w - bw}px`, top: `${h - bh}px`, width: `${bw}px`, height: `${bh}px` })
    // Horizontal edges (top + bottom = mTexHorz): only between the corners, only
    // when width > 2*bw; the bottom edge is flipped vertically (Cfile:1122951).
    if (w > bw * 2) {
      put(4, b.horizontal, { left: `${bw}px`, top: '0', width: `${w - 2 * bw}px`, height: `${bh}px` })
      put(5, b.horizontal, {
        left: `${bw}px`,
        top: `${h - bh}px`,
        width: `${w - 2 * bw}px`,
        height: `${bh}px`,
        transform: 'scaleY(-1)',
      })
    } else {
      tiles[4]!.style.display = tiles[5]!.style.display = 'none'
    }
    // Vertical edges (left + right = mTex1): only between the corners, only when
    // height > 2*bh; the right edge is flipped horizontally (Cfile:1123005).
    if (h > bh * 2) {
      put(6, b.vertical, { left: '0', top: `${bh}px`, width: `${bw}px`, height: `${h - 2 * bh}px` })
      put(7, b.vertical, {
        left: `${w - bw}px`,
        top: `${bh}px`,
        width: `${bw}px`,
        height: `${h - 2 * bh}px`,
        transform: 'scaleX(-1)',
      })
    } else {
      tiles[6]!.style.display = tiles[7]!.style.display = 'none'
    }
  }

  /**
   * Die Zeilen einer ItemList. Im Original zeichnet die Engine sie (CMauiItemList
   * hält Zeilen, Auswahl und Scroll-Position selbst) — die Zahlen kommen also aus
   * dem Control, nicht aus der Lua: `top` ist die erste sichtbare Zeile,
   * `rowHeight` folgt aus der gesetzten Schrift (SetNewFont), die Farben aus
   * SetNewColors(fg, bg, selFg, selBg).
   */
  /**
   * CMauiEdit rendering: text with the selection span (highlight colors),
   * the caret bar and the optional background/dropshadow. Caret/selection
   * indices are CHARACTER counts (codepoints) — sliced with Array.from.
   * The exact caret-blink math of CMauiEdit::DoRender is not decoded
   * (named gap); a CSS opacity cycle over caretCycle seconds stands in.
   */
  private drawEdit(el: HTMLDivElement, c: MauiControl): void {
    const l = (c.list || {}) as {
      text?: string
      caret?: number
      fg?: string
      bg?: string
      showBackground?: boolean
      caretVisible?: boolean
      caretColor?: string
      caretCycle?: number
      selStart?: number
      selEnd?: number
      hlFg?: string
      hlBg?: string
      dropShadow?: boolean
    }
    el.textContent = ''
    el.style.color = l.fg ? argb(String(l.fg)) : '#ffffff'
    el.style.background = l.showBackground && l.bg ? argb(String(l.bg)) : 'transparent'
    el.style.fontSize = `${c.fontSize || 12}px`
    if (c.fontFamily) el.style.fontFamily = `"${c.fontFamily}"`
    el.style.lineHeight = `${c.height}px`
    el.style.whiteSpace = 'pre'
    el.style.overflow = 'hidden'
    el.style.textShadow = l.dropShadow ? '1px 1px 0 rgba(0,0,0,0.8)' : ''

    const chars = Array.from(String(l.text ?? ''))
    const caret = Math.max(0, Math.min(l.caret ?? chars.length, chars.length))
    const s = Math.min(l.selStart ?? 0, l.selEnd ?? 0)
    const e = Math.max(l.selStart ?? 0, l.selEnd ?? 0)

    const span = (text: string): HTMLSpanElement => {
      const sp = document.createElement('span')
      sp.textContent = text
      return sp
    }
    if (e > s) {
      el.appendChild(span(chars.slice(0, s).join('')))
      const sel = span(chars.slice(s, e).join(''))
      sel.style.color = l.hlFg ? argb(String(l.hlFg)) : '#000000'
      sel.style.background = l.hlBg ? argb(String(l.hlBg)) : '#ffffff'
      el.appendChild(sel)
      el.appendChild(span(chars.slice(e).join('')))
    } else {
      el.appendChild(span(chars.slice(0, caret).join('')))
      el.appendChild(span(chars.slice(caret).join('')))
    }
    if (l.caretVisible) {
      // Insert the caret bar at the caret position (between the two spans).
      const bar = document.createElement('span')
      bar.textContent = '​'
      bar.style.borderLeft = `1px solid ${l.caretColor ? argb(String(l.caretColor)) : '#fefefe'}`
      bar.style.animation = `cfa-caret-blink ${l.caretCycle ?? 1.5}s step-end infinite`
      const after = e > s ? 2 : 1
      el.insertBefore(bar, el.children[after] ?? null)
      this.ensureCaretKeyframes()
    }
  }

  private caretKeyframesAdded = false
  private ensureCaretKeyframes(): void {
    if (this.caretKeyframesAdded) return
    this.caretKeyframesAdded = true
    const style = document.createElement('style')
    style.textContent =
      '@keyframes cfa-caret-blink { 0%, 49% { opacity: 1; } 50%, 100% { opacity: 0.24; } }'
    document.head.appendChild(style)
  }

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
    if (hit === 'pending' || hit === 'failed') return null
    if (hit) return hit
    this.textures.set(key, 'pending')
    void (async () => {
      try {
        if (!this.vfs.exists(key)) {
          this.textures.set(key, 'failed')
          return
        }
        const url = ddsToDataUrl(key, await this.vfs.read(key))
        this.textures.set(key, url ?? 'failed')
      } catch {
        // An unsupported/corrupt DDS must not leave the bitmap stuck on
        // 'pending' (unhandled rejection). Mark it 'failed' so it renders
        // nothing and is not retried every frame.
        this.textures.set(key, 'failed')
      }
    })()
    return null
  }
}

/** FA-Farben sind 'aarrggbb' (oder 'rrggbb'). */
function argb(color: string): string {
  const c = String(color).replace(/^#/, '')
  // The engine's func_ParseColor (@574510) accepts an 8-digit AARRGGBB or a
  // 6-digit RRGGBB hex string, OR a named colour it resolves via enum_colors.
  if (/^[0-9a-fA-F]{8}$/.test(c)) {
    const a = parseInt(c.slice(0, 2), 16) / 255
    return `rgba(${parseInt(c.slice(2, 4), 16)},${parseInt(c.slice(4, 6), 16)},${parseInt(c.slice(6, 8), 16)},${a})`
  }
  if (/^[0-9a-fA-F]{6}$/.test(c)) return `#${c}`
  // Not hex -> a named colour. enum_colors is the full HTML/X11 name set (it
  // starts "AliceBlue", Cfile:387861; func_ParseColor lowercases before the
  // lookup, Cfile:574529-574551). CSS resolves the SAME names to the SAME
  // values case-insensitively, so 'black'/'white'/... pass straight through
  // (previously '#black' was emitted and silently dropped).
  return c.toLowerCase()
}
