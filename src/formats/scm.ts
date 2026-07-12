/**
 * Parser für das SCM-Modellformat der Moho-Engine (SupCom/FA).
 *
 * Format verifiziert gegen units.scd (UEL0001_LOD0.scm) und die von GPG mit
 * dem Mod-SDK veröffentlichte Spezifikation:
 *
 *   Header (little endian):
 *     0x00  char[4]  'MODL'
 *     0x04  u32      version (5)
 *     0x08  u32      boneOffset          — Start der Bone-Daten
 *     0x0C  u32      weightedBoneCount   — Bones mit Vertex-Gewichtung
 *     0x10  u32      vertexOffset
 *     0x14  u32      vertexExtraOffset   — 0 = keine Extra-Daten
 *     0x18  u32      vertexCount
 *     0x1C  u32      indexOffset
 *     0x20  u32      indexCount          — Anzahl u16-Indizes (Tri-Liste)
 *     0x24  u32      infoOffset
 *     0x28  u32      infoCount           — Bytes der Info-Strings
 *     0x2C  u32      totalBoneCount
 *   Sektionen sind mit 0xC5 gepolstert und tragen 4-Byte-Marker
 *   (NAME/SKEL/VTXL/TRIS/INFO) direkt vor dem jeweiligen Offset.
 *
 *   Bone (108 Bytes):
 *     0x00  f32[16]  restPoseInverse (4x4, column-major wie D3D)
 *     0x40  f32[3]   position (relativ zum Parent)
 *     0x4C  f32[4]   rotation (Quaternion w,x,y,z)
 *     0x5C  u32      nameOffset (absolut in die NAME-Sektion)
 *     0x60  i32      parentIndex (-1 = Wurzel)
 *     0x64  u8[8]    reserviert
 *
 *   Vertex (68 Bytes):
 *     f32[3] position, f32[3] tangent, f32[3] normal, f32[3] binormal,
 *     f32[2] uv0, f32[2] uv1, u8[4] boneIndices
 */

export interface ScmBone {
  name: string
  parent: number
  /** Inverse Rest-Pose, 16 floats */
  restPoseInverse: Float32Array
  position: [number, number, number]
  rotation: [number, number, number, number]
}

export interface ScmModel {
  bones: ScmBone[]
  weightedBoneCount: number
  vertexCount: number
  positions: Float32Array
  tangents: Float32Array
  normals: Float32Array
  binormals: Float32Array
  uv0: Float32Array
  uv1: Float32Array
  boneIndices: Uint8Array
  indices: Uint16Array
  info: string[]
}

const BONE_SIZE = 108
const VERTEX_SIZE = 68

function readCString(bytes: Uint8Array, offset: number): string {
  let end = offset
  while (end < bytes.length && bytes[end] !== 0) end++
  return new TextDecoder('utf-8').decode(bytes.subarray(offset, end))
}

export function parseScm(data: Uint8Array): ScmModel {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  const magic = new TextDecoder('ascii').decode(data.subarray(0, 4))
  if (magic !== 'MODL') throw new Error(`SCM: falsches Magic "${magic}" (erwartet MODL)`)
  const version = view.getUint32(4, true)
  if (version !== 5) throw new Error(`SCM: nicht unterstützte Version ${version}`)

  const boneOffset = view.getUint32(8, true)
  const weightedBoneCount = view.getUint32(12, true)
  const vertexOffset = view.getUint32(16, true)
  const vertexCount = view.getUint32(24, true)
  const indexOffset = view.getUint32(28, true)
  const indexCount = view.getUint32(32, true)
  const infoOffset = view.getUint32(36, true)
  const infoCount = view.getUint32(40, true)
  const totalBoneCount = view.getUint32(44, true)

  if (boneOffset + totalBoneCount * BONE_SIZE > data.byteLength) {
    throw new Error('SCM: Bone-Daten außerhalb der Datei')
  }
  if (vertexOffset + vertexCount * VERTEX_SIZE > data.byteLength) {
    throw new Error('SCM: Vertex-Daten außerhalb der Datei')
  }
  if (indexOffset + indexCount * 2 > data.byteLength) {
    throw new Error('SCM: Index-Daten außerhalb der Datei')
  }

  // --- Bones ---------------------------------------------------------------
  const bones: ScmBone[] = []
  for (let i = 0; i < totalBoneCount; i++) {
    const p = boneOffset + i * BONE_SIZE
    const restPoseInverse = new Float32Array(16)
    for (let j = 0; j < 16; j++) restPoseInverse[j] = view.getFloat32(p + j * 4, true)
    bones.push({
      restPoseInverse,
      position: [
        view.getFloat32(p + 64, true),
        view.getFloat32(p + 68, true),
        view.getFloat32(p + 72, true),
      ],
      rotation: [
        view.getFloat32(p + 76, true),
        view.getFloat32(p + 80, true),
        view.getFloat32(p + 84, true),
        view.getFloat32(p + 88, true),
      ],
      name: readCString(data, view.getUint32(p + 92, true)),
      parent: view.getInt32(p + 96, true),
    })
  }

  // --- Vertices ------------------------------------------------------------
  const positions = new Float32Array(vertexCount * 3)
  const tangents = new Float32Array(vertexCount * 3)
  const normals = new Float32Array(vertexCount * 3)
  const binormals = new Float32Array(vertexCount * 3)
  const uv0 = new Float32Array(vertexCount * 2)
  const uv1 = new Float32Array(vertexCount * 2)
  const boneIndices = new Uint8Array(vertexCount * 4)

  for (let i = 0; i < vertexCount; i++) {
    const p = vertexOffset + i * VERTEX_SIZE
    for (let j = 0; j < 3; j++) {
      positions[i * 3 + j] = view.getFloat32(p + j * 4, true)
      tangents[i * 3 + j] = view.getFloat32(p + 12 + j * 4, true)
      normals[i * 3 + j] = view.getFloat32(p + 24 + j * 4, true)
      binormals[i * 3 + j] = view.getFloat32(p + 36 + j * 4, true)
    }
    uv0[i * 2] = view.getFloat32(p + 48, true)
    uv0[i * 2 + 1] = view.getFloat32(p + 52, true)
    uv1[i * 2] = view.getFloat32(p + 56, true)
    uv1[i * 2 + 1] = view.getFloat32(p + 60, true)
    for (let j = 0; j < 4; j++) boneIndices[i * 4 + j] = data[p + 64 + j]!
  }

  // --- Indizes ---------------------------------------------------------------
  const indices = new Uint16Array(indexCount)
  for (let i = 0; i < indexCount; i++) {
    indices[i] = view.getUint16(indexOffset + i * 2, true)
  }

  // --- Info-Strings ----------------------------------------------------------
  const info: string[] = []
  if (infoOffset > 0 && infoOffset + infoCount <= data.byteLength) {
    const raw = new TextDecoder('utf-8').decode(data.subarray(infoOffset, infoOffset + infoCount))
    for (const s of raw.split('\0')) {
      if (s.length > 0) info.push(s)
    }
  }

  return {
    bones,
    weightedBoneCount,
    vertexCount,
    positions,
    tangents,
    normals,
    binormals,
    uv0,
    uv1,
    boneIndices,
    indices,
    info,
  }
}
