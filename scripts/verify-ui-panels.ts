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
  applySession,
} from '../src/lua/uiEngine'
import { SANDBOX_SESSION } from '../src/sim/session'
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
createRootFrame(host, 1920, 1080)
setupUi(host)

check(fonts.has('Arial') && fonts.has('Zeroes Three'), 'Arial + Zeroes Three aus <GameDir>/fonts')
const arial = fonts.metrics('Arial', 14)
check(arial[0] > 10 && arial[0] < 16, `Arial-Oberlänge bei 14px = ${arial[0].toFixed(2)} (aus der TTF)`)

const bpCount = loadUiBlueprints(host, bpPaths)
check(bpCount > 500, `${bpCount} Blueprints in der UI-VM (echte Pipeline)`)

console.log('\n== Die Session (GetArmiesTable / SessionGetScenarioInfo) ==')
// Ohne Session melden die Session-Globals „no active session." — wie das
// Original (Cfile:1330339). Nichts wird still behauptet.
const noSession = host.eval(`
  local ok, err = pcall(SessionRequestPause)
  return tostring(ok) .. '|' .. tostring(err)
`) as string
check(
  noSession.startsWith('false') && noSession.includes('no active session'),
  `ohne Session knallt SessionRequestPause: ${noSession.split('|')[1]?.replace(/\[string "[\s\S]*?"\]:?\d*:?\s*/, '')}`,
)

// Dieselbe Session, die auch die Sim bekommt (SANDBOX_SESSION) — EIN Weg für
// Browser und Test (applySession in src/lua/uiEngine.ts).
applySession(host, { ...SANDBOX_SESSION, map: 'SCMP_009' })
check(Number(host.eval('return GetArmiesTable().numArmies')) === 1, 'GetArmiesTable(): 1 Armee')
check(Number(host.eval('return GetArmiesTable().focusArmy')) === 1, 'focusArmy = 1 (1-basiert wie die Engine)')
// faction ist 0-BASIERT: gamemain.lua:109 rechnet `faction + 1` in factions.lua.
check(
  Number(host.eval('return GetArmiesTable().armiesTable[1].faction')) === 0,
  'faction der UEF-Armee = 0 (die Lua rechnet +1, Cfile:1267057)',
)
check(
  String(host.eval('return GetArmiesTable().armiesTable[1].nickname')) === 'Commander',
  'nickname aus der Session (gamemain.lua:83 setzt damit den ACU-Namen)',
)
check(
  host.eval('return GetArmiesTable().armiesTable[1].human') === true &&
    host.eval('return GetArmiesTable().armiesTable[1].showScore') === true,
  'human/showScore gesetzt (die Engine setzt beide, Cfile:1267068/1267076)',
)
check(
  String(host.eval("return type(SessionGetScenarioInfo().Options)")) === 'table',
  'SessionGetScenarioInfo().Options existiert (tabs.lua:21, diplomacy.lua:34 greifen ungeprüft zu)',
)
check(Number(host.eval('return SessionGetLocalCommandSource()')) === 1, 'lokale Befehlsquelle = 1')

// Pause: die UI verlangt sie, die Engine reicht sie an die SIM weiter. Ohne
// Naht knallt es (kein stiller No-Op) — hier wird die Naht gesetzt und geprüft.
let paused: boolean | null = null
host.setGlobal('__uiPauseSink', (p: boolean) => {
  paused = p
})
host.eval('SessionRequestPause()')
check(paused === true && host.eval('return SessionIsPaused()') === true, 'SessionRequestPause hält die Sim an')
host.eval('SessionResume()')
check(paused === false && host.eval('return SessionIsPaused()') === false, 'SessionResume lässt sie weiterlaufen')

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

