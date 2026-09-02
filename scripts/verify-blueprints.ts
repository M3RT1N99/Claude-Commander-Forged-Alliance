/**
 * Phase-A / A2: Fährt die Original-Blueprint-Pipeline
 * (`lua/system/Blueprints.lua`) im eingebetteten VM mit einem echten
 * Unit-Blueprint und prüft, dass Registrierung + Mesh-Extraktion laufen.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-blueprints.ts
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { LuaHost } from '../src/lua/host'
import { installEngine } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { FLAT_TEST_TERRAIN, FLAT_TEST_MAP_SIZE } from '../src/sim/terrain'
import { bootArchives } from './gameFiles'

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
const openFiles: NodeFile[] = []
for (const archive of ['mohodata.scd', 'lua.scd', ...(await bootArchives())]) {
  const file = await NodeFile.open(`${GAME}/gamedata/${archive}`)
  openFiles.push(file)
  const zip = await ZipArchive.open(file)
  for (const [key, entry] of zip.entries) {
    if (key.endsWith('.lua')) files.set(key, await zip.read(entry))
  }
}
// Ein echtes Unit-Blueprint (aus units.scd) für die Pipeline verfügbar machen
const unitsFile = await NodeFile.open(`${GAME}/gamedata/units.scd`)
openFiles.push(unitsFile)
const unitsZip = await ZipArchive.open(unitsFile)
const bpKey = 'units/uel0001/uel0001_unit.bp'
files.set(bpKey, await unitsZip.read(unitsZip.get(bpKey)!))
console.log(`${files.size} Module vorgeladen (inkl. 1 Unit-Blueprint)`)

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

// Lua long-string VALUES [[...]] / [=[...]=] — the real effect/emitter
// blueprints use them for texture paths (a3_end_nis_01_emit.bp:26); before, the
// whole blueprint failed to parse on the first one.
{
  const { parseBlueprint, bpGet } = await import('../src/formats/blueprint')
  const bp = parseBlueprint(
    'EmitterBlueprint { Texture = [[/textures/particles/glow_03.dds]], RampTexture = [=[a]]b]=], Count = 5 }',
  )
  check(bpGet(bp, 'Texture') === '/textures/particles/glow_03.dds', 'long-string [[...]] value parses')
  check(bpGet(bp, 'RampTexture') === 'a]]b', 'level-1 long-string [=[...]=] keeps inner ]]')
  check(bpGet(bp, 'Count') === 5, 'the assignment after a long string still parses')
}

const warnings: string[] = []
const host = await LuaHost.create(files, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})

// utils.lua global laden (liefert sortedpairs + table.deepcopy/merged, die die
// Pipeline braucht). Läuft im globalen Env → Funktionen werden global.
host.loadGlobal('/lua/system/utils.lua')

// Die ECHTE Pipeline — kein Nachbau im Test (sonst fehlt z. B. Sound{}).
installEngine(host)
// Flaches Testgelaende — EXPLIZIT, weil die Engine ohne Karte knallt (kein stiller 0-Wert).
setTerrainSource(host, FLAT_TEST_TERRAIN, FLAT_TEST_MAP_SIZE)


console.log('\n== Original-Pipeline: LoadBlueprints() ==')
// Die echte LoadBlueprints() fährt Init -> doscript(bp) -> ExtractAllMesh ->
// ModBlueprints -> RegisterAllBlueprints — nur gefüttert mit unserem einen
// Blueprint (DiskFindFiles oben).
host.eval(`__bpFiles = { '/${bpKey}' }; LoadBlueprints()`)

const storedId = host.eval(`
  local k = next(__registered.Unit)
  return k
`) as string
check(typeof storedId === 'string' && storedId.length > 0, `Blueprint registriert: id="${storedId}"`)

console.log('\n== Ergebnis ==')
const faction = host.eval(`return __registered.Unit['${storedId}'].General.FactionName`)
check(faction === 'UEF', `FactionName aus Original-bp: ${faction}`)
const hp = host.eval(`return __registered.Unit['${storedId}'].Defense.MaxHealth`)
check(hp === 12000, `Defense.MaxHealth: ${hp}`)
const meshBp = host.eval(`return __registered.Unit['${storedId}'].Display.MeshBlueprint`)
check(typeof meshBp === 'string' && meshBp.includes('uel0001'), `ExtractMeshBlueprint setzte MeshBlueprint: ${meshBp}`)
const meshCount = host.eval(`local n=0 for _ in pairs(__registered.Mesh) do n=n+1 end return n`)
check(typeof meshCount === 'number' && meshCount >= 1, `${meshCount} Mesh-Blueprint(s) extrahiert+registriert`)
if (warnings.length > 0) {
  console.log(`\n${warnings.length} WARN (erste 4):`)
  for (const w of warnings.slice(0, 4)) console.log(`  ${w.slice(0, 100)}`)
}

host.close()
for (const f of openFiles) await f.close()
console.log(failures === 0 ? '\nA2 BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
