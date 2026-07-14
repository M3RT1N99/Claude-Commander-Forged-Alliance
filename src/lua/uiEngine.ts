import type { LuaHost } from './host'
import { installMoho } from './moho'
import { installBlueprintPipeline } from './unitFactory'
import { installEngineGlobals } from './engineGlobals'
import { installSimThreads } from './simThreads'
import UI_GLOBALS_LUA from '../engine-lua/ui-globals.lua?raw'
import UI_GLOBALS_MISSING_LUA from '../engine-lua/ui-globals-missing.lua?raw'
import MAUI_LUA from '../engine-lua/maui.lua?raw'

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
  /** Maße einer DDS-Textur — daraus bemisst sich ein Bitmap ohne Layout-Helfer. */
  textureSize?: (path: string) => [number, number] | null
  /** Breite eines Strings in Pixeln (CMauiText::GetStringAdvance, Cfile:1146720). */
  stringAdvance?: (text: string, family: string, size: number) => number
  /** Ober-/Unterlänge der Schrift — text.lua:39 baut daraus die Höhe. */
  fontMetrics?: (family: string, size: number) => [number, number]
}

export function installUiEngine(host: LuaHost, fs: UiFileSystem): UiEngine {
  // Reihenfolge wie beim Sim-Boot und aus demselben Grund: erst die
  // Engine-Primitive, dann class.lua neu laden (class.lua:78 snapshottet
  // ForkThread als Upvalue), dann die Original-Lua.
  installSimThreads(host)
  installEngineGlobals(host)
  host.eval(UI_GLOBALS_LUA)

  // DiskGetFileInfo ist die Naht zum VFS. UIUtil.UIFile/SkinnableFile bauen
  // darauf ihre Skin-Fallback-Kette (uiutil.lua:310) — ohne echte Antwort
  // findet die UI ihre Texturen nicht.
  // `exists` und `DiskGetFileInfo` sind Core-Globals (docs/research/engine-api.md)
  // und die Naht zum VFS. Localization.lua:21 und UIUtil.UIFile bauen darauf.
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

  // Die gemeinsame Boot-Kette beider VMs — dieselben Dateien, die
  // globalInit.lua:14-24 lädt. Nicht einzeln zusammengeraten: config.lua
  // bringt `iscallable`, Localization.lua bringt `LOC`, collapse.lua die
  // Pfad-Normalisierung. (Den ConvertCClassToLuaClass-Lauf am Ende von
  // globalInit brauchen wir nicht: unsere moho-Klassen SIND schon Lua-Klassen,
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

  // Die UI-Seite des Sync-Tables. Das Gegenstück zu `/lua/simsync.lua` in der
  // Sim: die Engine legt beides selbst in den jeweiligen State (keine Lua-Datei
  // ruft es auf, deshalb steht es hier). Es bringt `Sync`, `PreviousSync`,
  // `UnitData` und `OnSync()` — und ohne `UnitData` scheitert schon
  // orders.lua:909 an der ersten Selektion.
  host.loadGlobal('/lua/usersync.lua')

  // maui-Substrat: die LazyVar-Instanzen, die InternalCreate*-Globals und
  // DoInit → OnInit. Muss NACH class.lua/moho stehen (die Controls sind
  // Lua-Klassen) und VOR jeder UI-Lua, die Controls erzeugt.
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

  // Alle noch nicht gebauten UI-Globals bekommen eine Funktion, die beim AUFRUF
  // mit ihrem Namen scheitert. Referenzieren geht (die UI-Lua baut daraus beim
  // Laden Tabellen), Aufrufen knallt — kein stiller Stub, sondern eine Liste
  // dessen, was als Nächstes zu bauen ist.
  host.eval(UI_GLOBALS_MISSING_LUA)

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
  // Die Original-Lua erwartet die Blueprints unter dem Global `__blueprints`
  // (so heisst die Tabelle, die die Engine in den State legt).
  host.eval(`__blueprints = __registered.Unit`)
  return Number(host.eval('local n = 0 for _ in pairs(__blueprints) do n = n + 1 end return n'))
}