// Kein Panel darf KOMPLETT aus dem Bild fallen. Die Original-UI rechnet ihr
// Layout gegen den Root-Frame (= Fenstergröße); säße daneben noch ein
// Web-Rahmen, läge das Orders-Panel (links 17, unten 0) hinter der Seitenleiste
// und wäre unsichtbar — deshalb läuft die Sandbox im Vollbild-Spielmodus.
//
// Teilweise überstehende Controls sind KEIN Fehler: die Klammern hängen im
// Original absichtlich über den Rand (orders_mini.lua:22 setzt die Klammer auf
// -17). Wer das verbietet, nagelt eine Lüge fest.
const outside = host.eval(`
  local bad = {}
  for _, c in ipairs(__mauiSnapshot()) do
    local right, bottom = c.left + c.width, c.top + c.height
    if right <= 0 or bottom <= 0 or c.left >= 1920 or c.top >= 1080 then
      bad[table.getn(bad) + 1] = c.name .. '(' .. c.kind .. ') @' .. math.floor(c.left) .. ',' .. math.floor(c.top)
    end
  end
  return table.concat(bad, '; ')
`) as string
check(
  outside === '',
  `kein Control fällt komplett aus dem Bild (1920×1080)${outside ? ' — draußen: ' + outside : ''}`,
)

console.log('\n== Die Reiter oben: Menü, Diplomatie, Pause (tabs.lua) ==')
// Genau der Ast, der im Browser gestorben ist: tabs.lua:482 BuildContent baut
// den Inhalt — 'main' aus seiner eigenen Menü-Tabelle, 'diplomacy' über
// diplomacy.lua:CreateContent (das schon beim Import SessionGetScenarioInfo()
// ruft). Ohne Session war beides tot; CollapseWindow lief danach auf ein
// `false` und riss die UI mit.
const tabMenu = host.eval(`
  local ok, err = pcall(function() import('/lua/ui/game/tabs.lua').BuildContent('main') end)
  return tostring(ok) .. '|' .. tostring(err)
`) as string
check(tabMenu.startsWith('true'), `Reiter „Menü" öffnet sich${tabMenu.startsWith('true') ? '' : ' — ' + tabMenu}`)
check(
  Number(host.eval(`return table.getn(import('/lua/ui/game/tabs.lua').controls.contentGroup.Buttons)`)) === 7,
  '7 Knöpfe im Spielmenü (Save/Load/Options/Restart/End/Exit/Close — tabs.lua:63-100)',
)

// Das Aufklappen ist eine ANIMATION über mehrere Bilder (tabs.lua:561-584: der
// Rahmen wächst, dann fährt der Boden aus, dann blendet der Inhalt ein). Sie
// muss ZU ENDE laufen, bevor der nächste Reiter dran ist — im Spiel sperrt
// `animationLock` genau dafür (tabs.lua:544). Ohne Frames dazwischen prüfte der
// Test einen Zustand, den die Engine nie erreicht.
const frames = (n: number) => {
  for (let i = 0; i < n; i++) host.eval('__mauiFrame(0.016)')
}
frames(30)

// Umschalten auf Diplomatie: erst CollapseWindow (Ausblenden), dann ruft der
// Callback BuildContent erneut — und der baut diplomacy.CreateContent.
// diplomacy.lua liest schon beim Import SessionGetScenarioInfo().Options.TeamLock.
host.eval(`import('/lua/ui/game/tabs.lua').BuildContent('diplomacy')`)
frames(60)
const diplo = host.eval(`
  local t = import('/lua/ui/game/tabs.lua')
  return tostring(t.controls.contentGroup and t.controls.contentGroup:GetName() or 'nichts')
`) as string
check(
  diplo !== 'nichts',
  `Reiter „Diplomatie" baut seinen Inhalt (diplomacy.lua:34 liest Options.TeamLock): ${diplo}`,
)

