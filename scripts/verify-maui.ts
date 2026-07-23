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

// --- VFS (all archives, first wins — like in the browser) --------------------
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

// The Lua calls GetTextureDimensions synchronously; reading from the zip is async.
// So the textures of this test are loaded beforehand. Will be another
// demands, it BANGS — instead of silently asserting 0×0.
const textureBytes = new Map<string, Uint8Array>()
const PRELOAD = [
  'textures/ui/uef/game/resource-panel/resources_panel_bmp.dds',
  // A real 9-slice frame of the game (orders.lua:427-434 builds it from it).
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

/** Texture dimensions from the real DDS header (the engine reads the same). */
const textureSize = (p: string): [number, number] => {
  const bytes = textureBytes.get(p)
  if (!bytes) throw new Error(`Texture not preloaded: ${p}`)
  const dds = parseDds(bytes)
  return [dds.width, dds.height]
}

const host = await LuaHost.create(files, () => {})
installUiEngine(host, {
  exists: (p) => allPaths.has(p),
  find: (dir, pattern) => findFiles(allPaths, dir, pattern),
  textureSize,
})
createRootFrame(host, 800, 600)
setupUi(host)

console.log('\n== Root frame: GetFrame(0), created via the original frame class ==')
// InternalCreateFrame → attachControl (7 LazyVars) → DoInit → Control.OnInit
// (control.lua:42) → ResetLayout() → the circular chain.
host.eval(`
  Group = import('/lua/maui/group.lua').Group
  Bitmap = import('/lua/maui/bitmap.lua').Bitmap
  LayoutHelpers = import('/lua/maui/layouthelpers.lua')
  root = GetFrame(0)
`)
check(Number(host.eval('return root.Right()')) === 800, `root.Right() = 800 (Left + Width, control.lua:36)`)
check(Number(host.eval('return root.Bottom()')) === 600, `root.Bottom() = 600 (Top + Height)`)
check(Number(host.eval('return root.Depth()')) === 0, `root.Depth() = 0 (frame.lua:10)`)

console.log('\n== LayoutHelpers calculates — the original file, not TS ==')
host.eval(`
  child = Group(root, 'child')
  child.Width:Set(100)
  child.Height:Set(50)
  LayoutHelpers.AtLeftTopIn(child, root, 16, 3)
`)
check(Number(host.eval('return child.Left()')) === 16, `child.Left() = 16 (AtLeftTopIn)`)
check(Number(host.eval('return child.Top()')) === 3, `child.Top() = 3`)
check(Number(host.eval('return child.Depth()')) === 1, `child.Depth() = 1 (Parent + 1, control.lua:46)`)

console.log('\n== A bitmap is measured by its DDS ==')
// THIS is the proof: 324×72 is now a constant in hud.ts - fall here
// them out of the substrate without anyone writing them down.
host.eval(`
  UIUtil = import('/lua/ui/uiutil.lua')
  panel = Bitmap(root, UIUtil.UIFile('/game/resource-panel/resources_panel_bmp.dds'), 'ecoPanel')
`)
const w = Number(host.eval('return panel.Width()'))
const h = Number(host.eval('return panel.Height()'))
check(w === 324, `panel.Width() = ${w} (from DDS, not from TS)`)
check(h === 72, `panel.Height() = ${h} (from the DDS)`)

console.log('\n== The circular layout chain MUST pop if too little is set ==')
// lazyvar.lua:21 — "circular dependency in lazy evaluation". The error comes
// not, the layout silently calculates nonsense.
let circErr = false
try {
  host.eval(`local g = Group(root, 'unset'); return g.Left()`)
} catch (e) {
  circErr = /circular dependency/.test((e as Error).message)
}
check(circErr, 'Zu wenig gesetzte Variablen → "circular dependency" (lazyvar.lua:21)')

console.log('\n== M1: The border is a real control (CMauiBorder) ==')
// border.lua:11-13 says it itself: "SetTextures will set the BorderWidth and
// BorderHeight lazy vars." The engine takes the dimensions from the TEXTURES
// (Cfile:1122728/1122748) — not from a number in the script.
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
check(bw === vertDds.width, `BorderWidth() = ${bw} — the width of the vertical DDS (${vertDds.width})`)
check(bh === horzDds.height, `BorderHeight() = ${bh} — the height of the horizontal DDS (${horzDds.height})`)
// LayoutAroundControl puts it AROUND the control: Left = child.Left − BorderWidth.
check(
  Number(host.eval('return brd.Left()')) === 16 - bw,
  `The frame is on the outside (Left = child.Left − BorderWidth)`,
)
const inSnapshot = host.eval(`
  for _, c in ipairs(__mauiSnapshot()) do
    if c.kind == 'border' then return true end
  end
  return false
`)
check(inSnapshot === true, 'The border is in the snapshot - the renderer gets its 8 tiles')

console.log('\n== M1: Keyboard focus — whoever types gets the keys alone ==')
// Cfile:1147634-1147650: if there is a control focus, the keydown ONLY goes to this.
// If it returns false, the capture stack is NOT asked - the event is
// "skipped" and from then on belongs to the keymap (M3).
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
check(host.eval('return GetCurrentFocusControl() == focusA') === true, 'AcquireKeyboardFocus sets the focus')
host.eval(`__mauiKey('KeyDown', 65, 65, {})`)
check(
  Number(host.eval('return gotA')) === 1 && Number(host.eval('return gotB')) === 0,
  'The KeyDown ONLY goes to the focus control',
)
// A ButtonPress somewhere else removes focus (Cfile:1147523-1147531).
host.eval(`__mauiMouse('ButtonPress', 900, 900, { Left = true }, 1)`)
check(
  host.eval('return GetCurrentFocusControl() == nil') === true,
  'A click next to it removes the keyboard focus',
)

console.log('\n== M1: InputCapture — this is how a dialog becomes modal ==')
// Cfile:1147376-1147390: if the stack is not empty, the hit test starts at
// top capture control instead of the root frame. Everything next to it is for the mouse
// invisible — this is uiutil.lua:615 MakeInputModal.
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
  'Without capture, the click hits the control next to it',
)
host.eval('AddInputCapture(dialog)')
check(host.eval('return AnyInputCapture()') === true, 'AddInputCapture sets the stack')
check(
  host.eval(`return __mauiHitTest(150, 150) == nil`) === true,
  'WITH Capture, clicking next to it no longer hits ANYTHING (modal)',
)
check(
  host.eval(`return __mauiHitTest(550, 550) == dialog`) === true,
  'The dialog itself remains clickable',
)
host.eval('RemoveInputCapture(dialog)')
check(
  host.eval(`return AnyInputCapture() == false and __mauiHitTest(150, 150) == outside`) === true,
  'RemoveInputCapture releases the mouse again',
)

console.log('\n== M1: The UI VM ticks per IMAGE, not per SIM tick ==')
// userinit.lua:13-21 — WaitFrames = coroutine.yield, WaitSeconds pollt
// CurrentTime(). The UI VM does not have a tick scheduler; their threads are running
// the pictures. So far they have NOT worked for us at all (the sim scheduler was
// installed, but nobody ticked it) — that's what they depend on
// Menu animations and the cursor thread (cursor.lua:34-43).
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

// WaitSeconds polls the clock - after 0.5 s (at 0.1 s/frame) it is further.
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
