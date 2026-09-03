import { Matrix4, Quaternion, Vector3 } from 'three'
import type { ScmModel } from '../formats/scm'
import type { ScaAnim } from '../formats/sca'

/**
 * Skelett-Animation nach Original-Semantik (faf-re CAnimationManipulator):
 * SCA-Keys sind Lokal-Posen (Position + Quaternion w,x,y,z relativ zum
 * Parent); Welt = Parent-Welt × Lokal; Skin-Matrix = Welt × restPoseInverse
 * aus der SCM-Datei (column-major, numerisch verifiziert: Bindpose ×
 * restPoseInverse = Identität). Interpolation: Positions-LERP + Quaternion-
 * NLERP zwischen Nachbar-Frames, wie im Original.
 *
 * FA-Vertices sind rigid gebunden (nur boneIndices[0], keine Gewichte).
 */
export class UnitAnimator {
  readonly boneCount: number
  /** Skin-Matrizen für den Shader — Instanzen bleiben stabil. */
  readonly skinMatrices: Matrix4[]

  private readonly parents: Int32Array
  private readonly restInverse: Matrix4[]
  private readonly bindPos: Vector3[]
  private readonly bindRot: Quaternion[]
  private readonly worlds: Matrix4[]
  private readonly localPos: Vector3[]
  private readonly localRot: Quaternion[]

  private anim: ScaAnim | null = null
  /** SCM-Bone-Index → SCA-Bone-Index (-1 = nicht animiert) */
  private animBoneMap: Int32Array | null = null
  /**
   * Turret aim overrides (bone index -> extra local rotation): the sim's
   * CAimManipulator state. Yaw turns around the bone's local Y, pitch
   * around its local X (standard FA turret rigging).
   */
  private readonly aimOverrides = new Map<number, { yaw: number; pitch: number }>()
  /**
   * Bones the sim has hidden (Unit:HideBone -> CAniPoseBone::mVisible = 0,
   * Cfile:981560-981600). The engine's renderer skips the geometry of an
   * invisible bone; here the bone's skin matrix collapses to zero scale, so
   * every vertex bound to it degenerates into a point that rasterises no
   * fragment -- in the main pass and in the shadow pass, which share the
   * matrices. The ACU hides its upgrade pods this way (uel0001_script.lua:110).
   */
  private readonly hiddenBones = new Set<number>()
  private lastTime = 0
  private readonly tmpAim = new Quaternion()
  private readonly axisY = new Vector3(0, 1, 0)
  private readonly axisX = new Vector3(1, 0, 0)

  private readonly tmpLocal = new Matrix4()
  private readonly tmpQ = new Quaternion()
  private readonly tmpP = new Vector3()
  private readonly one = new Vector3(1, 1, 1)

  constructor(model: ScmModel) {
    this.boneCount = model.bones.length
    this.parents = new Int32Array(this.boneCount)
    this.restInverse = []
    this.bindPos = []
    this.bindRot = []
    this.worlds = []
    this.localPos = []
    this.localRot = []
    this.skinMatrices = []

    for (let i = 0; i < this.boneCount; i++) {
      const b = model.bones[i]!
      this.parents[i] = b.parent
      this.restInverse.push(new Matrix4().fromArray(b.restPoseInverse))
      this.bindPos.push(new Vector3(...b.position))
      const [w, x, y, z] = b.rotation
      this.bindRot.push(new Quaternion(x, y, z, w))
      this.worlds.push(new Matrix4())
      this.localPos.push(new Vector3())
      this.localRot.push(new Quaternion())
      this.skinMatrices.push(new Matrix4())
    }

    this.update(0)
  }

  setAnimation(anim: ScaAnim | null, boneNames: string[]): void {
    this.anim = anim
    if (!anim) {
      this.animBoneMap = null
      this.update(0)
      return
    }
    const scaIndex = new Map<string, number>()
    anim.boneNames.forEach((name, i) => scaIndex.set(name.toLowerCase(), i))
    this.animBoneMap = new Int32Array(this.boneCount)
    for (let i = 0; i < this.boneCount; i++) {
      this.animBoneMap[i] = scaIndex.get(boneNames[i]!.toLowerCase()) ?? -1
    }
  }

  get duration(): number {
    return this.anim?.duration ?? 0
  }

