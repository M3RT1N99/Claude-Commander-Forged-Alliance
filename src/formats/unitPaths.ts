import { bpGet, type BpObject } from './blueprint'

/**
 * Mesh/texture resolution 1:1 with the original engine:
 *
 * - lua/system/Blueprints.lua `ExtractMeshBlueprint`: Default-Mesh-Blueprint
 *   is `/units/<id>/<id>_mesh`; `Display.MeshBlueprint` (lowercase, without
 *   `.bp`) overrides it; `'<none>'` = intentionally no mesh.
 * - faf-re `RMeshBlueprintLOD::Init` (0x00518870): `prefix` = source path up
 *   to the final `_`; mesh = `MeshName` (completed against the source
 *   directory) or `<prefix>_lod<N>.scm`; textures = explicit names (completed)
 *   or `<prefix>_albedo.dds`,
 *   `<prefix>_normalsTS.dds`, `<prefix>_SpecTeam.dds`.
 * - `Display.PlaceholderMeshName` serves as the mesh source when the unit's
 *   own mesh does not exist (campaign/civilian units).
 */
export interface UnitAssetPaths {
  mesh: string
  albedo: string[]
  normals: string[]
  specTeam: string[]
  lookup: string[]
  /** LOD0-ShaderName ('Unit', 'Seraphim', 'Insect', 'Aeon', …) */
  shader: string
  /** LOD0 `Scrolling`: the mesh scrolls its tread UVs (mesh.fx:438-452,
   *  ComputeScrolledTexcoord, gated by anim.w = the LOD flag, Cfile:1191018). */
  scrolling: boolean
}

/**
 * Resolve '..' and '.' segments — prop LODs reference textures relative to
 * their source dir (e.g. Pine06_GroupA_prop.bp: AlbedoName =
 * '../Pine06_V1_albedo.dds'); without this the VFS lookup misses and the
 * prop falls back to flat grey.
 */
function normalizePath(p: string): string {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') out.pop()
    else out.push(seg)
  }
  return out.join('/')
}

/** RES_CompletePath: absolute from the VFS root or relative to the source directory. */
function completePath(name: string, sourceDir: string): string[] {
  if (name.startsWith('/')) return [normalizePath(name)]
  const joined = normalizePath(`${sourceDir}/${name}`)
  // Also try names with a directory component relative to the root — some
  // original blueprints (e.g. XRL0403) specify 'Units/xrl0404/…'.
  return name.includes('/') ? [joined, normalizePath(name)] : [joined]
}

/** RMeshBlueprintLOD::Init (0x00518870): prefix resolution from the source path. */
function resolveFromSource(
  src: string,
  lod: BpObject | undefined,
  exists: (path: string) => boolean,
  lodIndex = 0,
): UnitAssetPaths | null {
  const prefix = src.includes('_') ? src.slice(0, src.lastIndexOf('_')) : src
  const sourceDir = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : ''

  let meshCandidates = [`${prefix}_lod${lodIndex}.scm`]
  const lodMesh = lod?.MeshName
  if (typeof lodMesh === 'string' && lodMesh) {
    meshCandidates = completePath(lodMesh, sourceDir)
  }
  const mesh = meshCandidates.find(exists)
  if (!mesh) return null

  const texture = (override: unknown, fallback: string): string[] => {
    const list: string[] = []
    if (typeof override === 'string' && override) {
      list.push(...completePath(override, sourceDir))
    }
    list.push(fallback)
    return list
  }

  return {
    mesh,
    albedo: texture(lod?.AlbedoName, `${prefix}_albedo.dds`),
    normals: texture(lod?.NormalsName, `${prefix}_normalsts.dds`),
    specTeam: texture(lod?.SpecularName, `${prefix}_specteam.dds`),
    lookup: texture(lod?.LookupName, `${prefix}_lookup.dds`),
    shader: typeof lod?.ShaderName === 'string' && lod.ShaderName ? lod.ShaderName : 'Unit',
    scrolling: lod?.Scrolling === true,
  }
}

