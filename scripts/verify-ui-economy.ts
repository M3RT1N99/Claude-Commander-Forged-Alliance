/**
 * Schritt 3 aus docs/PLAN-UI.md: Die ECHTE `lua/ui/game/economy.lua` läuft.
 *
 * Kein TS-Nachbau mehr: das Eco-Panel wird von der Original-Lua gebaut
 * (`CreateEconomyBar` → `CreateUI` → `SetLayout` → economy_mini.lua), und
 * `_BeatFunction` (economy.lua:251) liest `GetEconomyTotals()` — die Zahlen
 * unserer Sim.
 *
 * Geprüft wird der Text IN den maui-Controls. Steht dort das, was die Sim
 * gerechnet hat, ist die Kette Sim → Engine → Original-UI-Lua geschlossen.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-ui-economy.ts
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

// --- VFS + all DDS measurements (the UI measures its bitmaps by the textures) --------
const files = new Map<string, Uint8Array>()
const allPaths = new Set<string>()
const ddsBytes = new Map<string, Uint8Array>()
const openFiles: NodeFile[] = []
const archives = (await readdir(`${GAME}/gamedata`))
  .filter((n) => n.toLowerCase().endsWith('.scd'))
  .sort((a, b) => a.localeCompare(b))
for (const archive of archives) {
  const f = await NodeFile.open(`${GAME}/gamedata/${archive}`)
  openFiles.push(f)
  const zip = await ZipArchive.open(f)
  for (const [key, entry] of zip.entries) {
    const k = key.toLowerCase()
    allPaths.add(k)
    if (key.endsWith('.lua') && !files.has(key)) files.set(key, await zip.read(entry))
    // Only preload the UI textures — the Lua queries their dimensions synchronously.
    if (k.startsWith('textures/ui/') && k.endsWith('.dds') && !ddsBytes.has(k)) {
      ddsBytes.set(k, await zip.read(entry))
    }
  }
}
console.log(`${files.size} Lua files, ${ddsBytes.size} UI textures`)

const dims = new Map<string, [number, number]>()
const textureSize = (p: string): [number, number] | null => {
  const hit = dims.get(p)
  if (hit) return hit
  const bytes = ddsBytes.get(p)
  if (!bytes) return null // the skin chain also asks for files that don't exist
  const dds = parseDds(bytes)
  const out: [number, number] = [dds.width, dds.height]
  dims.set(p, out)
  return out
}

const warnings: string[] = []
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})
installUiEngine(host, {
  exists: (p) => allPaths.has(p),
  find: (dir, pattern) => findFiles(allPaths, dir, pattern),
  textureSize,
  // Without font metrics, there is no text layout. The width is a fixed value here
  // per character — the test does NOT measure text widths, it checks text content.
  stringAdvance: (text, _family, size) => text.length * size * 0.5,
  // Test metric: the test checks TEXT CONTENT, not text mass.
  fontMetrics: (_family, size) => [size * 0.8, size * 0.2],
})
createRootFrame(host, 1920, 1080)
setupUi(host)

console.log('\n== Die echte economy.lua baut das Panel ==')
let err: string | null = null
try {
  host.eval(`
    Economy = import('/lua/ui/game/economy.lua')
    Economy.CreateEconomyBar(GetFrame(0))
  `)
} catch (e) {
  err = (e as Error).message.split('\n')[0] ?? String(e)
}
check(err === null, err === null ? 'CreateEconomyBar() lief durch' : `CreateEconomyBar(): ${err}`)

if (err === null) {
  console.log('\n== Sim-Zahlen rein, Original-Lua rechnet, Text raus ==')
  // Exactly the state after the ACU spawn (verify-econ-lua): full warehouse,
  // 20 E/s + 1 M/s income, no consumption.
  host.eval(`__uiSetEconomy(650, 4000, 650, 4000, 1, 20, 0, 0, 0, 0)`)
  host.eval(`Economy._BeatFunction()`)

  const massCur = String(host.eval(`return Economy.GUI.mass.curStorage:GetText()`))
  const massMax = String(host.eval(`return Economy.GUI.mass.maxStorage:GetText()`))
  const energyCur = String(host.eval(`return Economy.GUI.energy.curStorage:GetText()`))
  const massIncome = String(host.eval(`return Economy.GUI.mass.income:GetText()`))
  const energyIncome = String(host.eval(`return Economy.GUI.energy.income:GetText()`))

  check(massCur === '650', `Masse-Vorrat: "${massCur}" (Sim: 650)`)
  check(massMax === '650', `Masse-Lager: "${massMax}" (aus der ACU: StorageMass)`)
  check(energyCur === '4000', `Energie-Vorrat: "${energyCur}" (Sim: 4000)`)
  check(massIncome === '+1', `Masse-Einkommen: "${massIncome}" (Blueprint: 1/s)`)
  check(energyIncome === '+20', `Energie-Einkommen: "${energyIncome}" (Blueprint: 20/s)`)

  console.log('\n== Das Panel misst sich selbst — 324×72 kommen aus der DDS ==')
  const w = Number(host.eval(`return Economy.GUI.bg.panel.Width()`))
  const h = Number(host.eval(`return Economy.GUI.bg.panel.Height()`))
  check(w === 324, `panel.Width() = ${w}`)
  check(h === 72, `panel.Height() = ${h}`)

  console.log('\n== Der BALKEN bewegt sich mit dem Vorrat (StatusBar) ==')
  // statusbar.lua:57-63 sets `_bar.Right` as the LazyVar FUNCTION, the
  // `_CalcRangePercent()` reads - so the bar is only as wide as that
  // level. If you don't re-evaluate the width, you'll have a bar that is
  // Shows numbers but never moves.
  // The RECTANGLE (Right − Left) is measured, not `Width()`: bitmap.lua:67-70
  // pins Width firmly to the TEXTURE WIDTH. That's exactly what the beam is hanging on
  // remained — the renderer read Width, and that never changes.
  const barWidth = (): number =>
    Number(
      host.eval(`
        local bar = Economy.GUI.mass.storageBar._bar
        return bar.Right() - bar.Left()
      `),
    )
  const barPinnedWidth = Number(host.eval(`return Economy.GUI.mass.storageBar._bar.Width()`))

  // __uiSetEconomy(maxM, maxE, storedM, storedE, …) — the WAREHOUSE first.
  host.eval(`__uiSetEconomy(650, 4000, 650, 4000, 1, 20, 0, 0, 0, 0)`)
  host.eval(`Economy._BeatFunction()`)
  const full = barWidth()

  host.eval(`__uiSetEconomy(650, 4000, 325, 4000, 1, 20, 0, 0, 0, 0)`)
  host.eval(`Economy._BeatFunction()`)
  const half = barWidth()

  host.eval(`__uiSetEconomy(650, 4000, 0, 4000, 1, 20, 0, 0, 0, 0)`)
  host.eval(`Economy._BeatFunction()`)
  const empty = barWidth()

  check(full > 0, `Volles Lager: Balken ${full.toFixed(0)} px breit`)
  check(
    Math.abs(half - full / 2) <= 1,
    `Halbes Lager (325/650): Balken halb so breit — ${half.toFixed(0)} px (voll: ${full.toFixed(0)})`,
  )
  check(empty === 0, `Leeres Lager: Balken ${empty.toFixed(0)} px`)
  check(
    barPinnedWidth > full,
    `And Width() remains the TEXTURE WIDTH (${barPinnedWidth}) — that's why it has to ` +
      'the renderer takes the rectangle (bitmap.lua:67-70)',
  )

  // And the same as the RENDERER sees: the snapshot must have the width
  // from the rectangle, not from Width().
  const snapBar = host.eval(`
    for _, c in ipairs(__mauiSnapshot()) do
      if __mauiControls[c.id] == Economy.GUI.mass.storageBar._bar then
        return string.format('%.0f', c.width)
      end
    end
    return 'not in snapshot'
  `) as string
  check(
    snapBar === '0',
    `The snapshot reports the real bar width to the renderer: ${snapBar} px (stock empty)`,
  )
}

console.log('\n== Event pump: hit test + original bubbling ==')
// The Eco panel is located at (16.3) and is 324x72 (economy_mini.lua).
// A click in the middle must hit a control; not a click far away.
const MODS = `{ Shift = false, Ctrl = false, Alt = false, Left = true, Middle = false, Right = false }`
// Click INS panel: belongs to the UI — the world is not allowed to see it.
const onPanel = host.eval(`return __mauiMouse('ButtonPress', 100, 40, ${MODS})`)
// Click far away: just the root frame — the world gets it.
const onWorld = host.eval(`return __mauiMouse('ButtonPress', 900, 900, ${MODS})`)
check(onPanel === true, 'Click on the eco panel belongs to the UI (no movement command)')
check(onWorld === false, 'Clicking next to it only hits the root frame → the world gets it')

// Bubbling: a child that returns false passes the event up to the parent
// (Cfile:1124525). If it gets there, the chain is correct.
// The child is a BITMAP, not a group: the hit test only hits whatever
// DRAWS (otherwise the invisible full-screen containers of the original UI
// eat every click — see verify-ui-panels). The bubbling itself is from it
// untouched: the event goes up the parent chain from the hit control.
const bubbled = host.eval(`
  local Group = import('/lua/maui/group.lua').Group
  local Bitmap = import('/lua/maui/bitmap.lua').Bitmap
  local parent = Group(GetFrame(0), 'bubbleParent')
  parent.Left:Set(500) parent.Top:Set(500) parent.Width:Set(100) parent.Height:Set(100)
  local child = Bitmap(parent)
  child:SetSolidColor('ff204060')
  child.Left:Set(500) child.Top:Set(500) child.Width:Set(50) child.Height:Set(50)
  local reached = false
  child.HandleEvent = function(self, event) return false end
  parent.HandleEvent = function(self, event) reached = true; return true end
  __mauiMouse('ButtonPress', 510, 510, { Shift = false, Ctrl = false, Alt = false })
  return reached
`)
check(bubbled === true, 'Kind liefert false → Event landet beim Parent (Cfile:1124525)')

if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN (erste 3):`)
  for (const w of warnings.slice(0, 3)) console.log(`  ${w.slice(0, 120)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nUI-ECONOMY BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
