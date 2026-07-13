import { LuaHost } from '../lua/host'
import { installUiEngine, setupUi, createRootFrame } from '../lua/uiEngine'
import { MauiRenderer } from './mauiRenderer'
import { findFiles } from '../vfs/glob'
import { parseDds } from '../formats/dds'
import type { GameVfs } from '../vfs/vfs'
import type { EcoSnapshot } from './hud'

/**
 * Die Spiel-UI — die ECHTE `lua/ui`, in einer eigenen Lua-VM im Main-Thread.
 *
 * Genau wie im Original: zwei Lua-States (docs/research/engine-api.md), die Sim
 * im Worker, die UI hier. Was hier passiert, ist nur Substrat — das Layout, die
 * Texte, die Farben und die Anzeigelogik kommen aus `lua/ui/game/economy.lua`
 * und ihren Layout-Dateien, nicht aus TypeScript.
 */
export class GameUi {
  private constructor(
    private readonly host: LuaHost,
    private readonly renderer: MauiRenderer,
  ) {}

  static async create(vfs: GameVfs, log: (msg: string) => void): Promise<GameUi> {
    // ALLE .lua-Dateien, nicht nur lua/**: Localization.lua lädt die Sprachdatei
    // aus /loc/<sprache>/strings_db.lua (localization.lua:15) — die liegt
    // außerhalb von lua/. Wer hier filtert, bricht den Boot an einer Stelle, die
    // nichts mit dem Filter zu tun hat.
    const luaPaths = vfs.find((p) => p.endsWith('.lua'))
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

    // Ab hier baut die Original-Lua die UI.
    host.eval(`
      Economy = import('/lua/ui/game/economy.lua')
      Economy.CreateEconomyBar(GetFrame(0))
    `)
    const count = Number(host.eval('return table.getn(__mauiSnapshot())'))
    log(`UI: economy.lua läuft (Original, kein Nachbau) — ${count} maui-Controls`)

    const renderer = new MauiRenderer(host, vfs)
    renderer.update()
    return new GameUi(host, renderer)
  }

  /**
   * Ein Sim-Beat: Ökonomie in die UI-VM, dann die Original-`_BeatFunction`
   * (economy.lua:251) rechnen lassen. Sie schreibt den Text in die Controls.
   */
  beat(eco: EcoSnapshot): void {
    this.host.eval(`__uiSetEconomy(
      ${eco.massStorage}, ${eco.energyStorage},
      ${eco.mass}, ${eco.energy},
      ${eco.massIncome}, ${eco.energyIncome},
      ${eco.massRequested}, ${eco.energyRequested},
      ${eco.massExpense}, ${eco.energyExpense})`)
    this.host.eval('Economy._BeatFunction()')
  }

  /** Pro Frame: den maui-Baum ins DOM schreiben. */
  render(): void {
    this.renderer.update()
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