/** `/textures/x.dds` → `textures/x.dds` (das VFS führt Pfade ohne führenden /). */
function normalize(path: string): string {
  return path.replace(/^\/+/, '').toLowerCase()
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
export function setupGameUi(host: LuaHost, log: (msg: string) => void): void {
  // Der Bildschirm-Baum, exakt wie gamemain.lua ihn aufspannt: EINE Screen-Group,
  // darin die vier Cluster von borders.lua. Alle Panels haengen an diesen Gruppen
  // — wer sie stattdessen an GetFrame(0) haengt, bekommt jedes Panel an die
  // falsche Stelle (die Layout-Dateien rechnen gegen den Cluster, nicht gegen den
  // Bildschirm).
  host.eval('__ui = {}')
  host.eval(`
    UIUtil = import('/lua/ui/uiutil.lua')
    __ui.gameParent = UIUtil.CreateScreenGroup(GetFrame(0), "GameMain ScreenGroup")
    __ui.controlCluster, __ui.statusCluster, __ui.mapGroup, __ui.windowGroup =
      import('/lua/ui/game/borders.lua').SetupBorderControl(__ui.gameParent)
  `)

  for (const [name, code] of [
    ['economy', `Economy = import('/lua/ui/game/economy.lua')
                 Economy.CreateEconomyBar(__ui.statusCluster)`],
    ['multifunction', `__ui.mfd = import('/lua/ui/game/multifunction.lua').Create(__ui.controlCluster)`],
    ['orders', `__ui.ordersModule = import('/lua/ui/game/orders.lua')
                __ui.orders = __ui.ordersModule.SetupOrdersControl(__ui.controlCluster, __ui.mfd)`],
    ['construction', `__ui.construction = import('/lua/ui/game/construction.lua')
                        .SetupConstructionControl(__ui.controlCluster, __ui.mfd, __ui.orders)`],
    ['unitview', `import('/lua/ui/game/unitview.lua')
                    .SetupUnitViewLayout(__ui.mapGroup, __ui.orders)`],
    // gamemain.lua:154 — die Detailansicht (Rollover-Tooltip). construction.lua
    // ruft sie ungeprüft (UnitViewDetail.Hide()), also MUSS sie stehen.
    ['unitviewDetail', `import('/lua/ui/game/unitviewDetail.lua')
                          .SetupUnitViewLayout(__ui.mapGroup, __ui.mapGroup)`],
  ] as const) {
    try {
      host.eval(code)
      log(`UI: ${name}.lua läuft`)
    } catch (e) {
      // Ohne das Abschneiden des [string "…"]-Präfixes verschluckt die Ausgabe
      // die eigentliche Lua-Meldung.
      const msg = (e as Error).message.replace(/\[string "[\s\S]*?"\]/g, '').split('\n')[0]
      log(`UI: ${name}.lua NOCH NICHT — ${msg?.slice(0, 200)}`)
    }
  }

  // Ab jetzt gibt es Empfänger für Selektions-Ereignisse (im Original registriert
  // die Engine den SelectionListener erst beim Session-Start, Cfile:1294170).
  host.eval('__uiSessionActive = true')
}

/**
 * Führt `SetupUI()` aus dem Original-`uimain.lua` aus — den Einstiegspunkt, den
 * die Engine selbst ruft (Cfile:1262333:
 * `SCR_Import('/lua/ui/uimain.lua')['SetupUI']()`). Danach stehen Skin, Layout
 * und Cursor — alles aus der Original-Lua, nichts aus TS.
 */
export function setupUi(host: LuaHost): void {
  // Ein Benutzerprofil muss existieren (prefs.lua:96 greift ungeprüft darauf
  // zu). Angelegt wird es über den Original-Weg — `Prefs.CreateProfile`
  // (prefs.lua:31), dieselbe Funktion, die das Spiel benutzt, wenn jemand zum
  // ersten Mal startet. Kein handgeschnitztes Profil-Table.
  host.eval(`
    local Prefs = import('/lua/user/prefs.lua')
    if not Prefs.ProfilesExist() then
      Prefs.CreateProfile('Commander')
    end
  `)
  host.eval(`import('/lua/ui/uimain.lua').SetupUI()`)
}
