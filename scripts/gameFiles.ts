/**
 * Der Zugriff auf die Spieldateien für die Verify-Suiten — dieselben Archive,
 * dasselbe „erstes Archiv gewinnt", derselbe Weg in die Sim wie im Browser.
 *
 * Wichtig ist vor allem `giveUnit()`: eine Unit braucht in der Sim DREI Dinge —
 * ihr Script, ihr Blueprint UND ihr Skelett. Das Skelett ist kein Renderer-Kram:
 * die Engine lädt das Modell auch in der Sim, weil Waffentürme, Mündungen und
 * Bau-Knochen an Knochennamen hängen (`weapon.lua:67` bricht ohne sie ab).
 * Jede Suite, die eine Unit spawnt, geht deshalb hierdurch — sonst prüft sie
 * eine Unit, die es so im Spiel nicht gibt.
 */
import { open, readdir, readFile, type FileHandle } from 'node:fs/promises'
import { ZipArchive } from '../src/vfs/zipArchive'
import type { RandomAccessFile } from '../src/vfs/randomAccess'
import type { LuaHost } from '../src/lua/host'
import {
  loadUnitBlueprint,
  loadProjectileBlueprints,
  loadPropBlueprints,
  setUnitBones,
  toSimBones,
  type SimBone,
} from '../src/lua/unitFactory'
import { parseBlueprint } from '../src/formats/blueprint'
import { resolveUnitPaths } from '../src/formats/unitPaths'
import { parseScm } from '../src/formats/scm'

/**
 * Das Skelett einer Unit — aus derselben SCM, die auch der Renderer liest.
 *
 * Liefert SimBone[] MIT Ruhepose (Name, Elternindex, Position relativ zum
 * Eltern, Quaternion): `setUnitBones` braucht die Pose, nicht nur die Namen —
 * ohne sie gibt es keine Muendungsposition und damit kein Projektil.
 *
 * `read` liefert die Bytes eines Pfads oder null. Die Suiten reichen hier ihren
 * eigenen Archiv-Zugriff herein; sie brauchen dafür kein zweites Mal alle
 * Archive zu öffnen.
 */
export async function bonesFromBlueprint(
  id: string,
  bpBytes: Uint8Array,
  read: (path: string) => Promise<Uint8Array | null>,
  exists: (path: string) => boolean,
): Promise<SimBone[]> {
  const bp = parseBlueprint(new TextDecoder('utf-8').decode(bpBytes))
  // `exists` ist nicht optional: resolveUnitPaths probiert mehrere Kandidaten
  // durch (RES_CompletePath). Wer immer `true` liefert, bekommt den ersten —
  // und wenn den niemand lesen kann, hat die Unit still KEIN Skelett. Genau so
  // ein stiller Fallback ist es, der später als „die Waffe geht halt nicht" endet.
  const paths = resolveUnitPaths(id, bp, exists)
  if (!paths) return [] // Unit ohne Modell (Effekt-Einheiten) — hat wirklich keine Knochen
  const bytes = await read(paths.mesh)
  if (!bytes) throw new Error(`Modell nicht lesbar: ${paths.mesh} (für ${id})`)
  return toSimBones(parseScm(bytes))
}

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

export const GAME_DIR =
  process.env.CFA_GAME_DIR ??
  'C:/Program Files (x86)/Steam/steamapps/common/Supreme Commander Forged Alliance'

