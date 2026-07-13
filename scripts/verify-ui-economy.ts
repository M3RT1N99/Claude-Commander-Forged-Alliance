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

// --- VFS + alle DDS-Maße (die UI misst ihre Bitmaps an den Texturen) --------
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
    // Nur die UI-Texturen vorladen — die Lua fragt ihre Maße synchron ab.
    if (k.startsWith('textures/ui/') && k.endsWith('.dds') && !ddsBytes.has(k)) {
      ddsBytes.set(k, await zip.read(entry))
    }
  }
}
console.log(`${files.size} Lua-Dateien, ${ddsBytes.size} UI-Texturen`)

const dims = new Map<string, [number, number]>()
const textureSize = (p: string): [number, number] | null => {
  const hit = dims.get(p)
  if (hit) return hit
  const bytes = ddsBytes.get(p)
  if (!bytes) return null // die Skin-Kette fragt auch nach Dateien, die es nicht gibt
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
  // Ohne Schriftmetrik kein Text-Layout. Die Breite ist hier ein fester Wert
  // pro Zeichen — der Test misst KEINE Textbreiten, er prüft Textinhalte.
  stringAdvance: (text, _family, size) => text.length * size * 0.5,
})
setupUi(host)
createRootFrame(host, 1920, 1080)

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
  // Genau der Zustand nach dem ACU-Spawn (verify-econ-lua): volles Lager,
  // 20 E/s + 1 M/s Einkommen, kein Verbrauch.
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
}

if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN (erste 3):`)
  for (const w of warnings.slice(0, 3)) console.log(`  ${w.slice(0, 120)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nUI-ECONOMY BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
