import { bpGet, type BpObject } from './blueprint'

/**
 * Mesh-/Textur-Auflösung 1:1 nach der Original-Engine:
 *
 * - lua/system/Blueprints.lua `ExtractMeshBlueprint`: Default-Mesh-Blueprint
 *   ist `/units/<id>/<id>_mesh`; `Display.MeshBlueprint` (kleingeschrieben,
 *   ohne `.bp`) übersteuert; `'<none>'` = bewusst ohne Mesh.
 * - faf-re `RMeshBlueprintLOD::Init` (0x00518870): `prefix` = Quellpfad bis
 *   zum letzten `_`; Mesh = `MeshName` (vervollständigt gegen das
 *   Quellverzeichnis) sonst `<prefix>_lod<N>.scm`; Texturen = explizite
 *   Namen (vervollständigt) sonst `<prefix>_albedo.dds`,
 *   `<prefix>_normalsTS.dds`, `<prefix>_SpecTeam.dds`.
 * - `Display.PlaceholderMeshName` dient als Mesh-Quelle, wenn das eigene
 *   Mesh nicht existiert (Kampagnen-/Zivil-Units).
 */
export interface UnitAssetPaths {
  mesh: string
  albedo: string[]
  normals: string[]
  specTeam: string[]
  lookup: string[]
  /** LOD0-ShaderName ('Unit', 'Seraphim', 'Insect', 'Aeon', …) */
  shader: string
}

/** RES_CompletePath: absolut ab VFS-Wurzel oder relativ zum Quellverzeichnis. */
function completePath(name: string, sourceDir: string): string[] {
  if (name.startsWith('/')) return [name.slice(1)]
  const joined = `${sourceDir}/${name}`
  // Namen mit Verzeichnisanteil zusätzlich wurzel-relativ probieren —
  // einzelne Original-BPs (z. B. XRL0403) schreiben 'Units/xrl0404/…'
  return name.includes('/') ? [joined, name] : [joined]
}

export function resolveUnitPaths(
  id: string,
  bp: BpObject,
  exists: (path: string) => boolean,
): UnitAssetPaths | null {
  const meshBlueprint = bpGet(bp, 'Display.MeshBlueprint')
  if (meshBlueprint === '<none>') return null

  const lodsRaw = bpGet(bp, 'Display.Mesh.LODs.1') ?? bpGet(bp, 'Display.Mesh.LODs')
  const lod = (Array.isArray(lodsRaw) ? lodsRaw[0] : lodsRaw) as BpObject | undefined

  const sourceFor = (unitId: string): string => `units/${unitId}/${unitId}_mesh`
  let source =
    typeof meshBlueprint === 'string' && meshBlueprint
      ? meshBlueprint.toLowerCase().replace(/\.bp$/, '').replace(/^\//, '')
      : sourceFor(id)

  const resolve = (src: string): UnitAssetPaths | null => {
    const prefix = src.includes('_') ? src.slice(0, src.lastIndexOf('_')) : src
    const sourceDir = src.includes('/') ? src.slice(0, src.lastIndexOf('/')) : ''

    let meshCandidates = [`${prefix}_lod0.scm`]
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
    }
  }

  const direct = resolve(source)
  if (direct) return direct

  // Platzhalter-Mesh einer anderen Unit (Kampagnen-Units)
  const placeholder = bpGet(bp, 'Display.PlaceholderMeshName')
  if (typeof placeholder === 'string' && placeholder) {
    return resolve(sourceFor(placeholder.toLowerCase()))
  }
  return null
}
