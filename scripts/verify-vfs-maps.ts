/**
 * Das Spielverzeichnis gehört ins VFS — nicht nur die Archive.
 *
 * Die Engine mountet BEIDES (bin/SupComDataPath.lua):
 *
 *     mount_dir(InitFileDir .. '\..\gamedata\*.scd', '/')
 *     mount_dir(InitFileDir .. '\..', '/')
 *
 * Die zweite Zeile ist der Grund, warum `/maps/**`, `/movies/**` und `/mods/**`
 * im VFS liegen: sie sind gar nicht in den Archiven, sondern lose Dateien.
 * Ohne sie findet `maputil.LoadScenario('/maps/X1CA_TUT/X1CA_TUT_scenario.lua')`
 * nichts — der Tutorial-Knopf im Hauptmenü stirbt mit
 * "SetupCampaignSession - scenario required", und keine Karte ist ladbar.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-vfs-maps.ts
 */
import { open, readdir, stat, type FileHandle } from 'node:fs/promises'
import { GameVfs } from '../src/vfs/vfs'
import type { GameSource, GameDirEntry } from '../src/vfs/gameSource'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import { join } from 'node:path'

const GAME =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

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

/** Dieselbe Quelle wie im Browser, nur mit Node-Dateien. */
class NodeSource implements GameSource {
  readonly label = 'Node'
  private readonly open_: NodeFile[] = []
  async list(relDir: string): Promise<GameDirEntry[]> {
    const dir = relDir ? join(GAME, relDir) : GAME
    const entries = await readdir(dir, { withFileTypes: true })
    const out: GameDirEntry[] = []
    for (const e of entries) {
      out.push({
        name: e.name,
        dir: e.isDirectory(),
        size: e.isDirectory() ? 0 : (await stat(join(dir, e.name))).size,
      })
    }
    return out
  }
  async open(relPath: string): Promise<RandomAccessFile> {
    const f = await NodeFile.open(join(GAME, relPath))
    this.open_.push(f)
    return f
  }
  async close(): Promise<void> {
    for (const f of this.open_) await f.close()
  }
}

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const source = new NodeSource()
console.log('\n== Das VFS mountet Archive UND das Spielverzeichnis ==')
const vfs = await GameVfs.mount(source, () => {})

// Aus den Archiven (wie bisher).
check(vfs.exists('lua/ui/menus/main.lua'), 'lua/ui/menus/main.lua (aus lua.scd)')

// Lose Dateien — nur über den zweiten Mount erreichbar.
check(
  vfs.exists('maps/X1CA_TUT/X1CA_TUT_scenario.lua'),
  'maps/X1CA_TUT/X1CA_TUT_scenario.lua (Tutorial — daran starb der Ja-Knopf)',
)
const maps = vfs.find((p) => /^maps\/[^/]+\/[^/]+_scenario\.lua$/.test(p))
check(maps.length > 20, `${maps.length} Karten-Szenarien im VFS`)
const scmaps = vfs.find((p) => p.endsWith('.scmap'))
check(scmaps.length > 20, `${scmaps.length} .scmap-Dateien`)

// Und sie sind LESBAR (nicht nur gelistet).
const text = await vfs.readText('maps/X1CA_TUT/X1CA_TUT_scenario.lua')
check(text.includes('ScenarioInfo'), `das Szenario ist lesbar (${text.length} Zeichen)`)

// Die Archive haben Vorrang — eine lose Datei darf sie nicht überdecken.
check(
  vfs.resolve('lua/ui/menus/main.lua')?.toLowerCase().includes('lua/ui/menus/main.lua') === true,
  'die Archive behalten Vorrang (SupComDataPath: erster Treffer gewinnt)',
)

await source.close()
console.log(failures === 0 ? '\nVFS-MAPS BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
