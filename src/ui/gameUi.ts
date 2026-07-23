import { LuaHost } from '../lua/host'
import {
  installUiEngine,
  setupUi,
  setupGameUi,
  startFrontEnd,
  startSessionLoading,
  finishSessionLoading,
  createRootFrame,
  loadUiBlueprints,
  applySession,
} from '../lua/uiEngine'
import { MauiRenderer, type WorldViewRect } from './mauiRenderer'
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
import { translateKey } from './keys'
import type { GameVfs } from '../vfs/vfs'
import type { EcoSnapshot } from './hud'
import type { LuaUnitSnapshot } from '../sim/luaSimClient'
import type { SessionInfo } from '../sim/session'

/**
 * Die Spiel-UI — die ECHTE `lua/ui`, in einer eigenen Lua-VM im Main-Thread.
 *
 * Genau wie im Original: zwei Lua-States (docs/research/engine-api.md), die Sim
 * im Worker, die UI hier. Was hier passiert, ist nur Substrat — das Layout, die
 * Texte, die Farben und die Anzeigelogik kommen aus `lua/ui/game/economy.lua`
 * und ihren Layout-Dateien, nicht aus TypeScript.
 */
/** Where the settings are located in the browser (the counterpart to Game.prefs). */
const PREFS_KEY = 'ccfa.prefs'

export class GameUi {
  private knownUnits = new Set<number>()

