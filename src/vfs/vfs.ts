import { ZipArchive, type ZipEntry } from './zipArchive'
import type { GameSource } from './gameSource'

/**
 * Virtuelles Dateisystem über allen gemounteten SCD-Archiven, analog zum
 * VFS der Moho-Engine. Pfade sind case-insensitiv ("units/UEL0001/..." ==
 * "units/uel0001/..."). Später gemountete Archive überschreiben frühere
 * Einträge gleichen Pfads.
 */
/** Eine Datei im VFS: entweder aus einem Archiv oder direkt von der Platte. */
type VfsFile =
  | { kind: 'zip'; archive: string; zip: ZipArchive; entry: ZipEntry }
  | { kind: 'disk'; archive: string; path: string }

export class GameVfs {
  private constructor(
    private readonly files: Map<string, VfsFile>,
    readonly archiveNames: string[],
    private readonly source: GameSource,
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
          files.set(key, { kind: 'zip', archive: scd.name, zip, entry })
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

    // Und das SPIELVERZEICHNIS selbst — die Engine mountet es nach `/`:
    //
    //   mount_dir(InitFileDir .. '\\..\\gamedata\\*.scd', '/')
    //   mount_dir(InitFileDir .. '\\..', '/')            <- bin/SupComDataPath.lua
    //
    // Nur deshalb liegen `/maps/**`, `/movies/**` und `/mods/**` im VFS: sie sind
    // gar nicht in den Archiven, sondern lose Dateien. Ohne diesen Mount findet
    // `maputil.LoadScenario('/maps/X1CA_TUT/X1CA_TUT_scenario.lua')` nichts —
    // der Tutorial-Knopf und jede Karte laufen ins Leere.
    //
    // gamedata/ wird uebersprungen (die Archive stehen schon oben), und die
    // Archive haben Vorrang: was schon da ist, wird nicht ueberschrieben.
    let disk = 0
    const walk = async (relDir: string, depth: number): Promise<void> => {
      if (depth > 6) return
      let entries: Awaited<ReturnType<typeof source.list>>
      try {
        entries = await source.list(relDir)
      } catch {
        return // nicht lesbar: ueberspringen, nicht raten
      }
      for (const e of entries) {
        const rel = relDir ? `${relDir}/${e.name}` : e.name
        const key = rel.toLowerCase().replaceAll('\\', '/')
        if (e.dir) {
          if (key === 'gamedata') continue
          await walk(rel, depth + 1)
        } else if (!files.has(key)) {
          files.set(key, { kind: 'disk', archive: '<Spielverzeichnis>', path: rel })
          disk++
        }
      }
    }
    await walk('', 0)
    if (disk > 0) {
      names.push('<Spielverzeichnis>')
      log(`  <Spielverzeichnis>: ${disk} lose Dateien (maps, movies, mods …)`)
    }

    log(`VFS bereit: ${files.size} Dateien aus ${names.length} Archiven`)
    return new GameVfs(files, names, source)
  }

  private normalize(path: string): string {
    return path.toLowerCase().replaceAll('\\', '/').replace(/^\/+/, '')
  }

  exists(path: string): boolean {
    return this.files.has(this.normalize(path))
  }

  /** Liefert den Original-Pfad (mit Original-Casing) oder null. */
  resolve(path: string): string | null {
    const file = this.files.get(this.normalize(path))
    if (!file) return null
    return file.kind === 'zip' ? file.entry.name : file.path
  }

  async read(path: string): Promise<Uint8Array> {
    const file = this.files.get(this.normalize(path))
    if (!file) throw new Error(`VFS: Datei nicht gefunden: ${path}`)
    if (file.kind === 'zip') return file.zip.read(file.entry)
    // Lose Datei aus dem Spielverzeichnis (maps, movies, mods).
    const raf = await this.source.open(file.path)
    return new Uint8Array(await raf.slice(0, raf.size))
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder('utf-8').decode(await this.read(path))
  }

  /**
   * Einen AUSSCHNITT einer Datei lesen — für Header-Scans über große Dateien
   * (die Wave-Banks in sounds/ sind bis zu ~100 MB; für die Auflösung des
   * inneren Banknamens reichen die ersten Bytes). Lose Dateien lesen über
   * RandomAccess nur den Bereich; Zip-Einträge (klein) werden ganz gelesen
   * und geschnitten.
   */
  async readSlice(path: string, start: number, end: number): Promise<Uint8Array> {
    const file = this.files.get(this.normalize(path))
    if (!file) throw new Error(`VFS: Datei nicht gefunden: ${path}`)
    if (file.kind === 'zip') {
      const all = await file.zip.read(file.entry)
      return all.subarray(start, end)
    }
    const raf = await this.source.open(file.path)
    return new Uint8Array(await raf.slice(start, Math.min(end, raf.size)))
  }

  /**
   * Viele Dateien auf einmal — der Weg für alles, was der Boot braucht.
   *
   * Einzeln gelesen kostet jede Datei zwei Zugriffe aufs Archiv (Header, Daten).
   * Beim Start sind das ~19.000 Zugriffe für Lua + UI-Texturen. Hier werden die
   * Pfade nach Archiv gruppiert und jedes Archiv am Stück gelesen
   * (ZipArchive.readMany).
   *
   * Fehlende Pfade fehlen auch im Ergebnis — kein Werfen: die Skin-Kette der UI
   * fragt planmäßig nach Dateien, die es nicht gibt.
   */
  async readMany(paths: string[]): Promise<Map<string, Uint8Array>> {
    const byZip = new Map<ZipArchive, { key: string; entry: ZipEntry }[]>()
    const onDisk: string[] = []
    for (const path of paths) {
      const key = this.normalize(path)
      const file = this.files.get(key)
      if (!file) continue
      if (file.kind === 'disk') {
        onDisk.push(key)
        continue
      }
      const list = byZip.get(file.zip)
      if (list) list.push({ key, entry: file.entry })
      else byZip.set(file.zip, [{ key, entry: file.entry }])
    }

    const out = new Map<string, Uint8Array>()
    for (const [zip, list] of byZip) {
      const bytes = await zip.readMany(list.map((l) => l.entry))
      for (const { key, entry } of list) {
        const b = bytes.get(entry)
        if (b) out.set(key, b)
      }
    }
    // Lose Dateien (maps, movies) liegen in keinem Archiv — da gibt es nichts
    // zusammenzufassen. Aber sie NACHEINANDER zu lesen kostet die volle Latenz
    // pro Datei: die ~250 Karten-Skripte allein haben den UI-Boot um Minuten
    // verlängert. Also mehrere gleichzeitig in der Luft.
    const PARALLEL = 8
    let next = 0
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL, onDisk.length) }, async () => {
        while (next < onDisk.length) {
          const key = onDisk[next++]!
          out.set(key, await this.read(key))
        }
      }),
    )
    return out
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
