/**
 * ABGLEICH GEGEN DIE ORIGINALE ENGINE.
 *
 * Nimmt die generierte Liste ALLER Engine-Bindungen (docs/research/engine-api.md,
 * aus der IDA-Decomp erzeugt) und prüft für JEDE einzelne, was unsere Engine
 * daraus gemacht hat:
 *
 *   ECHT    eine Implementierung, die etwas tut
 *   NO-OP   vorhanden, tut aber nichts (moho.lua füllt fehlende Namen so auf)
 *   FEHLT   gar nicht da (ein Aufruf knallt — so soll es sein, aber es fehlt)
 *
 * Das ist die Bestandsaufnahme, nach der gearbeitet wird: ohne sie ist „was
 * fehlt noch?" eine Meinung. Sortiert nach Klasse/Bereich, mit Zählern.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/coverage-engine.ts
 *   npx tsx --import ./scripts/register-lua.mjs scripts/coverage-engine.ts --alle
 */
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LuaHost } from '../src/lua/host'
import { installEngine } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { installUiEngine, setupUi, createRootFrame } from '../src/lua/uiEngine'
import { findFiles } from '../src/vfs/glob'
import { GameFiles } from './gameFiles'

const zeigeAlle = process.argv.includes('--alle')

// --- Die Engine-Liste einlesen (generiert aus der Decomp) -------------------
// Normalise CRLF: the repo checks out with core.autocrlf=true, and the class
// lines are matched with a `$`-anchored regex that never matches a trailing \r.
const md = (await readFile('docs/research/engine-api.md', 'utf-8')).replace(/\r\n/g, '\n')

interface Abschnitt {
  vm: 'Core' | 'UI' | 'Sim'
  globals: string[]
  klassen: { name: string; methoden: string[] }[]
}

