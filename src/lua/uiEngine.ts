import type { LuaHost } from './host'
import type { SessionInfo } from '../sim/session'
import { installMoho } from './moho'
import { installBlueprintPipeline } from './unitFactory'
import { installEngineGlobals } from './engineGlobals'
import { installSimThreads } from './simThreads'
import UI_GLOBALS_LUA from '../engine-lua/ui-globals.lua?raw'
import PREFS_LUA from '../engine-lua/prefs.lua?raw'
import CONSOLE_LUA from '../engine-lua/console.lua?raw'
import WORLD_COMMANDS_LUA from '../engine-lua/world-commands.lua?raw'
import UI_BOOT_LUA from '../engine-lua/ui-boot.lua?raw'
import UI_GLOBALS_MISSING_LUA from '../engine-lua/ui-globals-missing.lua?raw'
import MAUI_LUA from '../engine-lua/maui.lua?raw'
import pkg from '../../package.json' with { type: 'json' }

/**
 * Die UI-VM — der zweite Lua-State.
 *
 * Die Engine hat ZWEI Lua-States, und das ist kein Detail: eine Bindung wird
 * über `mPrevDef` in genau eine davon registriert
 * (docs/research/engine-api.md, aus der Decomp erzeugt):
 *
 *   scr_CoreInits   70 Bindungen — beide VMs
 *   scr_UserInits  453 Bindungen — nur UI
 *   sim_SimInits   626 Bindungen — nur Sim
 *
 * Deshalb kennt die Sim kein `_c_CreateCursor` und die UI kein `CreateUnit`.
 * Wer beides in eine VM wirft, baut etwas, das es im Original nie gab — und
 * merkt erst viel später, dass die UI Dinge sieht, die sie nicht sehen dürfte.
 *
 * Diese Funktion ist der UI-Gegenpart zu `installEngine()`. Sie bootet
 * absichtlich NICHT die Sim (keine Ökonomie, keine Units, kein Bau).
 */
export interface UiEngine {
  host: LuaHost
}

/**
 * Was die UI-VM von der Engine braucht: den Dateizugriff (VFS), die Maße einer
 * Textur und die Schriftmetrik. Alles drei sind echte Engine-Dienste — ohne sie
 * kann die maui-Lua ihr Layout nicht rechnen.
 */
export interface UiFileSystem {
  exists: (path: string) => boolean
  find: (dir: string, pattern: string) => string[]
  /** Dimensions of a DDS texture - this is used to measure a bitmap without a layout helper. */
  textureSize?: (path: string) => [number, number] | null
  /** Width of a string in pixels (CMauiText::GetStringAdvance, Cfile:1146720). */
  stringAdvance?: (text: string, family: string, size: number) => number
  /** Upper/lower length of the font - text.lua:39 uses this to build the height. */
  fontMetrics?: (family: string, size: number) => [number, number]
  /**
   * Die Engine erfährt, wenn eine ConVar sich ändert.
   *
   * `ConExecute("ui_KeyboardPanSpeed 90")` setzt in der Engine eine echte
   * Variable, die die C++-Seite in ihren Schleifen liest (die WorldView fragt
   * pro Bild ui_KeyboardPanSpeed, die Kamera cam_ZoomAmount). Die Engine hier
   * ist TypeScript — also muss sie es erfahren.
   */
  conVarChanged?: (name: string, value: string | number | boolean) => void
  /**
   * Die Einstellungen des Nutzers, dauerhaft.
   *
   * Die Engine schreibt sie als LUA-QUELLTEXT nach `Game.prefs` (nachgesehen in
   * der Installation: `PreGameData = { CurrentMapDir = '/maps/…' }`). Hier ist es
   * derselbe Text, nur die Ablage ist anders (Browser: localStorage).
   * Ohne diesen Haken ist jede Einstellung nach dem Neuladen weg.
   */
  prefs?: {
    load: () => string | null
    save: (luaText: string) => void
  }
}

