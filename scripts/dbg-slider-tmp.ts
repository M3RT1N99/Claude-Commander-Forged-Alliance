/** Zieht einen Regler im Optionen-Dialog — headless, ohne Browser. */
import { open, readdir, readFile, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { installUiEngine, createRootFrame, startFrontEnd } from '../src/lua/uiEngine'
import { findFiles } from '../src/vfs/glob'
import { parseDds } from '../src/formats/dds'
import { FontBook } from '../src/ui/fonts'

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
  close(): Promise<void> { return this.fh.close() }
}

const GAME = process.env.CFA_GAME_DIR ?? 'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'
const files = new Map<string, Uint8Array>()
const allPaths = new Set<string>()
const ddsBytes = new Map<string, Uint8Array>()
const openFiles: NodeFile[] = []
const archives = (await readdir(`${GAME}/gamedata`)).filter((n) => n.toLowerCase().endsWith('.scd')).sort()
for (const archive of archives) {
  const f = await NodeFile.open(`${GAME}/gamedata/${archive}`)
  openFiles.push(f)
  const zip = await ZipArchive.open(f)
  for (const [key, entry] of zip.entries) {
    const k = key.toLowerCase()
    allPaths.add(k)
    if (key.endsWith('.lua') && !files.has(key)) files.set(key, await zip.read(entry))
    if (k.startsWith('textures/ui/') && k.endsWith('.dds') && !ddsBytes.has(k)) ddsBytes.set(k, await zip.read(entry))
  }
}
const dims = new Map<string, [number, number]>()
const textureSize = (p: string): [number, number] | null => {
  const hit = dims.get(p); if (hit) return hit
  const b = ddsBytes.get(p); if (!b) return null
  try { const d = parseDds(b); const o: [number, number] = [d.width, d.height]; dims.set(p, o); return o } catch { return null }
}
const fonts = new FontBook()
for (const name of await readdir(`${GAME}/fonts`)) if (/\.ttf$/i.test(name)) fonts.add(await readFile(`${GAME}/fonts/${name}`))

const warns: string[] = []
const host = await LuaHost.create(files, (lvl, msg) => { if (lvl === 'WARN') warns.push(msg) })
installUiEngine(host, {
  exists: (p) => allPaths.has(p),
  find: (dir, pattern) => findFiles(allPaths, dir, pattern),
  textureSize,
  stringAdvance: (t, f, s) => fonts.advance(t, f, s),
  fontMetrics: (f, s) => fonts.metrics(f, s),
})
createRootFrame(host, 1920, 1080)
startFrontEnd(host)
for (let i = 0; i < 60; i++) host.eval('__mauiFrame(0.016)')

// Optionen-Dialog direkt bauen (wie verify-frontend).
host.eval(`
  __ui = {}
  __ui.parent = import('/lua/ui/uiutil.lua').CreateScreenGroup(GetFrame(0), 'Options Test')
  import('/lua/ui/dialogs/options.lua').CreateDialog(__ui.parent, function() end)
`)
for (let i = 0; i < 30; i++) host.eval('__mauiFrame(0.016)')

// Einen Slider finden: ein Control mit _currentValue.
const info = String(host.eval(`
  local out = {}
  for _, c in pairs(__mauiControls) do
    if c._currentValue and not c.__destroyed then
      local ok, l, t, r, b = pcall(function() return c.Left(), c.Top(), c.Right(), c.Bottom() end)
      local th = c._thumb
      local ok2, tl, tt, tr, tb = pcall(function() return th.Left(), th.Top(), th.Right(), th.Bottom() end)
      out[table.getn(out)+1] = 'name='..tostring(c.__name)
        ..' hidden='..tostring(c.__hidden)
        ..' value='..tostring(c:GetValue())
        ..' box='..(ok and (l..','..t..','..r..','..b) or 'KEIN LAYOUT')
        ..' thumb='..(ok2 and (tl..','..tt..','..tr..','..tb) or 'KEIN LAYOUT')
        ..' thumbTex='..tostring(th.__texture)
        ..' thumbHit='..tostring(th.__hitTest)
        ..' indent='..tostring(c._indentValue)
    end
  end
  return table.concat(out, '\\n')
`))
console.log('Slider gefunden:\n' + info)