function parse(md: string): Abschnitt[] {
  const out: Abschnitt[] = []
  const teile = md.split(/^## /m).slice(1)
  for (const teil of teile) {
    const kopf = teil.split('\n')[0]!
    let vm: Abschnitt['vm'] | null = null
    if (kopf.startsWith('Core')) vm = 'Core'
    else if (kopf.startsWith('User')) vm = 'UI'
    else if (kopf.startsWith('Sim')) vm = 'Sim'
    if (!vm) continue

    const namen = (zeile: string): string[] =>
      [...zeile.matchAll(/`([A-Za-z_][A-Za-z0-9_]*)`/g)].map((m) => m[1]!)

    const globals: string[] = []
    const klassen: { name: string; methoden: string[] }[] = []
    const zeilen = teil.split('\n')
    let imGlobalsBlock = false
    for (const z of zeilen) {
      if (z.startsWith('### Globals')) {
        imGlobalsBlock = true
        continue
      }
      if (z.startsWith('### Classes')) {
        imGlobalsBlock = false
        continue
      }
      if (imGlobalsBlock && z.startsWith('`')) globals.push(...namen(z))
      const k = /^\*\*([A-Za-z_][A-Za-z0-9_]*)\*\* \(\d+\): (.*)$/.exec(z)
      if (k) klassen.push({ name: k[1]!, methoden: namen(k[2]!) })
    }
    out.push({ vm, globals, klassen })
  }
  return out
}

const abschnitte = parse(md)

// --- Beide VMs booten, exakt wie im Spiel -----------------------------------
const game = await GameFiles.open()

const sim = await LuaHost.create(game.luaFiles, () => {})
installEngine(sim)
setTerrainSource(sim, () => 20)

const ui = await LuaHost.create(game.luaFiles, () => {})
installUiEngine(ui, {
  exists: (p) => game.exists(p),
  find: (dir, pattern) => findFiles(game.paths, dir, pattern),
  textureSize: () => [64, 64],
  stringAdvance: (t, _f, s) => t.length * s * 0.5,
  fontMetrics: (_f, s) => [s * 0.8, s * 0.2],
})
createRootFrame(ui, 1920, 1080)
setupUi(ui)

// Die NO-OP-Funktion von moho.lua ist EIN Objekt — daran ist ein No-Op erkennbar.
for (const h of [sim, ui]) {
  h.eval(`
    __mohoNoop = false
    -- entity_methods.AddLocalImpulse ist in moho.lua garantiert ein No-Op.
    if moho and moho.entity_methods then
      __mohoNoop = moho.entity_methods.AddLocalImpulse
    end
  `)
}
// Und die Liste der bewusst NICHT implementierten UI-Globals (sie werfen).
// Der strenge _G wirft beim Lesen unbekannter Globals — deshalb rawget.
const uiFehlt = new Set(
  ui.pull<string[]>(`(function()
    local out = {}
    for _, n in ipairs(rawget(_G, 'NOT_IMPLEMENTED') or {}) do out[#out+1] = '"' .. n .. '"' end
    return '[' .. table.concat(out, ',') .. ']'
  end)()`),
)

type Stand = 'ECHT' | 'NO-OP' | 'FEHLT'

const globalStand = (h: LuaHost, name: string, istUi: boolean): Stand => {
  if (istUi && uiFehlt.has(name)) return 'FEHLT'
  const t = String(h.eval(`return type(rawget(_G, '${name}'))`))
  if (t === 'nil') return 'FEHLT'
  return 'ECHT'
}

// moho-Klassenname aus der Decomp → unsere moho.<x>_methods
const klassenKarte: Record<string, string> = {
  Entity: 'entity_methods',
  Unit: 'unit_methods',
  UnitWeapon: 'weapon_methods',
  Projectile: 'projectile_methods',
  Prop: 'prop_methods',
  CAiBrain: 'aibrain_methods',
  CAiNavigatorImpl: 'navigator_methods',
  CMauiControl: 'control_methods',
  CMauiBitmap: 'bitmap_methods',
  CMauiText: 'text_methods',
  CMauiCursor: 'cursor_methods',
  CMauiItemList: 'item_list_methods',
  CMauiEdit: 'edit_methods',
  CMauiScrollbar: 'scrollbar_methods',
  CMauiFrame: 'frame_methods',
  CMauiBorder: 'border_methods',
  CMauiMovie: 'movie_methods',
  CUIWorldView: 'UIWorldView',
  CameraImpl: 'camera_methods',
  CollisionBeamEntity: 'CollisionBeamEntity',
  CMauiLuaDragger: 'dragger_methods',
}

/**
 * Klassen, deren Methoden NICHT unter `moho.<x>` liegen, sondern unter einem
 * Engine-Global. Die Manipulatoren teilen sich bei uns EINE Metatable
 * (`ManipMeta`, globals.lua) statt je Art eine C++-Klasse zu haben — eine
 * benannte Reduktion, die hier eine Methode als ECHT meldet, sobald die
 * gemeinsame Implementierung sie hat.
 *
 * Ohne diese zweite Tabelle zaehlte `methodenStand` jede nicht kartierte Klasse
 * pauschal als FEHLT (`if (!key) return 'FEHLT'`). Das betraf 238 Methoden aus
 * 32 Klassen und machte die veroeffentlichte Gesamtzahl falsch.
 */
const globalKarte: Record<string, string> = {
  CAimManipulator: '__manipulatorMethods',
  CAnimationManipulator: '__manipulatorMethods',
  CRotateManipulator: '__manipulatorMethods',
  CSlideManipulator: '__manipulatorMethods',
  CThrustManipulator: '__manipulatorMethods',
  CSlaveManipulator: '__manipulatorMethods',
  CBoneEntityManipulator: '__manipulatorMethods',
  CBuilderArmManipulator: '__manipulatorMethods',
  CCollisionManipulator: '__manipulatorMethods',
  IAniManipulator: '__manipulatorMethods',
  MotorFallDown: '__manipulatorMethods',
}

/**
 * `UserUnit` ist KEINE moho-Klasse: die Engine gibt der UI eigene Objekte
 * (35 Bindungen, engine-api.md). Bei uns sind es die Methoden von
 * `__userUnitMethods` (ui-globals.lua).
 */
const userUnitStand = (methode: string): Stand => {
  const t = String(
    ui.eval(`
      local m = rawget(_G, '__userUnitMethods')
      if not m then return 'FEHLT' end
      -- UserUnitMeta ist die Metatable; die Methoden liegen in ihrem __index.
      local idx = m.__index or m
      if type(idx) ~= 'table' then return 'FEHLT' end
      return idx['${methode}'] ~= nil and 'ECHT' or 'FEHLT'
    `),
  )
  return t as Stand
}

const methodenStand = (h: LuaHost, klasse: string, methode: string): Stand => {
  if (klasse === 'UserUnit') return userUnitStand(methode)
  const glob = globalKarte[klasse]
  if (glob) {
    return String(
      h.eval(`
        local t = rawget(_G, '${glob}')
        if not t then return 'FEHLT' end
        local f = t['${methode}']
        if f == nil then return 'FEHLT' end
        if __mohoNoop and f == __mohoNoop then return 'NO-OP' end
        return 'ECHT'
      `),
    ) as Stand
  }
  const key = klassenKarte[klasse]
  if (!key) return 'FEHLT'
  const r = String(
    h.eval(`
      local c = rawget(moho, '${key}')
      if not c then return 'FEHLT' end
      local f = c['${methode}']
      if f == nil then return 'FEHLT' end
      if __mohoNoop and f == __mohoNoop then return 'NO-OP' end
      return 'ECHT'
    `),
  )
  return r as Stand
}

// --- Der Bericht ------------------------------------------------------------
interface Zeile {
  bereich: string
  name: string
  stand: Stand
  vm: string
}
const zeilen: Zeile[] = []

for (const a of abschnitte) {
  const h = a.vm === 'UI' ? ui : sim
  const istUi = a.vm === 'UI'
  for (const g of a.globals) {
    zeilen.push({ bereich: `${a.vm}-Globals`, name: g, stand: globalStand(h, g, istUi), vm: a.vm })
  }
  for (const k of a.klassen) {
    for (const m of k.methoden) {
      zeilen.push({ bereich: k.name, name: m, stand: methodenStand(h, k.name, m), vm: a.vm })
    }
  }
}

const bereiche = [...new Set(zeilen.map((z) => z.bereich))]
const zaehle = (b: string, s: Stand): number =>
  zeilen.filter((z) => z.bereich === b && z.stand === s).length

console.log('\n' + '='.repeat(78))
console.log('ABGLEICH GEGEN DIE ENGINE — was von jeder Bindung bei uns wirklich da ist')
console.log('='.repeat(78))
console.log(
  `${'Bereich'.padEnd(22)}${'gesamt'.padStart(7)}${'ECHT'.padStart(7)}${'NO-OP'.padStart(7)}` +
    `${'FEHLT'.padStart(7)}   Abdeckung`,
)
console.log('-'.repeat(78))

const sortiert = bereiche.sort((a, b) => {
  const fa = zaehle(a, 'FEHLT') + zaehle(a, 'NO-OP')
  const fb = zaehle(b, 'FEHLT') + zaehle(b, 'NO-OP')
  return fb - fa
})

let gesGesamt = 0
let gesEcht = 0
for (const b of sortiert) {
  const gesamt = zeilen.filter((z) => z.bereich === b).length
  const echt = zaehle(b, 'ECHT')
  const noop = zaehle(b, 'NO-OP')
  const fehlt = zaehle(b, 'FEHLT')
  gesGesamt += gesamt
  gesEcht += echt
  const pct = gesamt > 0 ? Math.round((echt / gesamt) * 100) : 0
  const balken = '█'.repeat(Math.round(pct / 5)).padEnd(20, '·')
  console.log(
    `${b.padEnd(22)}${String(gesamt).padStart(7)}${String(echt).padStart(7)}` +
      `${String(noop).padStart(7)}${String(fehlt).padStart(7)}   ${balken} ${pct}%`,
  )
}
console.log('-'.repeat(78))
const gesPct = Math.round((gesEcht / gesGesamt) * 100)
console.log(
  `${'GESAMT'.padEnd(22)}${String(gesGesamt).padStart(7)}${String(gesEcht).padStart(7)}` +
    `${String(zeilen.filter((z) => z.stand === 'NO-OP').length).padStart(7)}` +
    `${String(zeilen.filter((z) => z.stand === 'FEHLT').length).padStart(7)}   ${gesPct}%`,
)

// Details: was in den größten Lücken konkret fehlt.
console.log('\nDie größten Lücken im Einzelnen:')
for (const b of sortiert.slice(0, zeigeAlle ? sortiert.length : 8)) {
  const offen = zeilen.filter((z) => z.bereich === b && z.stand !== 'ECHT')
  if (offen.length === 0) continue
  console.log(`\n[${b}] ${offen.length} offen`)
  const noops = offen.filter((z) => z.stand === 'NO-OP').map((z) => z.name)
  const fehlt = offen.filter((z) => z.stand === 'FEHLT').map((z) => z.name)
  if (fehlt.length) console.log(`   FEHLT: ${fehlt.join(', ')}`)
  if (noops.length) console.log(`   NO-OP: ${noops.join(', ')}`)
}

// --- Das Gate ---------------------------------------------------------------
// Dieses Werkzeug hat DREI falsche Zahlen nacheinander geliefert:
//   "398 / 86 %"  — die Klassen-Regex war `$`-verankert, CRLF-Checkout: KEINE
//                   einzige Klassenzeile wurde geparst, NO-OP stand auf 0
//   "1149 / 57 %" — `methodenStand` gab fuer jede Klasse ausserhalb einer
//                   19-Eintraege-Karte `FEHLT` zurueck: 238 Methoden blind
//   und beide wurden veroeffentlicht, die zweite einen Commit nach dem Fix der
//   ersten.
// Deshalb misst es sich ab jetzt selbst gegen eine eingecheckte Untergrenze.
// Ein Messgeraet, dessen Ausfall niemand bemerkt, ist schlimmer als keins.
const scriptsDir = dirname(fileURLToPath(import.meta.url))
const baselinePath = join(scriptsDir, 'fixtures', 'coverage-baseline.json')
interface Baseline { minKlassenZeilen: number; minEcht: number; minNoop: number; gesamt: number }
const gesNoop = zeilen.filter((z) => z.stand === 'NO-OP').length
const klassenZeilen = abschnitte.reduce((n, a) => n + a.klassen.length, 0)

let gateFehler = 0
const gate = (ok: boolean, text: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${text}`)
  if (!ok) gateFehler++
}

console.log('\n== Bestandsaufnahme gegen die eingecheckte Untergrenze ==')
if (!existsSync(baselinePath)) {
  mkdirSync(dirname(baselinePath), { recursive: true })
  const b: Baseline = {
    minKlassenZeilen: klassenZeilen,
    minEcht: gesEcht,
    minNoop: gesNoop,
    gesamt: gesGesamt,
  }
  writeFileSync(baselinePath, `${JSON.stringify(b, null, 2)}
`)
  console.log(`  Untergrenze angelegt: ${JSON.stringify(b)}`)
} else {
  const b = JSON.parse(readFileSync(baselinePath, 'utf-8')) as Baseline
  // Der Blindflug-Fall: die Klassenzeilen verschwinden lautlos.
  gate(
    klassenZeilen >= b.minKlassenZeilen,
    `${klassenZeilen} Klassenzeilen geparst (mindestens ${b.minKlassenZeilen}) — bei 0 ist das Werkzeug blind`,
  )
  gate(gesGesamt === b.gesamt, `${gesGesamt} Bindungen insgesamt (erwartet ${b.gesamt})`)
  gate(gesEcht >= b.minEcht, `${gesEcht} ECHT (mindestens ${b.minEcht}) — eine Bindung ist verschwunden`)
  // NO-OP darf FALLEN, aber nicht steigen: neue stille No-ops sind Rueckschritt.
  gate(gesNoop <= b.minNoop, `${gesNoop} NO-OP (hoechstens ${b.minNoop}) — kein neuer stiller No-op`)
  if (gesEcht > b.minEcht || gesNoop < b.minNoop) {
    console.log(`  (Die Untergrenze darf auf echt=${gesEcht}, no-op=${gesNoop} nachgezogen werden.)`)
  }
}

await game.close()
process.exit(gateFehler === 0 ? 0 : 1)