function lodOf(bp: BpObject): BpObject | undefined {
  const lodsRaw = bpGet(bp, 'Display.Mesh.LODs.1') ?? bpGet(bp, 'Display.Mesh.LODs')
  return (Array.isArray(lodsRaw) ? lodsRaw[0] : lodsRaw) as BpObject | undefined
}

export function resolveUnitPaths(
  id: string,
  bp: BpObject,
  exists: (path: string) => boolean,
): UnitAssetPaths | null {
  const meshBlueprint = bpGet(bp, 'Display.MeshBlueprint')
  if (meshBlueprint === '<none>') return null

  const lod = lodOf(bp)

  const sourceFor = (unitId: string): string => `units/${unitId}/${unitId}_mesh`
  const source =
    typeof meshBlueprint === 'string' && meshBlueprint
      ? meshBlueprint.toLowerCase().replace(/\.bp$/, '').replace(/^\//, '')
      : sourceFor(id)

  const resolve = (src: string): UnitAssetPaths | null => resolveFromSource(src, lod, exists)

  const direct = resolve(source)
  if (direct) return direct

  // Placeholder mesh from another unit (campaign units).
  const placeholder = bpGet(bp, 'Display.PlaceholderMeshName')
  if (typeof placeholder === 'string' && placeholder) {
    return resolve(sourceFor(placeholder.toLowerCase()))
  }
  return null
}

export interface PropLodPaths extends UnitAssetPaths {
  /** LODCutoff of this LOD; 0 = always visible (ends the chain). */
  cutoff: number
}

/**
 * Props (map features) resolve exactly like units, except the default mesh
 * blueprint comes from the .bp path itself: blueprints.lua:170
 * `gsub(bp.Source, "_[a-z]+%.bp$", "_mesh")` — '/env/…/eg_bush01_prop.bp'
 * -> '/env/…/eg_bush01_mesh'; RMeshBlueprintLOD::Init then cuts at the last
 * '_' -> prefix 'eg_bush01' -> 'eg_bush01_lod<N>.scm', '_albedo.dds', ….
 *
 * Props carry LOD CHAINS (e.g. Pine06_GroupA: LOD0 cutoff 30 -> LOD1 175
 * -> LOD2 700, each with its own mesh/albedo/shader). Mesh::ComputeLOD
 * (Mesh.cpp:4688-4724) picks the FIRST lod with distance <= cutoff; a
 * cutoff <= 0 wins at any distance, so the chain ends there.
 */
export function resolvePropLods(
  bpPath: string,
  bp: BpObject,
  exists: (path: string) => boolean,
): PropLodPaths[] {
  const meshBlueprint = bpGet(bp, 'Display.MeshBlueprint')
  if (meshBlueprint === '<none>') return []

  const source =
    typeof meshBlueprint === 'string' && meshBlueprint
      ? meshBlueprint.toLowerCase().replace(/\.bp$/, '').replace(/^\//, '')
      : bpPath
          .toLowerCase()
          .replace(/^\//, '')
          .replace(/_[a-z]+\.bp$/, '_mesh')

  const lodsRaw = bpGet(bp, 'Display.Mesh.LODs')
  const lods: (BpObject | undefined)[] = Array.isArray(lodsRaw)
    ? (lodsRaw as BpObject[])
    : [lodsRaw as BpObject | undefined]

  const out: PropLodPaths[] = []
  for (let i = 0; i < lods.length; i++) {
    const paths = resolveFromSource(source, lods[i], exists, i)
    if (!paths) continue
    const cutoffRaw = lods[i]?.LODCutoff
    const cutoff = typeof cutoffRaw === 'number' ? cutoffRaw : 0
    out.push({ ...paths, cutoff })
    if (cutoff <= 0) break
  }
  return out
}
