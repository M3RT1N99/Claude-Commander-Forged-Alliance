/**
 * M2 aus docs/PLAN-1ZU1.md: das ECHTE Hauptmenü läuft.
 *
 * Kein Nachbau, kein HTML-Menü: die Kette ist die der Engine.
 *
 *   EngineStartSplashScreens()            Cfile:1263790 → UI_StartSplashScreens
 *     → __uiSetNewLuaState(UIS_splash)    CUIManager::SetNewLuaState, Cfile:1273520
 *     → uimain.StartSplashScreen()        uimain.lua:41
 *     → splash.lua:22-25 sieht `movie.nologo` und ruft EngineStartFrontEndUI()
 *     → __uiSetNewLuaState(UIS_frontend) → SetupUI() → uimain.StartFrontEndUI()
 *     → menus/main.lua:CreateUI()         das Menü baut sich selbst
 *
 * Geprüft wird, was danach im maui-Baum steht: Logo, Konsolen-Rahmen und GENAU
 * so viele Menü-Knöpfe, wie `menuTop` Einträge hat (main.lua:104-142). Dazu die
 * Audio-Handles: das Menü startet zwei Cues und muss sie über ihr Handle wieder
 * stoppen können (main.lua:231-249).
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-frontend.ts
 */
import { open, readdir, readFile, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { installUiEngine, createRootFrame, startFrontEnd } from '../src/lua/uiEngine'
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

// --- VFS ---------------------------------------------------------------------
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
    if (k.startsWith('textures/ui/') && k.endsWith('.dds') && !ddsBytes.has(k)) {
      ddsBytes.set(k, await zip.read(entry))
    }
  }
}

const dims = new Map<string, [number, number]>()
const textureSize = (p: string): [number, number] | null => {
  const hit = dims.get(p)
  if (hit) return hit
  const bytes = ddsBytes.get(p)
  if (!bytes) return null
  try {
    const dds = parseDds(bytes)
    const out: [number, number] = [dds.width, dds.height]
    dims.set(p, out)
    return out
  } catch {
    return null
  }
}

const fonts = new FontBook()
for (const name of await readdir(`${GAME}/fonts`)) {
  if (/\.ttf$/i.test(name)) fonts.add(await readFile(`${GAME}/fonts/${name}`))
}

console.log(`\n== UI-VM booten (${files.size} Lua-Dateien, ${ddsBytes.size} UI-Texturen) ==`)
const warnings: string[] = []
const logs: string[] = []
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') {
    warnings.push(msg)
    // --warn: die WARN-Zeile SOFORT zeigen. import.lua:51 meldet den echten
    // Fehler per WARN und wirft danach nur noch „Error importing '<datei>'" —
    // ohne diese Ausgabe sucht man die Ursache im falschen Modul.
    if (process.argv.includes('--warn')) console.log(`WARN: ${msg.split('\n').slice(0, 3).join(' | ')}`)
  }
  logs.push(`${level}: ${msg}`)
})
// Die Ablage der Einstellungen (im Browser der localStorage, hier eine Variable).
// Sie ist Teil des Tests: die Prefs müssen einen VM-Neustart überleben.
let prefsStore: string | null = null
const uiFs = {
  exists: (p: string) => allPaths.has(p),
  find: (dir: string, pattern: string) => findFiles(allPaths, dir, pattern),
  textureSize,
  stringAdvance: (text: string, family: string, size: number) => fonts.advance(text, family, size),
  fontMetrics: (family: string, size: number) => fonts.metrics(family, size),
  prefs: {
    load: (): string | null => prefsStore,
    save: (luaText: string): void => {
      prefsStore = luaText
    },
  },
}
installUiEngine(host, uiFs)
// Der Root-Frame steht VOR SetupUI — CUIManager::SetNewLuaState legt ihn
// zuerst an (Cfile:1273621-1273666), SetupUI kommt erst danach (1273680).
createRootFrame(host, 1920, 1080)

console.log('\n== Das Original-Menü bootet sich selbst ==')
startFrontEnd(host)
check(String(host.eval('return GetCurrentUIState()')) === 'frontend', 'UI-Zustand ist "frontend" (splash.lua hat durchgereicht)')

