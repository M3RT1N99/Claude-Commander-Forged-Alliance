import { ZipArchive, type ZipEntry } from './zipArchive'
import type { GameSource } from './gameSource'

/**
 * Virtual filesystem over all mounted SCD archives, analogous to the Moho
 * engine VFS. Paths are case-insensitive ("units/UEL0001/..." ==
 * "units/uel0001/..."). Archives mounted later override earlier entries at
 * the same path.
 */
/** A VFS file: either from an archive or directly from disk. */
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

    // Priority: the archive mounted FIRST wins — the first match in the mount
    // path counts, and later archives only fill gaps.
    //
    // Evidence: bin/SupComDataPath.lua builds the `path` list and mounts /mods
    // and /maps BEFORE gamedata — that is exactly why mods override the game.
    // Whichever entry comes earlier in the path wins. The engine expands
    // `gamedata/*.scd` with findfirst in directory order, which is alphabetical.
    //
    // Both real collisions in the retail game resolve correctly only this way:
    //   lua.scd < mohodata.scd  → lua.scd wins. It must: mohodata's
    //     lua/sim/unit.lua is a 117-line stub WITHOUT SetupBuildBones, while
    //     the real one in lua.scd has 3,715 lines. The reverse makes every ACU
    //     die while spawning (uel0001_script.lua:113).
    //   "Advanced strategic icons.scd" < textures.scd → the icon pack wins,
    //     which is its entire purpose (1,102 files).
    for (const scd of scds) {
      try {
        const raf = await source.open(`gamedata/${scd.name}`)
        const zip = await ZipArchive.open(raf)
        let added = 0
        for (const [key, entry] of zip.entries) {
          if (files.has(key)) continue // an earlier archive takes priority
          files.set(key, { kind: 'zip', archive: scd.name, zip, entry })
          added++
        }
        names.push(scd.name)
        const shadowed = zip.entries.size - added
        log(
          `  ${scd.name}: ${zip.entries.size} files` +
            (shadowed > 0 ? ` (${shadowed} hidden by earlier archives)` : ''),
        )
      } catch (err) {
        log(`  ${scd.name}: ERROR — ${err instanceof Error ? err.message : err}`)
      }
    }

    // And the GAME DIRECTORY itself — the engine mounts it at `/`:
    //
    //   mount_dir(InitFileDir .. '\\..\\gamedata\\*.scd', '/')
    //   mount_dir(InitFileDir .. '\\..', '/')            <- bin/SupComDataPath.lua
    //
    // This is the only reason `/maps/**`, `/movies/**`, and `/mods/**` are in
    // the VFS: they are loose files, not archive contents. Without this mount,
    // `maputil.LoadScenario('/maps/X1CA_TUT/X1CA_TUT_scenario.lua')` finds
    // nothing — the tutorial button and every map fail.
    //
    // gamedata/ is skipped (the archives are already mounted above), and the
    // archives take priority: existing files are not overwritten.
    let disk = 0
    const walk = async (relDir: string, depth: number): Promise<void> => {
      if (depth > 6) return
      let entries: Awaited<ReturnType<typeof source.list>>
      try {
        entries = await source.list(relDir)
      } catch {
        return // unreadable: skip it, do not guess
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
      log(`  <Spielverzeichnis>: ${disk} loose files (maps, movies, mods …)`)
    }

    log(`VFS ready: ${files.size} files from ${names.length} archives`)
    return new GameVfs(files, names, source)
  }

  private normalize(path: string): string {
    return path.toLowerCase().replaceAll('\\', '/').replace(/^\/+/, '')
  }

  exists(path: string): boolean {
    return this.files.has(this.normalize(path))
  }

  /** Returns the original path (with original casing) or null. */
  resolve(path: string): string | null {
    const file = this.files.get(this.normalize(path))
    if (!file) return null
    return file.kind === 'zip' ? file.entry.name : file.path
  }

  async read(path: string): Promise<Uint8Array> {
    const file = this.files.get(this.normalize(path))
    if (!file) throw new Error(`VFS: file not found: ${path}`)
    if (file.kind === 'zip') return file.zip.read(file.entry)
    // Loose file from the game directory (maps, movies, mods).
    const raf = await this.source.open(file.path)
    return new Uint8Array(await raf.slice(0, raf.size))
  }

  async readText(path: string): Promise<string> {
    return new TextDecoder('utf-8').decode(await this.read(path))
  }

  /**
   * Read a SECTION of a file — for header scans of large files (the wave banks
   * in sounds/ are up to ~100 MB; the first bytes suffice to resolve the
   * internal bank name). RandomAccess reads only the requested range of loose
   * files; ZIP entries (small) are read entirely and sliced.
   */
  async readSlice(path: string, start: number, end: number): Promise<Uint8Array> {
    const file = this.files.get(this.normalize(path))
    if (!file) throw new Error(`VFS: file not found: ${path}`)
    if (file.kind === 'zip') {
      const all = await file.zip.read(file.entry)
      return all.subarray(start, end)
    }
    const raf = await this.source.open(file.path)
    return new Uint8Array(await raf.slice(start, Math.min(end, raf.size)))
  }

  /**
   * Read many files at once — the path for everything needed during boot.
   *
   * Read individually, each file costs two archive accesses (header, data).
   * At startup that is ~19,000 accesses for Lua + UI textures. Here, paths are
   * grouped by archive and each archive is read in one pass
   * (ZipArchive.readMany).
   *
   * Missing paths are also absent from the result — do not throw: the UI skin
   * chain deliberately requests files that do not exist.
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
    // Loose files (maps, movies) are not in an archive, so there is nothing to
    // combine. Reading them ONE AFTER ANOTHER incurs full latency per file: the
    // ~250 map scripts alone delayed UI boot by minutes. Read several in flight.
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

  /** All lowercase paths that satisfy the predicate. */
  find(predicate: (path: string) => boolean): string[] {
    const out: string[] = []
    for (const key of this.files.keys()) {
      if (predicate(key)) out.push(key)
    }
    return out
  }
}