  /**
   * Replace the aim overrides and re-pose immediately (idle units get no
   * per-frame update, so the turret must move on the spot).
   */
  setAimOverrides(list: { boneIndex: number; yaw: number; pitch: number }[]): void {
    let changed = list.length !== this.aimOverrides.size
    if (!changed) {
      for (const o of list) {
        const cur = this.aimOverrides.get(o.boneIndex)
        if (!cur || cur.yaw !== o.yaw || cur.pitch !== o.pitch) {
          changed = true
          break
        }
      }
    }
    if (!changed) return
    this.aimOverrides.clear()
    for (const o of list) this.aimOverrides.set(o.boneIndex, { yaw: o.yaw, pitch: o.pitch })
    this.update(this.lastTime)
  }

  /** Replace the hidden-bone set and re-pose when it changed. */
  setHiddenBones(indices: number[]): void {
    let changed = indices.length !== this.hiddenBones.size
    if (!changed) for (const i of indices) if (!this.hiddenBones.has(i)) { changed = true; break }
    if (!changed) return
    this.hiddenBones.clear()
    for (const i of indices) this.hiddenBones.add(i)
    this.update(this.lastTime)
  }

  /** Berechnet die Skin-Matrizen für Zeitpunkt t (Sekunden, looped). */
  update(timeSec: number): void {
    this.lastTime = timeSec
    const anim = this.anim

    let f0 = 0
    let f1 = 0
    let alpha = 0
    if (anim && anim.numFrames > 1 && anim.duration > 0) {
      const t = ((timeSec % anim.duration) + anim.duration) % anim.duration
      const framePos = (t / anim.duration) * (anim.numFrames - 1)
      f0 = Math.floor(framePos)
      f1 = Math.min(f0 + 1, anim.numFrames - 1)
      alpha = framePos - f0
    }

    for (let i = 0; i < this.boneCount; i++) {
      const scaBone = anim && this.animBoneMap ? this.animBoneMap[i]! : -1
      if (anim && scaBone >= 0) {
        const k0 = (f0 * anim.boneNames.length + scaBone) * 7
        const k1 = (f1 * anim.boneNames.length + scaBone) * 7
        const keys = anim.keys
        this.localPos[i]!.set(
          keys[k0]! + (keys[k1]! - keys[k0]!) * alpha,
          keys[k0 + 1]! + (keys[k1 + 1]! - keys[k0 + 1]!) * alpha,
          keys[k0 + 2]! + (keys[k1 + 2]! - keys[k0 + 2]!) * alpha,
        )
        // gespeichert w,x,y,z → THREE.Quaternion(x,y,z,w); Original nutzt
        // NLERP, wir Slerp (visuell identisch, keine Renormierung nötig)
        this.localRot[i]!.set(keys[k0 + 4]!, keys[k0 + 5]!, keys[k0 + 6]!, keys[k0 + 3]!)
        this.tmpQ.set(keys[k1 + 4]!, keys[k1 + 5]!, keys[k1 + 6]!, keys[k1 + 3]!)
        this.localRot[i]!.slerp(this.tmpQ, alpha)
      } else {
        this.localPos[i]!.copy(this.bindPos[i]!)
        this.localRot[i]!.copy(this.bindRot[i]!)
      }

      const aim = this.aimOverrides.get(i)
      if (aim) {
        if (aim.yaw !== 0) {
          this.tmpAim.setFromAxisAngle(this.axisY, aim.yaw)
          this.localRot[i]!.multiply(this.tmpAim)
        }
        if (aim.pitch !== 0) {
          this.tmpAim.setFromAxisAngle(this.axisX, aim.pitch)
          this.localRot[i]!.multiply(this.tmpAim)
        }
      }

      this.tmpLocal.compose(this.localPos[i]!, this.localRot[i]!, this.one)
      const parent = this.parents[i]!
      if (parent >= 0) {
        this.worlds[i]!.multiplyMatrices(this.worlds[parent]!, this.tmpLocal)
      } else {
        this.worlds[i]!.copy(this.tmpLocal)
      }
      if (this.hiddenBones.has(i)) {
        // The world matrix stays intact for the children; only the skin
        // matrix of the hidden bone itself collapses.
        this.skinMatrices[i]!.makeScale(0, 0, 0)
      } else {
        this.skinMatrices[i]!.multiplyMatrices(this.worlds[i]!, this.restInverse[i]!)
      }
    }
  }

  /** Welt-Position eines Bones (z. B. für Turret-Mündungen später). */
  getBoneWorld(index: number): Matrix4 | null {
    return this.worlds[index] ?? null
  }
}
