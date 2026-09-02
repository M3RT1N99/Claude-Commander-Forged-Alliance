/**
 * Schritt 1 aus docs/PLAN-UI.md: Die UI-VM bootet und `SetupUI()` aus dem
 * Original-`uimain.lua` läuft durch.
 *
 * Das ist der Einstiegspunkt, den die Engine selbst ruft (Cfile:1262316:
 * `SCR_Import('/lua/ui/uimain.lua')['SetupUI']()`). Läuft er, sind Skin, Layout
 * und Cursor gesetzt — und die Fallback-Kette von `UIUtil.UIFile` löst echte
 * Texturpfade im VFS auf. Damit steht das Fundament für den maui-Layer.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-ui-boot.ts
 */
import { open, readdir, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { installUiEngine, setupUi } from '../src/lua/uiEngine'
import { findFiles } from '../src/vfs/glob'

class NodeFile implements RandomAccessFile {
  private constructor(private readonly fh: FileHandle, readonly size: number) {}
  static async open(p: string): Promise<NodeFile> {
    const fh = await open(p, 'r')
    return new NodeFile(fh, (await fh.stat()).size)
  }
  async slice(s: number, e: number): Promise<ArrayBuffer> {
    if (e <= s) return new ArrayBuffer(0)
    const b = Buffer.alloc(e - s)
    await this.fh.read(b, 0, e - s, s)
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
  }
  close(): Promise<void> {
    return this.fh.close()
  }
}

const GAME =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

// --- VFS: alle Archive, gleiche Priorität wie im Browser (erstes gewinnt) ---
// Auch loc_*.scd: Localization.lua sucht sich die installierte Sprache selbst
// (okLanguage(), localization.lua:20-32) — diese Installation ist deutsch.
const files = new Map<string, Uint8Array>()
const allPaths = new Set<string>()
const openFiles: NodeFile[] = []
const archives = (await readdir(`${GAME}/gamedata`))
  .filter((n) => n.toLowerCase().endsWith('.scd'))
  .sort((a, b) => a.localeCompare(b))
for (const archive of archives) {
  const f = await NodeFile.open(`${GAME}/gamedata/${archive}`)
  openFiles.push(f)
  const zip = await ZipArchive.open(f)
  for (const [key, entry] of zip.entries) {
    allPaths.add(key.toLowerCase())
    if (key.endsWith('.lua') && !files.has(key)) files.set(key, await zip.read(entry))
  }
}

const warnings: string[] = []
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})

const uiFs = {
  exists: (p: string): boolean => allPaths.has(p),
  find: (dir: string, pattern: string): string[] => findFiles(allPaths, dir, pattern),
}

console.log('\n== UI-VM booten (zweiter Lua-State, scr_UserInits) ==')
installUiEngine(host, uiFs)

// ── Die UI-VM bootet /lua/userInit.lua, nicht eine Liste von Hand ──────────
//
// `userInit.lua` ist das Gegenstueck zu `simInit.lua`: es zieht globalInit nach
// (userinit.lua:11) und definiert danach selbst `WaitFrames`/`WaitSeconds`
// (userinit.lua:13-21), `FrontEndData` (:24) und `Prefetcher` (:27). Solange
// die Datei nicht laeuft, stammt das alles aus einem Nachbau — und `moho`
// bleibt in der C-Form liegen, weil niemand `ConvertCClassToLuaClass` ruft.
console.log()
console.log('== Der UI-Boot ist /lua/userInit.lua (Cfile: userInit -> globalInit) ==')
{
  const quelle = (fn: string): string =>
    String(host.eval(`local i = debug.getinfo(${fn}, 'S') return i.short_src .. ':' .. i.linedefined`))
  check(
    quelle('WaitSeconds').includes('userinit.lua'),
    `WaitSeconds kommt aus der Original-Datei (${quelle('WaitSeconds')})`,
  )
  check(
    host.eval(`return WaitFrames == coroutine.yield`) === true,
    'WaitFrames IST coroutine.yield (userinit.lua:13) — kein Wrapper davor',
  )
  check(host.eval(`return type(FrontEndData)`) === 'table', 'FrontEndData steht (userinit.lua:24)')
  check(host.eval(`return type(Prefetcher)`) === 'table', 'Prefetcher steht (userinit.lua:27)')
  check(
    host.eval(`return type(rawget(_G, '__language'))`) === 'string',
    '__language kommt aus den Einstellungen (userinit.lua:8)',
  )
  // Und die moho-Umwandlung, die globalInit.lua:31-34 macht: ohne sie ist
  // `moho.control_methods` eine Methodenliste und keine Klasse, und jedes
  // maui-Control faellt beim ersten `Class(...)` um.
  check(
    host.eval(`return getmetatable(moho.control_methods) == Class`) === true,
    'moho ist umgewandelt (globalInit.lua:31-34) — Controls sind echte Klassen',
  )
}
check(host.eval('return type(_c_CreateCursor)') === 'function', '_c_CreateCursor ist da (UI-Global)')
check(
  host.eval('return rawget(_G, "CreateUnit") == nil') === true,
  'CreateUnit ist NICHT da (Sim-Global, gehört nicht in die UI)',
)

