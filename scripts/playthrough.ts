/**
 * DURCHSPIELEN — headless, ohne Browser, ohne Maus.
 *
 * Das hier ist kein Test mit Erwartungswerten, sondern ein SUCHLAUF: es fährt
 * die echte Kette (Sim-VM + UI-VM, dieselben Boot-Pfade wie der Browser) durch
 * eine ganze Partie und sammelt JEDEN Fehler, jede Warnung und jedes fehlende
 * Engine-Teil ein — mit Datei und Zeile.
 *
 *   Spawn ACU → Auswahl → Bau-Menü → Gebäude setzen → Baustelle wächst → fertig
 *   → Fabrik auswählen → Einheiten in die Warteschlange → Sammelpunkt
 *   → produzierte Panzer fahren los → Feind spawnt → Waffen greifen
 *   → Treffer, Tod, Wrack → Ökonomie-Panel, Orders, Construction, Reiter
 *
 * Warum: Fehler im Browser zu suchen ist langsam und ungenau. Hier laufen
 * dieselben Original-Lua-Dateien, und jeder `WARN`, jeder Lua-Fehler und jedes
 * „ist noch nicht implementiert" landet in einer Liste — sortiert nach Häufigkeit.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/playthrough.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { spawnLuaUnit, spawnBuildSite, readLuaUnit } from '../src/lua/unitFactory'
import { issueBuildTask } from '../src/sim/build'
import { queueFactoryBuild } from '../src/sim/build'
import {
  installUiEngine,
  setupUi,
  setupGameUi,
  startSessionLoading,
  finishSessionLoading,
  createRootFrame,
  loadUiBlueprints,
  applySession,
} from '../src/lua/uiEngine'
import { worldClick, getCommandMode } from '../src/ui/worldCommands'
import { findFiles } from '../src/vfs/glob'
import { GameFiles } from './gameFiles'
import { SANDBOX_SESSION } from '../src/sim/session'

// --- Alles, was schiefgeht, landet hier ------------------------------------
interface Fund {
  wo: 'SIM' | 'UI'
  schritt: string
  text: string
}
const funde: Fund[] = []
let schritt = 'Boot'
const melde = (wo: 'SIM' | 'UI', text: string): void => {
  funde.push({ wo, schritt, text: text.split('\n')[0]!.slice(0, 200) })
}
const schritte: string[] = []
const tue = (name: string): void => {
  schritt = name
  schritte.push(name)
  console.log(`\n── ${name}`)
}

const game = await GameFiles.open()

// --- Die SIM, exakt wie im Worker (luaSimWorker.ts) -------------------------
tue('Sim booten')
const sim = await LuaHost.create(game.luaFiles, (level, msg) => {
  if (level === 'WARN') melde('SIM', msg)
})
const engine = installEngine(sim)
setTerrainSource(sim, () => 20)
const nProj = game.loadProjectiles(sim)
const nProps = game.loadProps(sim)
console.log(`   ${nProj} Projektil-, ${nProps} Prop-Blueprints`)

// --- Die UI-VM, exakt wie im Browser (GameUi.create) ------------------------
tue('UI booten (18 Panels aus gamemain.lua)')
const ui = await LuaHost.create(game.luaFiles, (level, msg) => {
  if (level === 'WARN') melde('UI', msg)
})
installUiEngine(ui, {
  exists: (p) => game.exists(p),
  find: (dir, pattern) => findFiles(game.paths, dir, pattern),
  // Texturmaße: der Test hat keine DDS-Dekodierung — die Maße sind hier egal,
  // geprüft werden Fehler, nicht Pixel.
  textureSize: () => [64, 64],
  stringAdvance: (t, _f, s) => t.length * s * 0.5,
  fontMetrics: (_f, s) => [s * 0.8, s * 0.2],
})
createRootFrame(ui, 1920, 1080)
setupUi(ui)
const bpPaths = [...game.paths].filter((p) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(p))
loadUiBlueprints(ui, bpPaths)
applySession(ui, { ...SANDBOX_SESSION, map: 'SCMP_009' })
// Der Weltstart der Engine, wie im Browser (gameUi.ts): DoPreload
// (StartGameUI + StartLoadingDialog, Cfile:1320735) -> DoInitializing
// (Frame-Reset + SetupUI + StartGameUI erneut, dann StopLoadingDialog,
// Cfile:1321030-1321090). Erst StopLoadingDialog forkt InitialAnimations —
// ohne diese Kette fahren Score, Economy und Avatare nie ein.
startSessionLoading(ui)
ui.eval('__mauiResetFrames()')
ui.eval('__uiSetupUi()')
ui.eval('__uiStartGameUI()')
finishSessionLoading(ui)
setupGameUi(ui, (m) => {
  if (m.includes('NOCH NICHT')) melde('UI', m)
})
ui.setGlobal('__uiSimCommand', (name: string, ids: number[], value: unknown) => {
  simBefehle.push({ name, ids, value })
})
ui.setGlobal('__uiPauseSink', () => {})
const simBefehle: { name: string; ids: number[]; value: unknown }[] = []

/** Ein Bild der UI (Frame-Pumpe + Snapshot — wie MauiRenderer.update). */
const uiFrame = (n = 1): void => {
  for (let i = 0; i < n; i++) {
    try {
      ui.eval('__mauiFrame(0.016)')
      ui.pull('__mauiSnapshotJson()')
    } catch (e) {
      melde('UI', `Bild-Pumpe: ${(e as Error).message}`)
    }
  }
}