// Das Menü fährt EIN: menuBracketMiddle:Animate schiebt die Klammer pro Bild
// (main.lua:305-326), danach forkt ButtonFade einen Thread, der jeden Knopf
// FadeIn()t — und erst FadeIn ruft `control:Enable()` (main.lua:621) und setzt
// `OnClick` (644). Vorher sind ALLE Knöpfe absichtlich gesperrt (609).
//
// Damit ist dieser Test zugleich der Beweis für den Frame-Scheduler aus M1:
// ohne laufende UI-Threads bliebe das Menü für immer grau und unklickbar.
for (let i = 0; i < 200; i++) host.eval('__mauiFrame(0.016)')

interface Snap {
  kind: string
  name: string
  texture: string | false
  text: string | false
  alpha: number
  hidden: boolean
}
const snap = host.pull<Snap[]>('__mauiSnapshotJson()')
const textures = snap.map((c) => (c.texture ? String(c.texture).toLowerCase() : ''))
const texturesOf = (needle: string): number => textures.filter((t) => t.includes(needle)).length

check(snap.length > 20, `${snap.length} maui-Controls stehen im Menü`)
check(texturesOf('/logo/logo.dds') === 1, 'das Logo hängt im Baum (/scx_menu/logo/logo.dds)')
check(texturesOf('border-console-top_bmp.dds') === 1, 'der Konsolen-Rahmen ist da (border-console-top_bmp.dds)')

// main.lua:104-142 — menuTop hat sieben Einträge; CreateButtonStd (543) gibt
// jedem sein large_btn_up.dds. Genau so viele Knöpfe müssen dastehen: einer
// weniger heißt, ein Eintrag ist beim Bauen verhungert.
const menuTopCount = 7
const buttons = texturesOf('large_btn_up.dds')
check(buttons === menuTopCount, `${buttons} freigegebene Menü-Knöpfe = ${menuTopCount} Einträge in menuTop`)
if (buttons !== menuTopCount && process.argv.includes('--dump')) {
  for (const c of snap) console.log(`    ${c.kind} ${c.name} ${c.texture || c.text || ''}`)
}
// … und sie müssen SICHTBAR sein. Die Knöpfe starten auf Alpha 0 (main.lua:610);
// erst `FadeIn` blendet sie über OnFrame auf 1 hoch (648/670). Ein Knopf mit der
// richtigen Textur, aber Alpha 0, ist im Bild schlicht nicht da — genau das war
// der Zustand, den nur der Browser zeigte, weil dieser Test nur Texturen prüfte.
const visibleButtons = snap.filter(
  (c) => c.name === 'button' && !c.hidden && c.alpha > 0.9 && String(c.texture).includes('large_btn'),
).length
check(visibleButtons >= menuTopCount, `${visibleButtons} Knöpfe sind voll eingeblendet (Alpha 1)`)

// Die sieben Beschriftungen — lokalisiert aus der Original-Lua (<LOC _Campaign> …).
const labels = snap.filter((c) => c.kind === 'text' && c.text).map((c) => String(c.text))
check(
  labels.some((t) => /Kampagne|Campaign/i.test(t)) && labels.some((t) => /Gefecht|Skirmish/i.test(t)),
  'die Knöpfe tragen ihre Beschriftung aus menuTop',
)
// … und zwar mit den richtigen Zeichen. `/loc/<sprache>/strings_db.lua` ist UTF-8;
// wer die Datei latin1 einliest und als UTF-8 wieder ausgibt, kodiert jedes Byte
// über 0x7F doppelt — im Menü stand „Profil Ã¤ndern".
const mojibake = labels.filter((t) => /Ã.|â€/.test(t))
check(mojibake.length === 0, `keine doppelt kodierten Umlaute (${mojibake[0]?.slice(0, 40) ?? '—'})`)

// GetVersion() steht sichtbar im Menü (main.lua:172) — und ist kein erfundener
// String mehr, sondern die Version DIESER Engine.
const version = String(host.eval('return GetVersion()'))
const versionShown = snap.some((c) => c.kind === 'text' && String(c.text) === version)
check(version !== 'CFA' && version.length > 3, `GetVersion() = "${version}" (aus der package.json)`)
check(versionShown, 'die Version steht als Text im Menü (main.lua:172)')

