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
/** Wo die Einstellungen im Browser liegen (das Gegenstück zu Game.prefs). */
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
    // Die Schriften des Spiels (<GameDir>/fonts). Sie liefern die Metrik, mit der
    // die Original-Lua ihr Text-Layout rechnet (text.lua:39/47) — und sie werden
    // gleich auch gerendert, statt sie durch eine Systemschrift zu ersetzen.
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

    // ALLE .lua-Dateien, nicht nur lua/**: Localization.lua lädt die Sprachdatei
    // aus /loc/<sprache>/strings_db.lua (localization.lua:15) — die liegt
    // außerhalb von lua/. Wer hier filtert, bricht den Boot an einer Stelle, die
    // nichts mit dem Filter zu tun hat.
    // Dazu die .bp-Dateien: LoadBlueprints() führt sie als Lua aus, und
    // `unitview.lua`/`construction.lua` brauchen `__blueprints`.
    const bpPaths = mode === 'frontend' ? [] : vfs.find((p) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(p))
    // Die Unit-SKRIPTE (`units/<id>/<id>_script.lua`) gehören der Sim, nicht der
    // UI: die Engine lädt sie über `Blueprint.Script`, wenn eine Unit entsteht —
    // keine einzige Datei unter `lua/ui/**` importiert eine davon (geprüft).
    // Sie liegen verstreut in units.scd (1 GB) und kosteten den UI-Boot allein
    // ~700 Archiv-Zugriffe.
    const luaPaths = [
      ...vfs.find((p) => p.endsWith('.lua') && !p.startsWith('units/')),
      ...bpPaths,
    ]
    // EIN Zugriff pro Archiv-Bereich statt zwei pro Datei (vfs.readMany). Die
    // Lua liegt in kleinen Archiven (lua.scd 7 MB, mohodata 0,5 MB) — sie am
    // Stück zu lesen kostet nichts; sie einzeln zu lesen kostete beim Start
    // Sekunden (und über HTTP tausende Requests).
    const files = await vfs.readMany(luaPaths)

    // Die maui-Lua fragt Texturmaße SYNCHRON ab (GetTextureDimensions, weil ein
    // Bitmap sich ohne Layout-Helfer nach seiner DDS bemisst). Das VFS liest
    // aber asynchron — also werden die Maße der UI-Texturen vorher ermittelt.
    const uiTextures = vfs.find((p) => p.startsWith('textures/ui/') && p.endsWith('.dds'))
    const dims = new Map<string, [number, number]>()
    {
      const bytes = await vfs.readMany(uiTextures)
      for (const [p, b] of bytes) {
        try {
          const dds = parseDds(b)
          dims.set(p, [dds.width, dds.height])
        } catch {
          // Kaputte/unbekannte DDS: nicht raten — die Lua bekommt nil und der
          // Skin-Fallback greift.
        }
      }
    }
    log(`UI: ${files.size} Lua-Dateien, ${dims.size} Texturmaße`)

    const allPaths = new Set(vfs.find(() => true))
    const host = await LuaHost.create(files, (level, msg) => {
      if (level === 'WARN') log(`UI-WARN: ${msg.slice(0, 400)}`)
    })
    // Der aufgeschobene DoInitializing-Schritt (nur 'game'-Modus, siehe unten).
    let worldInit: (() => void) | null = null

    installUiEngine(host, {
      exists: (p) => allPaths.has(p),
      find: (dir, pattern) => findFiles(allPaths, dir, pattern),
      textureSize: (p) => dims.get(p) ?? null,
      stringAdvance: (text, family, size) => fonts.advance(text, family, size),
      fontMetrics: (family, size) => fonts.metrics(family, size),
      conVarChanged,
      // Die Einstellungen überleben das Neuladen. Die Engine schreibt sie als
      // Lua-Quelltext nach `Game.prefs` — hier ist es derselbe Text, nur die
      // Ablage ist der localStorage. Ohne das war jede Option, jedes Profil und
      // jede Lautstärke nach dem nächsten Aufruf wieder auf Anfang.
      prefs: {
        load: () => localStorage.getItem(PREFS_KEY),
        save: (luaText) => {
          try {
            localStorage.setItem(PREFS_KEY, luaText)
          } catch (e) {
            // Voller/gesperrter Speicher: sagen, nicht schlucken.
            log(`Prefs: konnten nicht gespeichert werden — ${e instanceof Error ? e.message : e}`)
          }
        },
      },
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

      // Die SESSION steht vor den Panels: avatars.lua:30 liest
      // `GetArmiesTable().armiesTable[GetFocusArmy()].faction` schon beim
      // Import, tabs.lua:20 `SessionGetScenarioInfo().Options.Timeouts`.
      if (session) applySession(host, session)

      // Der Weltstart, wörtlich wie die Engine (func_DoPreload, Cfile:1320735):
      // StartGameUI → StartLoadingDialog. Der Lade-Dialog setzt dabei ECHTE
      // ConVars (UI_RenderUnitBars, UI_NisRenderIcons, ren_SelectBoxes —
      // gamemain.lua:217-219). Die Sim lädt parallel im Worker; die Wartezeit
      // an dieser Stelle ist im Browser null.
      startSessionLoading(host)

      // DoInitializing (Cfile:1321030-1321090) läuft NICHT hier, sondern erst
      // nach dem ERSTEN Sim-Beat mit Sync-Daten (Cfile:1321067) — siehe beat().
      // Der Grund ist kein Timing-Detail, sondern Semantik: gamemain.lua:77-102
      // (OnFirstUpdate) liest beim ersten Frame `GetArmyAvatars()` und forkt
      // einen Thread, der 3 s später `SelectUnits(avatars)` ruft. Läuft der
      // Aufbau VOR dem ersten Unit-Sync, ist avatars nil — der Fork löscht
      // dann jede inzwischen getätigte Auswahl, der Start-Zoom (UIZoomTo)
      // entfällt, und die ACU bekommt nie ihren Spielernamen. Genau das war
      // der „leere UI"-Befund (Orders versteckt, 0 Bau-Icons).
      worldInit = () => {
        // SetNewLuaState räumt die Root-Frames (der Lade-Dialog verschwindet),
        // SetupUI + StartGameUI laufen ERNEUT (frischer Provider), dann
        // StopLoadingDialog — das Fraktionsbild blendet über 1,5 s aus, und die
        // Original-Lua forkt InitialAnimations (gamemain.lua:253-263): erst
        // DARIN fahren Score, Economy, Avatare und die Reiter ein.
        host.eval('__mauiResetFrames()')
        host.eval('__uiSetupUi()')
        host.eval('__uiStartGameUI()')
        finishSessionLoading(host)

        // Ab hier baut die Original-Lua die UI — in der Reihenfolge aus
        // gamemain.lua:145-153; in der Engine kommt CreateGameInterface NACH
        // StopLoadingDialog (Cfile:1321080). Denselben Weg nimmt die Verify-Suite.
        setupGameUi(host, log)
      }
    }

    // Erst rendern, dann zählen — und zwar in dieser Reihenfolge: die Grids der
    // Original-UI legen ihre Kinder erst in OnFrame aus (grid.lua:40-48, die
    // Frame-Pumpe der Engine, Cfile:1118936). Ein Snapshot VOR dem ersten Frame
    // sieht sie ohne Layout und meldet sie zu Unrecht als kaputt.
    // Die Engine holt sich den STAND aller ConVars — Apply(true) hat sie beim
    // Boot gesetzt, und wer sich erst danach anschließt, hätte sie sonst nie
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
        `__uiSetUnit(${u.id}, '${u.name}', ${u.army ?? 1}, ${u.x}, ${u.y}, ${u.z}, ` +
          `${u.health}, ${u.maxHealth}, ${u.fraction ?? 1}, ${u.idle === true}, ` +
          `${u.fireState ?? 0}, ${u.guard ?? 0}, ${u.caps ?? -1}, ${u.dead === true}, ` +
          `${u.shieldRatio ?? 0})`,
      )
      // Die Bau-Warteschlange einer Fabrik (construction.lua zeigt sie an).
      // IMMER senden, auch leer: sonst bleibt in der UI-Kopie die letzte Queue
      // stehen, und der Übergang „letzter Eintrag fertig → leer" kommt nie an.
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
      ${eco.massExpense}, ${eco.energyExpense},
      ${eco.reclaimMass}, ${eco.reclaimEnergy})`)
    // Die SPIELZEIT (score.lua zeigt sie als Uhr; sie steht bei Pause still).
    lines.push(`__uiSetGameTick(${gameTick})`)
    // Der BEAT-VERTEILER der Original-UI — nicht ein einzelnes Panel.
    //
    // Die Engine ruft pro Sim-Beat GENAU EINE Lua-Funktion:
    // Moho::UI_LuaBeat() → gamemain.OnBeat() (Cfile:1262940-1262967). Dort
    // laufen ALLE per AddBeatFunction registrierten Update-Funktionen:
    // economy._BeatFunction, avatars.AvatarUpdate (das ACU-Icon rechts!),
    // commandmode.OnCommandModeBeat, connectivity.PingUpdate, …
    //
    // Vorher riefen wir Economy._BeatFunction() DIREKT — damit lief genau ein
    // Panel, und alle anderen registrierten Beat-Funktionen blieben tot.
    //
    // Der Queue-Wächter läuft VOR dem Lua-Beat — dieselbe Reihenfolge wie
    // CUIManager::DoBeat (Cfile:1273907-1273911: erst
    // UI_FactoryCommandQueueHandlerBeat, dann UI_LuaBeat). Er meldet
    // Änderungen der Fabrik-Warteschlange als gamemain.OnQueueChanged.
    lines.push(`__uiFactoryQueueBeat()`)
    lines.push(`import('/lua/ui/game/gamemain.lua').OnBeat()`)
    this.host.eval(lines.join('\n'))

    // Der erste Beat MIT Units ist der Moment, in dem die Engine DoInitializing
    // fährt (Cfile:1321067: StopLoadingDialog „nach dem ersten Beat mit
    // Sync-Daten"). Erst jetzt sieht gamemain.OnFirstUpdate seine Avatare —
    // vorher löschte dessen 3-s-Fork mit `SelectUnits(nil)` jede Auswahl.
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

  /** Wie viele Units gerade ausgewählt sind (GetSelectedUnits der UI-VM). */
  selectionCount(): number {
    return Number(this.host.eval('return table.getn(GetSelectedUnits() or {})'))
  }

  /** NUR Debug (CDP-Abnahmen): einen Lua-Ausdruck in der UI-VM auswerten. */
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
    // Ein Fehler in einem OnFrame-Skript darf die Bild-Pumpe nicht anhalten —
    // sonst friert nach dem ersten fehlenden Engine-Teil die ganze Oberfläche
    // ein. Die Engine macht es genauso (CMauiControl::Frame → RunScript).
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
    /** The picked object under the cursor: enemy → Attack, own unfinished →
     *  Repair, own healthy → Guard (0x0F), prop → Reclaim (0x13). */
    ziel: {
      enemy?: number
      repair?: number
      own?: number
      reclaimProp?: number
      reclaimMapProp?: number
    } = {},
  ): Promise<string | null> {
    return worldClick(this.host, sim, hit, elevation, {
      queue,
      enemyTargetId: ziel.enemy,
      repairTargetId: ziel.repair,
      ownTargetId: ziel.own,
      reclaimPropId: ziel.reclaimProp,
      reclaimMapPropIndex: ziel.reclaimMapProp,
    })
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

  /** Die Session in die UI-VM spiegeln (siehe `applySession`). */
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
    try {
      return this.host.eval(call) === true
    } catch (err) {
      // Ein Fehler in einem UI-Skript darf die Maus nicht abschalten. Die Engine
      // macht es genauso: CMauiControl::HandleEvent ruft das Lua-HandleEvent über
      // RunScript, ein Fehler wird protokolliert und das Programm läuft weiter.
      // Ohne das riss der erste fehlende Engine-Teil (ein Klick auf den
      // Ton-Reiter → GetVolume) die ganze Bedienung mit.
      //
      // Das Event gilt als VERBRAUCHT: es hat ein Control getroffen (sonst wäre
      // kein Skript gelaufen) — es darf nicht auch noch als Klick in die Welt gehen.
      this.reportUiError(err)
      return true
    }
  }

  private readonly seenErrors = new Set<string>()
  /** Jeden verschiedenen Lua-Fehler GENAU EINMAL melden — nicht 60-mal pro Sekunde. */
  private reportUiError(err: unknown): void {
    const full = (err instanceof Error ? err.message : String(err)).replace(
      /\[string "[\s\S]*?"\]/g,
      '',
    )
    // Dedupe on the first line, but LOG the whole message: wasmoon errors can
    // carry a Lua traceback in the tail, and cutting it off cost us the
    // caller when hunting a lazyvar.lua:92 error from a user report.
    const key = full.split('\n')[0]!.slice(0, 300)
    if (this.seenErrors.has(key)) return
    this.seenErrors.add(key)
    this.log(`UI-FEHLER: ${full.slice(0, 2000)}`)
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
    // Die Modifier-Tasten für IsKeyDown (mHelp Cfile:1141963) — die
    // Original-UI fragt 'Shift' (commandmode.lua:82: Shift hält den
    // Befehls-Modus nach dem ersten Befehl offen → Bau-Warteschlange).
    // Namen wie im EMauiKeyCode-Enum, das SCR_GetEnum auflöst.
    const meldeTaste = (e: KeyboardEvent, down: boolean): void => {
      const name = e.key === 'Shift' ? 'Shift' : e.key === 'Control' ? 'Control' : e.key === 'Alt' ? 'Alt' : null
      if (name) this.host.eval(`__uiSetKeyDown('${name}', ${down})`)
    }

    // Der TASTATUR-Pfad der Engine (wxWndProc @0x96D090 → maui-Dispatch →
    // CUIKeyHandler), aus dem Browser-Event nachgezeichnet:
    //   1. KeyDown an __mauiKey (Fokus-Control / Capture-Top). Konsumiert →
    //      das folgende Char wird VERSCHLUCKT (Bit-8-Semantik,
    //      Cfile:1499710-1499717).
    //   2. Nicht konsumiert → Keymap-Executor (__uiKeyMapExecute): Hotkeys
    //      aus keymapper.lua via ConExecute; Fallbacks Enter→Chat, ~→Konsole.
    //   3. Char (echt oder aus dem KeyDown synthetisiert, keys.ts) an
    //      __mauiKey — NUR darüber bekommen Edit-Felder ihre Zeichen
    //      (CMauiEdit reagiert ausschließlich auf MET_Char,
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
          // '~' erreicht die Konsole im Original über den Char-Code 126
          // (Cfile:1262747) — die Taste selbst ist VK 0xC0.
          const mauiCode = e.key === '~' ? 126 : k.wx
          acted =
            this.host.eval(
              `return __uiKeyMapExecute(${k.vk}, ${e.shiftKey}, ${e.ctrlKey}, ${e.altKey}, ${e.repeat}, ${mauiCode})`,
            ) === true
          if (k.charCode !== null) {
            this.host.eval(`__mauiKey('Char', ${k.charCode}, ${k.vk}, ${m})`)
          }
          // While an edit holds the keyboard focus, the Char event went into
          // it even though the edit reports not-consumed (CMauiEdit::
          // HandleEvent returns 0) — the browser must not also scroll the
          // page with Space/arrows or trigger shortcuts while typing.
          if (!acted && this.host.eval('return __mauiFocus ~= false and __mauiFocus ~= nil') === true) {
            acted = true
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
    // Fenster verlässt den Fokus → keine Taste gilt mehr als gehalten (sonst
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