  private constructor(
    private readonly host: LuaHost,
    private readonly renderer: MauiRenderer,
    private readonly log: (msg: string) => void,
    /**
     * Der aufgeschobene DoInitializing-Schritt (Cfile:1321030-1321090). Die
     * Engine fährt ihn erst nach dem ERSTEN Sim-Beat mit Sync-Daten
     * (Cfile:1321067) — beat() löst ihn aus, sobald Units ankommen.
     */
    private worldInit: (() => void) | null = null,
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
    /**
     * Die Engine hört zu, wenn eine ConVar sich ändert (ConExecute).
     * Kamera, Renderer und Auswahl lesen daraus ihre Werte — genau so, wie die
     * C++-Seite ui_KeyboardPanSpeed und cam_ZoomAmount in ihren Schleifen liest.
     */
    conVarChanged?: (name: string, value: string | number | boolean) => void,
    /**
     * Die laufende Session (dieselbe, die auch die Sim bekommt). Sie muss VOR
     * dem Bau der Panels stehen: avatars.lua:30 und tabs.lua:20 lesen
     * `GetArmiesTable()` bzw. `SessionGetScenarioInfo()` schon beim Import.
     */
    session?: SessionInfo,
  ): Promise<GameUi> {
    // The game's fonts (<GameDir>/fonts). They provide the metric with which
    // the original Lua calculates its text layout (text.lua:39/47) — and they will
    // rendered straight away instead of replacing it with a system font.
    const tStart = performance.now()
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

    // ALL .lua files, not just lua/**: Localization.lua loads the language file
    // from /loc/<language>/strings_db.lua (localization.lua:15) — which is located
    // outside of lua/. Anyone who filters here breaks the boat at one point
    // has nothing to do with the filter.
    // In addition, the .bp files: LoadBlueprints() runs them as Lua, and
    // `unitview.lua`/`construction.lua` need `__blueprints`.
    const bpPaths = mode === 'frontend' ? [] : vfs.find((p) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(p))
    // The unit SCRIPTS (`units/<id>/<id>_script.lua`) belong to the Sim, not the
    // UI: the engine loads it via `Blueprint.Script` when a unit is created —
    // not a single file under `lua/ui/**` imports any of them (checked).
    // They are scattered throughout units.scd (1 GB) and cost the UI boot alone
    // ~700 Archiv-Zugriffe.
    const luaPaths = [
      ...vfs.find((p) => p.endsWith('.lua') && !p.startsWith('units/')),
      ...bpPaths,
    ]
    // ONE access per archive area instead of two per file (vfs.readMany). The
    // Lua is located in small archives (lua.scd 7 MB, mohodata 0.5 MB) - they are on
    // Reading the piece costs nothing; reading them individually cost at launch
    // Seconds (and thousands of requests via HTTP).
    const files = await vfs.readMany(luaPaths)

    // The maui-Lua queries texture dimensions SYNCHRONOUSLY (GetTextureDimensions, because a
    // Bitmap is measured according to its DDS without layout helpers). The VFS reads
    // but asynchronously — so the dimensions of the UI textures are determined beforehand.
    const uiTextures = vfs.find((p) => p.startsWith('textures/ui/') && p.endsWith('.dds'))
    const dims = new Map<string, [number, number]>()
    {
      const bytes = await vfs.readMany(uiTextures)
      for (const [p, b] of bytes) {
        try {
          const dds = parseDds(b)
          dims.set(p, [dds.width, dds.height])
        } catch {
          // Broken/unknown DDS: don't guess — the Lua gets nil and the
          // Skin-Fallback greift.
        }
      }
    }
    log(`UI: ${files.size} Lua files, ${dims.size} texture dimensions`)

    const allPaths = new Set(vfs.find(() => true))
    const host = await LuaHost.create(files, (level, msg) => {
      if (level === 'WARN') log(`UI-WARN: ${msg.slice(0, 400)}`)
    })
    // The deferred DoInitializing step ('game' mode only, see below).
    let worldInit: (() => void) | null = null

    installUiEngine(host, {
      exists: (p) => allPaths.has(p),
      find: (dir, pattern) => findFiles(allPaths, dir, pattern),
      textureSize: (p) => dims.get(p) ?? null,
      stringAdvance: (text, family, size) => fonts.advance(text, family, size),
      fontMetrics: (family, size) => fonts.metrics(family, size),
      conVarChanged,
      // Settings survive reload. The engine writes them as
      // Lua source code to `Game.prefs` — here it's the same text, just the
      // Storage is localStorage. Without that, every option, every profile and
      // every volume returns to the beginning after the next call.
      prefs: {
        load: () => localStorage.getItem(PREFS_KEY),
        save: (luaText) => {
          try {
            localStorage.setItem(PREFS_KEY, luaText)
          } catch (e) {
            // Full/locked memory: say it, don't swallow it.
            log(`Prefs: could not be saved — ${e instanceof Error ? e.message : e}`)
          }
        },
      },
    })
    // Root frame FIRST, then SetupUI — that's how the engine does it
    // (CUIManager::SetNewLuaState: Frame Cfile:1273621-1273666, SetupUI erst
    // Cfile:1273680). The other way around, the import of is already tearing things apart
    // effecthelpers.lua, which calls GetFrame(0) at the module level (line 28).
    createRootFrame(host, window.innerWidth, window.innerHeight)

    if (mode === 'frontend') {
      // The main menu builds itself: startFrontEnd only calls the entry
      // Engine (EngineStartSplashScreens → splash.lua → EngineStartFrontEndUI →
      // uimain.StartFrontEndUI → menus/main.lua:CreateUI). SetupUI() läuft dabei
      // from __uiSetNewLuaState — just like in CUIManager::SetNewLuaState.
      startFrontEnd(host)
    } else {
      setupUi(host)

      // The blueprints belong in BOTH VMs: unitview.lua:180 reads
      // __blueprints[...], construction.lua:1681 asks EntityCategoryGetUnitList.
      const bpCount = loadUiBlueprints(host, bpPaths)
      log(`UI: ${bpCount} Blueprints geladen (echte Pipeline)`)

      // The SESSION is in front of the panels: avatars.lua:30 reads
      // `GetArmiesTable().armiesTable[GetFocusArmy()].faction` already at
      // Import, tabs.lua:20 `SessionGetScenarioInfo().Options.Timeouts`.
      if (session) applySession(host, session)

      // The world start, literally like the engine (func_DoPreload, Cfile:1320735):
      // StartGameUI → StartLoadingDialog. The loading dialog sets REAL
      // ConVars (UI_RenderUnitBars, UI_NisRenderIcons, ren_SelectBoxes —
      // gamemain.lua:217-219). The sim loads in parallel in the worker; the waiting time
      // at this point is zero in the browser.
      startSessionLoading(host)

      // DoInitializing (Cfile:1321030-1321090) does NOT run here, but first
      // after the FIRST sim beat with sync data (Cfile:1321067) — see beat().
      // The reason is not a timing detail, but semantics: gamemain.lua:77-102
      // (OnFirstUpdate) reads `GetArmyAvatars()` on the first frame and forks
      // a thread that calls `SelectUnits(avatars)` 3 s later. Is it running?
      // Setup BEFORE the first unit sync, avatars is nil - the fork deletes
      // then every selection made in the meantime, the start zoom (UIZoomTo)
      // is eliminated, and the ACU never gets its player name. That was exactly it
      // the “empty UI” finding (orders hidden, 0 construction icons).
      worldInit = () => {
        // SetNewLuaState clears the root frames (the loading dialog disappears),
        // SetupUI + StartGameUI run AGAIN (fresh provider), then
        // StopLoadingDialog — the faction image fades out over 1.5 s, and the
        // Original Lua forks InitialAnimations (gamemain.lua:253-263): first
        // THIS includes score, economy, avatars and the riders.
        host.eval('__mauiResetFrames()')
        host.eval('__uiSetupUi()')
        host.eval('__uiStartGameUI()')
        finishSessionLoading(host)

        // From here, the original Lua builds out the UI — in order
        // gamemain.lua:145-153; in the engine CreateGameInterface comes AFTER
        // StopLoadingDialog (Cfile:1321080). The Verify suite takes the same route.
        setupGameUi(host, log)
      }
    }

    // First render, then count - in this order: the grids of the
    // Original UI only exposes its children in OnFrame (grid.lua:40-48, the
    // Engine frame pump, Cfile:1118936). A snapshot BEFORE the first frame
    // sees it without a layout and wrongly reports it as broken.
    // The engine gets the STATUS of all ConVars - Apply(true) has it
    // The boat is set, and anyone who joins afterwards would never have it otherwise
    // gesehen.
    if (conVarChanged) {
      const all = host.pull<[string, string | number | boolean][]>(`(function()
        local out = {}
        for _, entry in pairs(__conVars) do
          if entry.value ~= nil then
            out[#out + 1] = '["' .. entry.name .. '",' ..
              (type(entry.value) == 'string' and ('"' .. entry.value .. '"') or tostring(entry.value)) .. ']'
          end
        end
        return '[' .. table.concat(out, ',') .. ']'
      end)()`)
      for (const [name, value] of all) conVarChanged(name, value)
    }

    const renderer = new MauiRenderer(host, vfs)
    renderer.update()
    const count = Number(host.eval('return table.getn(__mauiSnapshot())'))
    log(`UI: ${count} maui-Controls aus der Original-Lua (${Math.round(performance.now() - tStart)} ms)`)
    return new GameUi(host, renderer, log, worldInit)
  }