console.log('\n== Der Klick auf „Gefecht" trägt bis zur Lobby ==')
// Der ehrliche Beweis, dass die Kette steht: der Klick geht durch den Dragger
// (button.lua:120-160 — OnClick feuert erst in dragger:OnRelease), durch
// TutorialPrompt und MenuHide (eine Ausblend-Animation über Frames), und landet
// in lobby.CreateLobby (main.lua:915). Dort MUSS er scheitern, und zwar an
// GENAU einer Stelle: InternalCreateLobby (lobbycomm.lua:121) gibt es noch
// nicht. Ein anderer Fehler wäre ein Loch weiter vorn in der Kette.
interface Box {
  left: number
  top: number
  width: number
  height: number
  text: string | false
  kind: string
}
/** Klickt auf das Control unter einem Text und lässt die Animationen laufen.
 *  Liefert den Lua-Fehler, falls dabei einer hochkommt. */
const clickText = (pattern: RegExp, label: string): string | null => {
  const box = host
    .pull<Box[]>('__mauiSnapshotJson()')
    .find((c) => c.kind === 'text' && pattern.test(String(c.text)))
  check(box !== undefined, label)
  if (!box) return null
  const x = Math.round(box.left + box.width / 2)
  const y = Math.round(box.top + box.height / 2)
  try {
    host.eval(`__mauiMouse('ButtonPress', ${x}, ${y}, {}, 1)`)
    host.eval(`__mauiMouse('ButtonRelease', ${x}, ${y}, {}, 1)`)
    // MenuHide/Dialoge blenden über Bilder aus; der Callback kommt erst danach.
    for (let i = 0; i < 500; i++) host.eval('__mauiFrame(0.016)')
  } catch (e) {
    return (e as Error).message
  }
  return null
}

let err = clickText(/Gefecht|Skirmish/i, 'der Gefecht-Knopf ist im Baum zu finden')
if (err === null) {
  // Beim ersten Mal fragt das Spiel, ob man das Tutorial spielen will
  // (main.lua:855-872, Prefs 'MenuTutorialPrompt'). Das ist Original-Verhalten,
  // kein Fehler — der Dialog muss also erst beantwortet werden.
  err = clickText(/^Nein$|^No$/i, 'der Tutorial-Dialog steht da und lässt sich mit „Nein" beantworten')
}
const line = err?.split('\n')[0] ?? ''
check(
  line.includes('InternalCreateLobby'),
  err === null
    ? 'FEHLT: der Klick versandet — er kommt gar nicht bis zur Lobby'
    : `der Weg endet GENAU hier: ${line.replace(/^.*?:\s*/, '').slice(0, 90)}`,
)

console.log('\n== Der Optionen-Dialog: ItemList, Scrollbar und Combo ==')
// Der Optionen-Dialog ist der erste Ort, an dem die Original-UI die drei
// fehlenden Controls braucht: eine ItemList (jedes Dropdown ist eine —
// combo.lua:117) und einen Scrollbar (uiutil.CreateVertScrollbarFor).
// Er wird hier direkt gebaut, nicht geklickt: das Menü hat sich nach dem
// Lobby-Fehler schon abgeräumt.
{
  let dlgErr: string | null = null
  try {
    host.eval(`
      __ui = {}
      __ui.parent = import('/lua/ui/uiutil.lua').CreateScreenGroup(GetFrame(0), 'Options Test')
      import('/lua/ui/dialogs/options.lua').CreateDialog(__ui.parent, function() end)
    `)
    for (let i = 0; i < 30; i++) host.eval('__mauiFrame(0.016)')
  } catch (e) {
    dlgErr = ((e as Error).message.split('\n')[0] ?? '').replace(/\[string "[\s\S]*?"\]/g, '')
  }
  check(dlgErr === null, `options.lua baut den Dialog${dlgErr ? ` — ${dlgErr.slice(0, 110)}` : ''}`)

  // Die ItemLists der Dropdowns sind ZUGEKLAPPT (combo.lua versteckt sie), und
  // der Snapshot zeigt nur Sichtbares — also im Baum zählen, nicht im Snapshot.
  const lists = Number(
    host.eval(`
      local n = 0
      for _, c in pairs(__mauiControls) do
        if c.__kind == 'itemlist' and not c.__destroyed then n = n + 1 end
      end
      return n
    `),
  )
  const bars = host.pull<{ kind: string }[]>('__mauiSnapshotJson()').filter((c) => c.kind === 'scrollbar')
  check(lists > 0, `${lists} ItemLists im Dialog (jedes Dropdown ist eine — combo.lua:117)`)
  check(bars.length > 0, `${bars.length} Scrollbar(s) im Dialog`)

  // Und sie tragen echte Zeilen: die Combos werden aus den Optionsdaten gefüllt
  // (optionslogic.GetOptionsData → Auflösung, Sprache, Schatten …).
  const rows = Number(
    host.eval(`
      local best = 0
      for _, c in pairs(__mauiControls) do
        if c.__kind == 'itemlist' and not c.__destroyed then
          local n = table.getn(c.__items)
          if n > best then best = n end
        end
      end
      return best
    `),
  )
  check(rows > 1, `die größte Liste hat ${rows} Zeilen — die Optionen stehen wirklich drin`)
}