/** Den Sim-Zustand in die UI spiegeln — das tut im Browser gameUi.beat(). */
const spiegle = (): void => {
  const units = sim.pull<
    { id: number; name: string; x: number; y: number; z: number; health: number; maxHealth: number; fraction: number; moving: boolean; army: number; idle: boolean; buildQueue: { id: string; count: number }[] }[]
  >('__readAllUnitsJson()')
  for (const u of units) {
    ui.eval(
      `__uiSetUnit(${u.id}, '${u.name}', ${u.army}, ${u.x}, ${u.y}, ${u.z}, ${u.health}, ` +
        `${u.maxHealth}, ${u.fraction}, ${u.idle === true})`,
    )
    // Wie im Browser (gameUi.ts): die Queue IMMER spiegeln, auch leer.
    const items = (u.buildQueue ?? []).map((i) => `{ id = '${i.id}', count = ${i.count} }`).join(',')
    ui.eval(`__uiSetBuildQueue(${u.id}, { ${items} })`)
  }
  const e = engine.economy.army(1)
  ui.eval(
    `__uiSetEconomy(${e.maxMass}, ${e.maxEnergy}, ${e.mass}, ${e.energy}, ` +
      `${e.incomeMass}, ${e.incomeEnergy}, ${e.expenseMass}, ${e.expenseEnergy}, ` +
      `${e.expenseMass}, ${e.expenseEnergy})`,
  )
  ui.eval(`__uiSetGameTick(${Number(sim.eval('return __gameTick'))})`)
  // Queue-Waechter VOR dem Beat-Verteiler — Reihenfolge aus CUIManager::DoBeat
  // (Cfile:1273907-1273911), dann UI_LuaBeat -> gamemain.OnBeat (Cfile:1262940):
  // ALLE registrierten Beat-Funktionen laufen (economy, avatars, commandmode ...).
  ui.eval(`__uiFactoryQueueBeat()`)
  ui.eval(`import('/lua/ui/game/gamemain.lua').OnBeat()`)
}

/** Ein Beat der Sim + ein Bild der UI — der Takt des laufenden Spiels. */
const takt = (n = 1): void => {
  for (let i = 0; i < n; i++) {
    try {
      beat(engine)
    } catch (e) {
      melde('SIM', `beat(): ${(e as Error).message}`)
    }
    spiegle()
    uiFrame(1)
  }
}

// --- Die Partie -------------------------------------------------------------
tue('ACU spawnen (uel0001)')
for (const id of ['uel0001', 'ueb0101', 'ueb1101', 'uel0201', 'uel0101']) {
  await game.giveUnit(sim, id)
}
const acu = spawnLuaUnit(sim, 'uel0001', { x: 100, y: 20, z: 100 }, 1)
takt(10)
console.log(`   ACU ${acu}, Masse ${engine.economy.army(1).mass.toFixed(0)}`)

