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
  if (level === 'WARN') warnings.push(msg)
  logs.push(`${level}: ${msg}`)
})
installUiEngine(host, {
  exists: (p) => allPaths.has(p),
  find: (dir, pattern) => findFiles(allPaths, dir, pattern),
  textureSize,
  stringAdvance: (text, family, size) => fonts.advance(text, family, size),
  fontMetrics: (family, size) => fonts.metrics(family, size),
})
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
// Die sieben Beschriftungen — lokalisiert aus der Original-Lua (<LOC _Campaign> …).
const labels = snap.filter((c) => c.kind === 'text' && c.text).map((c) => String(c.text))
check(
  labels.some((t) => /Kampagne|Campaign/i.test(t)) && labels.some((t) => /Gefecht|Skirmish/i.test(t)),
  'die Knöpfe tragen ihre Beschriftung aus menuTop',
)

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

if (warnings.length > 0) {
  console.log(`\n  (${warnings.length} WARN aus der UI-Lua:)`)
  for (const w of warnings.slice(0, 8)) console.log(`   · ${w.split('\n')[0]?.slice(0, 160)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nFRONT-END BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
