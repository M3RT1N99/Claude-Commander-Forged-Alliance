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

// --- VFS: all archives, first wins (like in the browser) ---------------------
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
    // .lua AND .bp: LoadBlueprints() runs the .bp files as Lua.
    if ((key.endsWith('.lua') || key.endsWith('.bp')) && !files.has(key)) {
      files.set(key, await zip.read(entry))
    }
  }
}
const bpPaths = [...allPaths].filter((p) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(p))

// Texture dimensions: the maui-Lua asks them SYNCHRONOUSLY (a bitmap without layout helper
// is measured by his DDS). So read beforehand — the same files that the
// Engine liest.
const dims = new Map<string, [number, number]>()
for (const zip of zips) {
  for (const [key, entry] of zip.entries) {
    if (!key.startsWith('textures/ui/') || !key.endsWith('.dds') || dims.has(key)) continue
    try {
      const dds = parseDds(await zip.read(entry))
      dims.set(key, [dds.width, dds.height])
    } catch {
      // Broken DDS: don't guess. The Lua gets nil and the skin fallback takes effect.
    }
  }
}

// The game's fonts — real metrics, not estimated ones (see src/ui/fonts.ts).
const fonts = new FontBook()
for (const name of await readdir(`${GAME}/fonts`)) {
  if (/\.ttf$/i.test(name)) fonts.add(await readFile(`${GAME}/fonts/${name}`))
}

console.log(`\n== Boot UI VM (${files.size} Lua files, ${dims.size} texture dimensions) ==`)
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

check(fonts.has('Arial') && fonts.has('Zeroes Three'), 'Arial + Zeroes Three from <GameDir>/fonts')
const arial = fonts.metrics('Arial', 14)
check(arial[0] > 10 && arial[0] < 16, `Arial ascender at 14px = ${arial[0].toFixed(2)} (from the TTF)`)

const bpCount = loadUiBlueprints(host, bpPaths)
check(bpCount > 500, `${bpCount} Blueprints in the UI VM (real pipeline)`)

console.log('\n== The Session (GetArmiesTable / SessionGetScenarioInfo) ==')
// Without a session, the session globals report "no active session." - like that
// Original (Cfile:1330339). Nothing is quietly stated.
const noSession = host.eval(`
  local ok, err = pcall(SessionRequestPause)
  return tostring(ok) .. '|' .. tostring(err)
`) as string
check(
  noSession.startsWith('false') && noSession.includes('no active session'),
  `ohne Session knallt SessionRequestPause: ${noSession.split('|')[1]?.replace(/\[string "[\s\S]*?"\]:?\d*:?\s*/, '')}`,
)

// The same session that the sim gets (SANDBOX_SESSION) — ONE way for
// Browser and test (applySession in src/lua/uiEngine.ts).
applySession(host, { ...SANDBOX_SESSION, map: 'SCMP_009' })
check(
  Number(host.eval('return GetArmiesTable().numArmies')) === 2,
  'GetArmiesTable(): 2 armies (ARMY_1 + the selftest enemy ARMY_2)',
)
check(Number(host.eval('return GetArmiesTable().focusArmy')) === 1, 'focusArmy = 1 (1-basiert wie die Engine)')
// faction is 0-BASED: gamemain.lua:109 converts `faction + 1` into factions.lua.
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
  'SessionGetScenarioInfo().Options exists (tabs.lua:21, diplomacy.lua:34 access unchecked)',
)
check(Number(host.eval('return SessionGetLocalCommandSource()')) === 1, 'lokale Befehlsquelle = 1')

// Pause: the UI requests it, the engine passes it on to the SIM. Without
// The seam pops (not a silent no-op) - this is where the seam is placed and checked.
let paused: boolean | null = null
host.setGlobal('__uiPauseSink', (p: boolean) => {
  paused = p
})
host.eval('SessionRequestPause()')
check(paused === true && host.eval('return SessionIsPaused()') === true, 'SessionRequestPause pauses the sim')
host.eval('SessionResume()')
check(paused === false && host.eval('return SessionIsPaused()') === false, 'SessionResume keeps it running')