/**
 * The archives a hand-picked suite VFS must mount on top of its own list, so
 * that the retail Sim boot (`doscript('/lua/simInit.lua')`) finds what the real
 * VFS always has. `GameFiles.open()` mounts every .scd and needs none of this.
 *
 * - `loc_*.scd` — globalInit.lua:22 loads Localization.lua, and
 *   localization.lua:20-31 resolves the language by asking the VFS: first
 *   `exists('/loc/<la>/strings_db.lua')`, then `'us'`, and only then
 *   `DiskFindFiles('/loc', '*strings_db.lua')`. With no loc archive all three
 *   miss and the boot dies at `string.gsub(dbfiles[1], ...)` on nil.
 * - `schook.scd` — the hook layer `doscript` applies. `schook/lua/GlobalInit.lua`
 *   is what loads `/lua/system/BuffBlueprints.lua` (which DEFINES the global
 *   `BuffBlueprint`) plus BuffDefinitions, GlobalPlatoonTemplate,
 *   GlobalBuilderTemplate/Group and GlobalBaseTemplate. Without it
 *   `/lua/sim/adjacencybuffs.lua:37` dies on `BuffBlueprint`, which takes
 *   `/lua/defaultunits.lua` and with it every unit down.
 */
export async function bootArchives(): Promise<string[]> {
  const found = (await readdir(`${GAME_DIR}/gamedata`)).filter((n) => /^loc_.*\.scd$/i.test(n))
  return [...found.sort((a, b) => a.localeCompare(b)), 'schook.scd']
}

export class GameFiles {
  private constructor(
    /** Alle .lua und .bp — das, was der Lua-Host als VFS bekommt. */
    readonly luaFiles: Map<string, Uint8Array>,
    /** Jeder Pfad in jedem Archiv (auch Texturen, Modelle). */
    readonly paths: Set<string>,
    private readonly zips: ZipArchive[],
    private readonly handles: NodeFile[],
  ) {}

  static async open(): Promise<GameFiles> {
    const luaFiles = new Map<string, Uint8Array>()
    const paths = new Set<string>()
    const zips: ZipArchive[] = []
    const handles: NodeFile[] = []
    const archives = (await readdir(`${GAME_DIR}/gamedata`))
      .filter((n) => n.toLowerCase().endsWith('.scd'))
      .sort((a, b) => a.localeCompare(b))
    for (const archive of archives) {
      const f = await NodeFile.open(`${GAME_DIR}/gamedata/${archive}`)
      handles.push(f)
      const zip = await ZipArchive.open(f)
      zips.push(zip)
      for (const [key, entry] of zip.entries) {
        paths.add(key.toLowerCase())
        // Erstes Archiv gewinnt — wie im Browser (src/vfs/vfs.ts).
        if ((key.endsWith('.lua') || key.endsWith('.bp')) && !luaFiles.has(key)) {
          luaFiles.set(key, await zip.read(entry))
        }
      }
    }
    // Die losen KARTENDATEIEN. Sie liegen nicht in den .scd-Archiven, sondern
    // als Ordner unter `maps/`, und die Sim braucht sie: `SetupSession()` faehrt
    // `doscript(ScenarioInfo.save, ...)` und `doscript(ScenarioInfo.script, ...)`
    // (siminit.lua:93/98) — ohne die Dateien im VFS gibt es kein `Scenario`,
    // keine Marker und keine Startpositionen.
    try {
      for (const dir of await readdir(`${GAME_DIR}/maps`, { withFileTypes: true })) {
        if (!dir.isDirectory()) continue
        for (const name of await readdir(`${GAME_DIR}/maps/${dir.name}`)) {
          if (!name.toLowerCase().endsWith('.lua')) continue
          const key = `maps/${dir.name}/${name}`.toLowerCase()
          paths.add(key)
          if (!luaFiles.has(key)) {
            luaFiles.set(key, new Uint8Array(await readFile(`${GAME_DIR}/maps/${dir.name}/${name}`)))
          }
        }
      }
    } catch {
      // Keine Karten installiert: die Sitzung ohne Szenario laeuft weiter, die
      // Szenario-Suite meldet den Fehlschlag selbst.
    }

    return new GameFiles(luaFiles, paths, zips, handles)
  }

  exists(path: string): boolean {
    return this.paths.has(path.toLowerCase())
  }

