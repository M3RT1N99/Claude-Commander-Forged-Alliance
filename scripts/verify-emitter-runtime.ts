/**
 * Die Emitter-Laufzeit (src/effects/emitterRuntime.ts) gegen die belegte
 * Engine-Semantik (CEfxEmitter::Tick @0x65CE00, Cfile:894567-894932; Upload
 * faf-re ParticleRenderBuckets.cpp:4480-4512).
 *
 * Geprüft wird die MECHANIK mit kontrollierten Kurven und deterministischem
 * rand — das Kurven-SAMPLING selbst ist gegen alle 2724 echten Blueprints
 * abgenommen (scripts/verify-emitter-curves.ts).
 *
 *   npx tsx scripts/verify-emitter-runtime.ts
 */
import { EmitterRuntime, type EmitterState } from '../src/effects/emitterRuntime'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const nah = (a: number, b: number, eps = 1e-9): boolean => Math.abs(a - b) < eps

/** Konstante Kurve ohne Spread: ein Key, Wert v. */
const konst = (v: number) => ({ XRange: 10, Keys: [{ x: 5, y: v, z: 0 }] })
/** rand fest auf 0.5 → der Spread-Term (rand−0.5)·z fällt weg. */
const rand05 = (): number => 0.5

const ruhend: EmitterState = {
  x: 100,
  y: 20,
  z: 100,
  qw: 1,
  qx: 0,
  qy: 0,
  qz: 0,
  scale: 1,
  enabled: true,
}

console.log('\n== EmitRate-Akkumulator (Cfile:894662-894679) ==')
{
  // Rate 0.25 → genau 1 Partikel alle 4 Ticks, Bruchteile tragen über.
  const rt = new EmitterRuntime({ Lifetime: -1, EmitRateCurve: konst(0.25), LifetimeCurve: konst(10) }, rand05)
  const je: number[] = []
  for (let i = 0; i < 8; i++) je.push(rt.tick(ruhend, i).length)
  check(je.join(',') === '0,0,0,1,0,0,0,1', `Rate 0.25 → Spawn alle 4 Ticks (${je.join(',')})`)
}
{
  // Rate 2.5 → abwechselnd 2 und 3.
  const rt = new EmitterRuntime({ Lifetime: -1, EmitRateCurve: konst(2.5), LifetimeCurve: konst(10) }, rand05)
  const je: number[] = []
  for (let i = 0; i < 4; i++) je.push(rt.tick(ruhend, i).length)
  check(je.join(',') === '2,3,2,3', `Rate 2.5 → 2,3,2,3 (${je.join(',')})`)
}

console.log('\n== Spawn-Mapping (Cfile:894567-894932 / Upload 4480-4512) ==')
{
  const rt = new EmitterRuntime(
    {
      Lifetime: -1,
      EmitRateCurve: konst(1),
      LifetimeCurve: konst(20),
      XDirectionCurve: konst(3),
      YDirectionCurve: konst(0),
      ZDirectionCurve: konst(4), // |dir| = 5 — und BLEIBT 5 (kein normalize!)
      VelocityCurve: konst(2),
      XAccelCurve: konst(1),
      StartSizeCurve: konst(2),
      EndSizeCurve: konst(6),
      InitialRotationCurve: konst(90), // Grad!
      RotationRateCurve: konst(180),
      Gravity: true,
      ParticleResistance: true,
      ResistanceCurve: konst(4),
      TextureFramecount: 8,
      TextureStripcount: 4,
      TextureSelectionCurve: konst(2.7), // floor(2.7) = Zeile 2
      RampSelectionCurve: konst(0.5),
    },
    rand05,
  )
  const p = rt.tick(ruhend, 100)[0]!
  check(nah(p.vx, 6) && nah(p.vz, 8), `Velocity = Dir·Scale·v, NICHT normalisiert (${p.vx}, ${p.vz})`)
  check(nah(p.ax, 1) && nah(p.ay, -0.02), `Gravity: ay −= 0.02 pro Tick² (ay=${p.ay})`)
  check(nah(p.angle, 90 * 0.017453292), `InitialRotation in Grad → rad ×0.017453292 (${p.angle.toFixed(6)})`)
  check(nah(p.rotRate, 180 * 0.017453292), 'RotationRate ebenso Grad → rad')
  check(nah(p.beginSize, 2) && nah(p.sizeRate, (6 - 2) / 20), `sizeRate = (End−Begin)/Lifetime (${p.sizeRate})`)
  check(nah(p.dragX, 4) && nah(p.dragY, 0.25) && nah(p.dragZ, 0.0625), 'dragCoeff = (r, 1/r, 1/r²)')
  check(nah(p.frameSize, 1 / 8) && nah(p.rowHeight, 1 / 4), 'frameSize = 1/Framecount, Zeilenhöhe = 1/Stripcount')
  check(nah(p.texRow, 2 * 0.25), `TextureSelection: floor(2.7)·(1/Stripcount) = 0.5 (${p.texRow})`)
  check(nah(p.rampV, 0.5), 'RampSelection roh, keine Normalisierung')
  check(nah(p.birth, 100), 'birth = Sim-Tick des Spawns')
}

