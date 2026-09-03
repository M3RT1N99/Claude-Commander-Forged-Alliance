/**
 * The camera shake (src/viewer/cameraShake.ts) against Moho::CameraImpl:
 * CameraShake's replacement rule (Cfile:1149138-1149153), Frame's clock and
 * sign flip (Cfile:1150647-1150651) and func_CameraImplUpdateShake's offset
 * (Cfile:1148657-1148700), driven with a deterministic rand so every number
 * can be checked exactly. Asset-free.
 *
 *   npx tsx scripts/verify-camera-shake.ts
 */
import { CameraShakeState, type CamShakeParams } from '../src/viewer/cameraShake'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const near = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps
const len = (v: [number, number, number]): number => Math.hypot(v[0], v[1], v[2])

/** rand(lo, hi) -> hi: the upper bound of every draw, so amplitudes are exact. */
const randHi = (_lo: number, hi: number): number => hi
/** rand(lo, hi) -> lo. */
const randLo = (lo: number): number => lo

const shake = (over: Partial<CamShakeParams> = {}): CamShakeParams => ({
  x: 100, y: 0, z: 100, radius: 30, max: 2, min: 0.5, duration: 1, ...over,
})

console.log('\n== Nothing shakes before a request, and nothing after the duration ==')
{
  const s = new CameraShakeState(randHi)
  check(len(s.offset(0, 0, 1)) === 0, 'a fresh camera has a zero offset (constructor zeros, Cfile:1149667-1149674)')
  check(!s.active(), 'and no running shake')
  s.request(shake())
  check(s.active(), 'a request starts a shake')
  s.frame(0.4)
  check(s.active() && len(s.offset(100, 100, 1)) > 0, 'it runs while mTotalTime < duration')
  s.frame(0.7)
  check(!s.active() && len(s.offset(100, 100, 1)) === 0, 'mTotalTime is clamped to the duration and the offset is zero (Cfile:1150648-1150649, 1148675, 1148704-1148710)')
}

console.log('\n== The offset: direction, amplitude, decay and the two random terms ==')
{
  // Focus 40 units east of the epicentre: direction = (-1, 0, 0), beyond
  // the radius (30) -> amplitude = min. rand -> hi: along = amp*0.5*sign,
  // across = amp*0.25.
  const s = new CameraShakeState(randHi)
  s.request(shake())
  s.frame(0) // sign flips to -1 on the first frame (v255 starts at +1)
  let [ox, oy, oz] = s.offset(140, 100, 1)
  // amp = min = 0.5 -> along = 0.5*0.5*(-1) = -0.25, across = 0.5*0.25 = 0.125
  // dest = (dx*along + dz*across, 0, dz*along - dx*across) with (dx,dz)=(-1,0)
  check(near(ox, 0.25) && near(oy, 0) && near(oz, 0.125), `beyond the radius the amplitude is min: (${ox.toFixed(4)}, ${oy}, ${oz.toFixed(4)}) = (0.25, 0, 0.125)`)
  s.frame(0)
  ;[ox, oy, oz] = s.offset(140, 100, 1)
  check(near(ox, -0.25) && near(oz, 0.125), 'the along term flips sign every frame (v255, Cfile:1150651), the across term does not')
  // Halfway to the radius (15 units): amp = (min - max) * 0.5 + max = 1.25.
  ;[ox, oy, oz] = s.offset(115, 100, 1)
  check(near(ox, -0.625) && near(oz, 0.3125), `at half the radius the amplitude interpolates linearly to 1.25: (${ox.toFixed(4)}, ${oz.toFixed(4)})`)
  // Exactly at the epicentre distance 0 < 10: random direction (rand -> hi:
  // (1, 1) normalized) and amplitude max = 2.
  ;[ox, oy, oz] = s.offset(100, 100, 1)
  const d = Math.SQRT1_2
  // along = 2*0.5*(+1) = 1 (sign is +1 after two flips), across = 0.5
  check(near(ox, d * 1 + d * 0.5) && near(oz, d * 1 - d * 0.5), `closer than 10 units the direction is random and the amplitude is max (${ox.toFixed(4)}, ${oz.toFixed(4)})`)
  // Decay: at t = 0.5 of duration 1 the amplitude halves.
  s.frame(0.5)
  ;[ox, oy, oz] = s.offset(140, 100, 1)
  check(near(ox, 0.125) && near(oz, 0.0625), 'the amplitude decays linearly with (1 - t/duration)')
  // cam_ShakeMult scales the result (Cfile:1148697-1148699).
  ;[ox, oy, oz] = s.offset(140, 100, 3)
  check(near(ox, 0.375) && near(oz, 0.1875), 'cam_ShakeMult multiplies the offset')
  // rand -> lo: along = 0, across = -amp*0.25 -> only the across term.
  const lo = new CameraShakeState(randLo)
  lo.request(shake())
  lo.frame(0)
  ;[ox, oy, oz] = lo.offset(140, 100, 1)
  check(near(ox, 0) && near(oz, -0.125), 'the along term is rand(0, amp) and the across term rand(-amp, amp) (Cfile:1148695-1148696)')
}

console.log('\n== CameraShake replaces a running shake only with a stronger one ==')
{
  const s = new CameraShakeState(randHi)
  s.request(shake({ max: 2, duration: 1 }))
  s.frame(0.25)
  s.request(shake({ max: 1, duration: 5 }))
  s.frame(0)
  let o = s.offset(140, 100, 1)
  // Still the first shake: amp = min 0.5 * (1 - 0.25) = 0.375 -> along 0.1875 (sign +1
  // after two flips), across 0.09375; direction (-1, 0) -> (-0.1875, 0, 0.09375).
  check(near(o[0], -0.1875) && near(o[2], 0.09375), 'a weaker request while a shake runs is ignored (Cfile:1149142)')
  s.request(shake({ max: 3, min: 1, duration: 2 }))
  s.frame(0)
  o = s.offset(140, 100, 1)
  // New shake at t = 0: amp = min 1 -> along 0.5 (sign -1 after the third flip), across 0.25
  check(near(Math.abs(o[0]), 0.5) && near(o[2], 0.25), 'a stronger request replaces it and restarts the clock')
  s.frame(2)
  s.request(shake({ max: 0.1, min: 0.1, duration: 1 }))
  check(s.active(), 'after the duration any request is accepted again')
  const off = new CameraShakeState(randHi)
  off.canShake = false
  off.request(shake())
  check(!off.active(), 'with mCanShake cleared (an orthographic view, Cfile:1297718-1297735) requests are dropped')
}

console.log(failures === 0 ? '\nCAMERA SHAKE PASSED' : `\nCAMERA SHAKE FAILED (${failures})`)
process.exit(failures === 0 ? 0 : 1)
