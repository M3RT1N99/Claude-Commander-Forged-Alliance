/**
 * Partikel-Kurven des Effektsystems — 1:1 nach der Engine.
 *
 * Jede der 21 Emitter-Kurven kommt als `{ XRange = <float>, Keys = { {x,y,z},
 * ... } }` aus einem Emitter-Blueprint (`effects/Emitters/*_emit.bp`,
 * REmitterBlueprintCurve: Felder "XRange" + "Keys", Cfile:649298-649303).
 * `x` ist der Zeitpunkt in Ticks, `y` der Mittelwert, `z` die Zufalls-
 * Streubreite.
 *
 * Ausgewertet wird eine Kurve von `Moho::SEfxCurve::GetValue` (@0x514E50,
 * Cfile:649014-649070). Belegtes Verhalten:
 *
 *  - 0 Keys → 0.0 (Cfile:649030-649031). Kommt im Spiel nie vor, weil
 *    `func_MakeEmitterCurve` leere Blueprint-Kurven durch eine Default-Kurve
 *    ersetzt (siehe `makeEfxCurve`).
 *  - Suche den ersten Key mit `key.x > t` (Scan `while (start->x <= interp)`,
 *    Cfile:649049-649053).
 *  - t vor dem ersten Key → Clamp auf den ersten Key, Spread bleibt aktiv:
 *    `(rand01() - 0.5) * first.z + first.y` (Cfile:649054-649058).
 *  - t auf/hinter dem letzten Key → Clamp auf den letzten Key:
 *    `(rand01() - 0.5) * last.z + last.y` (Cfile:649036-649045).
 *  - sonst lineare Interpolation von y UND z zwischen Vor- und Nachfolger:
 *    `f = (t - pre.x) / (cur.x - pre.x)` (Cfile:649065), Ergebnis
 *    `(rand01() - 0.5) * (pre.z + (cur.z - pre.z)*f) + f*(cur.y - pre.y) + pre.y`
 *    (Cfile:649067).
 *  - rand01 ist EIN Zug aus dem globalen Mersenne-Twister, skaliert mit
 *    2.3283064e-10 = 2^-32 → Wertebereich [0,1) (func_RandomFloatSafe,
 *    Cfile:648929-648937; inline Cfile:649038-649044).
 *
 * GetValue selbst bricht die Zeit NICHT um und benutzt `XRange` NICHT
 * (nur die Key-Liste `v3` wird gelesen; die Felder v1/v2 mit 0/XRange aus
 * Cfile:649261-649262 dienen dem Kurven-Resize `ResizeEmitterCurve`,
 * sub_515090/Cfile:649117 ff.). Der zyklische Umbruch passiert beim AUFRUFER:
 * CEfxEmitter rechnet vor jedem GetValue
 * `t = fmod(params[EFFECT_TICKCOUNT] - tick, params[EFFECT_REPEATTIME])` und
 * addiert bei Vorzeichen-Differenz einmal Repeattime (floored modulo,
 * Cfile:894655-894661 für die EmitRate, Cfile:894693-894698 pro Partikel) —
 * also mit dem Blueprint-Feld `Repeattime` ("Repeattime of emitter in ticks",
 * Cfile:645131-645133), nicht mit XRange.
 *
 * Abweichung (dokumentiert): die Engine rechnet in 32-Bit-Floats, wir in
 * JS-Doubles — gleiche Formel, gleiche Reihenfolge, Differenz < 1e-6 relativ.
 */

/** A curve key: x = time in ticks, y = average, z = random spread. */
export interface EfxKey {
  x: number
  y: number
  z: number
}

/** Laufzeit-Kurve (Keys aufsteigend nach x sortiert — siehe makeEfxCurve). */
export interface EfxCurve {
  XRange: number
  Keys: EfxKey[]
}

/** Curve as it appears raw in the blueprint (any field may be missing). */
export interface EfxCurveBp {
  XRange?: number
  Keys?: readonly EfxKey[]
}

/**
 * Die 21 Kurven eines EmitterBlueprints, in der Feld-Reihenfolge von
 * `Moho::REmitterBlueprint::Init` (Cfile:645017-645079).
 *
 * Die LAUFZEIT-Lanes (`mCurves`-Indizes, CEfxEmitter-Ctor Cfile:893987-894008)
 * sind anders sortiert: XDir, YDir, ZDir, EmitRate, Lifetime, Velocity,
 * XAccel, YAccel, ZAccel, Resistance, Size, XPos, YPos, ZPos, StartSize,
 * EndSize, InitialRotation, RotationRate, FrameRate, TextureSelection,
 * RampSelection.
 */
