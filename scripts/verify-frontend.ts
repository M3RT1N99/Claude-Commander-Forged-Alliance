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

console.log(`\n== Boot UI VM (${files.size} Lua files, ${ddsBytes.size} UI textures) ==`)
const warnings: string[] = []
const logs: string[] = []
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') {
    warnings.push(msg)
    // --warn: show the WARN line IMMEDIATELY. import.lua:51 reports the real one
    // Error via WARN and then only throws "Error importing '<file>'" -
    // Without this output you look for the cause in the wrong module.
    if (process.argv.includes('--warn')) console.log(`WARN: ${msg.split('\n').slice(0, 3).join(' | ')}`)
  }
  logs.push(`${level}: ${msg}`)
})
// The storage of the settings (in the localStorage browser, here a variable).
// It is part of the test: the prefs must survive a VM restart.
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
// The root frame is BEFORE SetupUI — CUIManager::SetNewLuaState sets it
// comes first (Cfile:1273621-1273666), SetupUI comes afterwards (1273680).
createRootFrame(host, 1920, 1080)

console.log('\n== Das Original-Menü bootet sich selbst ==')
startFrontEnd(host)
check(String(host.eval('return GetCurrentUIState()')) === 'frontend', 'UI-Zustand ist "frontend" (splash.lua hat durchgereicht)')

// The menu moves ON: menuBracketMiddle:Animate pushes the bracket per frame
// (main.lua:305-326), then ButtonFade forks a thread that handles each button
// FadeIn()t — and only FadeIn calls `control:Enable()` (main.lua:621) and sets
// `OnClick` (644). Previously, ALL buttons were intentionally locked (609).
//
// This test is therefore also proof of the frame scheduler from M1:
// without running UI threads, the menu would remain gray and unclickable forever.
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

// main.lua:104-142 — menuTop has seven entries; CreateButtonStd (543) returns
// Everyone has their own large_btn_up.dds. There have to be exactly that many buttons: one
// less means an entry starved to death during construction.
const menuTopCount = 7
const buttons = texturesOf('large_btn_up.dds')
check(buttons === menuTopCount, `${buttons} freigegebene Menü-Knöpfe = ${menuTopCount} Einträge in menuTop`)
if (buttons !== menuTopCount && process.argv.includes('--dump')) {
  for (const c of snap) console.log(`    ${c.kind} ${c.name} ${c.texture || c.text || ''}`)
}
// ... and they have to be VISIBLE. The buttons start at Alpha 0 (main.lua:610);
// only `FadeIn` fades it up to 1 (648/670) via OnFrame. A button with the
// The right texture, but alpha 0, is simply not there in the image - that's exactly what it was
// the state that only the browser showed because this test only checked textures.
const visibleButtons = snap.filter(
  (c) => c.name === 'button' && !c.hidden && c.alpha > 0.9 && String(c.texture).includes('large_btn'),
).length
check(visibleButtons >= menuTopCount, `${visibleButtons} Knöpfe sind voll eingeblendet (Alpha 1)`)

// The seven labels — localized from the original Lua (<LOC _Campaign> …).
const labels = snap.filter((c) => c.kind === 'text' && c.text).map((c) => String(c.text))
check(
  labels.some((t) => /Kampagne|Campaign/i.test(t)) && labels.some((t) => /Gefecht|Skirmish/i.test(t)),
  'die Knöpfe tragen ihre Beschriftung aus menuTop',
)
// ... with the right characters. `/loc/<sprache>/strings_db.lua` is UTF-8;
// Anyone who reads the latin1 file and outputs it as UTF-8 encodes every byte
// über 0x7F doppelt — im Menü stand „Profil Ã¤ndern".
const mojibake = labels.filter((t) => /Ã.|â€/.test(t))
check(mojibake.length === 0, `keine doppelt kodierten Umlaute (${mojibake[0]?.slice(0, 40) ?? '—'})`)

// GetVersion() is visible in the menu (main.lua:172) — and is not an invented one
// String more, but the version of THIS engine.
const version = String(host.eval('return GetVersion()'))
const versionShown = snap.some((c) => c.kind === 'text' && String(c.text) === version)
check(version !== 'CFA' && version.length > 3, `GetVersion() = "${version}" (aus der package.json)`)
check(versionShown, 'die Version steht als Text im Menü (main.lua:172)')

