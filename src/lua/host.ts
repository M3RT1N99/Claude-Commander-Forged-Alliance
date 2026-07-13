import { LuaFactory, type LuaEngine } from 'wasmoon'
import { transpileFaLua, COMPAT_LUA } from './transpile'

/**
 * Host für die Original-Lua-Sim-Umgebung von Supreme Commander FA.
 *
 * Die Original-Skripte laufen **unverändert** (nur durch den FA-Dialekt-
 * Transpiler geschleust) in einem eingebetteten Lua-VM. Der Host stellt die
 * Engine-Seite: die globalen Funktionen, die die Engine in Lua injiziert
 * (`doscript`, `LOG`, `import`-Fundament), und später die `moho`-API.
 *
 * Modul-System (Original `lua/system/import.lua`): `import(name)` legt eine
 * Umgebung mit `__index = _G` an und ruft die Engine-Funktion
 * `doscript(name, env)`, die das File lädt und mit dieser Umgebung ausführt.
 *
 * Gleis B (Brücke, siehe docs/MASTERPLAN.md): wasmoon (Lua 5.4) + Transpiler.
 * Bekannte Semantik-Abweichungen zu Lua 5.0 werden später mit einem eigenen
 * 5.0-WASM-Build (Gleis A) beseitigt.
 */

export interface LogSink {
  (level: 'LOG' | 'SPEW' | 'WARN', message: string): void
}

const FS_PREFIX = '/mod'

export class LuaHost {
  private readonly mounted = new Set<string>()

  private constructor(
    private readonly factory: LuaFactory,
    private readonly luaWasm: unknown,
    readonly lua: LuaEngine,
    /** Key: kleingeschriebener VFS-Pfad ohne führenden Slash. */
    private readonly files: Map<string, Uint8Array>,
    private readonly log: LogSink,
  ) {}

  /**
   * Baut den Host. `files` enthält alle Lua-Quelltexte (lua.scd +
   * mohodata.scd, Key kleingeschrieben, z. B. `lua/system/class.lua`).
   * Muss vollständig vorgeladen sein, weil das Modul-Laden aus Lua heraus
   * synchron passiert.
   */
  static async create(files: Map<string, Uint8Array>, log: LogSink = defaultLog): Promise<LuaHost> {
    const factory = new LuaFactory()
    const luaWasm = await factory.getLuaModule()
    const lua = await factory.createEngine({ openStandardLibs: true })
    const host = new LuaHost(factory, luaWasm, lua, files, log)
    await host.boot()
    return host
  }

  /** Transpiliert ein Modul, mountet es ins VM-FS, liefert den FS-Pfad. */
  private mountModule(name: string): string | null {
    const key = name.replace(/^\/+/, '').toLowerCase()
    const bytes = this.files.get(key)
    if (!bytes) return null
    const fsPath = `${FS_PREFIX}/${key}`
    if (!this.mounted.has(fsPath)) {
      const raw = new TextDecoder('latin1').decode(bytes)
      const { code } = transpileFaLua(raw)
      // @ts-expect-error luaWasm ist das interne Emscripten-Modul
      this.factory.mountFileSync(this.luaWasm, fsPath, code)
      this.mounted.add(fsPath)
    }
    return fsPath
  }

  private async boot(): Promise<void> {
    const g = this.lua.global

    // --- Engine-Globals, die die Original-Skripte erwarten ---------------
    g.set('LOG', (...a: unknown[]) => this.log('LOG', a.map(str).join('')))
    g.set('SPEW', (...a: unknown[]) => this.log('SPEW', a.map(str).join('')))
    g.set('WARN', (...a: unknown[]) => this.log('WARN', a.map(str).join('')))
    g.set('_ALERT', (...a: unknown[]) => this.log('WARN', a.map(str).join('')))
    g.set('FileCollapsePath', collapsePath)
    g.set('__mountModule', (name: string) => this.mountModule(name))

    // Kompat-Schicht (Lua-5.0-Bibliotheksfunktionen) + Basis-Engine-Globals
    this.lua.doStringSync(COMPAT_LUA)
    this.lua.doStringSync(BOOT_LUA)

    // Original-Modulsystem laden (definiert import(), __modules)
    this.runModuleGlobally('/lua/system/import.lua')
    // Klassensystem laden (definiert globales Class)
    this.runModuleGlobally('/lua/system/class.lua')
  }

