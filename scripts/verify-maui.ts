/**
 * Schritt 2 aus docs/PLAN-UI.md: Das maui-Substrat trägt.
 *
 * Geprüft wird headless, ohne DOM — nur die LazyVar-Zahlen. Wenn die stimmen,
 * rechnet die Original-`layouthelpers.lua` richtig, und jede weitere
 * `lua/ui`-Datei bekommt ihr Layout geschenkt.
 *
 * Der entscheidende Test ist der letzte: ein Bitmap OHNE Layout-Helfer misst
 * sich nach seiner DDS (bitmap.lua:69-70 → BitmapWidth/BitmapHeight, die die
 * Engine aus den Texturmaßen füllt, Cfile:1118647). Kommt dort 324×72 heraus,
 * ist bewiesen, dass die Zahlen, die `hud.ts` von Hand einbetoniert hat, aus
 * dem Substrat von selbst herausfallen.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-maui.ts
 */
import { open, readdir, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { installUiEngine, setupUi, createRootFrame } from '../src/lua/uiEngine'
import { findFiles } from '../src/vfs/glob'
import { parseDds } from '../src/formats/dds'

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

// --- VFS (alle Archive, erstes gewinnt — wie im Browser) --------------------
const files = new Map<string, Uint8Array>()
const allPaths = new Set<string>()
const openFiles: NodeFile[] = []
const zips: ZipArchive[] = []
const archives = (await readdir(`${GAME}/gamedata`))
  .filter((n) => n.toLowerCase().endsWith('.scd'))
  .sort((a, b) => a.localeCompare(b))
for (const archive of archives) {
  const f = await NodeFile.open(`${GAME}/gamedata/${archive}`)
  openFiles.push(f)
  const zip = await ZipArchive.open(f)
  zips.push(zip)
  for (const [key, entry] of zip.entries) {
    allPaths.add(key.toLowerCase())
    if (key.endsWith('.lua') && !files.has(key)) files.set(key, await zip.read(entry))
  }
}

// Die Lua ruft GetTextureDimensions synchron; das Lesen aus dem Zip ist async.
// Also werden die Texturen dieses Tests vorher geladen. Wird eine andere
// verlangt, KNALLT es — statt still 0×0 zu behaupten.
const textureBytes = new Map<string, Uint8Array>()
const PRELOAD = ['textures/ui/uef/game/resource-panel/resources_panel_bmp.dds']
for (const p of PRELOAD) {
  for (const zip of zips) {
    const entry = zip.get(p)
    if (entry) {
      textureBytes.set(p, await zip.read(entry))
      break
    }
  }
}

/** Texturmaße aus dem echten DDS-Header (die Engine liest denselben). */
const textureSize = (p: string): [number, number] => {
  const bytes = textureBytes.get(p)
  if (!bytes) throw new Error(`Textur nicht vorgeladen: ${p}`)
  const dds = parseDds(bytes)
  return [dds.width, dds.height]
}

const host = await LuaHost.create(files, () => {})
installUiEngine(host, {
  exists: (p) => allPaths.has(p),
  find: (dir, pattern) => findFiles(allPaths, dir, pattern),
  textureSize,
})
setupUi(host)
createRootFrame(host, 800, 600)

console.log('\n== Root-Frame: GetFrame(0), erzeugt über die Original-Frame-Klasse ==')
// InternalCreateFrame → attachControl (7 LazyVars) → DoInit → Control.OnInit
// (control.lua:42) → ResetLayout() → die zirkuläre Kette.
host.eval(`
  Group = import('/lua/maui/group.lua').Group
  Bitmap = import('/lua/maui/bitmap.lua').Bitmap
  LayoutHelpers = import('/lua/maui/layouthelpers.lua')
  root = GetFrame(0)
`)
check(Number(host.eval('return root.Right()')) === 800, `root.Right() = 800 (Left + Width, control.lua:36)`)
check(Number(host.eval('return root.Bottom()')) === 600, `root.Bottom() = 600 (Top + Height)`)
check(Number(host.eval('return root.Depth()')) === 0, `root.Depth() = 0 (frame.lua:10)`)

console.log('\n== LayoutHelpers rechnet — die Original-Datei, nicht TS ==')
host.eval(`
  child = Group(root, 'child')
  child.Width:Set(100)
  child.Height:Set(50)
  LayoutHelpers.AtLeftTopIn(child, root, 16, 3)
`)
check(Number(host.eval('return child.Left()')) === 16, `child.Left() = 16 (AtLeftTopIn)`)
check(Number(host.eval('return child.Top()')) === 3, `child.Top() = 3`)
check(Number(host.eval('return child.Depth()')) === 1, `child.Depth() = 1 (Parent + 1, control.lua:46)`)

console.log('\n== Ein Bitmap misst sich nach seiner DDS ==')
// DAS ist der Beweis: 324×72 stehen heute als Konstante in hud.ts — hier fallen
// sie aus dem Substrat heraus, ohne dass jemand sie hinschreibt.
host.eval(`
  UIUtil = import('/lua/ui/uiutil.lua')
  panel = Bitmap(root, UIUtil.UIFile('/game/resource-panel/resources_panel_bmp.dds'), 'ecoPanel')
`)
const w = Number(host.eval('return panel.Width()'))
const h = Number(host.eval('return panel.Height()'))
check(w === 324, `panel.Width() = ${w} (aus der DDS, nicht aus TS)`)
check(h === 72, `panel.Height() = ${h} (aus der DDS)`)

console.log('\n== Die zirkuläre Layout-Kette MUSS knallen, wenn zu wenig gesetzt ist ==')
// lazyvar.lua:21 — "circular dependency in lazy evaluation". Kommt der Fehler
// nicht, rechnet das Layout still Unsinn.
let circErr = false
try {
  host.eval(`local g = Group(root, 'unset'); return g.Left()`)
} catch (e) {
  circErr = /circular dependency/.test((e as Error).message)
}
check(circErr, 'Zu wenig gesetzte Variablen → "circular dependency" (lazyvar.lua:21)')

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nMAUI BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