export function installUiEngine(host: LuaHost, fs: UiFileSystem): UiEngine {
  // Order as with the SIM boot and for the same reason: first the
  // Engine primitives, then reload class.lua (class.lua:78 snapshotted
  // ForkThread as Upvalue), then the original Lua.
  installSimThreads(host)
  installEngineGlobals(host)
  // GetVersion() (Core-Global, Cfile:599401) returns the version of the ENGINE:
  // Moho::GetEngineVersion @0x4D3D30 is `STR_Printf("%1.1f.%i", 1.5, 3764)` —
  // compiled in, not read from the game data. The engine here is us,
  // so our version is there. It is visible in the main menu (main.lua:172).
  host.setGlobal('__engineVersion', `${pkg.name} ${pkg.version}`)
  host.eval(UI_GLOBALS_LUA)
  host.eval(PREFS_LUA)
  // The engine's console (ConExecute + ConVars). 19 of the 37 options work
  // via exactly this path - previously ConExecute only logged, and that was it
  // each one a dummy.
  host.eval(CONSOLE_LUA)

  // Restore the saved settings — BEFORE everything she reads
  // (prefs.lua:96 accesses the profile without checking, main.lua:151 asks
  // `mainmenu_bgmovie`, uimain.lua:31 the skin).
  if (fs.prefs) {
    const stored = fs.prefs.load()
    if (stored) {
      host.setGlobal('__prefsStored', stored)
      const ok = host.eval('return __prefsLoad(__prefsStored)')
      if (ok !== true) host.eval('__prefsStored = nil')
    }
    host.setGlobal('__uiSavePrefs', (luaText: string) => fs.prefs!.save(luaText))
  }

  if (fs.conVarChanged) {
    host.setGlobal('__uiConSink', (name: string, value: string | number | boolean) =>
      fs.conVarChanged!(name, value),
    )
  }

  // DiskGetFileInfo is the seam to the VFS. Build UIUtil.UIFile/SkinnableFile
  // then their skin fallback chain (uiutil.lua:310) — with no real answer
  // the UI cannot find its textures.
  // `exists` and `DiskGetFileInfo` are core globals (docs/research/engine-api.md)
  // and the seam to the VFS. Localization.lua:21 and UIUtil.UIFile rely on it.
  host.setGlobal('exists', (path: string) => fs.exists(normalize(path)))
  host.setGlobal('DiskGetFileInfo', (path: string) => fs.exists(normalize(path)))
  host.setGlobal('__uiDiskFindFiles', (dir: string, pattern: string) =>
    fs.find(normalize(dir), pattern),
  )
  host.eval(`
    function DiskFindFiles(dir, pattern)
      return __uiDiskFindFiles(dir, pattern or '*')
    end
  `)

  // The common boot chain of both VMs — the same files that
  // globalInit.lua:14-24 is loading. Not recommended individually: config.lua
  // brings `iscallable`, Localization.lua brings `LOC`, collapse.lua the
  // Path normalization. (The ConvertCClassToLuaClass run at the end of
  // We don't need globalInit: our moho classes ARE already Lua classes,
  // siehe engine-lua/moho.lua.)
  host.loadGlobal('/lua/system/config.lua')
  host.loadGlobal('/lua/system/class.lua')
  installMoho(host)
  host.loadGlobal('/lua/system/utils.lua')
  host.loadGlobal('/lua/system/repr.lua')
  host.loadGlobal('/lua/system/trashbag.lua')
  host.loadGlobal('/lua/system/Localization.lua')
  host.loadGlobal('/lua/system/MultiEvent.lua')
  host.loadGlobal('/lua/system/collapse.lua')

  // The UI page of the sync table. The counterpart to `/lua/simsync.lua` in the
  // Sim: the engine puts both into the respective state itself (no Lua file
  // calls it up, that's why it's here). It brings `Sync`, `PreviousSync`,
  // `UnitData` and `OnSync()` - and without `UnitData` it fails
  // orders.lua:909 on the first selection.
  host.loadGlobal('/lua/usersync.lua')

  // maui substrate: the LazyVar instances, the InternalCreate* globals and
  // DoInit → OnInit. Must be AFTER class.lua/moho (the controls are
  // Lua classes) and BEFORE any UI Lua that creates controls.
  host.eval(MAUI_LUA)
  if (fs.textureSize) {
    host.setGlobal('__uiTextureDims', (path: string) => fs.textureSize!(normalize(path)))
  }
  if (fs.stringAdvance) {
    host.setGlobal('__uiStringAdvance', (text: string, family: string, size: number) =>
      fs.stringAdvance!(text, family, size),
    )
  }
  if (fs.fontMetrics) {
    host.setGlobal('__uiFontMetrics', (family: string, size: number) =>
      fs.fontMetrics!(family, size),
    )
  }

  // All UI globals that have not yet been built get a function that is activated when CALLED
  // fails with her name. Referencing is possible (the UI Lua builds from this when
  // Loading tables), calling pops — not a silent stub, but a list
  // of what to build next.
  host.eval(UI_GLOBALS_MISSING_LUA)

  // The engine boot flow (profile, apply options, front-end, game UI)
  // — in Lua, not in TS template literals. Only defines functions, called
  // nothing will happen; that's why it's at the end.
  host.eval(UI_BOOT_LUA)
  host.eval(WORLD_COMMANDS_LUA)

  // IN_InitKeyHandler (CUIManager::Init → LoadKeyMappings, Cfile:1259476):
  // the engine loads ITSELF keyNames.lua and when UI boots
  // keymapper.GetKeyMappings() into the keymap — it doesn't wait for lobby.lua.
  // Without this step, every key remains dead (the keymap is empty).
  host.eval('__uiInitKeyMap()')

  return { host }
}

