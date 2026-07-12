import { ZipArchive, type ZipEntry } from './zipArchive'
import type { GameSource } from './gameSource'

/**
 * Virtuelles Dateisystem über allen gemounteten SCD-Archiven, analog zum
 * VFS der Moho-Engine. Pfade sind case-insensitiv ("units/UEL0001/..." ==
 * "units/uel0001/..."). Später gemountete Archive überschreiben frühere
 * Einträge gleichen Pfads.
 */
interface VfsFile {
  archive: string
  zip: ZipArchive
  entry: ZipEntry
}

export class GameVfs {
  private constructor(
    private readonly files: Map<string, VfsFile>,
    readonly archiveNames: string[],
  ) {}

  static async mount(
    source: GameSource,
    log: (msg: string) => void = () => {},
  ): Promise<GameVfs> {
    const gamedata = await source.list('gamedata')
    const scds = gamedata
      .filter((e) => !e.dir && e.name.toLowerCase().endsWith('.scd'))
      .sort((a, b) => a.name.localeCompare(b.name))

    const files = new Map<string, VfsFile>()
    const names: string[] = []

    for (const scd of scds) {
      try {
        const raf = await source.open(`gamedata/${scd.name}`)
        const zip = await ZipArchive.open(raf)
        for (const [key, entry] of zip.entries) {
          files.set(key, { archive: scd.name, zip, entry })
        }
        names.push(scd.name)
        log(`  ${scd.name}: ${zip.entries.size} Dateien`)
      } catch (err) {
        log(`  ${scd.name}: FEHLER — ${err instanceof Error ? err.message : err}`)
      }
    }

    log(`VFS bereit: ${files.size} Dateien aus ${names.length} Archiven`)
    return new GameVfs(files, names)
  }

  private normalize(path: string): string {
    return path.toLowerCase().replaceAll('\\', '/').replace(/^\/+/, '')
  }

  exists(path: string): boolean {
    return this.files.has(this.normalize(path))
  }

  /** Liefert den Original-Pfad (mit Original-Casing) oder null. */
  resolve(path: string): string | null {
    return this.files.get(this.normalize(path))?.entry.name ?? null
  }

  async read(path: string): Promise<Uint8Array> {
    const file = this.files.get(this.normalize(path))
    if (!file) throw new Error(`VFS: Datei nicht gefunden: ${path}`)
    return file.zip.read(file.entry)
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder('utf-8').decode(await this.read(path))
  }

  /** Alle Pfade (lowercase), die das Prädikat erfüllen. */
  find(predicate: (path: string) => boolean): string[] {
    const out: string[] = []
    for (const key of this.files.keys()) {
      if (predicate(key)) out.push(key)
    }
    return out
  }
}
