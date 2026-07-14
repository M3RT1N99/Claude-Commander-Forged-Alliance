/**
 * Schritt 4 aus docs/PLAN-UI.md: die Spiel-Panels der Original-UI laufen —
 * und die AUSWAHL treibt sie an.
 *
 * Geprüft wird die echte Kette, headless und ohne DOM:
 *
 *   __uiSetUnit(...)          die Engine spiegelt den Sim-Zustand in die UI-VM
 *                             (Moho::UserUnit::UpdateUnitData @0x8C0750)
 *   __uiSelectByIds{...}      → SelectUnits → gamemain.OnSelectionChanged
 *                             (Moho::SelectionListener::Receive, Cfile:1294170)
 *   orders.lua                baut die Befehls-Buttons aus GetUnitCommandData
 *   construction.lua          baut das Bau-Menü aus EntityCategoryGetUnitList
 *   unitview.lua              zeigt Name/Leben der Rollover-Unit
 *
 * Nichts davon ist nachgebaut: die vier .lua-Dateien sind die des Spiels. Wenn
 * dieser Test grün ist, zeigt der Browser dasselbe — er nimmt exakt denselben
 * Boot-Pfad (setupGameUi in src/lua/uiEngine.ts).
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-ui-panels.ts
 */
import { open, readdir, readFile, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import {
  installUiEngine,
  setupUi,
  setupGameUi,
  createRootFrame,
  loadUiBlueprints,
} from '../src/lua/uiEngine'
import { findFiles } from '../src/vfs/glob'
import { parseDds } from '../src/formats/dds'
import { FontBook } from '../src/ui/fonts'

class NodeFile implements RandomAccessFile {
  private constructor(
    private readonly fh: FileHandle,
    readonly size: number,
  ) {}
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
const quiet = process.argv.includes('--quiet')
const log = (msg: string): void => {
  if (!quiet) console.log(`  · ${msg}`)
}

// --- VFS: alle Archive, erstes gewinnt (wie im Browser) ---------------------
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
    // .lua UND .bp: LoadBlueprints() führt die .bp-Dateien als Lua aus.
    if ((key.endsWith('.lua') || key.endsWith('.bp')) && !files.has(key)) {
      files.set(key, await zip.read(entry))
    }
  }
}
const bpPaths = [...allPaths].filter((p) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(p))

// Texturmaße: die maui-Lua fragt sie SYNCHRON (ein Bitmap ohne Layout-Helfer
// bemisst sich nach seiner DDS). Also vorher lesen — dieselben Dateien, die die
// Engine liest.
const dims = new Map<string, [number, number]>()
for (const zip of zips) {
  for (const [key, entry] of zip.entries) {
    if (!key.startsWith('textures/ui/') || !key.endsWith('.dds') || dims.has(key)) continue
    try {
      const dds = parseDds(await zip.read(entry))
      dims.set(key, [dds.width, dds.height])
    } catch {
      // Kaputte DDS: nicht raten. Die Lua bekommt nil und der Skin-Fallback greift.
    }
  }
}

// Die Schriften des Spiels — echte Metrik, keine geschätzte (siehe src/ui/fonts.ts).
const fonts = new FontBook()
for (const name of await readdir(`${GAME}/fonts`)) {
  if (/\.ttf$/i.test(name)) fonts.add(await readFile(`${GAME}/fonts/${name}`))
}

console.log(`\n== UI-VM booten (${files.size} Lua-Dateien, ${dims.size} Texturmaße) ==`)
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') log(`UI-WARN: ${msg.slice(0, 200)}`)
})
installUiEngine(host, {
  exists: (p) => allPaths.has(p),
  find: (dir, pattern) => findFiles(allPaths, dir, pattern),
  textureSize: (p) => dims.get(p) ?? null,
  stringAdvance: (text, family, size) => fonts.advance(text, family, size),
  fontMetrics: (family, size) => fonts.metrics(family, size),
})
setupUi(host)
createRootFrame(host, 1920, 1080)

check(fonts.has('Arial') && fonts.has('Zeroes Three'), 'Arial + Zeroes Three aus <GameDir>/fonts')
const arial = fonts.metrics('Arial', 14)
check(arial[0] > 10 && arial[0] < 16, `Arial-Oberlänge bei 14px = ${arial[0].toFixed(2)} (aus der TTF)`)

const bpCount = loadUiBlueprints(host, bpPaths)
check(bpCount > 500, `${bpCount} Blueprints in der UI-VM (echte Pipeline)`)

console.log('\n== Die vier Original-Panels aufbauen (gamemain.lua:145-153) ==')
setupGameUi(host, log)
// Erst ein Frame, dann messen: die Grids der Original-UI legen ihre Kinder in
// OnFrame aus (grid.lua:40-48) — genau wie die Engine es pro Bild tut.
host.eval('__mauiFrame(0.016)')