console.log('\n== Die vier Original-Panels aufbauen (gamemain.lua:145-153) ==')
setupGameUi(host, log)
// First a frame, then measure: the grids of the original UI put their children in
// OnFrame off (grid.lua:40-48) — just like the engine does per frame.
host.eval('__mauiFrame(0.016)')

const controls = Number(host.eval('return table.getn(__mauiSnapshot())'))
check(controls > 50, `${controls} maui-Controls mit vollständigem Layout`)
// Every visible control MUST have a layout; a skipped one is a find.
const broken = Number(host.eval('local n = 0 for _ in pairs(__mauiBroken) do n = n + 1 end return n'))
check(broken === 0, `kein Control ohne Layout (übersprungen: ${broken})`)

// No panel should be COMPLETELY out of the picture. The original UI works for you
// Layout against the root frame (= window size); would sit next to it
// Web frame, the Orders panel (left 17, bottom 0) would be behind the sidebar
// and would be invisible — that's why the sandbox runs in full-screen game mode.
//
// Controls that partially protrude are NOT an error: the brackets are hanging in the
// Original intentionally over the edge (orders_mini.lua:22 puts the bracket on
// -17). Anyone who forbids this is perpetuating a lie.
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
  `kein Control fällt komplett aus dem Bild (1920×1080)${outside ? '- outside:' + outside : ''}`,
)

console.log('\n== The tabs at the top: Menu, Diplomacy, Pause (tabs.lua) ==')
// Exactly the branch that died in the browser: tabs.lua:482 BuildContent builds
// the content — 'main' from its own menu table, 'diplomacy' above
// diplomacy.lua:CreateContent (which was already created during import SessionGetScenarioInfo()
// calls). Without a session, both were dead; CollapseWindow then ran on
// `false` and took the UI with it.
const tabMenu = host.eval(`
  local ok, err = pcall(function() import('/lua/ui/game/tabs.lua').BuildContent('main') end)
  return tostring(ok) .. '|' .. tostring(err)
`) as string
check(tabMenu.startsWith('true'), `Reiter „Menü"opens${tabMenu.startsWith('true')?'' : ' — ' + tabMenu}`)
check(
  Number(host.eval(`return table.getn(import('/lua/ui/game/tabs.lua').controls.contentGroup.Buttons)`)) === 7,
  '7 buttons in the game menu (Save/Load/Options/Restart/End/Exit/Close — tabs.lua:63-100)',
)

// The opening is an ANIMATION over several images (tabs.lua:561-584: the
// frame grows, then the floor extends, then the content fades in). She
// must FINISH before it is the next rider's turn - blocked in the game
// `animationLock` exactly for that (tabs.lua:544). It checked without any frames in between
// Test a state that the engine never reaches.
const frames = (n: number) => {
  for (let i = 0; i < n; i++) host.eval('__mauiFrame(0.016)')
}
frames(30)

// Switch to diplomacy: first CollapseWindow (hide), then it calls
// Callback BuildContent again — and it builds diplomacy.CreateContent.
// diplomacy.lua reads SessionGetScenarioInfo().Options.TeamLock during import.
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