/**
 * Erzeugt den Root-Frame (GetFrame(0)) — die Wurzel des UI-Baums, die die
 * Engine beim Start anlegt und mit der Fenstergröße versorgt. Die Klasse ist
 * die Original-`Frame` (frame.lua:6).
 */
export function createRootFrame(host: LuaHost, width: number, height: number): void {
  host.eval(`__mauiCreateRootFrame(${width}, ${height})`)
}

/**
 * Lädt die Unit-Blueprints in die UI-VM.
 *
 * Die Engine füllt `__blueprints` in BEIDEN Lua-States — die UI liest daraus
 * direkt (`unitview.lua:180`: `__blueprints[info.blueprintId]`), und
 * `construction.lua:1681` fragt über `EntityCategoryGetUnitList(cat)` die
 * baubaren Einheiten ab. Beides geht nur, wenn die UI-VM die Blueprints kennt.
 *
 * Gefahren wird die ECHTE Pipeline (`Blueprints.lua`), dieselbe wie in der Sim.
 */
export function loadUiBlueprints(host: LuaHost, bpPaths: string[]): number {
  installBlueprintPipeline(host)
  const list = bpPaths.map((p) => `'/${p}'`).join(',')
  host.eval(`__bpFiles = { ${list} }; LoadBlueprints()`)
  // The original Lua expects the blueprints under the Global `__blueprints`
  // (this is the name of the table that the engine puts in the state).
  host.eval(`__blueprints = __registered.Unit`)
  return Number(host.eval('local n = 0 for _ in pairs(__blueprints) do n = n + 1 end return n'))
}

/** `/textures/x.dds` → `textures/x.dds` (the VFS leads paths without leading /). */
function normalize(path: string): string {
  return path.replace(/^\/+/, '').toLowerCase()
}

/**
 * Die SESSION in die UI-VM spiegeln — dieselben Angaben, die auch die Sim
 * bekommt (`setupSession`, src/sim/session.ts).
 *
 * Danach liefern `GetArmiesTable()` und `SessionGetScenarioInfo()` echte Daten.
 * Welche Felder eine Armee trägt, steht nicht zur Debatte: die Engine setzt sie
 * in cfunc_GetArmiesTableL einzeln (Cfile:1267023-1267111) — name, nickname,
 * faction (0-BASIERT), color, iconColor, showScore, civilian, human, outOfGame,
 * authorizedCommandSources.
 *
 * Muss VOR setupGameUi laufen: avatars.lua:30 liest
 * `GetArmiesTable().armiesTable[GetFocusArmy()].faction` schon beim Import,
 * tabs.lua:20 `SessionGetScenarioInfo().Options.Timeouts`.
 *
 * Die Daten gehen als SKALARE in die VM (host.call) — kein Lua in TS-Literalen.
 */
export function applySession(host: LuaHost, info: SessionInfo, playerName = 'Commander'): void {
  host.call('__uiSessionBegin', info.type, info.map ?? '', info.map ?? '')
  for (const a of info.armies) {
    host.call('__uiSessionAddArmy', a.index, a.name, a.human ? playerName : a.name, a.faction, a.human)
  }
  for (const [key, value] of Object.entries(info.options ?? {})) {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      host.call('__uiSessionSetOption', key, value)
    }
  }
  // Exactly ONE client (the player). The engine counts command sources 1-based
  // (Cfile:1330618: `mLocalCmdSrc + 1`; 255 → 0 „can't issue commands").
  host.call('__uiSessionSetCommandSources', playerName, 1)
  host.call('__uiSessionSetFocusArmy', info.armies.find((a) => a.human)?.index ?? 1)
  // Alliance mirror: the same skirmish default the sim sets up
  // (scenarioutilities.lua:495 — distinct non-civilian pairs are enemies);
  // the engine syncs this via SSTIArmyVariableData (Cfile:551270).
  for (const a of info.armies) {
    for (const b of info.armies) {
      if (a.index < b.index) host.call('__uiSetAlliance', a.index, b.index, 'Enemy')
    }
  }
}

/**
 * Die Spiel-UI aufbauen — dieselbe Reihenfolge wie `gamemain.lua:145-153`, wenn
 * die Engine eine Session startet.
 *
 * Die Handles leben in einer TABELLE, nicht in Globals: `x = nil` legt unter dem
 * strengen `_G` (config.lua:51-56) keinen Schlüssel an, und der spätere
 * Lesezugriff wirft dann "access to nonexistent global variable". In gamemain
 * sind das `local`s — Tabellenfelder sind das Äquivalent, das über mehrere
 * eval-Aufrufe hinweg hält.
 *
 * Diese Funktion ist der EINE Aufbauweg der Spiel-UI. Browser und Verify-Suite
 * nehmen ihn beide — sonst prüft der Test etwas anderes, als der Browser tut.
 */