// KEIN Stub-Trap: config.lua:56 haengt selbst eine Metatable an _G, die den
// Zugriff auf ein nicht existierendes Global zum Fehler macht ("access to
// nonexistent global variable"). Das Original bringt die Anti-Stub-Regel also
// mit — ein Trap wuerde sie ueberschreiben.

console.log('\n== SetupUI() aus dem Original-uimain.lua ==')
let setupErr: string | null = null
try {
  setupUi(host)
} catch (e) {
  setupErr = (e as Error).message.split('\n')[0] ?? String(e)
}
check(setupErr === null, setupErr === null ? 'SetupUI() lief durch' : `SetupUI(): ${setupErr}`)

if (setupErr === null) {
  console.log('\n== Layout steht (aus der Original-Lua, nicht aus TS) ==')
  // `currentSkin` ist ein local in uiutil.lua:83 — kein Export. Der Skin zeigt
  // sich unten im aufgelösten Texturpfad, das ist ohnehin der bessere Beweis.
  const layout = host.eval(`return import('/lua/ui/uiutil.lua').currentLayout`)
  check(layout === 'bottom', `currentLayout = ${String(layout)} (uimain.lua:32)`)

  console.log('\n== UIUtil.GetLayoutFilename: die echte Layout-Datei ==')
  const eco = host.eval(`return import('/lua/ui/uiutil.lua').GetLayoutFilename('economy')`)
  check(
    typeof eco === 'string' && eco.includes('economy'),
    `GetLayoutFilename('economy') = ${String(eco)}`,
  )

  console.log('\n== UIUtil.UIFile: Skin-Fallback-Kette löst echte Texturen auf ==')
  const bmp = host.eval(
    `return import('/lua/ui/uiutil.lua').UIFile('/game/resource-panel/resources_panel_bmp.dds')`,
  )
  const bmpPath = String(bmp)
  check(
    typeof bmp === 'string' && allPaths.has(bmpPath.replace(/^\/+/, '').toLowerCase()),
    `UIFile(resources_panel_bmp.dds) = ${bmpPath} (existiert im VFS)`,
  )
  check(
    bmpPath.toLowerCase().includes('/uef/'),
    `Skin greift: Pfad liegt im uef-Skin (uimain.lua:34 setzt 'uef')`,
  )

  console.log('\n== Cursor: echtes maui-Objekt, keine Attrappe ==')
  const cursorTex = host.eval(`return __cursor and __cursor.__texture`)
  check(typeof cursorTex === 'string', `SetCursor bekam eine Textur: ${String(cursorTex)}`)
}

if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN (erste 3):`)
  for (const w of warnings.slice(0, 3)) console.log(`  ${w.slice(0, 120)}`)
}

console.log()
console.log('== GetFocusPosition liefert eine TABELLE, keine userdata ==')
{
  // Die 3D-Seite gibt den Brennpunkt als Objekt zurueck, nicht als Array: ein
  // JS-Array kommt in dieser wasmoon-Fassung als `js_proxy`-userdata an
  // (ProxyTypeExtension Prioritaet 3 vor TableTypeExtension 0), und darauf
  // laufen `#p`, `ipairs(p)` und der FA-Dialekt `for i, v in p do` ins Leere.
  const achsen: Record<string, number> = { focusX: 11, focusY: 22, focusZ: 33 }
  host.setGlobal('__uiCameraBridge', (op: string, _name: string, what: string) =>
    op === 'get' ? achsen[what] : undefined,
  )
  const art = String(host.eval(`return type(GetCamera('WorldCamera'):GetFocusPosition())`))
  check(art === 'table', `der Typ ist table (${art})`)
  check(
    String(host.eval(`local p = GetCamera('WorldCamera'):GetFocusPosition()
      return string.format('%g,%g,%g|%d', p[1], p[2], p[3], #p)`)) === '11,22,33|3',
    'sie ist indizierbar und hat die Laenge 3',
  )
  check(
    host.eval(`local p = GetCamera('WorldCamera'):GetFocusPosition()
      return p.x == 11 and p.y == 22 and p.z == 33`) === true,
    'und .x/.y/.z lesen dieselben Felder (Vector-Metatabelle)',
  )
  // Und sie ist KEINE userdata — das war der Fehler: die 3D-Seite gab ein
  // Array zurueck, und alles, was kein Primitivwert ist, kommt in dieser
  // wasmoon-Fassung als js_proxy-userdata an (nachgemessen: Array UND
  // einfaches Objekt). Deshalb holt die Lua-Seite jetzt drei ZAHLEN.
  check(
    String(host.eval(`return type(__uiCameraGet('WorldCamera', 'focusX'))`)) === 'number',
    'die Bruecke liefert Zahlen, keine zusammengesetzten Werte',
  )
  // `ipairs` wird hier bewusst NICHT verlangt: die Vector-Metatabelle wirft
  // fuer jeden Schluessel ausser x/y/z ("'x', 'y', or 'z' expected"), und das
  // tut sie im Original genauso (Cfile:596716-596732). Eine Pruefung, die
  // ipairs fordert, verlangte etwas, das die Engine auch nicht kann.
}
host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nUI-BOOT BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