console.log('\n== Hit test: the free playing area belongs to the world ==')
// In the original, the game world itself is a control (CUIWorldView) WITHIN the
// mapGroup — in depth order ABOVE the invisible full-screen containers
// (CreateScreenGroup does NOT disable its hit test, uiutil.lua:333). A
// Clicking in the free area hits the WorldView, never the container.
//
// With us the world is not yet under Maui control. If a container catches the click,
// NO UNIT CAN BE SELECTED ANYMORE - exactly this error was in the browser
// (the hit was the "GameMain ScreenGroup"). Therefore: only one control,
// that DRAWS something (bitmap/text) uses one click.
// The free area IS the WorldView — a real control (CUIWorldView) that
// gamemain.lua:142 hangs in the mapGroup. It does NOT consume the click: in
// Originally she handles it herself (selection, command, construction), with us she does it
// 3D page. The old crutch (“a hit on an invisible container
// belongs to the world") is gone.
const worldHit = String(
  host.eval(`local c = __mauiHitTest(960, 500) if not c then return 'NICHTS' end return c.__kind`),
)
check(worldHit === 'worldview', `der Klick in die freie Fläche trifft die WorldView (${worldHit})`)
check(
  host.eval(`return __mauiMouse('ButtonPress', 960, 500, { Left = true })`) === false,
  'and the UI does NOT consume it — it belongs to the world',
)

console.log('\n== Auswahl: __uiSetUnit → SelectUnits → OnSelectionChanged ==')
// The ACU as the sim reports it.
// The seam to the sim: without it, every command BANGS (instead of fizzling out quietly).
// Only what the UI WOULD send is recorded here.
host.eval('__t = { simCommands = {} }')
host.setGlobal('__uiSimCommand', (name: string) => {
  host.eval(`table.insert(__t.simCommands, '${name}')`)
})
host.eval(`__uiSetUnit(1, 'uel0001', 1, 100, 20, 100, 12000, 12000, 1, true)`)
const selected = Number(host.eval('return __uiSelectByIds({ 1 })'))
check(selected === 1, 'SelectUnits({acu}) → 1 unit selected')
check(
  Number(host.eval('local s = GetSelectedUnits() return s and table.getn(s) or 0')) === 1,
  'GetSelectedUnits() liefert die ACU (Cfile:1361395: nil bei leerer Auswahl)',
)
check(
  String(host.eval(`return GetSelectedUnits()[1]:GetBlueprint().BlueprintId`)) === 'uel0001',
  'The UserUnit object carries the real blueprint',
)

console.log('\n== Kategorien + Avatare: die Engine-Sicht auf UserUnits ==')
// The category bridge (globals.lua entityBp): the engine checks categories
// on UserUnits as well as on Sim Entities (cfunc_EntityCategoryContains).
// Without it, EVERY filter in the UI returns empty lists — avatar tabs,
// Click destinations, orders special paths.
check(
  host.eval(`return EntityCategoryContains(categories.COMMAND, GetSelectedUnits()[1])`) === true,
  'EntityCategoryContains(COMMAND, userUnit) — the category bridge is alive',
)
// The UEF-ACU carries PODSTAGINGPLATFORM (uel0001_unit.bp:125, drone upgrades)
// — orders.lua:923-932 runs this path on EVERY ACU selection.
check(
  Number(host.eval(`return table.getn(EntityCategoryFilterDown(categories.PODSTAGINGPLATFORM, GetSelectedUnits()))`)) === 1,
  'FilterDown findet die PODSTAGINGPLATFORM-Kategorie der UEF-ACU',
)
// Engine Avatar Criteria (UserUnit-Ctor, Cfile:1362979): General.
// QuickSelectPriority > 0 — the ACU-.bp sets 1 (uel0001_unit.bp:817).
check(
  Number(host.eval(`return table.getn(GetArmyAvatars())`)) === 1,
  'GetArmyAvatars() = 1 (QuickSelectPriority > 0, Cfile:1362979)',
)
// mIsEngineer (Cfile:1362995-1363014): ENGINEER without COMMAND/SCOUT/
// UNTARGETABLE — the idle ACU does NOT belong in the engineer tab.
// If EMPTY, the engine returns nil, not an empty table (Cfile:1360921).
check(
  host.eval(`return GetIdleEngineers() == nil`) === true,
  'GetIdleEngineers() does NOT contain the idle ACU (COMMAND exclusion, nil if empty)',
)
// ValidateUnitsList (Cfile:1360596-1360650): filters out dead/removed units
// a saved list (Ctrl groups, controlgroups.lua:102); return is
// ALWAYS a table, even empty.
check(
  Number(
    host.eval(`
      local acu = GetSelectedUnits()[1]
      local geist = { id = 9999 }
      local ok = ValidateUnitsList({ acu, geist })
      return table.getn(ok)
    `),
  ) === 1,
  'ValidateUnitsList keeps the live ACU and throws out the ghost',
)
check(
  host.eval(`return table.getn(ValidateUnitsList(17)) == 0`) === true,
  'ValidateUnitsList(nicht-Tabelle) = leere Tabelle (AssignNewTable, Cfile:1360617)',
)

