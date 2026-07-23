/**
 * Parser für das SCA-Animationsformat der Moho-Engine (SupCom/FA).
 *
 * Layout (verifiziert an UEL0001_A001.sca und dem rekonstruierten Loader
 * RScaResource::LoadScaFile in faf-re; Dateigrößen-Arithmetik geht exakt
 * auf: animDataOffset + 28 + numFrames*(8 + numBones*28) == Dateigröße):
 *
 *   Header:
 *     0x00  char[4]  'ANIM'
 *     0x04  u32      version (5; <5 hat andere Quaternion-Reihenfolge)
 *     0x08  u32      numFrames
 *     0x0C  f32      duration (Sekunden)
 *     0x10  u32      numBones
 *     0x14  u32      namesOffset    — numBones nullterminierte Strings
 *     0x18  u32      linksOffset    — numBones × i32 Parent-Index (-1 = Wurzel)
 *     0x1C  u32      animDataOffset
 *     0x20  u32      frameSize      — 8 + numBones*28 (redundant)
 *
 *   Ab animDataOffset:
 *     28 Bytes Root-Delta  {pos f32[3], quat f32[4] (w,x,y,z)}
 *     numFrames × Frame:
 *       8-Byte-Header {f32 time, u32 flags}
 *       numBones × 28-Byte-Key {pos f32[3], quat f32[4] (w,x,y,z)}
 *
 *   Keys sind Lokal-Posen relativ zum Parent-Bone.
 */

export interface ScaAnim {
  version: number
  numFrames: number
  duration: number
  boneNames: string[]
  boneParents: Int32Array
  /** Root delta: overall movement of the animation [px,py,pz, qw,qx,qy,qz] */
  rootDelta: Float32Array
  /** Frame-Zeiten (numFrames) */
  times: Float32Array
  /**
   * Keys: numFrames × numBones × 7 floats [px,py,pz, qw,qx,qy,qz],
   * Frame-major (Frame f, Bone b beginnt bei (f*numBones + b) * 7).
   */
  keys: Float32Array
}

const KEY_FLOATS = 7
const KEY_BYTES = 28
const FRAME_HEADER_BYTES = 8

function readCString(bytes: Uint8Array, offset: number): { value: string; next: number } {
  let end = offset
  while (end < bytes.length && bytes[end] !== 0) end++
  return {
    value: new TextDecoder('utf-8').decode(bytes.subarray(offset, end)),
    next: end + 1,
  }
}

export function parseSca(data: Uint8Array): ScaAnim {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)

  const magic = new TextDecoder('ascii').decode(data.subarray(0, 4))
  if (magic !== 'ANIM') throw new Error(`SCA: falsches Magic "${magic}" (erwartet ANIM)`)
  const version = view.getUint32(4, true)
  const numFrames = view.getUint32(8, true)
  const duration = view.getFloat32(12, true)
  const numBones = view.getUint32(16, true)
  const namesOffset = view.getUint32(20, true)
  const linksOffset = view.getUint32(24, true)
  const animDataOffset = view.getUint32(28, true)

  const frameBytes = FRAME_HEADER_BYTES + numBones * KEY_BYTES
  const expectedEnd = animDataOffset + KEY_BYTES + numFrames * frameBytes
  if (expectedEnd > data.byteLength) {
    throw new Error(
      `SCA: File too short (${data.byteLength} B, expected ${expectedEnd} B) — layout error?`,
    )
  }

  // --- Bone Names & Parents --------------------------------------------------
  const boneNames: string[] = []
  let p = namesOffset
  for (let i = 0; i < numBones; i++) {
    const { value, next } = readCString(data, p)
    boneNames.push(value)
    p = next
  }

  const boneParents = new Int32Array(numBones)
  for (let i = 0; i < numBones; i++) {
    boneParents[i] = view.getInt32(linksOffset + i * 4, true)
  }

  // --- Keys ---------------------------------------------------------------------
  // Version < 5 stores quaternions as (x,y,z,w) → rotate to (w,x,y,z).
  const oldQuatOrder = version < 5

  const readKey = (offset: number, out: Float32Array, outIdx: number): void => {
    out[outIdx] = view.getFloat32(offset, true)
    out[outIdx + 1] = view.getFloat32(offset + 4, true)
    out[outIdx + 2] = view.getFloat32(offset + 8, true)
    if (oldQuatOrder) {
      out[outIdx + 3] = view.getFloat32(offset + 24, true) // w
      out[outIdx + 4] = view.getFloat32(offset + 12, true) // x
      out[outIdx + 5] = view.getFloat32(offset + 16, true) // y
      out[outIdx + 6] = view.getFloat32(offset + 20, true) // z
    } else {
      out[outIdx + 3] = view.getFloat32(offset + 12, true)
      out[outIdx + 4] = view.getFloat32(offset + 16, true)
      out[outIdx + 5] = view.getFloat32(offset + 20, true)
      out[outIdx + 6] = view.getFloat32(offset + 24, true)
    }
  }

  const rootDelta = new Float32Array(KEY_FLOATS)
  readKey(animDataOffset, rootDelta, 0)

  const times = new Float32Array(numFrames)
  const keys = new Float32Array(numFrames * numBones * KEY_FLOATS)
  let frameOffset = animDataOffset + KEY_BYTES
  for (let f = 0; f < numFrames; f++) {
    times[f] = view.getFloat32(frameOffset, true)
    // +4: u32 flags (ungenutzt)
    let keyOffset = frameOffset + FRAME_HEADER_BYTES
    for (let b = 0; b < numBones; b++) {
      readKey(keyOffset, keys, (f * numBones + b) * KEY_FLOATS)
      keyOffset += KEY_BYTES
    }
    frameOffset += frameBytes
  }

  return {
    version,
    numFrames,
    duration,
    boneNames,
    boneParents,
    rootDelta,
    times,
    keys,
  }
}
