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
const PRELOAD = [
  'textures/ui/uef/game/resource-panel/resources_panel_bmp.dds',
  // Ein echter 9-Slice-Rahmen des Spiels (orders.lua:427-434 baut ihn daraus).
  'textures/ui/uef/game/ability_brd/chat_brd_vert_l.dds',
  'textures/ui/uef/game/ability_brd/chat_brd_horz_um.dds',
  'textures/ui/uef/game/ability_brd/chat_brd_ul.dds',
  'textures/ui/uef/game/ability_brd/chat_brd_ur.dds',
  'textures/ui/uef/game/ability_brd/chat_brd_ll.dds',
  'textures/ui/uef/game/ability_brd/chat_brd_lr.dds',
]
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

console.log('\n== M1: Der Border ist ein echtes Control (CMauiBorder) ==')
// border.lua:11-13 sagt es selbst: "SetTextures will set the BorderWidth and
// BorderHeight lazy vars." Die Engine nimmt die Maße aus den TEXTUREN
// (Cfile:1122728/1122748) — nicht aus einer Zahl im Skript.
const vertDds = parseDds(textureBytes.get('textures/ui/uef/game/ability_brd/chat_brd_vert_l.dds')!)
const horzDds = parseDds(textureBytes.get('textures/ui/uef/game/ability_brd/chat_brd_horz_um.dds')!)
host.eval(`
  Border = import('/lua/maui/border.lua').Border
  brd = Border(root, 'testBorder')
  brd:SetTextures(
    UIUtil.UIFile('/game/ability_brd/chat_brd_vert_l.dds'),
    UIUtil.UIFile('/game/ability_brd/chat_brd_horz_um.dds'),
    UIUtil.UIFile('/game/ability_brd/chat_brd_ul.dds'),
    UIUtil.UIFile('/game/ability_brd/chat_brd_ur.dds'),
    UIUtil.UIFile('/game/ability_brd/chat_brd_ll.dds'),
    UIUtil.UIFile('/game/ability_brd/chat_brd_lr.dds'))
  brd:LayoutAroundControl(child, 0)
`)
const bw = Number(host.eval('return brd.BorderWidth()'))
const bh = Number(host.eval('return brd.BorderHeight()'))
check(bw === vertDds.width, `BorderWidth() = ${bw} — die Breite der vertical-DDS (${vertDds.width})`)
check(bh === horzDds.height, `BorderHeight() = ${bh} — die Höhe der horizontal-DDS (${horzDds.height})`)
// LayoutAroundControl legt ihn UM das Control: Left = child.Left − BorderWidth.
check(
  Number(host.eval('return brd.Left()')) === 16 - bw,
  `Der Rahmen liegt außen herum (Left = child.Left − BorderWidth)`,
)
const inSnapshot = host.eval(`
  for _, c in ipairs(__mauiSnapshot()) do
    if c.kind == 'border' then return true end
  end
  return false
`)
check(inSnapshot === true, 'Der Border steht im Snapshot — der Renderer bekommt seine 8 Kacheln')

console.log('\n== M1: Tastatur-Fokus — wer tippt, bekommt die Tasten allein ==')
// Cfile:1147634-1147650: hat ein Control Fokus, geht das KeyDown NUR an dieses.
// Liefert es false, wird der Capture-Stack NICHT gefragt — das Event ist
// "skipped" und gehört ab dann der Keymap (M3).
host.eval(`
  focusA = Group(root, 'focusA')
  focusA.Left:Set(0) focusA.Top:Set(0) focusA.Width:Set(10) focusA.Height:Set(10)
  focusB = Group(root, 'focusB')
  focusB.Left:Set(0) focusB.Top:Set(0) focusB.Width:Set(10) focusB.Height:Set(10)
  gotA, gotB = 0, 0
  focusA.HandleEvent = function(self, event) gotA = gotA + 1 return true end
  focusB.HandleEvent = function(self, event) gotB = gotB + 1 return true end
  focusA:AcquireKeyboardFocus(false)
`)
check(host.eval('return GetCurrentFocusControl() == focusA') === true, 'AcquireKeyboardFocus setzt den Fokus')
host.eval(`__mauiKey('KeyDown', 65, 65, {})`)
check(
  Number(host.eval('return gotA')) === 1 && Number(host.eval('return gotB')) === 0,
  'Das KeyDown geht NUR an das Fokus-Control',
)
// Ein ButtonPress woanders entzieht den Fokus (Cfile:1147523-1147531).
host.eval(`__mauiMouse('ButtonPress', 900, 900, { Left = true }, 1)`)
check(
  host.eval('return GetCurrentFocusControl() == nil') === true,
  'Ein Klick daneben entzieht den Tastatur-Fokus',
)