console.log('\n== orders.lua: die Befehls-Buttons kommen aus dem Blueprint ==')
// GetUnitCommandData → General.CommandCaps of the ACU. Move/Stop/Attack MUST be there
// otherwise the UI has invented its commands.
// The buttons are in the grid of the Original-orders.lua (orders.lua:868 SetItem).
// The grid content is read, not a replica table.
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
  'RULEUCC_Move is active as soon as the ACU is selected (Blueprint: CommandCaps)',
)
check(
  host.eval(`return __t.enabled['RULEUCC_Nuke'] ~= true`) === true,
  'RULEUCC_Nuke remains off — the ACU does not have the capability',
)

// The counter-check to the hit test above: the orders panel is only available WITH a selection
// (orders.lua keeps it hidden otherwise). Now there is a bitmap there - and a
// Clicking on it is a UI click, not a movement command.
check(
  host.eval(`return __ui.ordersModule.controls.bg:IsHidden() == false`) === true,
  'Mit Auswahl ist das Orders-Panel sichtbar (vorher: hidden)',
)
check(
  host.eval(`return __mauiMouse('ButtonPress', 30, 1075, { Left = true })`) === true,
  'Klick auf das Orders-Panel WIRD verbraucht (dort zeichnet ein Bitmap)',
)

console.log('\n== construction.lua: the build menu comes from the blueprint ==')
// The ACU builds what its BuildableCategory provides (uel0001_unit.bp). The list
// pulls construction.lua over EntityCategoryGetUnitList — not over one
// handwritten table.
// Exactly the way out of construction.lua:1677-1681: the categories come out
// GetUnitCommandData(Engine, from bp.Economy.BuildableCategory), the list
// EntityCategoryGetUnitList.
const buildable = Number(
  host.eval(`
    local _, _, cats = GetUnitCommandData(GetSelectedUnits())
    return table.getn(EntityCategoryGetUnitList(cats))
  `),
)
check(buildable > 10, `${buildable} baubare Einheiten für die ACU (EntityCategoryGetUnitList)`)
// The list is not just any: the ACU builds BUILDINGS (ueb0101 = T1-Landfabrik,
// Category BUILTBYCOMMANDER, ueb0101_unit.bp:50) — and NO tanks
// (uel0101 builds the factory). This is exactly what distinguishes a real construction menu from
// a recommended list.
const inMenu = (bp: string): boolean =>
  host.eval(`
    local _, _, cats = GetUnitCommandData(GetSelectedUnits())
    for _, id in ipairs(EntityCategoryGetUnitList(cats)) do
      if id == '${bp}' then return true end
    end
    return false
  `) === true
check(inMenu('ueb0101'), 'ueb0101 (T1-Landfabrik) is in the construction menu of the ACU')
check(!inMenu('uel0101'), 'uel0101 (Panzer) steht NICHT drin — den baut die Fabrik')

