/**
 * Diagnose: Für alle Units prüfen, ob Mesh + Texturen mit der aktuellen
 * Lade-Logik gefunden werden, und was die Blueprints (Display.Mesh.LODs)
 * tatsächlich referenzieren.
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { parseBlueprints, bpGet, type BpObject, type BpValue } from '../src/formats/blueprint'

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
}

const GAME =
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

const units = await ZipArchive.open(await NodeFile.open(`${GAME}/gamedata/units.scd`))
const textures = await ZipArchive.open(await NodeFile.open(`${GAME}/gamedata/textures.scd`))

const has = (p: string): boolean => !!(units.get(p) ?? textures.get(p))

const bpPaths = [...units.entries.keys()].filter((p) => /^units\/[^/]+\/[^/]+_unit\.bp$/.test(p))
let meshOk = 0
let meshMissing: string[] = []
let texOkCurrent = 0
let texFixableViaLod = 0
let texMissing: string[] = []
let lodOverrides = 0

for (const path of bpPaths) {
  const id = path.split('/')[1]!
  const base = `units/${id}/${id}`

  if (has(`${base}_lod0.scm`)) meshOk++
  else meshMissing.push(id)

  // aktuelle Logik
  const currentAlbedo = has(`${base}_albedo.dds`) || has(`${base}_lod1_albedo.dds`)

  // Blueprint-LOD-Overrides
  let bp: BpObject | null = null
  try {
    bp = parseBlueprints(new TextDecoder().decode(await units.read(units.get(path)!)))[0]!
  } catch {
    continue
  }
  const lods = bpGet(bp, 'Display.Mesh.LODs')
  let lodAlbedo: string | null = null
  if (Array.isArray(lods) && lods.length > 0) {
    const lod0 = lods[0] as BpObject
    const a = lod0.AlbedoName
    if (typeof a === 'string' && a) {
      lodOverrides++
      lodAlbedo = a
    }
  }

  const resolveTex = (name: string): boolean => {
    if (name.startsWith('/')) return has(name)
    return has(`units/${id}/${name}`)
  }

  if (currentAlbedo) {
    texOkCurrent++
  } else if (lodAlbedo && resolveTex(lodAlbedo)) {
    texFixableViaLod++
    if (texFixableViaLod <= 8) console.log(`  LOD-Fix: ${id}: AlbedoName=${lodAlbedo}`)
  } else {
    texMissing.push(`${id}${lodAlbedo ? ` (AlbedoName=${lodAlbedo} nicht gefunden)` : ''}`)
  }
}

console.log(`\nUnits gesamt: ${bpPaths.length}`)
console.log(`Mesh (<id>_lod0.scm) vorhanden: ${meshOk}, fehlend: ${meshMissing.length}`)
console.log(`  Fehlende Meshes: ${meshMissing.slice(0, 20).join(', ')}${meshMissing.length > 20 ? '…' : ''}`)
console.log(`Albedo mit aktueller Logik: ${texOkCurrent}`)
console.log(`Albedo über Display.Mesh.LODs auflösbar: ${texFixableViaLod}`)
console.log(`Albedo weiterhin fehlend: ${texMissing.length}`)
console.log(`  ${texMissing.slice(0, 20).join(', ')}${texMissing.length > 20 ? '…' : ''}`)
console.log(`Units mit LOD-AlbedoName-Override insgesamt: ${lodOverrides}`)