console.log('\n== M1: InputCapture — so wird ein Dialog modal ==')
// Cfile:1147376-1147390: ist der Stack nicht leer, startet der Hit-Test beim
// obersten Capture-Control statt am Root-Frame. Alles daneben ist für die Maus
// unsichtbar — das ist uiutil.lua:615 MakeInputModal.
host.eval(`
  dialog = Bitmap(root)
  dialog:SetSolidColor('ff102030')
  dialog.Left:Set(500) dialog.Top:Set(500) dialog.Width:Set(100) dialog.Height:Set(100)
  outside = Bitmap(root)
  outside:SetSolidColor('ff204060')
  outside.Left:Set(100) outside.Top:Set(100) outside.Width:Set(100) outside.Height:Set(100)
`)
check(
  host.eval(`return __mauiHitTest(150, 150) == outside`) === true,
  'Ohne Capture trifft der Klick das Control daneben',
)
host.eval('AddInputCapture(dialog)')
check(host.eval('return AnyInputCapture()') === true, 'AddInputCapture setzt den Stack')
check(
  host.eval(`return __mauiHitTest(150, 150) == nil`) === true,
  'MIT Capture trifft ein Klick daneben NICHTS mehr (modal)',
)
check(
  host.eval(`return __mauiHitTest(550, 550) == dialog`) === true,
  'Der Dialog selbst bleibt anklickbar',
)
host.eval('RemoveInputCapture(dialog)')
check(
  host.eval(`return AnyInputCapture() == false and __mauiHitTest(150, 150) == outside`) === true,
  'RemoveInputCapture gibt die Maus wieder frei',
)

console.log('\n== M1: Die UI-VM tickt pro BILD, nicht pro Sim-Tick ==')
// userinit.lua:13-21 — WaitFrames = coroutine.yield, WaitSeconds pollt
// CurrentTime(). Die UI-VM hat keinen Tick-Scheduler; ihre Threads laufen mit
// den Bildern. Bei uns liefen sie bisher GAR NICHT (der Sim-Scheduler war
// installiert, aber niemand hat ihn getickt) — daran hängen die
// Menü-Animationen und der Cursor-Thread (cursor.lua:34-43).
host.eval(`
  frames = 0
  animThread = ForkThread(function()
    while true do
      frames = frames + 1
      WaitFrames(1)
    end
  end)
`)
check(Number(host.eval('return frames')) === 0, 'Vor dem ersten Bild hat der Thread nichts getan')
for (let i = 0; i < 5; i++) host.eval('__mauiFrame(0.016)')
check(Number(host.eval('return frames')) === 5, `Nach 5 Bildern lief der Thread 5-mal`)

// WaitSeconds pollt die Uhr — nach 0,5 s (bei 0,1 s/Bild) ist er weiter.
host.eval(`
  waited = false
  ForkThread(function()
    WaitSeconds(0.5)
    waited = true
  end)
`)
for (let i = 0; i < 4; i++) host.eval('__mauiFrame(0.1)')
check(host.eval('return waited') === false, 'Nach 0,4 s wartet der Thread noch')
for (let i = 0; i < 3; i++) host.eval('__mauiFrame(0.1)')
check(host.eval('return waited') === true, 'Nach 0,6 s ist er durch (WaitSeconds pollt CurrentTime)')

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nMAUI BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