console.log('\n== Klick aufs Bau-Icon: der Bau-Modus startet, die Auswahl bleibt ==')
// The path a player takes: Select ACU → click on building icon → building
// set. The click accidentally went to the WELT (because an invisible group
// was above the icon), the ACU was deselected instead.
//
// The icon is NOT searched for, but rather taken by name: construction.lua
// appends its blueprint ID (`item.id`) to each construction button and the click lands
// via the original way in commandmode.StartCommandMode('build', {name=id}).
// First one frame: the grids of the original UI lay out their children in OnFrame
// (grid.lua:40-48) — after a selection, the construction menu is freshly filled.
host.eval('__mauiFrame(0.016)')
// specialgrid.lua:108 attaches the item data to the button as `control.Data`.
// The first BUILDING in the menu is taken (MotionType RULEUMT_None) - just that
// starts construction mode; The factory (construction.lua:878) builds mobile units.
// The test may not care which tab is currently open.
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
  // One click is pressing AND releasing - via the dragger: button.lua
  // OnClick only fires in dragger:OnRelease (button.lua:122-133). Who only
  // ButtonPress sends, never sees a click.
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
    'The ACU is STILL selected (the click was not a world click)',
  )
}

console.log('\n== Deselecting must not kill the UI ==')
// GetUnitCommandData returns EMPTY TABLES if the selection is empty (the engine sets
// they always appear after the unit loop, Cfile:1264740). Our version was nil
// back, orders.lua:891 died into the void at the first click.
let deselectOk = true
try {
  host.eval('__uiSelectByIds({})')
} catch {
  deselectOk = false
}
check(deselectOk, 'SelectUnits({}) survives orders.lua/construction.lua')
check(
  host.eval('return GetSelectedUnits() == nil') === true,
  'GetSelectedUnits() ist danach nil (Cfile:1361395)',
)
// And restore the selection so that the following checks are correct.
host.eval(`__uiSelectByIds({ 1 })`)

console.log('\n== unitview.lua: Rollover zeigt die echte Unit ==')
host.eval('__uiSetRollover(1)')
const rollover = host.eval(`
  local info = GetRolloverInfo()
  return info and info.blueprintId or false
`)
check(rollover === 'uel0001', 'GetRolloverInfo().blueprintId = uel0001')

console.log('\n== score.lua: the points panel is set, the clock runs out of the sim tick ==')
// CreateScoreUI lief im One-Shot-OnFrame (gamemain.OnFirstUpdate,
// ui-boot.lua) for the first __mauiFrame after panel construction.
check(
  host.eval(`return import('/lua/ui/game/score.lua').controls.bg ~= nil`) === true,
  'CreateScoreUI hat das Panel gebaut (controls.bg existiert)',
)
// The clock: GetGameTime() is a FORMATTED string (Cfile:1266614/1266640,
// %H:%M:%S); score._OnBeat schreibt ihn in controls.time (score.lua:230).
// The drive is the REAL beat distributor (UI_LuaBeat → gamemain.OnBeat,
// Cfile:1262940) — Economy mirror beforehand, otherwise economy._BeatFunction calculates
// with nothing.
host.eval(`__uiSetEconomy(650, 4000, 650, 4000, 1, 10, 0, 0, 0, 0)`)
host.eval(`__uiSetGameTick(725)`)
host.eval(`__uiFactoryQueueBeat()`)
host.eval(`import('/lua/ui/game/gamemain.lua').OnBeat()`)
const scoreZeit = String(host.eval(`return import('/lua/ui/game/score.lua').controls.time:GetText()`))
check(scoreZeit === '00:01:12', `die Uhr zeigt ${scoreZeit} (Tick 725 → 00:01:12)`)
// FOUND (documented): currentScores has NONE in the vanilla 3599 dataset
// Produzenten — aibrain.lua:59/334 (CollectCurrentScores/SyncCurrentScores)
// Nobody forks (neither Lua nor Engine; only engine import from aibrain.lua
// is func_LoadAiBrain, Cfile:724474, for the class only). The points column
// remains empty 1:1 until a session delivers it.
check(
  host.eval(`return import('/lua/ui/game/score.lua').currentScores == false`) === true,
  'currentScores bleibt false — 1:1: Vanilla hat keinen Score-Sync-Produzenten',
)