  /** Führt ein Modul im GLOBALEN Environment aus (für Boot-Skripte). */
  private runModuleGlobally(name: string): void {
    const fsPath = this.mountModule(name)
    if (!fsPath) throw new Error(`Boot-Modul nicht gefunden: ${name}`)
    const err = this.lua.doStringSync(`return __runGlobal(${JSON.stringify(fsPath)})`)
    if (err) throw new Error(`Fehler in ${name}: ${err}`)
  }

  /** Lädt ein Modul über das Original-`import()` und gibt die Modultabelle. */
  importModule(name: string): unknown {
    return this.lua.doStringSync(`return import(${JSON.stringify(name)})`)
  }

  /** Setzt/überschreibt ein globales Symbol (Engine-Funktion, Tabelle). */
  setGlobal(name: string, value: unknown): void {
    this.lua.global.set(name, value)
  }

  /** Führt ein Boot-Modul im globalen Environment aus (öffentlich für Setup). */
  loadGlobal(name: string): void {
    this.runModuleGlobally(name)
  }

  /**
   * Installiert einen nachsichtigen Trap: Zugriff auf ein nicht definiertes
   * Global liefert einen No-Op-Stub statt eines Fehlers und meldet den Namen.
   * Werkzeug zum Entdecken der von den Original-Skripten benötigten
   * Engine-API (statt zu raten). Nicht für den Produktivbetrieb.
   */
  installStubTrap(onMissing: (name: string) => void): void {
    this.lua.global.set('__onMissingGlobal', (name: string) => onMissing(name))
    this.lua.doStringSync(`
      local seen = {}
      -- Identitaets-Stub: gibt das erste Argument zurueck. Passt fuer die
      -- Blueprint-DSL-Konstruktoren (Sound{...} -> {...}) und ist harmlos
      -- fuer void-Engine-Aufrufe.
      local stub = function(a) return a end
      setmetatable(_G, {
        __index = function(_, k)
          if type(k) == 'string' and not seen[k] then
            seen[k] = true
            __onMissingGlobal(k)
          end
          return stub
        end,
      })
    `)
  }

  /** Direkter Lua-Ausdruck (Tests/Diagnose). */
  eval(code: string): unknown {
    return this.lua.doStringSync(code)
  }

  close(): void {
    this.lua.global.close()
  }
}

/** Engine-Bootstrap in Lua: doscript + __runGlobal auf Basis von loadfile. */
const BOOT_LUA = `
__diskwatch = {}
__currentSource = nil

-- Engine-Hook: Modul in gegebener Umgebung ausfuehren (import.lua ruft das).
-- Verfolgt zusaetzlich das aktuell geladene File fuer GetSource() (die
-- Blueprint-Pipeline leitet daraus die BlueprintId ab).
function doscript(name, env)
    local fsPath = __mountModule(name)
    if not fsPath then error("module not found: " .. tostring(name), 2) end
    -- Ohne env laeuft das Modul im globalen Environment (Blueprints/Boot).
    -- Explizites nil als 4. load-Argument wuerde _ENV auf nil setzen.
    local chunk, err = loadfile(fsPath, "t", env or _G)
    if not chunk then error(err, 2) end
    local prev = __currentSource
    __currentSource = name
    local r = chunk()
    __currentSource = prev
    return r
end

-- Engine-Funktion: Pfad des gerade per doscript geladenen Files
function GetSource()
    return __currentSource
end

-- Boot-Skripte im globalen _ENV ausfuehren; gibt Fehlermeldung oder nil
function __runGlobal(fsPath)
    local chunk, err = loadfile(fsPath, "t")
    if not chunk then return err end
    local ok, e = pcall(chunk)
    if not ok then return e end
    return nil
end
`

function str(v: unknown): string {
  if (v === null || v === undefined) return 'nil'
  if (typeof v === 'string') return v
  return String(v)
}

/** FA `FileCollapsePath`: löst `..`/`.`-Segmente in einem VFS-Pfad auf. */
function collapsePath(path: string): string {
  const absolute = path.startsWith('/')
  const parts: string[] = []
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return (absolute ? '/' : '') + parts.join('/')
}

const defaultLog: LogSink = (level, message) => {
  if (level === 'WARN') console.warn(`[${level}] ${message}`)
  else console.log(`[${level}] ${message}`)
}
