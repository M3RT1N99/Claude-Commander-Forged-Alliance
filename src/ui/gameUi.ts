import { LuaHost } from '../lua/host'
import {
  installUiEngine,
  setupUi,
  setupGameUi,
  startFrontEnd,
  createRootFrame,
  loadUiBlueprints,
} from '../lua/uiEngine'
import { MauiRenderer } from './mauiRenderer'
import { findFiles } from '../vfs/glob'
import { parseDds } from '../formats/dds'
import { FontBook } from './fonts'
import {
  worldClick,
  getCommandMode,
  footprintOf,
  type CommandMode,
  type WorldCommandSim,
} from './worldCommands'
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

  /**
   * @param mode `'game'` baut die Spiel-UI (gamemain.lua:145-153), `'frontend'`
   *   das Hauptmenü (uimain.StartFrontEndUI → menus/main.lua). Beide laufen in
   *   DERSELBEN VM — die Engine hat genau eine UI-VM (USER_GetLuaState ist ein
   *   Singleton, Cfile:1368027); was wechselt, ist nur der Zustand.
   */
  static async create(
    vfs: GameVfs,
    fontFiles: Uint8Array[],
    log: (msg: string) => void,
    mode: 'game' | 'frontend' = 'game',
  ): Promise<GameUi> {
    // Die Schriften des Spiels (<GameDir>/fonts). Sie liefern die Metrik, mit der
    // die Original-Lua ihr Text-Layout rechnet (text.lua:39/47) — und sie werden
    // gleich auch gerendert, statt sie durch eine Systemschrift zu ersetzen.
    const fonts = new FontBook()
    for (const bytes of fontFiles) {
      try {
        const family = fonts.add(bytes)
        registerBrowserFont(family, bytes)
      } catch (e) {
        log(`UI: Schrift nicht lesbar — ${e instanceof Error ? e.message : e}`)
      }
    }
    log(`UI: ${fonts.size} Schriften aus <GameDir>/fonts`)

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
      if (level === 'WARN') log(`UI-WARN: ${msg.slice(0, 400)}`)
    })

    installUiEngine(host, {
      exists: (p) => allPaths.has(p),
      find: (dir, pattern) => findFiles(allPaths, dir, pattern),
      textureSize: (p) => dims.get(p) ?? null,
      stringAdvance: (text, family, size) => fonts.advance(text, family, size),
      fontMetrics: (family, size) => fonts.metrics(family, size),
    })
    // Root-Frame ZUERST, dann SetupUI — so macht es die Engine
    // (CUIManager::SetNewLuaState: Frame Cfile:1273621-1273666, SetupUI erst
    // Cfile:1273680). Andersherum zerreißt schon der Import von
    // effecthelpers.lua, das auf Modulebene GetFrame(0) ruft (Zeile 28).
    createRootFrame(host, window.innerWidth, window.innerHeight)

    if (mode === 'frontend') {
      // Das Hauptmenü baut sich selbst: startFrontEnd ruft nur den Einstieg der
      // Engine (EngineStartSplashScreens → splash.lua → EngineStartFrontEndUI →
      // uimain.StartFrontEndUI → menus/main.lua:CreateUI). SetupUI() läuft dabei
      // aus __uiSetNewLuaState heraus — genau wie in CUIManager::SetNewLuaState.
      startFrontEnd(host)
    } else {
      setupUi(host)

      // Die Blueprints gehören in BEIDE VMs: unitview.lua:180 liest
      // __blueprints[...], construction.lua:1681 fragt EntityCategoryGetUnitList.
      const bpCount = loadUiBlueprints(host, bpPaths)
      log(`UI: ${bpCount} Blueprints geladen (echte Pipeline)`)

      // Ab hier baut die Original-Lua die UI — in der Reihenfolge aus
      // gamemain.lua:145-153. Denselben Weg nimmt die Verify-Suite.
      setupGameUi(host, log)
    }

    // Erst rendern, dann zählen — und zwar in dieser Reihenfolge: die Grids der
    // Original-UI legen ihre Kinder erst in OnFrame aus (grid.lua:40-48, die
    // Frame-Pumpe der Engine, Cfile:1118936). Ein Snapshot VOR dem ersten Frame
    // sieht sie ohne Layout und meldet sie zu Unrecht als kaputt.
    const renderer = new MauiRenderer(host, vfs)
    renderer.update()
    const count = Number(host.eval('return table.getn(__mauiSnapshot())'))
    log(`UI: ${count} maui-Controls aus der Original-Lua`)
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
    // EIN eval für den ganzen Beat, nicht eines pro Unit: jeder eval-Aufruf
    // kompiliert einen eigenen Lua-Chunk. Bei 50 Einheiten und 10 Beats/s wären
    // das 500 Chunks pro Sekunde — Arbeit, die niemand braucht.
    const lines: string[] = []
    for (const u of units) {
      seen.add(u.id)
      lines.push(
        `__uiSetUnit(${u.id}, '${u.name}', 1, ${u.x}, ${u.y}, ${u.z}, ` +
          `${u.health}, ${u.maxHealth}, ${u.fraction ?? 1}, ${!u.moving})`,
      )
      // Die Bau-Warteschlange einer Fabrik (construction.lua zeigt sie an).
      const q = u.buildQueue ?? []
      if (q.length > 0) {
        const items = q.map((i) => `{ id = '${i.id}', count = ${i.count} }`).join(',')
        lines.push(`__uiSetBuildQueue(${u.id}, { ${items} })`)
      }
    }
    for (const id of this.knownUnits) {
      if (!seen.has(id)) lines.push(`__uiRemoveUnit(${id})`)
    }
    this.knownUnits = seen

    lines.push(`__uiSetEconomy(
      ${eco.massStorage}, ${eco.energyStorage},
      ${eco.mass}, ${eco.energy},
      ${eco.massIncome}, ${eco.energyIncome},
      ${eco.massRequested}, ${eco.energyRequested},
      ${eco.massExpense}, ${eco.energyExpense})`)
    lines.push('Economy._BeatFunction()')
    this.host.eval(lines.join('\n'))
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

  /**
   * Pro Bild: die Frame-Pumpe der Engine laufen lassen (OnFrame auf jedem
   * Control mit SetNeedsFrameUpdate, Cfile:1118936) und den maui-Baum ins DOM
   * schreiben. `delta` ist die echte Zeit seit dem letzten Bild — die UI-VM hat
   * KEINEN Tick-Scheduler, ihre Threads laufen mit den Bildern (userinit.lua:13-21).
   */
  render(delta = 1 / 60): void {
    this.renderer.update(delta)
  }

  /**
   * Fenstergröße geändert → der Root-Frame zieht nach.
   *
   * Die Engine tut genau das: `GetFrame(0)` trägt die Fenstermaße, und das
   * ganze Layout der Original-UI hängt daran (die Panels rechnen gegen
   * `gameParent`, das den Frame füllt). Ohne diesen Schritt bleibt die UI auf
   * der Größe stehen, die beim Start galt — und sitzt nach dem Umschalten in
   * den Vollbild-Spielmodus an der falschen Stelle.
   */
  resize(width: number, height: number): void {
    this.host.eval(`
      local f = GetFrame(0)
      f.Width:Set(${Math.max(1, Math.round(width))})
      f.Height:Set(${Math.max(1, Math.round(height))})
    `)
    this.renderer.update()
  }

  /**
   * Ein Klick in die Welt. Was er bedeutet, steht in `commandmode.lua` — die
   * Engine fragt dort nach (src/ui/worldCommands.ts), sie entscheidet nicht.
   */
  worldClick(
    sim: WorldCommandSim,
    hit: { x: number; z: number },
    elevation: (x: number, z: number) => number,
    queue = false,
  ): Promise<string | null> {
    return worldClick(this.host, sim, hit, elevation, { queue })
  }

  /** Der aktuelle Command-Mode (was der nächste Klick in der Welt tut). */
  commandMode(): CommandMode {
    return getCommandMode(this.host)
  }

  /**
   * Die ganzzahligen Footprint-Maße eines Blueprints (`Footprint.SizeX/SizeZ`).
   * Dieselben Zahlen, mit denen die Engine das Gebäude aufs Raster setzt — die
   * Bau-Vorschau kann also nicht von der Platzierung abweichen.
   */
  footprint(blueprintId: string): [number, number] {
    return footprintOf(this.host, blueprintId)
  }

  /** Command-Mode abbrechen — das tut im Original der Rechtsklick. */
  cancelCommandMode(): void {
    this.host.eval(`import('/lua/ui/game/commandmode.lua').EndCommandMode(true)`)
  }

  /**
   * Command-Mode starten. Im Original ist das ein Konsolenbefehl — die
   * Tastenbelegung ruft ihn genau so auf (`StartCommandMode order RULEUCC_Move`,
   * keymap/keyactions.lua:218), und die Bau-Icons rufen dieselbe Lua-Funktion.
   */
  startCommandMode(mode: 'order' | 'build' | 'buildanchored', name: string): void {
    this.host.eval(
      `import('/lua/ui/game/commandmode.lua').StartCommandMode('${mode}', { name = '${name}' })`,
    )
  }

  /**
   * Ein Befehl mit einem Blueprint als Ziel — der Weg, den die Original-UI für
   * die Fabrik-Warteschlange nimmt (construction.lua:884). Er läuft durch
   * dieselbe Lua-Funktion, die ein Klick aufs Bau-Icon auslöst.
   */
  issueBlueprintCommand(command: string, blueprintId: string, count = 1): void {
    this.host.eval(`IssueBlueprintCommand('${command}', '${blueprintId}', ${count}, false)`)
  }

  /** Die Naht für Befehle, die direkt an eine Unit gehen (SetFireState, SetPaused …). */
  connectSim(send: (name: string, ids: number[], value: unknown) => void): void {
    this.host.setGlobal('__uiSimCommand', send)
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
    // Bei ButtonRelease ist `e.buttons` schon 0 — die gedrückte Taste steht dann
    // nur noch in `e.button`. Beides zusammen ergibt die Modifiers, die die
    // Original-Lua erwartet.
    const down = e.buttons | (type === 'ButtonRelease' ? [1, 4, 2][e.button] ?? 0 : 0)
    const mods = `{ Shift = ${e.shiftKey}, Ctrl = ${e.ctrlKey}, Alt = ${e.altKey}, ` +
      `Left = ${(down & 1) !== 0}, Middle = ${(down & 4) !== 0}, Right = ${(down & 2) !== 0} }`
    // KeyCode der Maustaste (Windows-VK: 1 = links, 2 = rechts, 4 = mitte). Der
    // Dragger merkt sich ihn beim ButtonPress (button.lua:160 PostDragger) und
    // beendet sich erst, wenn GENAU diese Taste losgelassen wird.
    const keyCode = [1, 4, 2][e.button] ?? 0
    const call =
      type === 'WheelRotation'
        ? `return __mauiWheel(${e.clientX}, ${e.clientY}, ${-(e as WheelEvent).deltaY}, ${mods})`
        : `return __mauiMouse('${type}', ${e.clientX}, ${e.clientY}, ${mods}, ${keyCode})`
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
 * Die Schrift auch im Browser verfügbar machen — dieselbe TTF-Datei, die die
 * Metrik geliefert hat. Sonst rechnet das Layout mit "Zeroes Three" und der
 * Browser zeichnet eine Ersatzschrift: zwei Wahrheiten, die auseinanderlaufen.
 */
function registerBrowserFont(family: string, bytes: Uint8Array): void {
  if (typeof FontFace === 'undefined') return
  const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const face = new FontFace(family, buf as ArrayBuffer)
  void face.load().then((f) => document.fonts.add(f))
}
