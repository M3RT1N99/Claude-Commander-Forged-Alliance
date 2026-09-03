/**
 * The camera shake of Moho::CameraImpl — pure state and math, no renderer.
 *
 * A shake starts in the sim: `Entity:ShakeCamera(radius, max, min, duration)`
 * (cfunc_EntityShakeCameraL, Cfile:931108-931169) packs the entity's position
 * and the four numbers into an SCamShakeParams and appends it to
 * Sim::mSyncCamShake (func_ShakeCamera, Cfile:936387). Sim::Sync hands the list
 * to the user layer with the beat (Cfile:1074494-1074501), which calls
 * CameraImpl::CameraShake on every camera for every entry (Cfile:1327867).
 *
 *   CameraImpl::CameraShake (Cfile:1149138-1149153): accepted only while
 *     mCanShake, and only when the running shake is over
 *     (mTotalTime >= duration) or the new one is stronger (max > current max);
 *     then the parameters are replaced and mTotalTime restarts at 0.
 *   CameraImpl::Frame (Cfile:1150647-1150651): mTotalTime += delta, clamped to
 *     the duration; the sign v255 flips every frame.
 *   func_CameraImplUpdateShake (Cfile:1148657-1148700): while
 *     mTotalTime < duration, the direction is focus -> epicentre in the XZ
 *     plane (a random direction closer than 10 units); the amplitude is
 *     (1 - t/duration) * ((min - max) * clamp(dist/radius, 0, 1) + max); along
 *     the direction rand(0, amp) * sign * 0.5, across it rand(-amp, amp) * 0.25;
 *     the result times cam_ShakeMult (Cfile:421830, default 1.0) is added to
 *     the camera eye (Cfile:1151445-1151452).
 *
 * The constructor values are those of CameraImpl::CameraImpl
 * (Cfile:1149667-1149676): zero parameters, mTotalTime 0, v255 = 1,
 * mCanShake = 1. CRenderWorldView::SetOrthographic clears mCanShake for an
 * orthographic view (Cfile:1297718-1297735).
 */

export interface CamShakeParams {
  /** The epicentre — the requesting entity's position (Cfile:931137-931139). */
  x: number
  y: number
  z: number
  /** Distance from the epicentre at which the shake falls off to `min`. */
  radius: number
  /** Shake size in world units when looking at the epicentre. */
  max: number
  /** Shake size at `radius` distance or farther. */
  min: number
  /** Length of the shake in seconds. */
  duration: number
}

/** func_DRand(a, b) (Cfile:1148620-1148627): uniform in [a, b). */
export type Rand = (lo: number, hi: number) => number

const defaultRand: Rand = (lo, hi) => lo + (hi - lo) * Math.random()

export class CameraShakeState {
  private params: CamShakeParams = { x: 0, y: 0, z: 0, radius: 0, max: 0, min: 0, duration: 0 }
  /** mTotalTime — seconds into the running shake, clamped to its duration. */
  private totalTime = 0
  /** v255 — flips every frame (Cfile:1150651). */
  private sign = 1
  /** mCanShake (Cfile:1149676). */
  canShake = true

  constructor(private readonly rand: Rand = defaultRand) {}

  /** CameraImpl::CameraShake (Cfile:1149138-1149153). */
  request(p: CamShakeParams): void {
    if (!this.canShake) return
    if (this.totalTime >= this.params.duration || p.max > this.params.max) {
      this.params = { ...p }
      this.totalTime = 0
    }
  }

  /** CameraImpl::Frame's shake part (Cfile:1150647-1150651). */
  frame(delta: number): void {
    const t = this.totalTime + delta
    this.totalTime = this.params.duration <= t ? this.params.duration : t
    this.sign = -this.sign
  }

  /** Whether a shake is still running — the condition of UpdateShake. */
  active(): boolean {
    return this.totalTime < this.params.duration
  }

  /**
   * func_CameraImplUpdateShake (Cfile:1148657-1148700): the eye offset of this
   * frame for a camera focused at (focusX, focusZ), already multiplied by
   * cam_ShakeMult. Zero when no shake is running.
   */
  offset(focusX: number, focusZ: number, shakeMult: number): [number, number, number] {
    const p = this.params
    if (!(this.totalTime < p.duration)) return [0, 0, 0]
    // Wm3::Vector3f::Normalize returns the length and normalizes in place
    // (from its use at Cfile:1148680-1148681; the body is not in the
    // decompilation, so its tolerance for tiny lengths is UNVERIFIED — the
    // <10 branch below redraws the direction anyway).
    let dx = p.x - focusX
    let dz = p.z - focusZ
    const dist = Math.sqrt(dx * dx + dz * dz)
    if (dist > 0) {
      dx /= dist
      dz /= dist
    }
    if (dist < 10) {
      dx = this.rand(-1, 1)
      dz = this.rand(-1, 1)
      const l = Math.sqrt(dx * dx + dz * dz)
      if (l > 0) {
        dx /= l
        dz /= l
      }
    }
    // dist / radius, capped at 1 — the engine divides without guarding a zero
    // radius (Cfile:1148679); so does this.
    let f = dist / p.radius
    if (f >= 1) f = 1
    const amp = (1 - this.totalTime / p.duration) * ((p.min - p.max) * f + p.max)
    // sub_7A6460(amp) is rand(0, amp) (Cfile:1148609-1148615).
    const along = this.rand(0, amp) * this.sign * 0.5
    const across = this.rand(-amp, amp) * 0.25
    return [(dx * along + dz * across) * shakeMult, 0, (dz * along - dx * across) * shakeMult]
  }
}
