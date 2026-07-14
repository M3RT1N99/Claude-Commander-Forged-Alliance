import { LuaFactory, type LuaEngine } from 'wasmoon'
import { transpileFaLua, COMPAT_LUA } from './transpile'
import BOOT_LUA from '../engine-lua/boot.lua?raw'

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
      // Byte rein, Byte raus. Der Transpiler arbeitet auf Text, die VM will die
      // ORIGINAL-BYTES — Lua ist byte-transparent, und die Engine transkodiert
      // nichts: sie liest die Datei, wie sie im .scd steht (die Loc-Dateien sind
      // UTF-8, `loc/de/strings_db.lua` enthält „ä" als C3 A4).
      //
      // Ein String darf hier NICHT direkt gemountet werden: Emscripten kodiert
      // ihn als UTF-8, und jedes Byte über 0x7F wäre doppelt kodiert — im Menü
      // stand „Profil Ã¤ndern".
      const { code } = transpileFaLua(bytesToLatin1(bytes))
      // @ts-expect-error luaWasm ist das interne Emscripten-Modul
      this.factory.mountFileSync(this.luaWasm, fsPath, latin1ToBytes(code))
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

  /**
   * Daten aus Lua holen, OHNE dass die VM ausblutet.
   *
   * **Jeder Rückgabewert aus Lua nach JS leckt.** wasmoon hält ihn im
   * Lua-Registry fest; der Lua-GC kann ihn nie einsammeln. Gemessen (2000
   * Aufrufe, Zuwachs NACH einem collectgarbage("collect")):
   *
   *   Tabelle zurückgeben        156,6 MB   ← der maui-Snapshot, 60× pro Sekunde
   *   JSON-String zurückgeben     24,9 MB
   *   Aufruf ohne Rückgabewert     0,0 MB
   *   Lua ruft eine JS-Funktion    0,0 MB   ← dieser Weg
   *
   * Bei 60 Bildern/s waren das rund 5 MB pro Sekunde — nach wenigen Minuten
   * stand die UI-VM an ihrer 2-GB-Grenze und starb mit "not enough memory".
   *
   * Deshalb: für alles, was pro Bild oder pro Beat läuft, gibt Lua NICHTS
   * zurück — es RUFT eine JS-Funktion mit einem JSON-String auf. Der wird beim
   * Übergang kopiert, und in Lua bleibt nichts liegen.
   *
   * `expr` ist ein Lua-Ausdruck, der einen String liefert (z. B.
   * `__mauiSnapshotJson()`).
   */
  pull<T>(expr: string): T {
    let payload = ''
    this.lua.global.set('__pullSink', (s: string) => {
      payload = s
    })
    this.lua.doStringSync(`__pullSink(${expr})`)
    return JSON.parse(payload) as T
  }

  /** Setzt/überschreibt ein globales Symbol (Engine-Funktion, Tabelle). */
  setGlobal(name: string, value: unknown): void {
    // Eine JS-Funktion darf NIEMALS `null` nach Lua zurückgeben: wasmoon prüft
    // den Rückgabewert mit `typeof target !== 'object'` und greift danach auf
    // `target.then` zu (wasmoon/dist/index.js:1020-1026). Für `null` ist
    // `typeof` aber "object" — die VM stirbt mit "Cannot read properties of null
    // (reading 'then')", und zwar irgendwo tief in einer Original-Lua-Datei, die
    // damit nichts zu tun hat. (Gefunden, als GetTextureDimensions für eine
    // fehlende DDS `null` lieferte: die Auswahl der ACU riss die ganze UI-VM um.)
    //
    // `undefined` ist der richtige Wert — daraus wird in Lua `nil`.
    if (typeof value === 'function') {
      const fn = value as (...args: unknown[]) => unknown
      this.lua.global.set(name, (...args: unknown[]) => {
        const r = fn(...args)
        return r === null ? undefined : r
      })
      return
    }
    this.lua.global.set(name, value)
  }

  /**
   * Registriert eine Datei zur Laufzeit im VFS des Hosts (z. B. ein
   * Unit-Blueprint aus units.scd, das erst bei Bedarf gebraucht wird).
   * Key wird kleingeschrieben; führende Slashes entfernt.
   */
  addFile(path: string, bytes: Uint8Array): void {
    this.files.set(path.replace(/^\/+/, '').toLowerCase(), bytes)
  }

  /** Prüft, ob ein Modul-Pfad im Host-VFS vorhanden ist. */
  hasFile(path: string): boolean {
    return this.files.has(path.replace(/^\/+/, '').toLowerCase())
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

/**
 * Bytes ↔ Text, ein Byte = ein Zeichen (echtes Latin-1).
 *
 * `new TextDecoder('latin1')` tut das NICHT: in der WHATWG-Spec ist 'latin1'
 * (wie 'iso-8859-1') ein Alias für **windows-1252**. Byte 0x80 wird dort zu '€'
 * (U+20AC), 0x99 zu '™'. Wer damit dekodiert und die Zeichen später wieder als
 * Bytes nimmt, zerstört jede UTF-8-Datei — und die Loc-Dateien des Spiels SIND
 * UTF-8. Einen byte-treuen Decoder gibt es in der Web-API nicht.
 */
function bytesToLatin1(bytes: Uint8Array): string {
  let out = ''
  const CHUNK = 0x8000 // String.fromCharCode nimmt nicht beliebig viele Argumente
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return out
}

function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff
  return out
}

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