console.log('\n== Der Klick auf „Gefecht" trägt bis zur Lobby ==')
// The honest proof that the chain is standing: the click goes through the dragger
// (button.lua:120-160 — OnClick only fires in dragger:OnRelease), through
// TutorialPrompt and MenuHide (a fade animation over frames), and lands
// in lobby.CreateLobby(main.lua:915). That's where he MUST fail, and that's where
// EXACTLY one place: InternalCreateLobby (lobbycomm.lua:121) still exists
// not. Another error would be a hole further forward in the chain.
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
    // MenuHide/Hide dialogs via images; the callback only comes afterwards.
    for (let i = 0; i < 500; i++) host.eval('__mauiFrame(0.016)')
  } catch (e) {
    return (e as Error).message
  }
  return null
}

let err = clickText(/Gefecht|Skirmish/i, 'der Gefecht-Knopf ist im Baum zu finden')
if (err === null && !warnings.some((w) => w.includes('InternalCreateLobby'))) {
  // The first time the game asks if you want to play the tutorial
  // (main.lua:855-872, Prefs 'MenuTutorialPrompt'). This is original behavior,
  // no error - the dialog must therefore be answered first.
  err = clickText(/^Nein$|^No$/i, 'der Tutorial-Dialog steht da und lässt sich mit „Nein" beantworten')
}
// A Lua error in an OnFrame does not THROW in the engine: RunScript catches
// it (lua_call != 0) and logs "Error running %s script in %s: %s"
// (gpg::Warnf, Cfile:590672; LogScriptWarning Cfile:590508) — the image is running
// further. The image pump has been doing the same thing since the xpcall (maui.lua). The proof,
// The fact that the click takes you to the lobby is therefore in the WARN log - not in one
// hochgeworfenen Exception.
const lobbySource = err ?? warnings.find((w) => w.includes('InternalCreateLobby')) ?? ''
const line = lobbySource.split('\n').find((l) => l.includes('InternalCreateLobby')) ?? ''
check(
  line.includes('InternalCreateLobby'),
  line === ''
    ? 'FEHLT: der Klick versandet — er kommt gar nicht bis zur Lobby'
    : `der Weg endet GENAU hier: ${line.replace(/^.*?:\s*/, '').slice(0, 90)}`,
)

console.log('\n== Der Optionen-Dialog: ItemList, Scrollbar und Combo ==')
// The Options dialog is the first place where the original UI has the three
// Missing controls need: an ItemList (each dropdown is one -
// combo.lua:117) and a scrollbar (uiutil.CreateVertScrollbarFor).
// It is built directly here, not clicked: the menu is based on that
// Lobby error already cleared up.
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

  // The ItemLists of the dropdowns are CLOSED (combo.lua hides them), and
  // the snapshot only shows what is visible - i.e. counting in the tree, not in the snapshot.
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

  // And they carry real lines: the combos are filled from the options data
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
// The train goes through the dragger (slider.lua:49-70: ButtonPress → Dragger,
// OnMove → CalculateValueFromMouse → SetValue → OnValueChanged); options.lua
// depends on it `update` (options.lua:713 → SetVolume). Without Dragger OnMove
// Nothing moves and the controller would be purely decorative.
//
// The test runs AFTER the dialog test — but the dialog is MODAL (uiutil.lua:616
// MakeInputModal → AddInputCapture), and clicking next to it does nothing.
// This is exactly what the modality is intended to do; so the capture stack is emptied beforehand,
// as the dialog itself would do when closing.
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
// main.lua:231-249 starts ambient + music and stops it via the HANDLE.
// Without a return value from PlaySound, StopSound would have nothing to grab onto.
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

// Exit the menu - the engine way: every change of state gives the
// Root frames free (CUIManager::SetNewLuaState, Cfile:1273600), the tree is
// then empty, and main.lua:249 stops the music above her in his OnDestroy
// Act. This is exactly why PlaySound MUST return one.
host.eval('__mauiResetFrames()')
const stopped = cueList()
  .split(' ')
  .filter((c) => c.startsWith('Main_Menu:'))
