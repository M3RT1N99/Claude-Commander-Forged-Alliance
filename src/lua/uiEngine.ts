import type { LuaHost } from './host'
import { installMoho } from './moho'
import { installEngineGlobals } from './engineGlobals'
import { installSimThreads } from './simThreads'
import UI_GLOBALS_LUA from '../engine-lua/ui-globals.lua?raw'
import UI_GLOBALS_MISSING_LUA from '../engine-lua/ui-globals-missing.lua?raw'

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

/** Zugriff der UI-VM auf die Spieldateien (VFS) — für DiskGetFileInfo/DiskFindFiles. */
export interface UiFileSystem {
  exists: (path: string) => boolean
  find: (dir: string, pattern: string) => string[]
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

  // Alle noch nicht gebauten UI-Globals bekommen eine Funktion, die beim AUFRUF
  // mit ihrem Namen scheitert. Referenzieren geht (die UI-Lua baut daraus beim
  // Laden Tabellen), Aufrufen knallt — kein stiller Stub, sondern eine Liste
  // dessen, was als Nächstes zu bauen ist.
  host.eval(UI_GLOBALS_MISSING_LUA)

  return { host }
}

/** `/textures/x.dds` → `textures/x.dds` (das VFS führt Pfade ohne führenden /). */
function normalize(path: string): string {
  return path.replace(/^\/+/, '').toLowerCase()
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
