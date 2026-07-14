import { LuaHost } from '../lua/host'
import { installUiEngine, setupUi, createRootFrame, loadUiBlueprints } from '../lua/uiEngine'
import { MauiRenderer } from './mauiRenderer'
import { findFiles } from '../vfs/glob'
import { parseDds } from '../formats/dds'
import type { GameVfs } from '../vfs/vfs'
import type { EcoSnapshot } from './hud'
import type { LuaUnitSnapshot } from '../sim/luaSimClient'

/**
 * Die Spiel-UI — die ECHTE `lua/ui`, in einer eigenen Lua-VM im Main-Thread.
 *
 * Genau wie im Original: zwei Lua-States (docs/research/engine-api.md), die Sim
 * im Worker, die UI hier. Was hier passiert, ist nur Substrat — das Layout, die
 * Texte, die Farben und die Anzeigelogik kommen aus `lua/ui/game/economy.lua`
 * und ihren Layout-Dateien, nicht aus TypeScript.
 */
export class GameUi {
  private knownUnits = new Set<number>()

  private constructor(
    private readonly host: LuaHost,
    private readonly renderer: MauiRenderer,
  ) {}

  static async create(vfs: GameVfs, log: (msg: string) => void): Promise<GameUi> {
    // ALLE .lua-Dateien, nicht nur lua/**: Localization.lua lädt die Sprachdatei
    // aus /loc/<sprache>/strings_db.lua (localization.lua:15) — die liegt
    // außerhalb von lua/. Wer hier filtert, bricht den Boot an einer Stelle, die
    // nichts mit dem Filter zu tun hat.
    // Dazu die .bp-Dateien: LoadBlueprints() führt sie als Lua aus, und
    // `unitview.lua`/`construction.lua` brauchen `__blueprints`.
    const bpPaths = vfs.find((p) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(p))
    const luaPaths = [...vfs.find((p) => p.endsWith('.lua')), ...bpPaths]
    const files = new Map<string, Uint8Array>()
    const BATCH = 64
    for (let i = 0; i < luaPaths.length; i += BATCH) {
      const batch = luaPaths.slice(i, i + BATCH)
      const bytes = await Promise.all(batch.map((p) => vfs.read(p)))
      batch.forEach((p, j) => files.set(p, bytes[j]!))
    }

    // Die maui-Lua fragt Texturmaße SYNCHRON ab (GetTextureDimensions, weil ein
    // Bitmap sich ohne Layout-Helfer nach seiner DDS bemisst). Das VFS liest
    // aber asynchron — also werden die Maße der UI-Texturen vorher ermittelt.
    const uiTextures = vfs.find((p) => p.startsWith('textures/ui/') && p.endsWith('.dds'))
    const dims = new Map<string, [number, number]>()
    for (let i = 0; i < uiTextures.length; i += BATCH) {
      const batch = uiTextures.slice(i, i + BATCH)
      const bytes = await Promise.all(batch.map((p) => vfs.read(p)))
      batch.forEach((p, j) => {
        try {
          const dds = parseDds(bytes[j]!)
          dims.set(p, [dds.width, dds.height])
        } catch {
          // Kaputte/unbekannte DDS: nicht raten — die Lua bekommt nil und der
          // Skin-Fallback greift.
        }
      })
    }
    log(`UI: ${files.size} Lua-Dateien, ${dims.size} Texturmaße`)

    const allPaths = new Set(vfs.find(() => true))
    const host = await LuaHost.create(files, (level, msg) => {
      if (level === 'WARN') log(`UI-WARN: ${msg.slice(0, 90)}`)
    })

    installUiEngine(host, {
      exists: (p) => allPaths.has(p),
      find: (dir, pattern) => findFiles(allPaths, dir, pattern),
      textureSize: (p) => dims.get(p) ?? null,
      stringAdvance: (text, family, size) => measureText(text, family, size),
      fontMetrics: (family, size) => fontMetrics(family, size),
    })
    setupUi(host)
    createRootFrame(host, window.innerWidth, window.innerHeight)

    // Die Blueprints gehören in BEIDE VMs: unitview.lua:180 liest
    // __blueprints[...], construction.lua:1681 fragt EntityCategoryGetUnitList.
    const bpCount = loadUiBlueprints(host, bpPaths)
    log(`UI: ${bpCount} Blueprints geladen (echte Pipeline)`)

    // Ab hier baut die Original-Lua die UI — in der Reihenfolge aus
    // gamemain.lua:145-153.
    host.eval(`
      Economy = import('/lua/ui/game/economy.lua')
      Economy.CreateEconomyBar(GetFrame(0))
    `)
    // Orders, Bau-Menü, Unit-View — dieselben Aufrufe wie gamemain.lua:145-153.
    //
    // Die Handles leben in einer TABELLE, nicht in Globals: `x = nil` legt
    // unter dem strengen _G (config.lua:56) keinen Schlüssel an, und der
    // spätere Lesezugriff wirft dann "access to nonexistent global variable".
    // In gamemain sind das `local`s — Tabellenfelder sind das Äquivalent, das
    // über mehrere eval-Aufrufe hinweg hält.
    host.eval('__ui = {}')
    for (const [name, code] of [
      // gamemain.lua:148 — Orders und Construction positionieren sich am
      // Multifunction-Display; ohne das fehlt ihnen der Bezugspunkt.
      ['multifunction', `__ui.mfd = import('/lua/ui/game/multifunction.lua').Create(GetFrame(0))`],
      ['orders', `Orders = import('/lua/ui/game/orders.lua')
                  __ui.orders = Orders.SetupOrdersControl(GetFrame(0), __ui.mfd)`],
      ['construction', `import('/lua/ui/game/construction.lua')
                    .SetupConstructionControl(GetFrame(0), __ui.mfd, __ui.orders)`],
      ['unitview', `import('/lua/ui/game/unitview.lua')
                    .SetupUnitViewLayout(GetFrame(0), __ui.orders)`],
    ] as const) {
      try {
        host.eval(code)
        log(`UI: ${name}.lua läuft`)
      } catch (e) {
        // Ohne das Abschneiden des [string "…"]-Präfixes verschluckt die
        // Ausgabe die eigentliche Lua-Meldung.
        const msg = (e as Error).message.replace(/\[string "[\s\S]*?"\]/g, '').split('\n')[0]
        log(`UI: ${name}.lua NOCH NICHT — ${msg?.slice(0, 150)}`)
      }
    }

    // Ab jetzt gibt es Empfänger für Selektions-Ereignisse (im Original
    // registriert die Engine den SelectionListener erst beim Session-Start).
    host.eval('__uiSessionActive = true')

    const count = Number(host.eval('return table.getn(__mauiSnapshot())'))
    log(`UI: ${count} maui-Controls aus der Original-Lua`)

    const renderer = new MauiRenderer(host, vfs)
    renderer.update()
    return new GameUi(host, renderer)
  }