const controls = Number(host.eval('return table.getn(__mauiSnapshot())'))
check(controls > 50, `${controls} maui-Controls mit vollständigem Layout`)
// Jedes sichtbare Control MUSS ein Layout haben; ein übersprungenes ist ein Fund.
const broken = Number(host.eval('local n = 0 for _ in pairs(__mauiBroken) do n = n + 1 end return n'))
check(broken === 0, `kein Control ohne Layout (übersprungen: ${broken})`)

console.log('\n== Auswahl: __uiSetUnit → SelectUnits → OnSelectionChanged ==')
// Die ACU, so wie die Sim sie meldet.
host.eval(`__uiSetUnit(1, 'uel0001', 1, 100, 20, 100, 12000, 12000, 1, true)`)
const selected = Number(host.eval('return __uiSelectByIds({ 1 })'))
check(selected === 1, 'SelectUnits({acu}) → 1 Einheit ausgewählt')
check(
  Number(host.eval('local s = GetSelectedUnits() return s and table.getn(s) or 0')) === 1,
  'GetSelectedUnits() liefert die ACU (Cfile:1361395: nil bei leerer Auswahl)',
)
check(
  String(host.eval(`return GetSelectedUnits()[1]:GetBlueprint().BlueprintId`)) === 'uel0001',
  'Das UserUnit-Objekt trägt den echten Blueprint',
)

console.log('\n== orders.lua: die Befehls-Buttons kommen aus dem Blueprint ==')
// GetUnitCommandData → General.CommandCaps der ACU. Move/Stop/Attack MÜSSEN da
// sein, sonst hat die UI ihre Befehle erfunden.
// Die Buttons stehen im Grid der Original-orders.lua (orders.lua:868 SetItem).
// Ausgelesen wird der Grid-Inhalt, nicht eine Nachbau-Tabelle.
host.eval(`
  __t = { orders = {}, enabled = {} }
  local grid = __ui.ordersModule.controls.orderButtonGrid
  local cols, rows = grid:GetDimensions()
  for row = 1, rows do
    for col = 1, cols do
      local item = grid:GetItem(col, row)
      if item and item._order then
        __t.orders[item._order] = true
        __t.enabled[item._order] = not item:IsDisabled()
      end
    end
  end
`)
const orderCount = Number(host.eval('local n = 0 for _ in pairs(__t.orders) do n = n + 1 end return n'))
check(orderCount > 0, `${orderCount} Order-Buttons im Grid der Original-Lua`)
check(host.eval(`return __t.orders['RULEUCC_Move'] == true`) === true, 'RULEUCC_Move existiert')
check(
  host.eval(`return __t.enabled['RULEUCC_Move'] == true`) === true,
  'RULEUCC_Move ist aktiv, sobald die ACU ausgewählt ist (Blueprint: CommandCaps)',
)
check(
  host.eval(`return __t.enabled['RULEUCC_Nuke'] ~= true`) === true,
  'RULEUCC_Nuke bleibt aus — die ACU hat die Fähigkeit nicht',
)

console.log('\n== construction.lua: das Bau-Menü kommt aus dem Blueprint ==')
// Die ACU baut, was ihre BuildableCategory hergibt (uel0001_unit.bp). Die Liste
// zieht construction.lua über EntityCategoryGetUnitList — nicht über eine
// handgeschriebene Tabelle.
// Genau der Weg aus construction.lua:1677-1681: die Kategorien kommen aus
// GetUnitCommandData (Engine, aus bp.Economy.BuildableCategory), die Liste aus
// EntityCategoryGetUnitList.
const buildable = Number(
  host.eval(`
    local _, _, cats = GetUnitCommandData(GetSelectedUnits())
    return table.getn(EntityCategoryGetUnitList(cats))
  `),
)
check(buildable > 10, `${buildable} baubare Einheiten für die ACU (EntityCategoryGetUnitList)`)
// Die Liste ist nicht irgendeine: die ACU baut GEBÄUDE (ueb0101 = T1-Landfabrik,
// Kategorie BUILTBYCOMMANDER, ueb0101_unit.bp:50) — und eben KEINE Panzer
// (uel0101 baut die Fabrik). Genau das unterscheidet ein echtes Bau-Menü von
// einer geratenen Liste.
const inMenu = (bp: string): boolean =>
  host.eval(`
    local _, _, cats = GetUnitCommandData(GetSelectedUnits())
    for _, id in ipairs(EntityCategoryGetUnitList(cats)) do
      if id == '${bp}' then return true end
    end
    return false
  `) === true
check(inMenu('ueb0101'), 'ueb0101 (T1-Landfabrik) steht im Bau-Menü der ACU')
check(!inMenu('uel0101'), 'uel0101 (Panzer) steht NICHT drin — den baut die Fabrik')

console.log('\n== unitview.lua: Rollover zeigt die echte Unit ==')
host.eval('__uiSetRollover(1)')
const rollover = host.eval(`
  local info = GetRolloverInfo()
  return info and info.blueprintId or false
`)
check(rollover === 'uel0001', 'GetRolloverInfo().blueprintId = uel0001')

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nUI-PANELS BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