console.log('\n== Hit-Test: die freie Spielfläche gehört der Welt ==')
// Im Original ist die Spielwelt selbst ein Control (CUIWorldView) INNERHALB der
// mapGroup — in der Tiefenordnung also ÜBER den unsichtbaren Vollbild-Containern
// (CreateScreenGroup deaktiviert seinen Hit-Test NICHT, uiutil.lua:333). Ein
// Klick in die freie Fläche trifft dort die WorldView, nie den Container.
//
// Bei uns ist die Welt noch kein maui-Control. Fängt ein Container den Klick,
// ist KEINE EINHEIT MEHR SELEKTIERBAR — genau dieser Fehler stand im Browser
// (der Treffer war die "GameMain ScreenGroup"). Deshalb gilt: nur ein Control,
// das etwas ZEICHNET (Bitmap/Text), verbraucht einen Klick.
// Die freie Fläche IST die WorldView — ein echtes Control (CUIWorldView), das
// gamemain.lua:142 in die mapGroup hängt. Sie verbraucht den Klick NICHT: im
// Original behandelt sie ihn selbst (Auswahl, Befehl, Bau), bei uns tut das die
// 3D-Seite. Die alte Krücke („ein Treffer auf einen unsichtbaren Container
// gehört der Welt") ist damit weg.
const worldHit = String(
  host.eval(`local c = __mauiHitTest(960, 500) if not c then return 'NICHTS' end return c.__kind`),
)
check(worldHit === 'worldview', `der Klick in die freie Fläche trifft die WorldView (${worldHit})`)
check(
  host.eval(`return __mauiMouse('ButtonPress', 960, 500, { Left = true })`) === false,
  'und die UI verbraucht ihn NICHT — er gehört der Welt',
)

console.log('\n== Auswahl: __uiSetUnit → SelectUnits → OnSelectionChanged ==')
// Die ACU, so wie die Sim sie meldet.
// Die Naht zur Sim: ohne sie KNALLT jeder Befehl (statt still zu verpuffen).
// Hier wird nur mitgeschrieben, was die UI schicken WÜRDE.
host.eval('__t = { simCommands = {} }')
host.setGlobal('__uiSimCommand', (name: string) => {
  host.eval(`table.insert(__t.simCommands, '${name}')`)
})
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
  __t.orders = {}
  __t.enabled = {}
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