console.log('\n== Die Hoch-Stubs der Inventur: CommandCap, SimCallback, Chat, Restart ==')
// GetUnitCommandFromCommandCap (Cfile:1264844 + Mapping Cfile:1242230):
// RULEUCC name (case-insensitive, prefix optional) -> command name WITHOUT
// "UNITCOMMAND_"-Praefix — orders.lua:205 steckt ihn direkt in IssueCommand.
check(
  host.eval(`return GetUnitCommandFromCommandCap('RULEUCC_Stop')`) === 'Stop',
  "GetUnitCommandFromCommandCap('RULEUCC_Stop') = 'Stop' (ohne Praefix)",
)
check(
  host.eval(`return GetUnitCommandFromCommandCap('ruleucc_overcharge')`) === 'OverCharge',
  "…('ruleucc_overcharge') = 'OverCharge' — case-insensitiv, grosses C (Cfile:696219)",
)
check(
  host.eval(`return GetUnitCommandFromCommandCap('RULEUCC_RetaliateToggle')`) === 'None',
  "…('RULEUCC_RetaliateToggle') = 'None' (kein Mapping -> UNITCOMMAND_None)",
)

// SimCallback (Cfile:1359123): the sink gets (func, args-as-lua-literal,
// selection IDs); the literal is the serialization SNAPSHOT (copy).
{
  let sink: [string, string, unknown] | null = null
  host.setGlobal('__uiSimCallbackSink', (f: string, a: string, ids: unknown) => {
    sink = [f, a, ids]
  })
  host.eval(`SimCallback({ Func = 'ToggleSelfDestruct', Args = { units = { 4, 5 }, owner = 1 } })`)
  const [func, argsLua] = sink ?? ['', '', null]
  check(func === 'ToggleSelfDestruct', `SimCallback: Func = ${func} erreicht den Sink`)
  const argsOk = host.eval(`
    local a = ${argsLua || 'nil'}
    return a and a.owner == 1 and a.units[1] == 4 and a.units[2] == 5
  `)
  check(argsOk === true, `SimCallback: Args-Snapshot als Lua-Literal auswertbar (${argsLua})`)
}

// GetSessionClients (fields from cfunc_GetSessionClientsL, Cfile:1321886-1321957).
check(
  host.eval(`
    local c = GetSessionClients()
    return table.getn(c) == 1 and c[1]['local'] == true and c[1].connected == true
      and type(c[1].name) == 'string' and table.getn(c[1].authorizedCommandSources) == 1
  `) === true,
  'GetSessionClients: 1 lokaler Client mit den Engine-Feldern',
)

// SessionSendChatMessage (Cfile:1322106-1322227): Snapshot + asynchrone
// Delivery to gamemain.ReceiveChat — msg.echo AFTER sending (chat.lua:759)
// may NOT reach the delivered copy.
host.eval(`
  __chatTest = false
  import('/lua/ui/game/gamemain.lua').RegisterChatFunc(function(sender, data)
    __chatTest = { sender = sender, text = data.text, echo = data.echo }
  end, 'Chat')
  local msg = { text = 'verify', Chat = true }
  SessionSendChatMessage(msg)
  msg.echo = true
`)
check(host.eval('return __chatTest') === false, 'Chat: Zustellung ist ASYNCHRON (nicht im Sende-Stack)')
host.eval('__mauiFrame(0.016)')
host.eval('__mauiFrame(0.016)')
const chat = host.eval('return __chatTest') as { sender?: string; text?: string; echo?: unknown } | false
check(chat !== false && chat.text === 'verify', `Chat: kommt beim naechsten Frame an (text=${chat && chat.text})`)
check(chat !== false && chat.echo == null, 'Chat: msg.echo nach dem Senden erreicht die Kopie NICHT (Snapshot)')
check(
  host.eval(`
    local ok, err = pcall(SessionSendChatMessage, { text = string.rep('x', 1100), Chat = true })
    return not ok and string.find(tostring(err), 'Message too long', 1, true) ~= nil
  `) === true,
  'Chat: > 1024 Bytes serialisiert -> "Message too long." (Cfile:1322198)',
)

