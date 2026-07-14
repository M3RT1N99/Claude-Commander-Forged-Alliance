/** TEMP: probes each main-menu branch for the first hard failure. */
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
const warns: string[] = []
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') warns.push(msg)
})
installUiEngine(host, {
  exists: (p) => allPaths.has(p),
  find: (dir, pattern) => findFiles(allPaths, dir, pattern),
  textureSize,
  stringAdvance: (text, family, size) => fonts.advance(text, family, size),
  fontMetrics: (family, size) => fonts.metrics(family, size),
})
createRootFrame(host, 1920, 1080)

// Welche Core-/User-Globals existieren ueberhaupt in der UI-VM?
const names = [
  'STR_GetTokens', 'STR_Utf8Len', 'STR_Utf8SubString', 'Basename', 'Dirname', 'FileCollapsePath',
  'DiskToLocal', 'doscript', 'DiskFindFiles', 'DiskGetFileInfo', 'exists', 'GetMovieDuration',
  'InternalCreateMovie', 'InternalCreateLobby', 'InternalCreateDiscoveryService', 'InternalCreateMapPreview',
  'GetSpecialFiles', 'GetSpecialFileInfo', 'GetSpecialFilePath', 'GetSpecialFolder', 'RemoveSpecialFile',
  'CopyCurrentReplay', 'LaunchSinglePlayerSession', 'LaunchReplaySession', 'LaunchGPGNet', 'PrefetchSession',
  'RemoveProfileDirectories', 'ExitApplication', 'OpenURL', 'ValidateIPAddress', 'IsSignedInToSteam',
  'InternalStartSteamDiscoveryService', 'CreatePrefetchSet', 'SessionRequestPause', 'MATH_Lerp',
  'GetSystemTimeSeconds', 'GetSystemTime', 'FormatTime', 'AddInputCapture', 'RemoveInputCapture',
  'GetCursor', 'SetFocusArmy', 'WorldIsLoading', 'GpgNetActive', 'GpgNetSend', 'IsObserver',
  'InternalCreateItemList', 'InternalCreateScrollbar', 'InternalCreateEdit', 'InternalCreateBitmap',
]
for (const n of names) {
  const state = host.eval(`
    local v = rawget(_G, '${n}')
    if v == nil then return 'FEHLT-GANZ' end
    local ok = pcall(function() return __missingNames and __missingNames['${n}'] end)
    return type(v)
  `)
  console.log(`  ${n.padEnd(36)} ${String(state)}`)
}

console.log('\n--- Ist es ein "noch nicht implementiert"-Platzhalter? ---')
for (const n of names) {
  const r = host.eval(`
    local v = rawget(_G, '${n}')
    if v == nil then return 'FEHLT-GANZ (nicht mal Platzhalter)' end
    if type(v) ~= 'function' then return 'da (' .. type(v) .. ')' end
    local ok, err = pcall(v)
    if not ok and tostring(err):find('noch nicht implementiert') then return 'PLATZHALTER (knallt)' end
    return 'IMPLEMENTIERT (oder anderer Fehler: ' .. tostring(ok and 'ok' or tostring(err):sub(1,60)) .. ')'
  `)
  console.log(`  ${n.padEnd(36)} ${String(r)}`)
}

host.close()
for (const f of openFiles) await f.close()