tue('Lade-Fade abwarten (das Fraktionsbild fängt sonst jeden Klick)')
// gamemain.lua:274-292: das Fraktionsbild liegt auf Depth 200 über ALLEM und
// faded erst nach 1,5 s über ~2 s aus — solange trifft jeder Hit-Test nur
// dieses Bitmap. Der Spieler klickt im Original auch erst nach dem Fade.
uiFrame(260)

tue('ACU auswählen (SelectUnits → gamemain.OnSelectionChanged)')
spiegle()
try {
  ui.eval(`__uiSelectByIds({ ${acu} })`)
} catch (e) {
  melde('UI', `SelectUnits: ${(e as Error).message}`)
}
uiFrame(3)

tue('Bau-Icon klicken (echter Maus-Weg: Hit-Test → Dragger → construction.lua)')
// Genau der Weg eines Spielers: ein Gebäude-Icon im Bau-Menü suchen und mit der
// MAUS anklicken (durch den Hit-Test der Engine, nicht per internem Aufruf).
uiFrame(1)
const icon = ui.eval(`
  -- Die T1-LANDFABRIK (ueb0101) — das, was ein Spieler zuerst baut. Genommen wird
  -- nur ein Icon, das der HIT-TEST auch wirklich zurueckgibt: die Icons der
  -- verschiedenen Reiter liegen uebereinander.
  local erstes = ''
  for _, c in pairs(__mauiControls) do
    if not c.__destroyed and c.Data and c.Data.type == 'item' and c.Data.id then
      local bp = __blueprints[c.Data.id]
      local up = bp and bp.General and bp.General.UpgradesFrom
      local isUpgrade = up ~= nil and up ~= 'none' and up ~= ''
      if bp and bp.Physics.MotionType == 'RULEUMT_None' and not isUpgrade and not c:IsHidden() then
        local mx = math.floor(c.Left() + c.Width() / 2)
        local my = math.floor(c.Top() + c.Height() / 2)
        if __mauiHitTest(mx, my) == c then
          local eintrag = string.format('%s|%d|%d', c.Data.id, mx, my)
          if c.Data.id == 'ueb0101' then return eintrag end
          if erstes == '' then erstes = eintrag end
        end
      end
    end
  end
  return erstes
`) as string
if (!icon) {
  melde('UI', 'Kein Gebäude-Icon im Bau-Menü (construction.lua liefert nichts)')
} else {
  const [bpId, mx, my] = icon.split('|')
  console.log(`   Icon ${bpId} bei ${mx},${my}`)
  // Ein Klick ist Druecken UND Loslassen — und die MODIFIER gehoeren dazu
  // ({ Left = true }): button.lua feuert OnClick erst im Dragger-Release.
  ui.eval(`__mauiMouse('ButtonPress', ${mx}, ${my}, { Left = true }, 1)`)
  ui.eval(`__mauiMouse('ButtonRelease', ${mx}, ${my}, { Left = true }, 1)`)
  uiFrame(2)
}
const cm = getCommandMode(ui)
console.log(`   Command-Mode: ${JSON.stringify(cm)}`)
if (cm.mode === false) melde('UI', 'Der Klick aufs Bau-Icon startet KEINEN Bau-Modus')