  async read(path: string): Promise<Uint8Array> {
    const key = path.toLowerCase()
    for (const zip of this.zips) {
      const entry = zip.get(key)
      if (entry) return zip.read(entry)
    }
    throw new Error(`Datei nicht im Archiv: ${path}`)
  }

  /**
   * Eine Unit in der Sim verfügbar machen: Blueprint registrieren und das
   * Skelett aus der SCM hinterlegen. Danach kann `spawnLuaUnit` sie erzeugen —
   * mit funktionierenden Waffen.
   */
  async giveUnit(host: LuaHost, id: string): Promise<void> {
    const bpBytes = await this.read(`units/${id}/${id}_unit.bp`)
    loadUnitBlueprint(host, id, bpBytes)
    setUnitBones(host, id, await this.bonesOf(id, bpBytes))
  }

  /**
   * Das Skelett aus dem Modell der Unit (dieselbe SCM wie im Renderer) — mit
   * Ruhepose, nicht nur Namen: die Mündungsposition eines Schusses hängt daran.
   */
  async bonesOf(id: string, bpBytes?: Uint8Array): Promise<SimBone[]> {
    const bytes = bpBytes ?? (await this.read(`units/${id}/${id}_unit.bp`))
    const bp = parseBlueprint(new TextDecoder('utf-8').decode(bytes))
    const assetPaths = resolveUnitPaths(id, bp, (p) => this.exists(p))
    if (!assetPaths || !this.exists(assetPaths.mesh)) return []
    return toSimBones(parseScm(await this.read(assetPaths.mesh)))
  }

  /**
   * Alle Projektil-Blueprints in die Sim (289 Stück). Sie müssen vor dem ersten
   * Schuss da sein — mitten im Tick kann die Engine nichts nachladen.
   */
  loadProjectiles(host: LuaHost): number {
    // Auch `/effects/entities/**` — dort liegen die TRÜMMER-Projektile
    // (defaultexplosions.lua:285 wirft beim Tod DebrisMisc0x) und die
    // Nuke-Effekt-Controller (uel0001_unit.bp:1188). Es sind ProjectileBlueprints.
    // And the mesh blueprints outside effects/: every units/** .bp that is
    // not the unit blueprint itself (the ACU's phase shield, the personal
    // shields), meshes/** and the env/** .bp that are not props (those go
    // through loadProps) -- the same set the worker boots with
    // (simBootPaths, lua/system/blueprints.lua:330-331).
    const paths = [...this.paths].filter(
      (p) =>
        ((p.startsWith('projectiles/') || p.startsWith('effects/') || p.startsWith('meshes/')) && p.endsWith('.bp')) ||
        (p.startsWith('units/') && p.endsWith('.bp') && !p.endsWith('_unit.bp')) ||
        (p.startsWith('env/') && p.endsWith('.bp') && !p.endsWith('_prop.bp')),
    )
    return loadProjectileBlueprints(host, paths)
  }

  /**
   * Die Prop-Blueprints: alles unter `props/` und unter `env/<x>/props/`.
   *
   * `/env` gehoert dazu, weil die Karte selbst daraus baut:
   * `ScenarioUtils.CreateResources()` setzt auf jeden Massepunkt ein
   * `/env/common/props/massDeposit01_prop.bp` (scenarioutilities.lua:389) und
   * auf jede Hydrokohlenstoff-Stelle ein `hydrocarbonDeposit01_prop.bp`
   * (:399). Ohne sie wirft `CreateProp` „Invalid blueprint" — was richtig ist,
   * aber eben bedeutet, dass sie geladen sein muessen.
   */
  loadProps(host: LuaHost): number {
    const paths = [...this.paths].filter(
      (p) => p.endsWith('.bp') && (p.startsWith('props/') || /(^|\/)env\/.*\/props\//.test(p)),
    )
    return loadPropBlueprints(host, paths)
  }

  async close(): Promise<void> {
    for (const f of this.handles) await f.close()
  }
}