  /**
   * Ein Sim-Beat: Ökonomie in die UI-VM, dann die Original-`_BeatFunction`
   * (economy.lua:251) rechnen lassen. Sie schreibt den Text in die Controls.
   */
  beat(eco: EcoSnapshot, units: LuaUnitSnapshot[]): void {
    // Der Zustand der Units in die UI-VM (die Engine spiegelt ihn clientseitig:
    // UserUnit::UpdateUnitData @0x8C0750). Erst danach kann die UI ihn zeigen.
    const seen = new Set<number>()
    for (const u of units) {
      seen.add(u.id)
      this.host.eval(
        `__uiSetUnit(${u.id}, '${u.name}', 1, ${u.x}, ${u.y}, ${u.z}, ` +
          `${u.health}, ${u.maxHealth}, ${u.fraction ?? 1}, ${!u.moving})`,
      )
    }
    for (const id of this.knownUnits) {
      if (!seen.has(id)) this.host.eval(`__uiRemoveUnit(${id})`)
    }
    this.knownUnits = seen

    this.host.eval(`__uiSetEconomy(
      ${eco.massStorage}, ${eco.energyStorage},
      ${eco.mass}, ${eco.energy},
      ${eco.massIncome}, ${eco.energyIncome},
      ${eco.massRequested}, ${eco.energyRequested},
      ${eco.massExpense}, ${eco.energyExpense})`)
    this.host.eval('Economy._BeatFunction()')
  }