console.log('\n== Der Tastatur-Pfad: Keymap, Executor, Fallbacks ==')
// IN_InitKeyHandler (Cfile:1259476): the engine has keyNames.lua + when booting
// keymapper.GetKeyMappings() loaded — the keymap is NOT empty.
{
  const n = Number(
    host.eval(`local n = 0 for _ in pairs(__uiKeyActions) do n = n + 1 end return n`),
  )
  check(n > 30, `${n} Hotkeys aus keymapper.GetKeyMappings() geparst (defaultKeyMap.lua)`)
  // The Esc entry is keymap action #1 (defaultKeyMap.lua:8 ->
  // keyactions.lua:8, 'UI_Lua import(...).EscapeHandler()'), VK_ESCAPE=0x1B.
  check(
    host.eval(`return __uiKeyActions[27] ~= nil and string.find(__uiKeyActions[27], 'EscapeHandler', 1, true) ~= nil`) === true,
    `Esc ist gemappt: ${host.eval('return tostring(__uiKeyActions[27])')}`,
  )
}
// Executor path end-to-end: own action -> ConExecute -> UI_Lua (the
// Console command behind almost every keymap action, CConFunc_UI_Lua Cfile:423593).
host.eval(`
  __keyTest = 0
  IN_AddKeyMapTable({ ['Ctrl-Shift-P'] = { action = 'UI_Lua __keyTest = __keyTest + 1' } })
`)
// CV of P = 0x50; Modifier bits Shift+Ctrl (Cfile:1259010-1259023).
check(
  host.eval(`return __uiKeyMapExecute(80, true, true, false, false, 80)`) === true &&
    Number(host.eval('return __keyTest')) === 1,
  'Ctrl-Shift-P: Keymap hits -> ConExecute -> UI_Lua running (__keyTest = 1)',
)
check(
  host.eval(`return __uiKeyMapExecute(80, true, true, false, true, 80)`) === false &&
    Number(host.eval('return __keyTest')) === 1,
  'Auto-Repeat ohne keyRepeat-Flag wird verworfen (Cfile:1259049)',
)
// (Shift-P alone is REALLY documented in the original — Patrol. For the
// Negative test i.e. a VK that no keymap knows: 0x07 is undefined.)
check(
  host.eval(`return __uiKeyMapExecute(7, true, true, false, false, 7)`) === false,
  'unbelegte Taste -> kein Treffer, keine Aktion',
)
// Focus blocks ALL hotkeys (Cfile:1259003-1259005) - including matching ones.
check(
  host.eval(`
    __mauiFocus = { __destroyed = false }
    local r = __uiKeyMapExecute(80, true, true, false, false, 80)
    __mauiFocus = false
    return r
  `) === false,
  'ein Fokus-Control blockt den Key-Handler komplett',
)
host.eval(`IN_RemoveKeyMapTable({ ['Ctrl-Shift-P'] = true })`)
check(
  host.eval(`return __uiKeyMapExecute(80, true, true, false, false, 80)`) === false,
  'IN_RemoveKeyMapTable entfernt den Eintrag wieder',
)
// SetVolume/GetVolume (CUserSoundManager, Cfile:1346194/603714/605038):
// SetVolume caches and forwards the raw float; without an audio engine it
// simply caches (no error). GetVolume NEVER reads back — cache only,
// insert-default 1.0.
check(Number(host.eval(`return GetVolume('Music')`)) === 1.0, "GetVolume('Music') default = 1.0")
host.eval(`SetVolume('Music', 0.25)`)
check(Number(host.eval(`return GetVolume('Music')`)) === 0.25, 'SetVolume cached, GetVolume liest den Cache')
{
  const gesehen: [string, number][] = []
  host.setGlobal('__uiVolumeSink', (c: string, v: number) => {
    gesehen.push([c, v])
  })
  host.eval(`SetVolume('World', 0.5)`)
  check(
    gesehen.length === 1 && gesehen[0]![0] === 'World' && gesehen[0]![1] === 0.5,
    'Mit Naht erreicht der rohe Float die Audio-Engine',
  )
}