tue('Gebäude setzen (worldClick → Baustelle + Bau-Auftrag)')
const simFassade = {
  move: (id: number, x: number, z: number): void => {
    sim.eval(`local u=__units[${id}] if u then u:GetNavigator():SetGoal({ ${x}, 0, ${z} }) end`)
  },
  setRallyPoint: (id: number, x: number, y: number, z: number): void => {
    sim.eval(`local u=__units[${id}] if u then u:SetRallyPoint({ ${x}, ${y}, ${z} }) end`)
  },
  build: async (
    builderId: number,
    bpId: string,
    pos: { x: number; y: number; z: number },
    army: number,
    queue = false,
  ): Promise<number> => {
    // Wie im Browser: das Blueprint (+ Skelett) kommt erst beim Bau in die Sim.
    await game.giveUnit(sim, bpId)
    const uid = spawnBuildSite(sim, bpId, pos, army)
    issueBuildTask(sim, builderId, uid, !queue)
    return uid
  },
}
// Ein Bau-Modus muss laufen; sonst nehmen wir die Fabrik direkt.
console.log(`   Auswahl vor dem Klick: ${String(ui.eval('return __uiSelectionJson()'))}`)
console.log(`   Command-Mode vor dem Klick: ${JSON.stringify(getCommandMode(ui))}`)
let msg: string | null = null
try {
  msg = await worldClick(ui, simFassade, { x: 112, z: 112 }, () => 20, { queue: false })
} catch (e) {
  melde('UI', `worldClick: ${(e as Error).message}`)
}
console.log(`   ${msg ?? 'kein Befehl'}`)
if (!msg?.startsWith('Bau')) {
  // Der Bau-Modus kam nicht zustande — dann setzen wir die Fabrik direkt, damit
  // der Durchlauf weiterläuft (und der Fund oben steht in der Liste).
  const site = spawnBuildSite(sim, 'ueb0101', { x: 112, y: 20, z: 112 }, 1)
  issueBuildTask(sim, acu, site)
}

tue('Bauen bis fertig (Ökonomie zahlt, Bauer fährt hin)')
// Geprüft wird das Gebäude, das WIRKLICH geklickt wurde — nicht ein fest
// verdrahtetes. (Der Durchlauf nimmt das erste klickbare Gebäude-Icon.)
const gebaut = (icon.split('|')[0] || 'ueb0101').toLowerCase()
let fabrik = 0
for (let i = 0; i < 400 && fabrik === 0; i++) {
  takt(1)
  const alle = sim.pull<{ id: number; name: string; fraction: number }[]>('__readAllUnitsJson()')
  const f = alle.find((u) => u.name === gebaut && u.fraction >= 1)
  if (f) fabrik = f.id
}
console.log(fabrik ? `   ${gebaut} ${fabrik} fertig` : `   ${gebaut} NICHT fertig geworden (teuer + wenig Einkommen ist normal — nur melden, wenn der Fortschritt STEHT)`)
if (!fabrik) {
  const f2 = sim.pull<{ id: number; name: string; fraction: number }[]>('__readAllUnitsJson()')
    .find((u) => u.name === gebaut)
  if (!f2 || f2.fraction <= 0) melde('SIM', 'Die Baustelle wächst nicht (Bau-Kette hängt)')
  else console.log(`   Fortschritt: ${(f2.fraction * 100).toFixed(0)}% — Kette läuft`)
  // Der Bau wird nicht fertig (teuer + wenig Einkommen) — die FABRIK-Kette
  // (Auswahl, Sammelpunkt, Warteschlange, Produktion) darf davon nicht
  // abhängen: eine fertige T1-Landfabrik spawnen, den teuren ACU-Bau stoppen
  // (er fräße sonst alles Einkommen) und das Lager füllen — mit dem
  // Original-Weg der Szenario-Skripte (SetArmyEconomy, echtes Engine-Global).
  fabrik = spawnLuaUnit(sim, 'ueb0101', { x: 120, y: 20, z: 120 }, 1)
  sim.eval(`__clearBuildQueue(${acu})`)
  sim.eval(`SetArmyEconomy(1, 4000, 100000)`)
  takt(2)
  console.log(`   fertige Fabrik ${fabrik} gespawnt — die Fabrik-Kette läuft trotzdem`)
}