  /**
   * Auswahl setzen. Das Picking (Maus → Unit) macht die Engine; die UI-VM
   * baut daraus UserUnits, ruft `SelectUnits` und damit
   * `gamemain.OnSelectionChanged` — genau die Kette aus
   * Moho::SelectionListener::Receive (Cfile:1294170).
   */
  select(ids: number[]): number {
    const list = ids.join(',')
    return Number(this.host.eval(`return __uiSelectByIds({ ${list} })`))
  }

  /** Die Unit unter dem Mauszeiger (unitview.lua liest sie über GetRolloverInfo). */
  setRollover(id: number | null): void {
    this.host.eval(id === null ? '__uiSetRollover(nil)' : `__uiSetRollover(${id})`)
  }

  /** Pro Frame: den maui-Baum ins DOM schreiben. */
  render(): void {
    this.renderer.update()
  }

  /**
   * Maus-Events in die UI-VM. Der Hit-Test und das Bubbling laufen dort — nicht
   * im DOM (CMauiControl::HandleEvent, Cfile:1124525: liefert Lua `false`, geht
   * das Event die Parent-Kette hoch).
   *
   * Liefert `true`, wenn die UI das Event verbraucht hat. Dann darf es NICHT
   * mehr an die Spielwelt gehen — ein Klick auf einen Button ist kein
   * Bewegungsbefehl.
   */
  private handleMouse(type: string, e: MouseEvent | WheelEvent): boolean {
    const mods = `{ Shift = ${e.shiftKey}, Ctrl = ${e.ctrlKey}, Alt = ${e.altKey}, ` +
      `Left = ${(e.buttons & 1) !== 0}, Middle = ${(e.buttons & 4) !== 0}, Right = ${(e.buttons & 2) !== 0} }`
    const call =
      type === 'WheelRotation'
        ? `return __mauiWheel(${e.clientX}, ${e.clientY}, ${-(e as WheelEvent).deltaY}, ${mods})`
        : `return __mauiMouse('${type}', ${e.clientX}, ${e.clientY}, ${mods})`
    return this.host.eval(call) === true
  }

  /**
   * Hängt die Event-Pump an. Capture-Phase: verbraucht die UI das Event, wird es
   * gestoppt, bevor die Kamera-/Selektions-Handler des Viewers es sehen.
   */
  attachEvents(target: Window = window): void {
    const consume = (type: string) => (e: MouseEvent | WheelEvent) => {
      if (this.handleMouse(type, e)) {
        e.stopPropagation()
        e.preventDefault()
      }
    }
    target.addEventListener('pointermove', consume('MouseMotion') as EventListener, true)
    target.addEventListener('pointerdown', consume('ButtonPress') as EventListener, true)
    target.addEventListener('pointerup', consume('ButtonRelease') as EventListener, true)
    target.addEventListener('dblclick', consume('ButtonDClick') as EventListener, true)
    target.addEventListener('wheel', consume('WheelRotation') as EventListener, {
      capture: true,
      passive: false,
    })
  }

  dispose(): void {
    this.renderer.dispose()
    this.host.close()
  }
}

/**
 * Textbreite (CMauiText::GetStringAdvance). Die Engine misst mit der echten
 * Schrift; der Browser kann das über Canvas — mit denselben TTFs aus
 * `<GameDir>/fonts`, sobald die geladen sind.
 */
let ctx: CanvasRenderingContext2D | null = null
function context(family: string, size: number): CanvasRenderingContext2D | null {
  if (!ctx) ctx = document.createElement('canvas').getContext('2d')
  if (ctx) ctx.font = `${size}px ${family || 'sans-serif'}`
  return ctx
}

function measureText(text: string, family: string, size: number): number {
  const c = context(family, size)
  return c ? c.measureText(text).width : 0
}

/**
 * Ober-/Unterlänge — text.lua:39 macht daraus die Höhe eines Text-Controls
 * (die Engine liefert sie aus der Schrift, Cfile:1145928).
 */
function fontMetrics(family: string, size: number): [number, number] {
  const c = context(family, size)
  if (!c) return [size, 0]
  const m = c.measureText('Hg')
  return [m.fontBoundingBoxAscent || size * 0.8, m.fontBoundingBoxDescent || size * 0.2]
}