console.log('\n== Der Regler lässt sich ziehen — und meldet den neuen Wert ==')
// Der Zug geht durch den Dragger (slider.lua:49-70: ButtonPress → Dragger,
// OnMove → CalculateValueFromMouse → SetValue → OnValueChanged); options.lua
// hängt daran sein `update` (options.lua:713 → SetVolume). Ohne Dragger-OnMove
// bewegt sich nichts, und der Regler wäre reine Dekoration.
//
// Der Test läuft NACH dem Dialog-Test — aber der Dialog ist MODAL (uiutil.lua:616
// MakeInputModal → AddInputCapture), und ein Klick daneben trifft dann nichts.
// Genau das soll die Modalität tun; also wird der Capture-Stack vorher geleert,
// wie es der Dialog beim Schließen selbst täte.
{
  host.eval(`
    while AnyInputCapture() do RemoveInputCapture(GetInputCapture()) end
    __sliderTest = {}
    __sliderTest.parent = import('/lua/ui/uiutil.lua').CreateScreenGroup(GetFrame(0), 'Slider Test')
    __sliderTest.parent.Depth:Set(99999)
    local Slider = import('/lua/maui/slider.lua').Slider
    local UIUtil = import('/lua/ui/uiutil.lua')
    __sliderTest.slider = Slider(__sliderTest.parent, false, 0, 100,
      UIUtil.SkinnableFile('/slider02/slider_btn_up.dds'),
      UIUtil.SkinnableFile('/slider02/slider_btn_over.dds'),
      UIUtil.SkinnableFile('/slider02/slider_btn_down.dds'),
      UIUtil.SkinnableFile('/slider02/slider-back_bmp.dds'))
    __sliderTest.slider.Left:Set(100)
    __sliderTest.slider.Top:Set(60)
    __sliderTest.slider.Depth:Set(100000)
    __sliderTest.slider:SetValue(100)
    __sliderTest.changed = false
    __sliderTest.slider.OnValueChanged = function(self, newValue)
      __sliderTest.changed = newValue
    end
  `)
  host.eval('__mauiFrame(0.016)')
  const thumb = host.pull<{ left: number; top: number; width: number; height: number }[]>(
    `(function()
      local t = __sliderTest.slider._thumb
      return '[{"left":' .. t.Left() .. ',"top":' .. t.Top() .. ',"width":' .. t.Width() .. ',"height":' .. t.Height() .. '}]'
    end)()`,
  )[0]!
  const tx = Math.round(thumb.left + thumb.width / 2)
  const ty = Math.round(thumb.top + thumb.height / 2)
  const hit = String(host.eval(`local c = __mauiHitTest(${tx}, ${ty}) return c and c.__kind or 'NICHTS'`))
  check(hit === 'bitmap', `der Zeiger trifft den Regler-Knopf bei ${tx},${ty} (${hit})`)

  host.eval(`__mauiMouse('ButtonPress', ${tx}, ${ty}, {}, 1)`)
  host.eval(`__mauiMouse('MouseMotion', 110, ${ty}, {}, 1)`)
  host.eval(`__mauiMouse('ButtonRelease', 110, ${ty}, {}, 1)`)
  const value = Number(host.eval('return __sliderTest.slider:GetValue()'))
  check(value < 50, `Zug nach links: 100 → ${Math.round(value)} (Dragger → OnMove → SetValue)`)
  check(
    host.eval('return __sliderTest.changed') !== false,
    'OnValueChanged feuert — daran hängt options.lua:713 (update → SetVolume)',
  )
}

