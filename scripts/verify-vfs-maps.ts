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
import { parseScmap } from '../src/formats/scmap'
import { parseScm } from '../src/formats/scm'
import { parseBlueprint } from '../src/formats/blueprint'
import { resolvePropLods } from '../src/formats/unitPaths'
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

// --- SCMAP tail: every retail map must parse down to exact EOF ---------------
// (render-details.md par. 1 decoded the full tail: masks, terrain type,
// v60 skybox, props; the parser now throws on leftover bytes.)
console.log('\n== SCMAP-Schwanz: alle Karten bis exakt EOF ==')
{
  // Only real maps under maps/ — lua/ai/opai/opaimap.scmap is a v51 SC1-format
  // helper the parser rejects by design.
  const realMaps = scmaps.filter((p) => p.startsWith('maps/'))
  let parsed = 0
  let withProps = 0
  let withSkybox = 0
  let failed = 0
  const shaderCount = new Map<string, number>()
  for (const p of realMaps) {
    try {
      const m = parseScmap(await vfs.read(p))
      parsed++
      if (m.props.length > 0) withProps++
      if (m.skybox) withSkybox++
      if (m.water.waveNormals.length !== 4) throw new Error('waveNormals != 4')
      shaderCount.set(m.terrainShader, (shaderCount.get(m.terrainShader) ?? 0) + 1)
    } catch (e) {
      failed++
      if (failed <= 3) console.log(`  · FEHLER ${p}: ${e instanceof Error ? e.message : e}`)
    }
  }
  check(failed === 0 && parsed === realMaps.length, `${parsed}/${realMaps.length} Karten bis EOF geparst`)
  // Terrain shader split documented in render-details.md par. 4:
  // TTerrain 39, TTerrainXP 20, TTerrainGlow 1 — the variant choice in
  // terrainMaterial.ts depends on exactly these strings.
  check(
    shaderCount.get('TTerrain') === 39 &&
      shaderCount.get('TTerrainXP') === 20 &&
      shaderCount.get('TTerrainGlow') === 1,
    `terrain shader split: ${[...shaderCount].map(([k, v]) => `${k}=${v}`).join(', ')}`,
  )
  check(withProps > 10, `${withProps} Karten mit Props (SCMP_005 hat ~47k)`)
  check(withSkybox > 0, `${withSkybox} Karten mit v60-Skybox-Block`)
  // Spot checks on one known map: props carry real blueprint paths and an
  // orthonormal rotation basis.
  const m9 = parseScmap(await vfs.read('maps/scmp_009/scmp_009.scmap'))
  check(
    m9.props.length > 100 && m9.props[0]!.blueprintPath.endsWith('_prop.bp'),
    `SCMP_009: ${m9.props.length} Props, erster: ${m9.props[0]!.blueprintPath}`,
  )
  const p0 = m9.props[0]!
  const dot = p0.rotationX[0] * p0.rotationZ[0] + p0.rotationX[1] * p0.rotationZ[1] + p0.rotationX[2] * p0.rotationZ[2]
  check(Math.abs(dot) < 1e-4, `Rotationsbasis orthonormal (rotX·rotZ = ${dot.toFixed(6)})`)
  check(
    m9.terrainTypeData.length === m9.width * m9.height,
    `TerrainType-Daten ${m9.terrainTypeData.length} = ${m9.width}×${m9.height}`,
  )

  // Prop asset resolution (render-details.md par. 2): every distinct prop
  // blueprint of SCMP_009 must resolve to an existing mesh via
  // blueprints.lua:170 (`_prop.bp` -> `_mesh` -> prefix), the mesh must
  // parse as SCM, and every LOD's albedo must exist in the VFS (the pine
  // props reference them as '../Pine06_V1_albedo.dds' — the '..' has to
  // resolve).
  const distinct = [...new Set(m9.props.map((p) => p.blueprintPath.toLowerCase().replace(/^\//, '')))]
  let resolved = 0
  let lodTotal = 0
  let albedoOk = 0
  const unresolved: string[] = []
  const albedoMissing: string[] = []
  for (const bpPath of distinct) {
    if (!vfs.exists(bpPath)) {
      unresolved.push(`${bpPath} (bp fehlt)`)
      continue
    }
    const bp = parseBlueprint(await vfs.readText(bpPath))
    const lods = resolvePropLods(bpPath, bp, (p) => vfs.exists(p))
    if (lods.length === 0) {
      unresolved.push(bpPath)
      continue
    }
    resolved++
    for (const lod of lods) {
      lodTotal++
      if (lod.albedo.some((a) => vfs.exists(a))) albedoOk++
      else albedoMissing.push(`${bpPath}: ${lod.albedo[0]}`)
    }
  }
  check(
    unresolved.length === 0,
    `SCMP_009: ${resolved}/${distinct.length} Prop-Blueprints aufgelöst` +
      (unresolved.length ? ` (fehlt: ${unresolved.slice(0, 3).join(', ')})` : ''),
  )
  check(
    albedoMissing.length === 0,
    `alle Prop-LOD-Albedos vorhanden (${albedoOk}/${lodTotal})` +
      (albedoMissing.length ? ` — fehlt: ${albedoMissing.slice(0, 3).join(' | ')}` : ''),
  )
  // The pine group is the '..'-reference case: LOD chain 30/175/700 with
  // per-LOD meshes and the LOD0 albedo one directory up.
  const pineBp = 'env/evergreen/props/trees/groups/pine06_groupa_prop.bp'
  const pineLods = resolvePropLods(pineBp, parseBlueprint(await vfs.readText(pineBp)), (p) =>
    vfs.exists(p),
  )
  check(
    pineLods.length === 3 &&
      pineLods[0]!.cutoff === 30 &&
      pineLods[1]!.cutoff === 175 &&
      pineLods[2]!.cutoff === 700,
    `Pine06_GroupA: LOD-Kette ${pineLods.map((l) => l.cutoff).join('/')}`,
  )
  check(
    pineLods[0]!.albedo[0]!.toLowerCase() === 'env/evergreen/props/trees/pine06_v1_albedo.dds' &&
      vfs.exists(pineLods[0]!.albedo[0]!),
    `'..'-Referenz aufgelöst: ${pineLods[0]!.albedo[0]}`,
  )
  const propModel = parseScm(await vfs.read(pineLods[0]!.mesh))
  check(
    propModel.vertexCount > 0 && propModel.indices.length > 0,
    `Prop-Mesh parsbar: ${pineLods[0]!.mesh} (${propModel.vertexCount} Vertices, Shader ${pineLods[0]!.shader})`,
  )

  // Albedo decals (type 1): every referenced texture must resolve in the
  // VFS — mapDecals.ts groups by texture set and skips nothing silently.
  const decalT1 = m9.decals.filter((d) => d.type === 1)
  const decalTex = [
    ...new Set(
      decalT1.flatMap((d) => d.textures.filter((t) => t.length > 0))
        .map((t) => t.replace(/^\//, '').toLowerCase()),
    ),
  ]
  const decalMissing = decalTex.filter((t) => !vfs.exists(t))
  check(
    decalT1.length > 1000 && decalMissing.length === 0,
    `SCMP_009: ${decalT1.length} albedo decals, ${decalTex.length} textures all resolvable` +
      (decalMissing.length ? ` (missing: ${decalMissing[0]})` : ''),
  )

  // Water assets (water2.fx): the four wave normal maps and the sky
  // cubemap referenced by the water block must resolve.
  const waveTex = m9.water.waveNormals.map((w) => w.path.replace(/^\//, '').toLowerCase())
  const skyCubePath = m9.water.texPathCubemap.replace(/^\//, '').toLowerCase()
  check(
    m9.water.hasWater &&
      waveTex.length === 4 &&
      waveTex.every((t) => vfs.exists(t)) &&
      vfs.exists(skyCubePath) &&
      m9.waterMapDds !== null,
    `SCMP_009 water: 4 wave maps + sky cube (${skyCubePath.split('/').pop()}) + baked water map resolvable`,
  )

  // Sky dome assets (sky.fx): the fixed horizon lookup (SkyDome.cpp:158)
  // plus the map's planet atlas and cirrus texture must resolve.
  const skyTex = [
    'textures/environment/horizonlookup.dds',
    m9.skybox!.albedo.replace(/^\//, '').toLowerCase(),
    m9.skybox!.cirrusTexture.replace(/^\//, '').toLowerCase(),
  ]
  check(
    m9.skybox !== null && skyTex.every((t) => vfs.exists(t)) && m9.skybox!.planets.length === 9,
    `SCMP_009 skybox: ${m9.skybox!.planets.length} planets, ${m9.skybox!.cirrusLayers.length} cirrus layers, textures resolvable`,
  )

  // Stratum normal maps (render-details.md par. 4: lower + strata 0-3 are
  // populated on the retail maps): every non-empty path must exist.
  const normalPaths = m9.normalStrata
    .map((s) => s?.albedoPath ?? '')
    .filter((p) => p.length > 0)
    .map((p) => p.replace(/^\//, '').toLowerCase())
  check(
    normalPaths.length >= 5 && normalPaths.every((p) => vfs.exists(p)),
    `SCMP_009: ${normalPaths.length} stratum normal maps, all resolvable (${normalPaths[0]})`,
  )
}

await source.close()
console.log(failures === 0 ? '\nVFS-MAPS BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
