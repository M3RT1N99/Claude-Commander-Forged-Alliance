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

// --- VFS: all archives, same priority as in the browser (first wins) ---
// loc_*.scd: Localization.lua also looks for the installed language itself
// (okLanguage(), localization.lua:20-32) — this installation is German.
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
check(host.eval('return type(_c_CreateCursor)') === 'function', '_c_CreateCursor is here (UI-Global)')
check(
  host.eval('return rawget(_G, "CreateUnit") == nil') === true,
  'CreateUnit is NOT there (Sim-Global, does not belong in the UI)',
)

// NO stub trap: config.lua:56 itself appends a metatable to _G that contains the
// Accessing a non-existent global makes an error ("access to
// nonexistent global variable"). The original brings the anti-stub rule
// with — a trap would overwrite it.

console.log('\n== SetupUI() from the Original-uimain.lua ==')
let setupErr: string | null = null
try {
  setupUi(host)
} catch (e) {
  setupErr = (e as Error).message.split('\n')[0] ?? String(e)
}
check(setupErr === null, setupErr === null ? 'SetupUI() went through' : `SetupUI(): ${setupErr}`)

if (setupErr === null) {
  console.log('\n== Layout is available (from the original Lua, not from TS) ==')
  // `currentSkin` is a local in uiutil.lua:83 — not an export. The skin shows
  // at the bottom of the resolved texture path, that's better proof anyway.
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

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nUI-BOOT BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