if (fabrik) {
  tue('Fabrik auswählen + Sammelpunkt setzen')
  spiegle()
  ui.eval(`__uiSelectByIds({ ${fabrik} })`)
  uiFrame(2)
  const rally = await worldClick(ui, simFassade, { x: 130, z: 130 }, () => 20, { queue: false })
  console.log(`   ${rally ?? 'kein Befehl'}`)

  tue('Panzer bauen (construction.lua → IssueBlueprintCommand → Fabrik)')
  simBefehle.length = 0
  try {
    ui.eval(`IssueBlueprintCommand('UNITCOMMAND_BuildFactory', 'uel0201', 2, false)`)
  } catch (e) {
    melde('UI', `IssueBlueprintCommand: ${(e as Error).message}`)
  }
  console.log(`   Befehl an die Sim: ${JSON.stringify(simBefehle[0] ?? null)}`)
  queueFactoryBuild(sim, fabrik, 'uel0201', 2)

  tue('Bau-Warteschlange: der Wächter meldet, Decrease geht durch die Naht')
  // Der Queue-Wächter (UI_FactoryCommandQueueHandlerBeat, Cfile:1256904) muss
  // die neue 2er-Queue als gamemain.OnQueueChanged melden — GEZÄHLT am Modul.
  ui.eval(`
    __qtest = { n = 0 }
    local gm = import('/lua/ui/game/gamemain.lua')
    local orig = gm.OnQueueChanged
    gm.OnQueueChanged = function(q) __qtest.n = __qtest.n + 1 return orig(q) end
  `)
  spiegle() // Queue in die UI-Kopie + Wächter läuft (vor OnBeat)
  const ev1 = Number(ui.eval('return __qtest.n'))
  if (ev1 < 1) melde('UI', 'OnQueueChanged feuert nicht — der Queue-Wächter meldet die neue Warteschlange nicht')
  else console.log(`   OnQueueChanged gefeuert (${ev1}×) — die Queue-Anzeige lebt`)
  // Rechtsklick aufs Queue-Icon = DecreaseBuildCountInQueue (construction.lua:895).
  simBefehle.length = 0
  try {
    ui.eval(`DecreaseBuildCountInQueue(1, 1)`)
  } catch (e) {
    melde('UI', `DecreaseBuildCountInQueue: ${(e as Error).message}`)
  }
  const dec = simBefehle[0]
  if (dec?.name !== 'ISSUE_DecreaseCommandCount') melde('UI', `Decrease schickt keinen ISSUE_DecreaseCommandCount (${JSON.stringify(dec ?? null)})`)
  else console.log(`   Naht: ${dec.name} an Fabrik ${dec.ids.join(',')} ${JSON.stringify(dec.value)}`)
  // Das Sim-Ende (im Browser routet main.ts den Befehl; hier direkt):
  sim.eval(`__adjustFactoryQueue(${fabrik}, 1, -1)`)
  spiegle()
  const ev2 = Number(ui.eval('return __qtest.n'))
  const restCount = Number(ui.eval(`local q = __uiUnits[${fabrik}].buildQueue return (q[1] and q[1].count) or 0`))
  if (ev2 <= ev1) melde('UI', 'Der Wächter meldet die geänderte Queue nicht (Decrease unsichtbar)')
  if (restCount !== 1) melde('SIM', `__adjustFactoryQueue: erwartet count=1, ist ${restCount}`)
  else console.log(`   nach Decrease: count=${restCount}, OnQueueChanged ${ev2}×`)
  // … und Increase (Linksklick, construction.lua:988) stellt den Panzer wieder
  // her — der Produktions-Schritt erwartet BEIDE.
  simBefehle.length = 0
  ui.eval(`IncreaseBuildCountInQueue(1, 1)`)
  if (simBefehle[0]?.name !== 'ISSUE_IncreaseCommandCount') melde('UI', `Increase schickt keinen ISSUE_IncreaseCommandCount (${JSON.stringify(simBefehle[0] ?? null)})`)
  sim.eval(`__adjustFactoryQueue(${fabrik}, 1, 1)`)
  spiegle()

  tue('Fabrik produziert (RollOffUnit → IssueMove → IsCommandDone)')
  let panzer: number[] = []
  for (let i = 0; i < 600 && panzer.length < 2; i++) {
    takt(1)
    const alle = sim.pull<{ id: number; name: string; fraction: number }[]>('__readAllUnitsJson()')
    panzer = alle.filter((u) => u.name === 'uel0201' && u.fraction >= 1).map((u) => u.id)
  }
  console.log(`   ${panzer.length} Panzer produziert`)
  if (panzer.length < 2) melde('SIM', `Die Fabrik hat nur ${panzer.length} von 2 Panzern gebaut`)
}

