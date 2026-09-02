/**
 * Partikel-Kurven-Sampler (src/effects/curves.ts) gegen ECHTE Emitter-
 * Blueprints aus effects.scd — 1:1-Verhalten von Moho::SEfxCurve::GetValue
 * (@0x514E50, Cfile:649014-649070) und func_MakeEmitterCurve
 * (Cfile:649226-649274).
 *
 * Die Blueprints laufen durch die ORIGINAL-Pipeline (lua/system/Blueprints.lua
 * → EmitterBlueprint{} → RegisterEmitterBlueprint), nicht durch einen
 * TS-Parser. Geprüft wird:
 *  - Anzahl der geladenen Emitter/Trail/Beam-BPs gegen eine unabhängige
 *    Text-Klassifikation derselben Dateien (Doku: 2437/184/103,
 *    docs/research/effects-audio.md).
 *  - An den Key-Zeitpunkten liefert sampleCurve exakt y (rand=0.5 → z-Term 0).
 *  - Zwischen Keys exakt linear (Mittel-/Viertelpunkt), y UND z interpoliert.
 *  - Vor dem ersten / hinter dem letzten Key: Clamp auf den Randkey
 *    (Cfile:649054-649058 bzw. 649036-649045) — der Spread bleibt aktiv.
 *  - rand=0 → −z/2, rand=1 → +z/2 (Formel `(rand-0.5)*z + y`, Cfile:649067).
 *  - Default-Kurve bei fehlenden Keys: XRange=10, ein Key {5,0,0}
 *    (Cfile:649264-649271); 0 Keys → 0.0 (Cfile:649030-649031).
 *  - Zyklischer Umbruch des Aufrufers über Repeattime (floored fmod,
 *    Cfile:894655-894661) via wrapEmitterTime.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-emitter-curves.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { FLAT_TEST_TERRAIN, FLAT_TEST_MAP_SIZE } from '../src/sim/terrain'
import { GameFiles } from './gameFiles'
import {
  EMITTER_CURVE_NAMES,
  makeEfxCurve,
  sampleCurve,
  wrapEmitterTime,
  type EfxKey,
} from '../src/effects/curves'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const R05 = () => 0.5
const R0 = () => 0
const R1 = () => 1

// --- Spieldateien + Engine (der EINE Sim-Boot, CLAUDE.md) ---------------------
const game = await GameFiles.open()
const warnings: string[] = []
const host = await LuaHost.create(game.luaFiles, (level, msg) => {
  if (level === 'WARN') warnings.push(msg)
})
installEngine(host)
// Flaches Testgelände — explizit, wie in verify-blueprints.ts (die Engine
// knallt ohne Karte, kein stiller 0-Wert).
setTerrainSource(host, FLAT_TEST_TERRAIN, FLAT_TEST_MAP_SIZE)

// --- Unabhängige Text-Klassifikation der effects-.bp-Dateien -------------------
// Erster Konstruktor-Aufruf in der Datei entscheidet den Typ. „EmitterBlueprint"
// matcht dank \b nicht in „TrailEmitterBlueprint".
const bpPaths = [...game.luaFiles.keys()]
  .filter((p) => p.startsWith('effects/') && p.endsWith('.bp'))
  .sort()
const textCount = { Emitter: 0, TrailEmitter: 0, Beam: 0 }
for (const p of bpPaths) {
  const text = new TextDecoder('latin1').decode(game.luaFiles.get(p)!)
  const m = /\b(TrailEmitterBlueprint|EmitterBlueprint|BeamBlueprint)\s*\{/.exec(text)
  if (m) {
    if (m[1] === 'EmitterBlueprint') textCount.Emitter++
    else if (m[1] === 'TrailEmitterBlueprint') textCount.TrailEmitter++
    else textCount.Beam++
  }
}

// --- Alle effects-.bp durch die ORIGINAL-Pipeline -----------------------------
console.log(`\n== Blueprint-Pipeline: ${bpPaths.length} .bp aus effects.scd ==`)
// In Blöcken, damit kein Mega-Chunk in die VM geht; LoadBlueprints() setzt
// original_blueprints je Aufruf zurück (InitOriginalBlueprints,
// Blueprints.lua:58) — __registered akkumuliert.
const BATCH = 500
for (let i = 0; i < bpPaths.length; i += BATCH) {
  const list = bpPaths
    .slice(i, i + BATCH)
    .map((p) => `'/${p}'`)
    .join(',')
  host.eval(`__bpFiles = { ${list} }; LoadBlueprints()`)
}

// Serialisierer: __registered.{Emitter,TrailEmitter,Beam} als JSON nach TS —
// über host.pull (Rückgabe-lose Übergabe, src/lua/host.ts:117-146). Kurve =
// jedes Tabellenfeld mit einer Keys-Tabelle. Nicht-endliche Zahlen knallen,
// statt still kaputtes JSON zu liefern.
host.eval(`
  function __countRegistered(group)
    local n = 0
    for _ in pairs(__registered[group]) do n = n + 1 end
    return n
  end
  local function num(v)
    if type(v) ~= 'number' or v ~= v or v == math.huge or v == -math.huge then
      error('non-finite number in emitter curve: ' .. tostring(v))
    end
    return string.format('%.17g', v)
  end
  local function curveJson(c)
    local p = { '{"XRange":', num(c.XRange or 0), ',"Keys":[' }
    for i, k in ipairs(c.Keys) do
      if i > 1 then p[#p + 1] = ',' end
      p[#p + 1] = '[' .. num(k.x) .. ',' .. num(k.y) .. ',' .. num(k.z) .. ']'
    end
    p[#p + 1] = ']}'
    return table.concat(p)
  end
  function __emitterCurvesJson()
    local out = { '{' }
    local first = true
    for id, bp in pairs(__registered.Emitter) do
      if not first then out[#out + 1] = ',' end
      first = false
      out[#out + 1] = string.format('%q', id) .. ':{"Repeattime":'
        .. num(bp.Repeattime or 0) .. ',"curves":{'
      local cfirst = true
      for name, v in pairs(bp) do
        if type(v) == 'table' and type(v.Keys) == 'table' then
          if not cfirst then out[#out + 1] = ',' end
          cfirst = false
          out[#out + 1] = string.format('%q', name) .. ':' .. curveJson(v)
        end
      end
      out[#out + 1] = '}}'
    end
    out[#out + 1] = '}'
    return table.concat(out)
  end
`)

const nEmitter = Number(host.eval(`return __countRegistered('Emitter')`))
const nTrail = Number(host.eval(`return __countRegistered('TrailEmitter')`))
const nBeam = Number(host.eval(`return __countRegistered('Beam')`))
check(
  nEmitter === textCount.Emitter,
  `Pipeline registriert ${nEmitter} EmitterBlueprints = Text-Klassifikation (${textCount.Emitter})`,
)
check(
  nTrail === textCount.TrailEmitter,
  `Pipeline registriert ${nTrail} TrailEmitterBlueprints = Text-Klassifikation (${textCount.TrailEmitter})`,
)
check(
  nBeam === textCount.Beam,
  `Pipeline registriert ${nBeam} BeamBlueprints = Text-Klassifikation (${textCount.Beam})`,
)
check(nEmitter === 2437, `2437 Emitter laut Doku (echt: ${nEmitter})`)
check(nTrail === 184, `184 TrailEmitter laut Doku (echt: ${nTrail})`)
check(nBeam === 103, `103 Beam laut Doku (echt: ${nBeam})`)

// --- Kurven-Daten nach TS ziehen ----------------------------------------------
interface RawCurve {
  XRange: number
  Keys: [number, number, number][]
}
interface RawEmitter {
  Repeattime: number
  curves: Record<string, RawCurve>
}
const emitters = host.pull<Record<string, RawEmitter>>('__emitterCurvesJson()')
const toKeys = (c: RawCurve): EfxKey[] => c.Keys.map(([x, y, z]) => ({ x, y, z }))

// --- Kurven-Inventar: genau die 21 Namen aus der Decomp ------------------------
console.log('\n== Kurven-Inventar über alle Emitter ==')
const seenNames = new Set<string>()
let curveCount = 0
for (const e of Object.values(emitters)) {
  for (const name of Object.keys(e.curves)) {
    seenNames.add(name)
    curveCount++
  }
}
const unknown = [...seenNames].filter((n) => !(EMITTER_CURVE_NAMES as readonly string[]).includes(n))
const missing = EMITTER_CURVE_NAMES.filter((n) => !seenNames.has(n))
check(
  unknown.length === 0,
  `Keine Kurve außerhalb der 21 Namen aus REmitterBlueprint::Init (Cfile:645017-645079)${unknown.length ? `: ${unknown.join(', ')}` : ''}`,
)
check(
  missing.length === 0,
  `Alle 21 Kurven-Namen kommen in den Daten vor${missing.length ? ` — fehlt: ${missing.join(', ')}` : ''}`,
)
console.log(`  (${curveCount} Kurven in ${Object.keys(emitters).length} Emittern)`)

// --- Eigenschafts-Checks für EINE Kurve ----------------------------------------
// Erwartungswerte kommen aus den ROHEN Key-Daten der .bp, nicht aus dem Sampler:
// an einem Key mit eindeutigem x ist das Ergebnis exakt y (f=0 bzw. Clamp),
// der Spread exakt ±z/2. Keys mit doppeltem x werden separat geprüft.
const EPS = 1e-9
function curveErrors(raw: RawCurve): string[] {
  const errs: string[] = []
  const rawKeys = toKeys(raw)
  const curve = makeEfxCurve({ XRange: raw.XRange, Keys: rawKeys })
  const keys = curve.Keys

  // makeEfxCurve sortiert aufsteigend (sub_5151B0, Cfile:649185-649191)
  for (let i = 1; i < keys.length; i++) {
    if (keys[i - 1]!.x > keys[i]!.x) errs.push(`Keys unsortiert bei i=${i}`)
  }

  const xCount = new Map<number, number>()
  for (const k of keys) xCount.set(k.x, (xCount.get(k.x) ?? 0) + 1)

  for (const k of keys) {
    if (xCount.get(k.x) !== 1) continue // Duplikate: eigener Check unten
    // Key-Treffer: rand=0.5 → z-Term exakt 0 → exakt y
    const got = sampleCurve(curve, k.x, R05)
    if (got !== k.y) errs.push(`sample(${k.x}) = ${got}, erwartet y = ${k.y}`)
    // Spread: (0-0.5)*z + y bzw. (1-0.5)*z + y — exakt ±z/2
    const lo = sampleCurve(curve, k.x, R0)
    const hi = sampleCurve(curve, k.x, R1)
    if (lo !== k.y - 0.5 * k.z) errs.push(`sample(${k.x}, rand=0) = ${lo}, erwartet y-z/2`)
    if (hi !== k.y + 0.5 * k.z) errs.push(`sample(${k.x}, rand=1) = ${hi}, erwartet y+z/2`)
  }

  // Clamp vor dem ersten / hinter dem letzten Key (Randkey eindeutig, sonst
  // greift der Duplikat-Check)
  const first = keys[0]!
  const last = keys[keys.length - 1]!
  if (xCount.get(first.x) === 1) {
    if (sampleCurve(curve, first.x - 7, R05) !== first.y) errs.push('kein Clamp vor dem ersten Key')
    if (sampleCurve(curve, first.x - 1e6, R05) !== first.y) errs.push('kein Clamp weit vor dem ersten Key')
    if (sampleCurve(curve, first.x - 7, R1) !== first.y + 0.5 * first.z)
      errs.push('Clamp vorn ohne Spread')
  }
  if (xCount.get(last.x) === 1) {
    if (sampleCurve(curve, last.x + 100, R05) !== last.y) errs.push('kein Clamp hinter dem letzten Key')
    if (sampleCurve(curve, last.x + 100, R0) !== last.y - 0.5 * last.z)
      errs.push('Clamp hinten ohne Spread')
  }

  // Linear zwischen benachbarten Keys (Mittel- und Viertelpunkt); z ebenso
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1]!
    const b = keys[i]!
    if (!(a.x < b.x)) continue
    const tMid = (a.x + b.x) / 2
    if (tMid > a.x && tMid < b.x) {
      const wantY = (a.y + b.y) / 2
      const gotMid = sampleCurve(curve, tMid, R05)
      if (Math.abs(gotMid - wantY) > EPS * Math.max(1, Math.abs(wantY)))
        errs.push(`Mitte [${a.x},${b.x}]: ${gotMid} statt ${wantY}`)
      // z wird MIT interpoliert (Cfile:649067): Spread an der Mitte = Mittel der z
      const wantZ2 = ((a.z + b.z) / 2) * 0.5
      const spread = sampleCurve(curve, tMid, R1) - gotMid
      if (Math.abs(spread - wantZ2) > EPS * Math.max(1, Math.abs(wantZ2)))
        errs.push(`z-Interpolation Mitte [${a.x},${b.x}]: ${spread} statt ${wantZ2}`)
    }
    const tQ = a.x + (b.x - a.x) * 0.25
    if (tQ > a.x && tQ < b.x) {
      const want = a.y + (b.y - a.y) * 0.25
      const got = sampleCurve(curve, tQ, R05)
      if (Math.abs(got - want) > EPS * Math.max(1, Math.abs(want)))
        errs.push(`Viertel [${a.x},${b.x}]: ${got} statt ${want}`)
    }
  }

  // Genau EIN rand()-Zug pro Aufruf (GetValue zieht einmal, Cfile:649038-649044
  // bzw. func_RandomFloatSafe in den anderen Zweigen)
  let calls = 0
  sampleCurve(curve, first.x, () => {
    calls++
    return 0.5
  })
  if (calls !== 1) errs.push(`rand ${calls}× gezogen statt 1×`)

  return errs
}

// --- 4 konkrete Emitter im Detail ----------------------------------------------
console.log('\n== Konkrete Emitter (Mehr-Key-Kurven, z != 0) ==')
const NAMED = [
  '/effects/emitters/cloak_ambient_01_emit.bp', // EmitRateCurve: 24 Keys, z != 0
  '/effects/emitters/build_cybran_sparks_01_emit.bp', // EmitRateCurve: 27 Keys
  '/effects/emitters/commander_teleport_01_emit.bp', // EmitRateCurve: 8 Keys, z != 0
  '/effects/emitters/adisruptor_cannon_munition_01_emit.bp', // Ein-Key-Kurven
]
for (const id of NAMED) {
  const e = emitters[id]
  check(e !== undefined, `${id} ist registriert (BlueprintId = kleingeschriebener Pfad)`)
  if (!e) continue
  let total = 0
  const errs: string[] = []
  for (const [name, raw] of Object.entries(e.curves)) {
    total++
    for (const err of curveErrors(raw)) errs.push(`${name}: ${err}`)
  }
  check(errs.length === 0, `${id}: alle ${total} Kurven exakt (${errs.length} Fehler)`)
  for (const err of errs.slice(0, 5)) console.log(`       · ${err}`)
}

// Die Mehr-Key-Voraussetzung der Auswahl wirklich prüfen (Daten, nicht Annahme)
const cloak = emitters['/effects/emitters/cloak_ambient_01_emit.bp']
if (cloak) {
  const er = cloak.curves['EmitRateCurve']
  check(
    er !== undefined && er.Keys.length >= 3 && er.Keys.some(([, , z]) => z !== 0),
    `cloak_ambient_01: EmitRateCurve hat ${er?.Keys.length ?? 0} Keys, davon z != 0 vorhanden`,
  )
}

// Belegte Einzelwerte aus der .bp (adisruptor_cannon_munition_01_emit.bp:52-57,
// 112-117): LifetimeCurve = {x=25, y=2, z=0}, StartSizeCurve y=0.162 — Clamp
// liefert die Werte über die GANZE Zeitachse.
const adis = emitters['/effects/emitters/adisruptor_cannon_munition_01_emit.bp']
if (adis) {
  const ltRaw = adis.curves.LifetimeCurve!
  const lt = makeEfxCurve({ XRange: ltRaw.XRange, Keys: toKeys(ltRaw) })
  check(
    sampleCurve(lt, 0, R05) === 2 && sampleCurve(lt, 25, R05) === 2 && sampleCurve(lt, 50, R05) === 2,
    'adisruptor: LifetimeCurve konstant 2 über [0,50] (Ein-Key-Clamp beidseitig)',
  )
  const ssRaw = adis.curves.StartSizeCurve!
  const ss = makeEfxCurve({ XRange: ssRaw.XRange, Keys: toKeys(ssRaw) })
  check(sampleCurve(ss, 10, R05) === 0.162, 'adisruptor: StartSizeCurve = 0.162 (Wert aus der .bp)')
  // Zyklus über Repeattime = 50 (adisruptor_cannon_munition_01_emit.bp:4):
  // Aufrufer-Formel fmod + Vorzeichen-Korrektur (Cfile:894655-894661)
  const R = adis.Repeattime
  check(R === 50, `adisruptor: Repeattime = 50 (echt: ${R})`)
  check(
    sampleCurve(lt, wrapEmitterTime(25 + R, R), R05) === 2 &&
      sampleCurve(lt, wrapEmitterTime(25 - R, R), R05) === 2 &&
      wrapEmitterTime(R, R) === 0 &&
      wrapEmitterTime(-0.5 * R, R) === 0.5 * R,
    'wrapEmitterTime: floored modulo über Repeattime (t+R und t−R treffen denselben Kurvenwert)',
  )
  // Repeattime = 0 (Struct-Default): fmod(t, 0) = NaN — GetValue clampt dann
  // auf den ERSTEN Key (Float-Vergleich mit NaN ist falsch, Cfile:649049)
  check(
    Number.isNaN(wrapEmitterTime(5, 0)) && sampleCurve(lt, wrapEmitterTime(5, 0), R05) === 2,
    'Repeattime = 0: NaN-Zeit clampt auf den ersten Key (kein Absturz, kein stiller 0-Wert)',
  )
}

// --- Massencheck über ALLE Emitter-Kurven ---------------------------------------
console.log('\n== Massencheck: jede Kurve jedes Emitters ==')
let massCurves = 0
let unsortedRaw = 0
let dupCurves = 0
const massErrs: string[] = []
for (const [id, e] of Object.entries(emitters)) {
  for (const [name, raw] of Object.entries(e.curves)) {
    massCurves++
    const rk = toKeys(raw)
    for (let i = 1; i < rk.length; i++) if (rk[i - 1]!.x > rk[i]!.x) { unsortedRaw++; break }
    const xs = new Set(rk.map((k) => k.x))
    if (xs.size !== rk.length) dupCurves++
    for (const err of curveErrors(raw)) {
      if (massErrs.length < 10) massErrs.push(`${id} ${name}: ${err}`)
      else massErrs.push('')
    }
  }
}
check(
  massErrs.length === 0,
  `${massCurves} Kurven aus ${Object.keys(emitters).length} Emittern: Key-Treffer, Clamp, Spread, Linearität exakt (${massErrs.filter(Boolean).length}+ Fehler)`,
)
for (const err of massErrs.filter(Boolean).slice(0, 10)) console.log(`       · ${err}`)
console.log(`  (${unsortedRaw} Kurven mit unsortierten Roh-Keys, ${dupCurves} mit doppeltem x)`)

// Duplikat-Semantik: der Scan `while (x <= t)` (Cfile:649049) landet auf dem
// LETZTEN Key mit gleichem x (Einfügen ist stabil: Cfile:649185-649191) —
// wenn die echten Daten so einen Fall haben, explizit prüfen.
let dupChecked = 0
outer: for (const e of Object.values(emitters)) {
  for (const raw of Object.values(e.curves)) {
    const rk = toKeys(raw)
    const curve = makeEfxCurve({ XRange: raw.XRange, Keys: rk })
    for (let i = 1; i < curve.Keys.length; i++) {
      if (curve.Keys[i - 1]!.x === curve.Keys[i]!.x) {
        const x = curve.Keys[i]!.x
        const lastDup = [...curve.Keys].reverse().find((k) => k.x === x)!
        check(
          sampleCurve(curve, x, R05) === lastDup.y,
          `Doppeltes x=${x}: Ergebnis ist y des LETZTEN Keys (${lastDup.y})`,
        )
        dupChecked++
        if (dupChecked >= 3) break outer
        break
      }
    }
  }
}
if (dupChecked === 0) console.log('  (kein doppeltes x in den Daten — Duplikat-Semantik nur per Decomp belegt)')

// --- Default-Kurve und leere Keys ------------------------------------------------
console.log('\n== Default-Kurve (func_MakeEmitterCurve, Cfile:649264-649271) ==')
const def = makeEfxCurve(undefined)
check(
  def.XRange === 10 && def.Keys.length === 1 && def.Keys[0]!.x === 5 && def.Keys[0]!.y === 0 && def.Keys[0]!.z === 0,
  'Fehlende Kurve → XRange=10, ein Key {5,0,0}',
)
check(
  sampleCurve(def, 0, R05) === 0 && sampleCurve(def, 123, R0) === 0 && sampleCurve(def, 5, R1) === 0,
  'Default-Kurve liefert überall exakt 0 (Spread 0)',
)
check(
  sampleCurve({ XRange: 1, Keys: [] }, 0, R05) === 0,
  '0 Keys → 0.0 (GetValue-Frühausstieg, Cfile:649030-649031)',
)
check(EMITTER_CURVE_NAMES.length === 21, '21 Kurven-Namen (REmitterBlueprint::Init)')

// --- Ergebnis --------------------------------------------------------------------
if (warnings.length > 0) {
  console.log('\n== Warnungen der Pipeline ==')
  const uniq = [...new Set(warnings.map((w) => w.split('\n')[0]?.slice(0, 110)))]
  for (const w of uniq.slice(0, 10)) console.log(`  · ${w}`)
}

console.log(
  failures === 0 ? '\nEMITTER-KURVEN BESTANDEN' : `\n${failures} CHECK(S) FEHLGESCHLAGEN`,
)
await game.close()
process.exit(failures === 0 ? 0 : 1)
