import * as THREE from 'three'

/**
 * The selection marker — `func_DrawSelectionBrackets` (Cfile:1215114-1215433),
 * gated by `ren_SelectBoxes` (Cfile:1215520, default true).
 *
 * It is NOT a ring: the engine draws FOUR textured quads, one on each corner of
 * the unit's selection box, and nothing else. `func_DrawSelectionBrackets`
 * contains exactly four `CD3DPrimBatcher::DrawQuad` calls (Cfile:1215330,
 * 1215355, 1215380, 1215405) and no mesh, circle or line primitive; the whole
 * `/textures/ui/common/game/selection/` folder holds only the four
 * `selection_brackets_*.dds` plus `selection.dds` for the drag rectangle.
 * (The `SelectionMesh*` blueprint fields are the MOUSE-OVER hit test, "Scale
 * the mesh … when we perform our mouse over entity test", Cfile:647533.)
 *
 * The geometry, straight from the decompilation:
 *
 *   halfX = SelectionSizeX > 0 ? SelectionSizeX * ren_UnitSelectionScale
 *                              : ren_SelectionSizeFudge * meshBox.Extent[0]
 *   halfZ = ... same with Z                                Cfile:1215196-1215209
 *   S     = max(halfX, halfZ)                              Cfile:1215256-1215258
 *   t     = |SelectionThickness| >= 1e-5 ? SelectionThickness
 *                                        : ren_SelectBracketSize
 *   if (ren_SelectBracketMinPixelSize > (S*t)/D)  t = ren_SelectBracketMinPixelSize * D / S
 *                                                          Cfile:1215259-1215270
 *   box.Extent = (halfX, 0, halfZ)
 *   box.Center.y = unitY + ren_SelectionHeightFudge + offsetY
 *   box.Center.xz = meshBox.Center.xz + offset.xz          Cfile:1215271-1215278
 *
 * Each quad is a SQUARE with half edge `t * S`, centred exactly ON its corner
 * (Cfile:1215281-1215293), and takes one quadrant of the texture: local -X is
 * the smaller u, -Z the smaller v (Cfile:1215297-1215405). Vertex colour is
 * `ren_SelectColor` (0xFFFFFFFF).
 */

/** The six values of `lua/renderselectparams.lua` (Cfile:1214972-1215091). */
export interface SelectParams {
  /** ren_SelectionSizeFudge — 1.85 */
  sizeFudge: number
  /** ren_SelectionHeightFudge — 0.12 */
  heightFudge: number
  /** ren_UnitSelectionScale — 0.75 */
  unitScale: number
  /** ren_SelectBracketMinPixelSize — 3.0 */
  bracketMinPixelSize: number
  /** ren_SelectBracketSize — 0.2 */
  bracketSize: number
  /** ren_SelectColor — 0xFFFFFFFF (ARGB) */
  selectColor: number
}

export const SELECT_PARAM_DEFAULTS: SelectParams = {
  sizeFudge: 1.85,
  heightFudge: 0.12,
  unitScale: 0.75,
  bracketMinPixelSize: 3,
  bracketSize: 0.2,
  selectColor: 0xffffffff,
}

/** Half extents and centre offset of one unit's selection box (world metres). */
export interface BracketExtents {
  /** halfX */
  x: number
  /** halfZ */
  z: number
  /** SelectionCenterOffsetX */
  ox: number
  /** SelectionCenterOffsetY */
  oy: number
  /** SelectionCenterOffsetZ */
  oz: number
  /** `Display.SelectionThickness` (0 = use ren_SelectBracketSize) */
  thickness: number
}

/**
 * The bracket thickness in world metres, with the engine's minimum pixel size
 * applied (Cfile:1215259-1215270).
 *
 * @param ogridsPerPixel `dot(cam.mViewport.d[2], (pos, 1))` — the world width
 *   one pixel spans at the unit's depth. `(S*t)/D` is therefore the bracket
 *   size IN PIXELS.
 */
export function bracketThickness(
  extents: BracketExtents,
  ogridsPerPixel: number,
  params: SelectParams,
): number {
  const s = Math.max(extents.x, extents.z)
  let t = Math.abs(extents.thickness) >= 1e-5 ? extents.thickness : params.bracketSize
  if (s > 0 && ogridsPerPixel > 0 && params.bracketMinPixelSize > (s * t) / ogridsPerPixel) {
    t = (params.bracketMinPixelSize * ogridsPerPixel) / s
  }
  return t * s
}

/** Four quads = 16 vertices, 8 triangles. */
const CORNERS: readonly [number, number][] = [
  [-1, -1], // v[0]: -X -Z
  [+1, -1], // v[1]: +X -Z
  [+1, +1], // v[5]: +X +Z
  [-1, +1], // v[4]: -X +Z
]

/**
 * The UV quadrant of each corner (Cfile:1215297-1215405): -X -> smaller u,
 * -Z -> smaller v. Order per quad matches the vertex order A, B, C, D =
 * (-t,-t), (+t,-t), (+t,+t), (-t,+t).
 */
const UVS: readonly number[][] = [
  [0, 0, 0.5, 0, 0.5, 0.5, 0, 0.5],
  [0.5, 0, 1, 0, 1, 0.5, 0.5, 0.5],
  [0.5, 0.5, 1, 0.5, 1, 1, 0.5, 1],
  [0, 0.5, 0.5, 0.5, 0.5, 1, 0, 1],
]

/** A fresh geometry for one unit's four brackets (positions filled per frame). */
export function createBracketGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(16 * 3), 3))
  const uv = new Float32Array(16 * 2)
  for (let q = 0; q < 4; q++) uv.set(UVS[q]!, q * 8)
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  const idx: number[] = []
  for (let q = 0; q < 4; q++) {
    const b = q * 4
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3)
  }
  g.setIndex(idx)
  return g
}

/**
 * Write the 16 vertices for one unit. `centerX/Z` come from the MESH BOX
 * centre, `unitY` from the unit's position (Cfile:1215271-1215278); `heading`
 * turns the box with the unit (the engine uses the full box axes).
 */
export function updateBracketGeometry(
  geometry: THREE.BufferGeometry,
  centerX: number,
  unitY: number,
  centerZ: number,
  heading: number,
  extents: BracketExtents,
  halfEdge: number,
  params: SelectParams,
): void {
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute
  const cos = Math.cos(heading)
  const sin = Math.sin(heading)
  // R * (x, z) for a heading rotation about Y.
  const rx = (x: number, z: number): number => x * cos + z * sin
  const rz = (x: number, z: number): number => -x * sin + z * cos
  const cx = centerX + rx(extents.ox, extents.oz)
  const cz = centerZ + rz(extents.ox, extents.oz)
  const cy = unitY + params.heightFudge + extents.oy
  let i = 0
  for (let q = 0; q < 4; q++) {
    const [sx, sz] = CORNERS[q]!
    // The corner of the box: Center ± halfX along the X axis, ± halfZ along Z.
    const localX = sx * extents.x
    const localZ = sz * extents.z
    for (const [dx, dz] of [
      [-halfEdge, -halfEdge],
      [+halfEdge, -halfEdge],
      [+halfEdge, +halfEdge],
      [-halfEdge, +halfEdge],
    ] as const) {
      const x = localX + dx
      const z = localZ + dz
      pos.setXYZ(i++, cx + rx(x, z), cy, cz + rz(x, z))
    }
  }
  pos.needsUpdate = true
  geometry.computeBoundingSphere()
}