/**
 * Der Weltstart, wie die Engine ihn fährt (func_DoPreload, Cfile:1320735):
 * `func_StartGameUI` (uimain.StartGameUI → der WldUIProvider entsteht,
 * gamemain.lua:225), dann `provider:StartLoadingDialog()` — der Lade-Bildschirm
 * der Original-Lua (Fraktions-Movie + „IN TRANSIT").
 */
export function startSessionLoading(host: LuaHost): void {
  host.eval('__uiStartGameUI()')
  host.eval('__uiProviderStartLoading()')
}

/** Pro Bild während des Ladens: `provider:UpdateLoadingDialog(elapsed)`
 *  (Moho::CLuaWldUIProvider::UpdateLoadingDialog, Cfile:1295322). */
export function updateSessionLoading(host: LuaHost, elapsedSeconds: number): void {
  host.eval(`__uiProviderUpdateLoading(${elapsedSeconds})`)
}

/**
 * Das Ende des Ladens (DoInitializing, Cfile:1321067): `StopLoadingDialog()`
 * zeigt das Fraktionsbild, blendet es über 1,5 s aus und forkt
 * InitialAnimations (gamemain.lua:253-263) — erst darin fahren Score, Economy,
 * Avatare und die Reiter ein. Danach ruft die Engine CreateGameInterface
 * (= setupGameUi). Diese Reihenfolge ist Semantik, nicht Kosmetik.
 */
export function finishSessionLoading(host: LuaHost): void {
  host.eval('__uiProviderStopLoading()')
}

export function setupGameUi(host: LuaHost, log: (msg: string) => void): void {
  // The Lua code for this is in ui-boot.lua - it is just called here. Each
  // Panel individually, so that a missing engine part only costs ITS panel and
  // is named instead of dragging the entire structure along with it.
  host.eval('__uiCreateScreenTree()')

  const count = Number(host.eval('return __uiPanelCount()'))
  for (let i = 1; i <= count; i++) {
    const name = String(host.eval(`return __uiPanelName(${i})`))
    const err = host.eval(`return __uiBuildPanel(${i})`)
    if (err === undefined || err === null) {
      log(`UI: ZZPROTECT0ZZ.lua läuft`)
    } else {
      // Without truncating the [string "..."] prefix, the output is choked
      // the actual Lua message.
      const msg = String(err).replace(/\[string "[\s\S]*?"\]/g, '').split('\n')[0]
      log(`UI: ZZPROTECT0ZZ.lua NOCH NICHT — ${msg?.slice(0, 200)}`)
    }
  }

  host.eval('__uiSessionStarted()')
}

/**
 * Das Hauptmenü — der Weg, den die Engine beim normalen Start nimmt.
 *
 * `main()` (Cfile:1373865) ruft ohne Kommandozeilen-Argumente
 * `Moho::UI_StartSplashScreens()`; `splash.lua:22-25` springt bei gesetzter
 * Preference `movie.nologo` sofort mit `EngineStartFrontEndUI()` weiter — das
 * ist ein Original-Pfad, kein Trick. Von dort: `SetNewLuaState(UIS_frontend)`
 * → `SetupUI()` → `uimain.StartFrontEndUI()` → `menus/main.lua:CreateUI()`.
 *
 * Ohne SFD-Decoder gibt es kein Hintergrund-Video. Auch das geht über den
 * Original-Weg: `mainmenu_bgmovie` ist eine echte Option (options.lua:358-371),
 * die main.lua:151-153 abfragt. Kein Sonderfall im Code.
 */
export function startFrontEnd(host: LuaHost): void {
  host.eval('__uiEnsureProfile()')
  // Apply the options — that's exactly what Moho::OPTIONS_Apply() does at startup
  // (Cfile:1368338: optionslogic.Apply(true)). Without this call, NONE works
  // saved option: the value is in the prefs, but no one enters it
  // the engine.
  host.eval('__uiApplyOptions()')
  // The path begins with the splash — just like in the game. That he immediately
  // Frontend passes through, the original Lua decides, not us.
  host.eval('__uiStartFrontEnd()')
}

/**
 * Runs `SetupUI()` from the original `uimain.lua` — the entry point
 * the engine itself calls (Cfile:1262333:
 * `SCR_Import('/lua/ui/uimain.lua')['SetupUI']()`). Then there are skin and layout
 * and cursors — everything from the original Lua, nothing from TS.
 */
export function setupUi(host: LuaHost): void {
  host.eval('__uiEnsureProfile()')
  host.eval('__uiApplyOptions()')
  host.eval('__uiSetupUi()')
}