console.log('\n== ScaleEmitter: multipliziert NUR die belegten Kanäle ==')
{
  const bp = {
    Lifetime: -1,
    EmitRateCurve: konst(1),
    LifetimeCurve: konst(10),
    XDirectionCurve: konst(1),
    VelocityCurve: konst(1),
    XAccelCurve: konst(1),
    StartSizeCurve: konst(2),
    EndSizeCurve: konst(2),
    RotationRateCurve: konst(90),
    XPosCurve: konst(1),
  }
  const rt = new EmitterRuntime(bp, rand05)
  const p = rt.tick({ ...ruhend, scale: 3, ox: 0.5 }, 0)[0]!
  check(nah(p.vx, 3), `Dir/Velocity × Scale (vx=${p.vx})`)
  check(nah(p.ax, 3), `Accel × Scale (ax=${p.ax})`)
  check(nah(p.beginSize, 6), `Start/EndSize × Scale (${p.beginSize})`)
  // PosCurve skaliert (1·3), OffsetEmitter NICHT (0.5) → x = 100 + 3 + 0.5.
  check(nah(p.px, 103.5), `PosCurve skaliert, OffsetEmitter unskaliert (px=${p.px})`)
  check(nah(p.rotRate, 90 * 0.017453292), 'RotationRate NICHT skaliert')
  check(nah(p.lifetime, 10), 'Lifetime NICHT skaliert')
}

console.log('\n== LocalVelocity: Bone-Drehung EINMALIG beim Spawn ==')
{
  // 90° um Y (w=cos45, y=sin45): lokal +Z zeigt in Welt +X.
  const s = Math.SQRT1_2
  const gedreht: EmitterState = { ...ruhend, qw: s, qy: s, qx: 0, qz: 0 }
  const bp = {
    Lifetime: -1,
    EmitRateCurve: konst(1),
    LifetimeCurve: konst(10),
    ZDirectionCurve: konst(1),
    VelocityCurve: konst(1),
  }
  const mit = new EmitterRuntime({ ...bp, LocalVelocity: true }, rand05).tick(gedreht, 0)[0]!
  const ohne = new EmitterRuntime({ ...bp, LocalVelocity: false }, rand05).tick(gedreht, 0)[0]!
  check(nah(mit.vx, 1, 1e-6) && nah(mit.vz, 0, 1e-6), `LocalVelocity: +Z → Welt +X (${mit.vx.toFixed(3)})`)
  check(nah(ohne.vz, 1, 1e-6), 'ohne LocalVelocity: Kurven wirken in Welt-Achsen')
}

console.log('\n== InterpolateEmission: Geburt um j/N gestaffelt (Cfile:894712-894717) ==')
{
  const rt = new EmitterRuntime(
    { Lifetime: -1, EmitRateCurve: konst(4), LifetimeCurve: konst(10), InterpolateEmission: true },
    rand05,
  )
  const p = rt.tick(ruhend, 50)
  check(p.length === 4, `4 Partikel bei Rate 4`)
  check(
    nah(p[0]!.birth, 50) && nah(p[1]!.birth, 50.25) && nah(p[3]!.birth, 50.75),
    `Geburten 50, 50.25, …, 50.75 (${p.map((q) => q.birth).join(',')})`,
  )
}

console.log('\n== Emitter-Lifetime: nach Ablauf keine Emission mehr ==')
{
  const rt = new EmitterRuntime({ Lifetime: 3, EmitRateCurve: konst(1), LifetimeCurve: konst(10) }, rand05)
  const je: number[] = []
  for (let i = 0; i < 5; i++) je.push(rt.tick(ruhend, i).length)
  check(je.join(',') === '1,1,1,0,0', `Lifetime 3 → 3 Ticks Emission (${je.join(',')})`)
}

console.log(failures === 0 ? '\nEMITTER-LAUFZEIT BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`)
process.exit(failures === 0 ? 0 : 1)