tue('Feind spawnen + Kampf (Zielerfassung, Schuss, Treffer, Tod, Wrack)')
const feind = spawnLuaUnit(sim, 'uel0201', { x: 106, y: 20, z: 106 }, 2)
let tot = false
// Der Emitter-Kanal: Mündungsfeuer/Einschläge müssen WÄHREND des Kampfes mit
// Weltposition gemeldet werden (__readAllEmittersJson — das Futter fürs
// Partikelsystem). Gezählt wird das Maximum über den Kampf.
let maxEmitter = 0
let emitterBeispiel = ''
let emitterBp = ''
for (let i = 0; i < 400 && !tot; i++) {
  takt(1)
  if (i % 5 === 0) {
    const em = sim.pull<{ id: number; bp: string; x: number; y: number; z: number }[]>('__readAllEmittersJson()')
    if (em.length > maxEmitter) {
      maxEmitter = em.length
      const e0 = em[0]!
      emitterBeispiel = `${e0.bp.split('/').pop()} @ ${e0.x.toFixed(1)},${e0.y.toFixed(1)},${e0.z.toFixed(1)}`
      emitterBp = e0.bp
    }
  }
  tot = sim.eval(`return __units[${feind}] == nil or __units[${feind}].__dead == true`) === true
  if (i % 50 === 49) {
    const hp = sim.eval(`
      local u = __units[${feind}]
      if not u then return 'weg' end
      return string.format('%.0f HP', u.__health or 0)
    `)
    console.log(`   nach ${i + 1} Beats: Feind ${String(hp)}`)
  }
}
console.log(tot ? '   Der Feind ist gefallen' : '   Der Feind lebt noch (kein Kampf?)')
if (!tot) melde('SIM', 'Der Feind wurde nicht getötet — die Waffen greifen nicht')
if (maxEmitter > 0) console.log(`   Emitter gemeldet: max. ${maxEmitter} gleichzeitig (z. B. ${emitterBeispiel})`)
else melde('SIM', 'KEIN Emitter während des Kampfes gemeldet — Mündungsfeuer/Einschläge erreichen den Renderer nicht')
if (emitterBp) {
  // Der Blueprint-RPC fürs Partikelsystem: die Sim liefert das GEPARSTE
  // Emitter-BP als JSON (__emitterBpJson) — mit Textur und Kurven.
  const bp = sim.pull<{ Texture?: string; EmitRateCurve?: { Keys?: unknown[] } } | null>(
    `__emitterBpJson('${emitterBp}')`,
  )
  if (bp && typeof bp.Texture === 'string' && bp.EmitRateCurve?.Keys) {
    console.log(`   Emitter-BP über RPC: Texture=${bp.Texture.split('/').pop()}, EmitRateCurve mit ${bp.EmitRateCurve.Keys.length} Keys`)
  } else {
    melde('SIM', `__emitterBpJson liefert kein brauchbares BP für ${emitterBp}`)
  }
}
takt(60)
const wracks = Number(sim.eval('local n = 0 for _ in pairs(__props) do n = n + 1 end return n'))
console.log(`   ${wracks} Wrack(s) auf dem Feld`)

tue('Hover: unitview zeigt Name + HP der Unit unter dem Cursor')
// Genau der Browser-Weg: main.ts meldet die Unit unter der Maus per
// __uiSetRollover; unitview.lua liest GetRolloverInfo() in seinem OnFrame
// (unitview.lua:422-433) und fuellt Name, HP-Balken und Statistiken.
spiegle()
ui.eval(`__uiSetRollover(${acu})`)
uiFrame(5)
const uv = ui.eval(`
  local Unitview = import('/lua/ui/game/unitview.lua')
  local c = Unitview.controls
  if not c or not c.name then return 'controls nicht erreichbar' end
  return string.format('name=%q hp=%q alpha=%.1f',
    tostring(c.name:GetText()), tostring(c.health:GetText()), c.bg:GetAlpha())
`) as string
console.log(`   ${uv}`)
if (uv.indexOf('name=""') >= 0 || uv.indexOf('nicht erreichbar') >= 0) {
  melde('UI', `unitview zeigt nichts beim Hover: ${uv}`)
}
ui.eval('__uiSetRollover(nil)')
uiFrame(2)

