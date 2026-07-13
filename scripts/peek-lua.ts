/**
 * Original-Lua nachschlagen (Dev-Werkzeug). Ohne dieses Werkzeug wäre jede
 * Aussage über das Original geraten — genau das soll nicht passieren.
 *
 *   npx tsx scripts/peek-lua.ts lua/sim/unit.lua 1640 1675   # Zeilen zeigen
 *   npx tsx scripts/peek-lua.ts --grep SetAimingArc          # in allen .lua suchen
 */
import { open, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'

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
  close(): Promise<void> {
    return this.fh.close()
  }
}

const GAME =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

const ARCHIVES = ['lua.scd', 'mohodata.scd', 'units.scd']
const args = process.argv.slice(2)
const files: NodeFile[] = []
const zips: { name: string; zip: ZipArchive }[] = []
for (const a of ARCHIVES) {
  const f = await NodeFile.open(`${GAME}/gamedata/${a}`)
  files.push(f)
  zips.push({ name: a, zip: await ZipArchive.open(f) })
}

if (args[0] === '--grep') {
  const needle = args[1] ?? ''
  const rx = new RegExp(needle)
  for (const { name, zip } of zips) {
    for (const [key, entry] of zip.entries) {
      if (!key.endsWith('.lua') && !key.endsWith('.bp')) continue
      const lines = new TextDecoder().decode(await zip.read(entry)).split(/\r?\n/)
      lines.forEach((l, i) => {
        if (rx.test(l)) console.log(`${name}:${key}:${i + 1}: ${l.trim()}`)
      })
    }
  }
} else {
  const [path, fromS, toS] = args
  const from = Number(fromS ?? 1)
  const to = Number(toS ?? from + 20)
  let found = false
  for (const { zip } of zips) {
    const entry = zip.get(path!)
    if (!entry) continue
    found = true
    const lines = new TextDecoder().decode(await zip.read(entry)).split(/\r?\n/)
    for (let n = from; n <= Math.min(to, lines.length); n++) console.log(`${n}: ${lines[n - 1]}`)
    break
  }
  if (!found) console.log(`NICHT GEFUNDEN: ${path}`)
}

for (const f of files) await f.close()