console.log('\n== Audio: Handles ohne Ausgabe ==')
// main.lua:231-249 startet Ambient + Musik und stoppt sie über das HANDLE.
// Ohne Rückgabewert von PlaySound hätte StopSound nichts zu greifen.
const cueList = (): string =>
  String(
    host.eval(`
      local out = {}
      for _, h in ipairs(__uiSoundsRequested) do
        out[table.getn(out) + 1] = tostring(h.Cue) .. ':' .. (h.playing and 'an' or (h.stopped and 'aus' or 'still'))
      end
      return table.concat(out, ' ')
    `),
  )
const cues = cueList().split(' ').filter(Boolean)
check(cues.some((c) => c.startsWith('AMB_Menu_Loop:')), `Ambient-Cue angefordert (${cues.length} Cues insgesamt)`)
check(cues.some((c) => c.startsWith('Main_Menu:')), 'Musik-Cue "Main_Menu" angefordert')
check(cues.filter((c) => c.endsWith(':an')).length >= 2, 'die Cues LAUFEN (Zustand wird geführt, nicht ausgegeben)')

// Das Menü verlassen — auf dem Engine-Weg: jeder Zustandswechsel gibt die
// Root-Frames frei (CUIManager::SetNewLuaState, Cfile:1273600), der Baum ist
// danach leer, und main.lua:249 stoppt in seinem OnDestroy die Musik über ihr
// Handle. Genau das ist der Grund, warum PlaySound eins zurückgeben MUSS.
host.eval('__mauiResetFrames()')
const stopped = cueList()
  .split(' ')
  .filter((c) => c.startsWith('Main_Menu:'))
check(stopped.every((c) => c.endsWith(':aus')), 'nach dem Abräumen ist die Musik über ihr Handle gestoppt')

console.log('\n== Die Einstellungen überleben den Neustart ==')
// Zwei Dinge zusammen, und beide fehlten:
//
//  1. `SavePreferences()` war ein Nullaufruf (`__uiSavePrefs` wurde nie gesetzt)
//     — jede Option, jedes Profil, jede Lautstärke war nach dem Neuladen weg.
//     Die Engine schreibt Game.prefs als LUA-QUELLTEXT; genau das tun wir jetzt.
//  2. `optionslogic.Apply(true)` ruft die Engine beim Start selbst
//     (Moho::OPTIONS_Apply, Cfile:1368338 — Call_True_Obj = Apply(true)). Ohne
//     diesen Aufruf steht der gespeicherte Wert zwar in den Prefs, aber niemand
//     trägt ihn in die Engine: es wirkte KEINE einzige Option.
{
  host.eval(`
    local Prefs = import('/lua/user/prefs.lua')
    Prefs.SetOption('music_volume', 42)
    SavePreferences()
  `)
  check(prefsStore !== null && prefsStore.includes('42'), 'die Option landet als Lua-Text in der Ablage')

  // Eine FRISCHE VM — dieselbe Ablage. Das ist der Neustart.
  const host2 = await LuaHost.create(files, () => {})
  installUiEngine(host2, uiFs)
  createRootFrame(host2, 1920, 1080)
  const restored = Number(
    host2.eval(`return import('/lua/user/prefs.lua').GetOption('music_volume')`),
  )
  check(restored === 42, `nach dem Neustart steht der Wert wieder da (${restored})`)

  // … und er WIRKT: Apply(true) trägt ihn über SetVolume in die Engine
  // (options.lua:735 → SetVolume('Music', value/100)).
  startFrontEnd(host2)
  const musicVolume = Number(host2.eval(`return GetVolume('Music')`))
  check(
    Math.abs(musicVolume - 0.42) < 0.001,
    `und Apply(true) trägt ihn ein: GetVolume('Music') = ${musicVolume}`,
  )
  host2.close()
}

if (warnings.length > 0) {
  console.log(`\n  (${warnings.length} WARN aus der UI-Lua:)`)
  for (const w of warnings.slice(0, 8)) console.log(`   · ${w.split('\n')[0]?.slice(0, 160)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nFRONT-END BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