tue('Die Reiter oben (Menü, Diplomatie) + Abwahl')
try {
  ui.eval(`import('/lua/ui/game/tabs.lua').BuildContent('main')`)
  uiFrame(30)
  ui.eval(`import('/lua/ui/game/tabs.lua').BuildContent('diplomacy')`)
  uiFrame(60)
} catch (e) {
  melde('UI', `Reiter: ${(e as Error).message}`)
}
try {
  ui.eval(`__uiSelectByIds({ })`)
  uiFrame(3)
} catch (e) {
  melde('UI', `Abwahl: ${(e as Error).message}`)
}

tue('InitialAnimations: das Fraktionsbild faded, die Panels fahren ein')
// Der Fade braucht 1,5 s Wartezeit + ~2 s Ausblenden (gamemain.lua:279-291,
// delta/2 pro Bild) — erst danach forkt die Original-Lua InitialAnimations
// und score.lua:406 ruft controls.bg:Show(). Die Uhr oben rechts (score.lua:230,
// GetGameTime) muss am Ende SICHTBAR sein und LAUFEN.
try {
  uiFrame(380)
  const uhr = String(
    ui.eval(`
      for _, c in pairs(__mauiControls) do
        if not c.__destroyed and tostring(c.__text or ''):find('^%d%d:%d%d:%d%d$') then
          -- laufende Uhr, nicht der (zu Recht versteckte) Kampagnen-Timer
          if tostring(c.__text) ~= '00:00:00' then
            local n = c
            while n do
              if n.__hidden then return 'VERSTECKT durch ' .. tostring(n.__name) end
              n = n.__parent
            end
            return 'sichtbar: ' .. tostring(c.__text)
          end
        end
      end
      return 'KEINE laufende Uhr im Baum'
    `),
  )
  if (uhr.startsWith('sichtbar')) console.log(`   Score-Uhr ${uhr}`)
  else melde('UI', `Score-Uhr nach InitialAnimations: ${uhr}`)
} catch (e) {
  melde('UI', `InitialAnimations: ${(e as Error).message}`)
}

// --- Der Bericht ------------------------------------------------------------
console.log('\n' + '='.repeat(72))
console.log(`DURCHLAUF: ${schritte.length} Schritte, ${funde.length} Meldungen`)
console.log('='.repeat(72))

// Nach Text zusammenfassen (dieselbe Meldung 300× ist EIN Fund).
const gezaehlt = new Map<string, { n: number; wo: string; schritt: string }>()
for (const f of funde) {
  const key = `${f.wo} ${f.text}`
  const hit = gezaehlt.get(key)
  if (hit) hit.n++
  else gezaehlt.set(key, { n: 1, wo: f.wo, schritt: f.schritt })
}
const sortiert = [...gezaehlt.entries()].sort((a, b) => b[1].n - a[1].n)

// Bekanntes Rauschen — kein Fund, sondern eine offene Baustelle mit Ticket.
const bekannt = [
  'Audio: keine Ausgabe angeschlossen',
  'MetaImpact: keine Impuls-Physik',
]
let echte = 0
for (const [key, v] of sortiert) {
  const text = key.slice(v.wo.length + 1)
  const known = bekannt.some((b) => text.includes(b))
  if (!known) echte++
  console.log(`\n[${v.wo}] ×${v.n}${known ? ' (bekannt)' : ''}  — zuerst in: ${v.schritt}`)
  console.log(`   ${text}`)
}

console.log('\n' + '='.repeat(72))
if (echte === 0) {
  console.log('DURCHLAUF SAUBER — keine unbekannten Fehler, keine fehlenden Engine-Teile.')
} else {
  console.log(`${echte} offene Punkte (siehe oben).`)
}
await game.close()
process.exit(0)
