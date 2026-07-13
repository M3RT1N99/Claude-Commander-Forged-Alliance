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

    // Priorität: das ZUERST gemountete Archiv gewinnt — der erste Treffer im
    // Mount-Pfad zählt, spätere Archive füllen nur Lücken.
    //
    // Beleg: bin/SupComDataPath.lua baut die `path`-Liste und mountet /mods und
    // /maps VOR gamedata — genau deshalb überschreiben Mods das Spiel. Wer früher
    // im Pfad steht, gewinnt. `gamedata/*.scd` expandiert die Engine per
    // findfirst in Verzeichnisreihenfolge, also alphabetisch.
    //
    // Beide echten Kollisionen im Retail-Spiel lösen sich nur so korrekt auf:
    //   lua.scd < mohodata.scd  → lua.scd gewinnt. Und das muss es: mohodatas
    //     lua/sim/unit.lua ist ein 117-Zeilen-Stub OHNE SetupBuildBones, die
    //     echte in lua.scd hat 3715 Zeilen. Andersherum stirbt jede ACU beim
    //     Spawn (uel0001_script.lua:113).
    //   "Advanced strategic icons.scd" < textures.scd → der Icon-Pack gewinnt,
    //     was sein ganzer Zweck ist (1102 Dateien).
    for (const scd of scds) {
      try {
        const raf = await source.open(`gamedata/${scd.name}`)
        const zip = await ZipArchive.open(raf)
        let added = 0
        for (const [key, entry] of zip.entries) {
          if (files.has(key)) continue // früheres Archiv hat Vorrang
          files.set(key, { archive: scd.name, zip, entry })
          added++
        }
        names.push(scd.name)
        const shadowed = zip.entries.size - added
        log(
          `  ${scd.name}: ${zip.entries.size} Dateien` +
            (shadowed > 0 ? ` (${shadowed} von früheren Archiven überdeckt)` : ''),
        )
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