// Hit-Test auf die Thumb-Mitte des ersten sichtbaren Sliders.
const probeStr = String(host.eval(`
  for _, c in pairs(__mauiControls) do
    if c._currentValue and not c.__destroyed then
      local th = c._thumb
      local ok, tl, tt, tr, tb = pcall(function() return th.Left(), th.Top(), th.Right(), th.Bottom() end)
      if ok then
        local x = math.floor((tl+tr)/2)
        local y = math.floor((tt+tb)/2)
        local hit = __mauiHitTest(x, y)
        __dbgSlider = c
        return x..';'..y..';'..(hit and tostring(hit.__name) or 'NICHTS')..';'..tostring(hit == th)
          ..';'..c.Left()..';'..c.Right()..';'..c:GetValue()
      end
    end
  end
  return ''
`))
console.log('Probe (x;y;hitName;hitIsThumb;sliderL;sliderR;value):', probeStr)

if (probeStr) {
  const p = probeStr.split(';')
  const x = Number(p[0])
  const y = Number(p[1])
  const probe = { sliderRight: Number(p[5]) }
  const traced = host.eval(`
    __trace = {}
    for _, c in pairs({ __dbgSlider }) do
      if c._currentValue and not c.__destroyed then
        local old = c.OnValueSet
        c.OnValueSet = function(self, v) table.insert(__trace, 'OnValueSet '..tostring(v)); old(self, v) end
        local oldS = c.OnScrub
        c.OnScrub = function(self, v) table.insert(__trace, 'OnScrub '..tostring(v)); oldS(self, v) end
        local oldC = c.OnValueChanged
        c.OnValueChanged = function(self, v) table.insert(__trace, 'OnValueChanged '..tostring(v)); oldC(self, v) end
        break
      end
    end
    return 'ok'
  `)
  console.log('Trace installiert:', traced)

  const mods = `{ Shift=false, Ctrl=false, Alt=false, Left=true, Middle=false, Right=false }`
  const run = (code: string): unknown => {
    try { return host.eval(code) } catch (e) { return 'FEHLER: ' + (e as Error).message.split('\n')[0] }
  }
  console.log('MouseMotion(hover):', run(`return __mauiMouse('MouseMotion', ${x}, ${y}, ${mods}, 0)`))
  console.log('ButtonPress:', run(`return __mauiMouse('ButtonPress', ${x}, ${y}, ${mods}, 1)`))
  console.log('Dragger aktiv?', run(`return __mauiDragger ~= false`), 'Key:', run(`return __mauiDraggerKey`))
  const target = Math.round(probe.sliderRight as number) - 10
  for (let i = 1; i <= 5; i++) {
    const px = Math.round(x + ((target - x) * i) / 5)
    const r = run(`return __mauiMouse('MouseMotion', ${px}, ${y}, ${mods}, 0)`)
    console.log(`  MouseMotion x=${px} ->`, r)
  }
  console.log('ButtonRelease:', run(`return __mauiMouse('ButtonRelease', ${target}, ${y}, ${mods}, 1)`))
  console.log('Trace:', run(`return table.concat(__trace, ' | ')`))
  console.log('Wert danach:', run(`return __dbgSlider:GetValue()`))
  console.log('Volumes:', run(`return tostring(__uiVolumes.Global)..' / world '..tostring(__uiVolumes.World)`))
}
console.log('WARNs:', warns.slice(0, 10).map((w) => w.split('\n')[0]?.slice(0, 140)).join('\n  '))
host.close()



for (const f of openFiles) await f.close()

