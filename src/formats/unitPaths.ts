import { bpGet, type BpObject, type BpValue } from './blueprint'

/**
 * Ermittelt Mesh- und Textur-Pfade einer Unit wie die Original-Engine:
 * 1. `Display.Mesh.LODs[0].MeshName/AlbedoName/NormalsName/SpecularName`
 *    (absolute Pfade, z. B. Env-Props für Zivilgebäude) haben Vorrang,
 * 2. `Display.MeshBlueprint = '/units/XYZ/XYZ_mesh.bp'` leiht Mesh und
 *    Texturen einer anderen Unit; `'<none>'` = bewusst ohne Mesh (null),
 * 3. sonst Namenskonvention `units/<id>/<id>_lod0.scm` + `_albedo.dds` etc.
 *
 * Textur-Listen sind nach Priorität geordnet (erste existierende gewinnt).
 */
export interface UnitAssetPaths {
  mesh: string
  albedo: string[]
  normals: string[]
  specTeam: string[]
}

export function resolveUnitPaths(
  id: string,
  bp: BpObject,
  exists: (path: string) => boolean,
): UnitAssetPaths | null {
  const lodsRaw = bpGet(bp, 'Display.Mesh.LODs.1') ?? bpGet(bp, 'Display.Mesh.LODs')
  const lodTable = (Array.isArray(lodsRaw) ? lodsRaw[0] : lodsRaw) as BpObject | undefined

  const meshBlueprint = bpGet(bp, 'Display.MeshBlueprint')
  if (meshBlueprint === '<none>') return null

  let base = `units/${id}/${id}`
  if (typeof meshBlueprint === 'string' && /_mesh\.bp$/i.test(meshBlueprint)) {
    base = meshBlueprint.replace(/^\//, '').replace(/_mesh\.bp$/i, '')
  }

  let mesh = `${base}_lod0.scm`
  const lodMesh = lodTable?.MeshName
  if (typeof lodMesh === 'string' && lodMesh) {
    mesh = lodMesh.startsWith('/') ? lodMesh.slice(1) : `units/${id}/${lodMesh}`
    base = mesh.replace(/_lod\d\.scm$/i, '')
  }

  // Kampagnen-Units ohne eigenes Mesh: Platzhalter-Mesh einer anderen Unit
  if (!exists(mesh)) {
    const placeholder = bpGet(bp, 'Display.PlaceholderMeshName')
    if (typeof placeholder === 'string' && placeholder) {
      const ph = placeholder.toLowerCase()
      const phBase = `units/${ph}/${ph}`
      if (exists(`${phBase}_lod0.scm`)) {
        mesh = `${phBase}_lod0.scm`
        base = phBase
      }
    }
  }
  // Immer noch kein Mesh: unsichtbare Gameplay-Unit (z. B. Tracking Device)
  if (!exists(mesh)) return null

  // LOD1 als Textur-Fallback (einige Zivilgebäude definieren nur dort Namen)
  const lod1Table = (
    Array.isArray(lodsRaw) ? lodsRaw[1] : bpGet(bp, 'Display.Mesh.LODs.2')
  ) as BpObject | undefined

  const texList = (
    override: BpValue | undefined,
    fallbackOverride: BpValue | undefined,
    suffix: string,
  ): string[] => {
    const list: string[] = []
    for (const o of [override, fallbackOverride]) {
      if (typeof o !== 'string' || !o) continue
      if (o.includes('/')) {
        // mit Verzeichnisanteil = wurzel-relativ
        list.push(o.replace(/^\//, ''))
      } else {
        list.push(`units/${id}/${o}`)
        // Dateiname verweist auf eine andere Unit (z. B. Seraphim-Zivilbau
        // nutzt 'uac1101_lod1_albedo.dds' der Aeon-Variante)
        const prefix = o.split('_')[0]!.toLowerCase()
        if (prefix && prefix !== id) list.push(`units/${prefix}/${o}`)
      }
    }
    list.push(`${base}_${suffix}.dds`, `${base}_lod1_${suffix}.dds`)
    return list
  }

  return {
    mesh,
    albedo: texList(lodTable?.AlbedoName, lod1Table?.AlbedoName, 'albedo'),
    normals: texList(lodTable?.NormalsName, lod1Table?.NormalsName, 'normalsts'),
    specTeam: texList(lodTable?.SpecularName, lod1Table?.SpecularName, 'specteam'),
  }
}