// StartCommandMode as a console command (CON_StartCommandMode,
// Cfile:1255125): the keymap actions run through it — same mode+name
// again toggles the command mode OFF.
host.eval(`ConExecute('StartCommandMode order RULEUCC_Attack')`)
check(
  host.eval(`
    local m = import('/lua/ui/game/commandmode.lua').GetCommandMode()
    return m[1] == 'order' and type(m[2]) == 'table' and m[2].name == 'RULEUCC_Attack'
  `) === true,
  "ConExecute('StartCommandMode order RULEUCC_Attack') startet den Command-Mode",
)
host.eval(`ConExecute('StartCommandMode order RULEUCC_Attack')`)
check(
  host.eval(`
    local m = import('/lua/ui/game/commandmode.lua').GetCommandMode()
    return m[1] == false
  `) === true,
  'the same command again turns it OFF (Toggle, Cfile:1255233)',
)

// WorldIsLoading: maintained by the provider chain (ui-boot.lua) — after
// StopLoadingDialog the world is no longer loading.
check(host.eval('return WorldIsLoading()') === false, 'WorldIsLoading() = false nach DoInitializing')
// The Enter fallback (Cfile:1263522-1263568) depends on the UI state: only in
// Game (sUIState = UIS_game, set by __uiStartGameUI) opens Enter
// Chat. This suite runs setupGameUi without the provider chain — the condition
// is set here as by func_StartGameUI and the fallback is checked.
host.eval(`__uiState = 3`)
check(
  host.eval(`return GetCurrentUIState()`) === 'game' &&
    host.eval(`return __uiKeyMapExecute(13, false, false, false, false, 13)`) === true,
  'Enter without keymap hit goes to chat.ActivateChat (in-game only, UIS_game=3)',
)

// RestartSession (Cfile:1263968): without sink the session cannot be restarted —
// the call is then a no-op, NOT an error; Sink restarts.
check(host.eval('return SessionCanRestart()') === false, 'SessionCanRestart = false without engine seam')
host.eval('RestartSession()')
{
  let restarted = false
  host.setGlobal('__uiRestartSink', () => {
    restarted = true
  })
  check(host.eval('return SessionCanRestart()') === true, 'SessionCanRestart = true mit Naht')
  host.eval('RestartSession()')
  check(restarted, 'RestartSession triggers the restart')
}

// === IsAlly/IsEnemy/IsNeutral (scr_UserInits, Cfile:1361954-1362085) ===
// The UI mirror of the sim's alliance sets; chat.lua:561 ('allies'
// recipients) and diplomacy.lua:273 depend on these.
console.log('\n== Alliances in the UI VM ==')
{
  check(host.eval('return IsAlly(1, 1)') === true, 'IsAlly(1,1): self-ally (Cfile:1017297)')
  check(host.eval('return IsEnemy(1, 2)') === true, 'IsEnemy(1,2): skirmish default')
  check(
    host.eval(`return IsEnemy('ARMY_1', 'army_2')`) === true,
    'army names resolve case-insensitively (ARMY_FromLuaState, Cfile:1358456)',
  )
  const bad = host.eval(
    `local ok, err = pcall(IsAlly, 99, 1) return (not ok) and tostring(err) or 'NO ERROR'`,
  ) as string
  check(String(bad).includes('Invalid army'), `invalid index errors loudly (${bad})`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nUI-PANELS BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