check(stopped.every((c) => c.endsWith(':aus')), 'nach dem Abräumen ist die Musik über ihr Handle gestoppt')

console.log('\n== Die Einstellungen überleben den Neustart ==')
// Two things together, and both were missing:
//
//  1. `SavePreferences()` was a null call (`__uiSavePrefs` was never set)
//     — every option, every profile, every volume was gone after reloading.
//     The engine writes Game.prefs as LUA SOURCE; That's exactly what we're doing now.
//  2. `optionslogic.Apply(true)` calls the engine itself when starting
//     (Moho::OPTIONS_Apply, Cfile:1368338 — Call_True_Obj = Apply(true)). Without
//     For this call, the stored value is in the Prefs, but no one is there
//     carries it into the engine: NOT a single option worked.
{
  host.eval(`
    local Prefs = import('/lua/user/prefs.lua')
    Prefs.SetOption('music_volume', 42)
    SavePreferences()
  `)
  check(prefsStore !== null && prefsStore.includes('42'), 'die Option landet als Lua-Text in der Ablage')

  // A FRESH VM — same tray. This is the restart.
  const host2 = await LuaHost.create(files, () => {})
  installUiEngine(host2, uiFs)
  createRootFrame(host2, 1920, 1080)
  const restored = Number(
    host2.eval(`return import('/lua/user/prefs.lua').GetOption('music_volume')`),
  )
  check(restored === 42, `nach dem Neustart steht der Wert wieder da (${restored})`)

  // ... and it WORKS: Apply(true) carries it into the engine via SetVolume
  // (options.lua:735 → SetVolume('Music', value/100)).
  startFrontEnd(host2)
  const musicVolume = Number(host2.eval(`return GetVolume('Music')`))
  check(
    Math.abs(musicVolume - 0.42) < 0.001,
    `und Apply(true) trägt ihn ein: GetVolume('Music') = ${musicVolume}`,
  )
  host2.close()
}

console.log('\n== ConExecute ist eine echte Konsole — 19 Optionen hängen daran ==')
// options.lua sets half of its options via console commands:
//     set = function(key, value, startup) ConExecute("ui_KeyboardPanSpeed " .. value) end
// Behind this there are real variables in the engine (Moho::TConVar), which
// C++ page reads in its loops. As long as ConExecute only LOGGED, everyone was
// these options are a dummy.
{
  // The starting values ​​are in the decomp - not advised.
  check(
    Math.abs(Number(host.eval(`return __conGet('ui_KeyboardPanSpeed')`)) - 90) < 0.001,
    'ui_KeyboardPanSpeed = 90 (Cfile:421739)',
  )
  check(
    Math.abs(Number(host.eval(`return __conGet('cam_ZoomAmount')`)) - 0.4) < 0.001,
    'cam_ZoomAmount = 0.4 (Cfile:421825)',
  )
  // The names are NOT case-sensitive: options.lua writes `ren_Skydome`,
  // the engine is called Moho::ren_SkyDome. If you compare exactly, you lose it.
  host.eval(`ConExecute('ren_Skydome false')`)
  check(host.eval(`return __conGet('ren_SkyDome')`) === false, 'ren_Skydome ↔ ren_SkyDome (Groß/Klein egal)')

  // And all the way: change option → optionslogic → ConExecute → ConVar.
  host.eval(`
    local Prefs = import('/lua/user/prefs.lua')
    Prefs.SetOption('keyboard_pan_speed', 150)
  `)
  check(
    Math.abs(Number(host.eval(`return __conGet('ui_KeyboardPanSpeed')`)) - 150) < 0.001,
    'eine geänderte Option schlägt bis in die ConVar durch (90 → 150)',
  )
}

if (warnings.length > 0) {
  console.log(`\n  (${warnings.length} WARN aus der UI-Lua:)`)
  for (const w of warnings.slice(0, 8)) console.log(`   · ${w.split('\n')[0]?.slice(0, 160)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nFRONT-END BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