// Die Gegenprobe zum Hit-Test oben: das Orders-Panel gibt es erst MIT Auswahl
// (orders.lua hält es sonst versteckt). Jetzt liegt dort ein Bitmap — und ein
// Klick darauf ist ein UI-Klick, kein Bewegungsbefehl.
check(
  host.eval(`return __ui.ordersModule.controls.bg:IsHidden() == false`) === true,
  'Mit Auswahl ist das Orders-Panel sichtbar (vorher: hidden)',
)
check(
  host.eval(`return __mauiMouse('ButtonPress', 30, 1075, { Left = true })`) === true,
  'Klick auf das Orders-Panel WIRD verbraucht (dort zeichnet ein Bitmap)',
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

console.log('\n== Klick aufs Bau-Icon: der Bau-Modus startet, die Auswahl bleibt ==')
// Der Weg, den ein Spieler nimmt: ACU wählen → Bau-Icon anklicken → Gebäude
// setzen. Ging der Klick versehentlich an die WELT (weil eine unsichtbare Gruppe
// über dem Icon lag), wurde die ACU stattdessen abgewählt.
//
// Das Icon wird NICHT gesucht, sondern beim Namen genommen: construction.lua
// hängt jedem Bau-Button seine Blueprint-ID an (`item.id`), und der Klick landet
// über den Original-Weg in commandmode.StartCommandMode('build', {name=id}).
// Erst ein Frame: die Grids der Original-UI legen ihre Kinder in OnFrame aus
// (grid.lua:40-48) — nach einer Selektion ist das Bau-Menü frisch befüllt.
host.eval('__mauiFrame(0.016)')
// specialgrid.lua:108 hängt die Item-Daten als `control.Data` an den Button.
// Genommen wird das erste GEBÄUDE im Menü (MotionType RULEUMT_None) — nur das
// startet den Bau-Modus; mobile Einheiten baut die Fabrik (construction.lua:878).
// Welcher Tab gerade offen ist, darf dem Test egal sein.
host.eval(`
  __t.icon = false
  __t.iconId = false
  for _, c in pairs(__mauiControls) do
    if not c.__destroyed and not __t.icon and c.Data and c.Data.type == 'item' and c.Data.id then
      local bp = __blueprints[c.Data.id]
      -- Gebäude (RULEUMT_None) UND kein Upgrade der ausgewählten Unit:
      -- construction.lua:875 schickt Upgrades direkt als IssueBlueprintCommand,
      -- nur alles andere geht in den Bau-Modus (construction.lua:878-880).
      local upgrades = bp and bp.General and bp.General.UpgradesFrom
      local isUpgrade = upgrades ~= nil and upgrades ~= 'none' and upgrades ~= ''
      if bp and bp.Physics.MotionType == 'RULEUMT_None' and not isUpgrade and not c:IsHidden() then
        __t.icon = c
        __t.iconId = c.Data.id
      end
    end
  end
`)
const iconId = String(host.eval('return __t.iconId or ""'))
const hasIcon = host.eval(`return __t.icon ~= false`) === true
check(hasIcon, `Ein Gebäude-Icon steht im Bau-Menü: ${iconId} (construction.lua)`)
if (hasIcon) {
  const pos = host.eval(`
    local c = __t.icon
    return { x = math.floor(c.Left() + c.Width() / 2), y = math.floor(c.Top() + c.Height() / 2) }
  `) as { x: number; y: number }
  // Ein Klick ist Drücken UND Loslassen — und zwar über den Dragger: button.lua
  // feuert OnClick erst in dragger:OnRelease (button.lua:122-133). Wer nur
  // ButtonPress schickt, sieht nie einen Klick.
  check(
    host.eval(
      `return __mauiMouse('ButtonPress', ${pos.x}, ${pos.y}, { Left = true }, 1)`,
    ) === true,
    `Klick auf das Icon (${pos.x}, ${pos.y}) gehört der UI — NICHT der Welt`,
  )
  check(
    host.eval('return __mauiDragger ~= false') === true,
    'Der ButtonPress hat einen Dragger gesetzt (PostDragger, button.lua:160)',
  )
  host.eval(`__mauiMouse('ButtonRelease', ${pos.x}, ${pos.y}, { Left = true }, 1)`)
  check(
    host.eval('return __mauiDragger == false') === true,
    'Das Loslassen hat den Dragger beendet (OnRelease → Destroy, dragger.lua:15)',
  )
  const cm = host.eval(`
    local m = import('/lua/ui/game/commandmode.lua').GetCommandMode()
    return { mode = m[1] or false, name = (m[2] and m[2].name) or false }
  `) as { mode: string | false; name: string | false }
  check(
    cm.mode === 'build' && cm.name === iconId,
    `Der Bau-Modus läuft: ${String(cm.mode)}/${String(cm.name)} (commandmode.lua)`,
  )
  check(
    Number(host.eval('local s = GetSelectedUnits() return s and table.getn(s) or 0')) === 1,
    'Die ACU ist NOCH ausgewählt (der Klick war kein Welt-Klick)',
  )
}

console.log('\n== Abwahl darf die UI nicht töten ==')
// GetUnitCommandData liefert bei leerer Auswahl LEERE TABELLEN (die Engine legt
// sie hinter der Unit-Schleife immer an, Cfile:1264740). Gab unsere Version nil
// zurück, starb orders.lua:891 beim ersten Klick ins Leere.
let deselectOk = true
try {
  host.eval('__uiSelectByIds({})')
} catch {
  deselectOk = false
}
check(deselectOk, 'SelectUnits({}) überlebt orders.lua/construction.lua')
check(
  host.eval('return GetSelectedUnits() == nil') === true,
  'GetSelectedUnits() ist danach nil (Cfile:1361395)',
)
// Und die Auswahl wieder herstellen, damit die folgenden Prüfungen stimmen.
host.eval(`__uiSelectByIds({ 1 })`)

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