  /**
   * Ein Sim-Beat: Ökonomie in die UI-VM, dann die Original-`_BeatFunction`
   * (economy.lua:251) rechnen lassen. Sie schreibt den Text in die Controls.
   */
  beat(eco: EcoSnapshot, units: LuaUnitSnapshot[], gameTick = 0): void {
    // The state of the units in the UI VM (the engine reflects it on the client side:
    // UserUnit::UpdateUnitData @0x8C0750). Only then can the UI show it.
    const seen = new Set<number>()
    // ONE eval for the whole beat, not one per unit: every eval call
    // compiles its own Lua chunk. At 50 units and 10 beats/s would be
    // that 500 chunks per second — work that no one needs.
    const lines: string[] = []
    for (const u of units) {
      seen.add(u.id)
      lines.push(
        `__uiSetUnit(${u.id}, '${u.name}', ${u.army ?? 1}, ${u.x}, ${u.y}, ${u.z}, ` +
          `${u.health}, ${u.maxHealth}, ${u.fraction ?? 1}, ${u.idle === true})`,
      )
      // The build queue of a factory (construction.lua displays it).
      // ALWAYS send, even empty: otherwise the last queue remains in the UI copy
      // and the transition “last entry finished → empty” never arrives.
      const q = u.buildQueue ?? []
      const items = q.map((i) => `{ id = '${i.id}', count = ${i.count} }`).join(',')
      lines.push(`__uiSetBuildQueue(${u.id}, { ${items} })`)
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
    // The PLAY TIME (score.lua shows it as a clock; it stands still during break).
    lines.push(`__uiSetGameTick(${gameTick})`)
    // The BEAT DISTRIBUTOR of the original UI — not a single panel.
    //
    // The engine calls EXACTLY ONE Lua function per Sim beat:
    // Moho::UI_LuaBeat() → gamemain.OnBeat() (Cfile:1262940-1262967). There
    // ALL update functions registered via AddBeatFunction run:
    // economy._BeatFunction, avatars.AvatarUpdate (the ACU icon on the right!),
    // commandmode.OnCommandModeBeat, connectivity.PingUpdate, …
    //
    // Previously we called Economy._BeatFunction() DIRECTLY - this worked exactly
    // Panel, and all other registered beat functions remained dead.
    //
    // The queue guard runs BEFORE the Lua beat — same order as
    // CUIManager::DoBeat (Cfile:1273907-1273911: erst
    // UI_FactoryCommandQueueHandlerBeat, then UI_LuaBeat). He reports
    // Factory queue changes as gamemain.OnQueueChanged.
    lines.push(`__uiFactoryQueueBeat()`)
    lines.push(`import('/lua/ui/game/gamemain.lua').OnBeat()`)
    this.host.eval(lines.join('\n'))

    // The first beat MIT Units is the moment when the engine is DoInitializing
    // drives (Cfile:1321067: StopLoadingDialog “after the first beat
    // Sync data"). Only now does gamemain.OnFirstUpdate see its avatars -
    // previously its 3-s fork with `SelectUnits(nil)` deleted every selection.
    if (this.worldInit && units.length > 0) {
      const init = this.worldInit
      this.worldInit = null
      init()
      this.log('UI: DoInitializing nach dem ersten Sync-Beat (Cfile:1321067)')
    }
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

  /** How many units are currently selected (UI VM's GetSelectedUnits). */
  selectionCount(): number {
    return Number(this.host.eval('return table.getn(GetSelectedUnits() or {})'))
  }

  /** Debug ONLY (CDP Detects): evaluate a Lua expression in the UI VM. */
  debugEval(code: string): unknown {
    return this.host.eval(code)
  }

  /**
   * The armies' icon colors (ARGB hex) from the armiesTable — the field
   * cfunc_GetArmiesTableL publishes per army (Cfile:1267023-1267111),
   * sourced from /lua/gamecolors.lua ArmyColors. Strategic icons are
   * tinted with exactly this color.
   */
  armyIconColors(): Map<number, string> {
    const rows = this.host.pull<[number, string][]>(`(function()
      local parts = {}
      for i, a in ipairs(GetArmiesTable().armiesTable) do
        parts[#parts + 1] = '[' .. i .. ',"' .. tostring(a.iconColor) .. '"]'
      end
      return '[' .. table.concat(parts, ',') .. ']'
    end)()`)
    return new Map(rows)
  }

  /**
   * Die Weltansichten, die die Original-Lua gebaut hat — mit Lage und Größe.
   *
   * Im Original sind es echte Controls (CUIWorldView): die Hauptansicht
   * (gamemain.lua:142) und die Minimap (minimap.lua:115, `isMiniMap = true` →
   * kartografisch). Die 3D-Seite rendert IN diese Rechtecke; wo sie liegen,
   * entscheidet die Lua, nicht TypeScript. Genau deshalb lässt sich die Minimap
   * im Original verschieben.
   */
  worldViews(): WorldViewRect[] {
    return this.renderer.worldViews()
  }

  /** The unit under the mouse cursor (unitview.lua reads it via GetRolloverInfo). */
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
    // An error in an OnFrame script must not stop the image pump —
    // otherwise the entire surface will freeze after the first missing engine part
    // a. The engine does it the same way (CMauiControl::Frame → RunScript).
    try {
      this.renderer.update(delta)
    } catch (err) {
      this.reportUiError(err)
    }
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
    /** The picked unit under the cursor: enemy → Attack, own unfinished → Repair. */
    ziel: { enemy?: number; repair?: number } = {},
  ): Promise<string | null> {
    return worldClick(this.host, sim, hit, elevation, {
      queue,
      enemyTargetId: ziel.enemy,
      repairTargetId: ziel.repair,
    })
  }

  /** The current command mode (what the next click in the world does). */
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

  /** Cancel command mode - this is what the right click does in the original. */
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

  /** The seam for commands that go directly to a unit (SetFireState, SetPaused ...). */
  connectSim(send: (name: string, ids: number[], value: unknown) => void): void {
    this.host.setGlobal('__uiSimCommand', send)
  }

  /**
   * Die Naht für SimCallback (Cfile:1359123: „Execute a lua function in sim").
   * Args kommen als JSON-Snapshot (die UI-VM serialisiert wie SCR_ToByteStream),
   * die Auswahl als Entity-IDs — die Sim baut daraus Unit-Objekte.
   */
  connectSimCallback(send: (func: string, argsJson: string, ids: number[]) => void): void {
    this.host.setGlobal('__uiSimCallbackSink', send)
  }

  /**
   * Der Neustart der Session (RestartSession, Cfile:1263968: Teardown +
   * Neustart mit denselben Session-Infos). Erst mit dieser Naht wird
   * SessionCanRestart() wahr — ohne sie ist RestartSession ein No-Op,
   * exakt wie im Original bei nicht-restartbarer Session.
   */
  connectRestart(restart: () => void): void {
    this.host.setGlobal('__uiRestartSink', restart)
  }

  /**
   * The volume sink (CUserSoundManager::SetVolume forwards the raw float
   * to the audio engine, Cfile:1346194/603714). Values set BEFORE the sink
   * existed (options Apply during boot) are replayed once.
   */
  connectVolume(setVolume: (category: string, volume: number) => void): void {
    this.host.setGlobal('__uiVolumeSink', setVolume)
    const cached = this.host.pull<[string, number][]>(`(function()
      local parts = {}
      for k, v in pairs(__uiVolumes) do
        parts[#parts + 1] = '["' .. tostring(k) .. '",' .. tostring(v) .. ']'
      end
      return '[' .. table.concat(parts, ',') .. ']'
    end)()`)
    for (const [cat, vol] of cached) setVolume(cat, vol)
  }

  /**
   * Die Session anhalten/fortsetzen (SessionRequestPause/SessionResume,
   * mHelp: „Pause the world simulation."). Das ist ein Eingriff in die SIM,
   * nicht in die UI — der Pause-Reiter oben (tabs.lua:425/428) hängt daran.
   * Ohne diese Naht KNALLT SessionRequestPause, statt still nichts zu tun.
   */
  connectPause(pause: (paused: boolean) => void): void {
    this.host.setGlobal('__uiPauseSink', pause)
  }

  /** Mirror the session to the UI VM (see `applySession`). */
  setSession(info: SessionInfo, playerName?: string): void {
    applySession(this.host, info, playerName)
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
    // At ButtonRelease, `e.buttons` is already 0 - the pressed button is then there
    // only in `e.button`. Both together result in the modifiers
    // Original Lua expected.
    const down = e.buttons | (type === 'ButtonRelease' ? [1, 4, 2][e.button] ?? 0 : 0)
    const mods = `{ Shift = ${e.shiftKey}, Ctrl = ${e.ctrlKey}, Alt = ${e.altKey}, ` +
      `Left = ${(down & 1) !== 0}, Middle = ${(down & 4) !== 0}, Right = ${(down & 2) !== 0} }`
    // KeyCode of the mouse button (Windows-VK: 1 = left, 2 = right, 4 = middle). The
    // Dragger remembers it at ButtonPress (button.lua:160 PostDragger) and
    // only ends when EXACTLY this button is released.
    const keyCode = [1, 4, 2][e.button] ?? 0
    const call =
      type === 'WheelRotation'
        ? `return __mauiWheel(${e.clientX}, ${e.clientY}, ${-(e as WheelEvent).deltaY}, ${mods})`
        : `return __mauiMouse('${type}', ${e.clientX}, ${e.clientY}, ${mods}, ${keyCode})`
    try {
      return this.host.eval(call) === true
    } catch (err) {
      // An error in a UI script should not turn off the mouse. The engine
      // does the same: CMauiControl::HandleEvent calls the Lua HandleEvent
      // RunScript, an error is logged and the program continues to run.
      // Without that, the first missing engine part tore (clicking on the
      // Sound tab → GetVolume) includes the entire operation.
      //
      // The event is considered CONSUMED: it hit a control (otherwise it would be
      // no script ran) — it may not also be released into the world as a click.
      this.reportUiError(err)
      return true
    }
  }

  private readonly seenErrors = new Set<string>()
  /** Report each different Lua error EXACTLY ONCE — not 60 times per second. */
  private reportUiError(err: unknown): void {
    const msg = (err instanceof Error ? err.message : String(err))
      .replace(/\[string "[\s\S]*?"\]/g, '')
      .split('\n')[0]!
      .slice(0, 300)
    if (this.seenErrors.has(msg)) return
    this.seenErrors.add(msg)
    this.log(`UI-FEHLER: ${msg}`)
  }

  /**
   * Hängt die Event-Pump an. Capture-Phase: verbraucht die UI das Event, wird es
   * gestoppt, bevor die Kamera-/Selektions-Handler des Viewers es sehen.
   */
  /**
   * Die Audio-Ausgabe anschließen: StartSound ruft __uiAudioSink(bank, cue,
   * id), StopSound __uiAudioStopSink(id) — ohne Sink protokolliert die UI-VM
   * die Cues nur (ui-globals.lua, __uiSoundsRequested).
   */
  connectAudio(play: (bank: string, cue: string, id: number) => void, stop: (id: number) => void): void {
    this.host.setGlobal('__uiAudioSink', (bank: string, cue: string, id: number) => play(bank, cue, id))
    this.host.setGlobal('__uiAudioStopSink', (id: number) => stop(id))
  }

  /**
   * Click-feedback blips (AddCommandFeedbackBlip, commandmode.lua:133) —
   * the renderer receives the flat spec and spawns the short-lived mesh.
   */
  connectCommandFeedback(
    sink: (
      meshName: string,
      blueprintId: string,
      textureName: string,
      shaderName: string,
      uniformScale: number,
      x: number,
      y: number,
      z: number,
      duration: number,
    ) => void,
  ): void {
    this.host.setGlobal('__uiBlipSink', sink)
  }

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
    // The modifier keys for IsKeyDown (mHelp Cfile:1141963) — the
    // Original UI asks 'Shift' (commandmode.lua:82: Shift holds the
    // Command mode open after the first command → build queue).
    // Names as in the EMauiKeyCode enum that resolves SCR_GetEnum.
    const meldeTaste = (e: KeyboardEvent, down: boolean): void => {
      const name = e.key === 'Shift' ? 'Shift' : e.key === 'Control' ? 'Control' : e.key === 'Alt' ? 'Alt' : null
      if (name) this.host.eval(`__uiSetKeyDown('${name}', ${down})`)
    }

    // The engine's KEYBOARD path (wxWndProc @0x96D090 → maui-Dispatch →
    // CUIKeyHandler), traced from the browser event:
    //   1. KeyDown an __mauiKey (Fokus-Control / Capture-Top). Konsumiert →
    //      the following character is SWALLOWED (bit 8 semantics,
    //      Cfile:1499710-1499717).
    //   2. Not consumed → Keymap executor (__uiKeyMapExecute): Hotkeys
    //      from keymapper.lua via ConExecute; Fallbacks Enter→Chat, ~→Console.
    //   3. Char (real or synthesized from the KeyDown, keys.ts).
    //      __mauiKey — Edit fields only get their characters via this
    //      (CMauiEdit only responds to MET_Char,
    //      Cfile:1132299-1132318).
    const mods = (e: KeyboardEvent): string =>
      `{ ${[e.shiftKey && 'Shift = true', e.ctrlKey && 'Ctrl = true', e.altKey && 'Alt = true']
        .filter(Boolean)
        .join(', ')} }`
    target.addEventListener(
      'keydown',
      (e) => {
        meldeTaste(e, true)
        const k = translateKey(e)
        if (!k) return
        const m = mods(e)
        const consumed =
          this.host.eval(`return __mauiKey('KeyDown', ${k.wx}, ${k.vk}, ${m})`) === true
        let acted = consumed
        if (!consumed) {
          // '~' reaches the console in the original via the char code 126
          // (Cfile:1262747) — the key itself is VK 0xC0.
          const mauiCode = e.key === '~' ? 126 : k.wx
          acted =
            this.host.eval(
              `return __uiKeyMapExecute(${k.vk}, ${e.shiftKey}, ${e.ctrlKey}, ${e.altKey}, ${e.repeat}, ${mauiCode})`,
            ) === true
          if (k.charCode !== null) {
            this.host.eval(`__mauiKey('Char', ${k.charCode}, ${k.vk}, ${m})`)
          }
        }
        if (acted) {
          e.preventDefault()
          e.stopPropagation()
        }
      },
      true,
    )
    target.addEventListener(
      'keyup',
      (e) => {
        meldeTaste(e, false)
        const k = translateKey(e)
        if (k) this.host.eval(`__mauiKey('KeyUp', ${k.wx}, ${k.vk}, ${mods(e)})`)
      },
      true,
    )
    // Window leaves focus → no key is considered held anymore (otherwise
    // klemmt Shift nach Alt+Tab dauerhaft).
    target.addEventListener('blur', () => {
      this.host.eval(`__uiSetKeyDown('Shift', false) __uiSetKeyDown('Control', false) __uiSetKeyDown('Alt', false)`)
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