export const EMITTER_CURVE_NAMES = [
  'SizeCurve',
  'XDirectionCurve',
  'YDirectionCurve',
  'ZDirectionCurve',
  'EmitRateCurve',
  'LifetimeCurve',
  'VelocityCurve',
  'XAccelCurve',
  'YAccelCurve',
  'ZAccelCurve',
  'ResistanceCurve',
  'StartSizeCurve',
  'EndSizeCurve',
  'InitialRotationCurve',
  'RotationRateCurve',
  'FrameRateCurve',
  'TextureSelectionCurve',
  'XPosCurve',
  'YPosCurve',
  'ZPosCurve',
  'RampSelectionCurve',
] as const

export type EmitterCurveName = (typeof EMITTER_CURVE_NAMES)[number]

/**
 * Baut aus einer Blueprint-Kurve die Laufzeit-Kurve — 1:1
 * `func_MakeEmitterCurve` (@0x515320, Cfile:649226-649274):
 *
 *  - Keys werden einzeln SORTIERT eingefügt (sub_5151B0, Cfile:649144-649194):
 *    jeder neue Key kommt vor den ersten vorhandenen mit `x > neu.x`
 *    (Cfile:649185-649191). Gleiches x → der spätere Blueprint-Key landet
 *    dahinter (stabil aufsteigend).
 *  - Kurve ohne Keys (fehlend oder leer) → Default XRange = 10 mit genau
 *    einem Key {x=5, y=0, z=0} (Cfile:649264-649271) — GetValue liefert dann
 *    konstant 0 (± Spread 0).
 */
export function makeEfxCurve(bp?: EfxCurveBp | null): EfxCurve {
  const raw = bp?.Keys
  if (!raw || raw.length === 0) {
    return { XRange: 10, Keys: [{ x: 5, y: 0, z: 0 }] }
  }
  // Stable increasing to x — Array.prototype.sort is stable according to the spec and
  // This corresponds exactly to the insert scan of the engine.
  const keys = raw.map((k) => ({ x: k.x, y: k.y, z: k.z }))
  keys.sort((a, b) => a.x - b.x)
  return { XRange: bp.XRange ?? 0, Keys: keys }
}

/**
 * `Moho::SEfxCurve::GetValue` (@0x514E50, Cfile:649014-649070), 1:1.
 *
 * `t` ist die bereits umgebrochene Emitter-Zeit in Ticks (siehe
 * `wrapEmitterTime`); `rand` liefert eine Gleichverteilung in [0,1) — als
 * Parameter, damit Tests deterministisch sind (Engine: func_RandomFloatSafe).
 * Pro Aufruf wird `rand` genau EINMAL gezogen, wie im Original.
 */
export function sampleCurve(curve: EfxCurve, t: number, rand: () => number): number {
  const keys = curve.Keys
  const n = keys.length
  if (n === 0) return 0 // Cfile:649030-649031
  let i = 0
  // Erster Key mit x > t; NaN-t (Repeattime = 0 → fmod = NaN) fällt hier
  // immediately and clamps to the first key — like the float comparison in C.
  while (keys[i]!.x <= t) {
    // Cfile:649049
    if (++i === n) {
      // behind the last key: Clamp on the last (Cfile:649036-649045)
      const last = keys[n - 1]!
      return (rand() - 0.5) * last.z + last.y
    }
  }
  const cur = keys[i]!
  if (i === 0) {
    // before the first key: Clamp on the first (Cfile:649054-649058)
    return (rand() - 0.5) * cur.z + cur.y
  }
  const pre = keys[i - 1]!
  const f = (t - pre.x) / (cur.x - pre.x) // Cfile:649065
  // y AND z linearly interpolated, then spread (Cfile:649067)
  return (rand() - 0.5) * (pre.z + (cur.z - pre.z) * f) + f * (cur.y - pre.y) + pre.y
}

/**
 * Der zyklische Zeit-Umbruch des AUFRUFERS (nicht von GetValue): floored
 * modulo mit `Repeattime` — `r = fmod(t, repeatTime)`, und wenn das Vorzeichen
 * von r nicht zum Divisor passt, einmal `+ repeatTime`
 * (Cfile:894655-894661, ebenso Cfile:894693-894698).
 *
 * JS `%` IST C `fmod` (truncated, Vorzeichen des Dividenden) — die
 * Korrekturzeile darunter macht daraus dasselbe floored modulo wie im Binary.
 * `repeatTime = 0` liefert NaN (wie fmod in C) — sampleCurve clampt dann auf
 * den ersten Key.
 */
export function wrapEmitterTime(t: number, repeatTime: number): number {
  const r = t % repeatTime
  return r < 0 !== repeatTime < 0 ? r + repeatTime : r
}
