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
import { LuaHost } from '../src/lua/host'
import { installEngine } from '../src/lua/engine'
import { setTerrainSource } from '../src/lua/engineGlobals'
import { installUiEngine, setupUi, createRootFrame } from '../src/lua/uiEngine'
import { findFiles } from '../src/vfs/glob'
import { GameFiles } from './gameFiles'

const zeigeAlle = process.argv.includes('--alle')

// --- Read the engine list (generated from the decomp) -------------------
const md = await readFile('docs/research/engine-api.md', 'utf-8')

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
      if (z.startsWith('### Klassen')) {
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

// --- Both VMs boot, exactly like in the game -----------------------------------
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

// The NO-OP function of moho.lua is ONE object - this indicates a no-op.
for (const h of [sim, ui]) {
  h.eval(`
    __mohoNoop = false
    -- entity_methods.AddLocalImpulse ist in moho.lua garantiert ein No-Op.
    if moho and moho.entity_methods then
      __mohoNoop = moho.entity_methods.AddLocalImpulse
    end
  `)
}
// And the list of deliberately NOT implemented UI globals (they throw).
// The strict _G throws when reading unknown globals — hence rawget.
const uiFehlt = new Set(
  ui.pull<string[]>(`(function()
    local out = {}
    for _, n in ipairs(rawget(_G, 'NOT_IMPLEMENTED') or {}) do out[#out+1] = '"' .. n .. '"' end
    return '[' .. table.concat(out, ',') .. ']'
  end)()`),
)

type Stand = 'ECHT' | 'NO-OP' | 'FEHLT'

const globalStand = (h: LuaHost, name: string, istUi: boolean): Stand => {
  if (isUi && uiMissing.has(name)) return 'FEHLT'
  const t = String(h.eval(`return type(rawget(_G, '${name}'))`))
  if (t === 'nil') return 'FEHLT'
  return 'ECHT'
}

// moho class name from the decomp → our moho.<x>_methods
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
}

/**
 * `UserUnit` is NOT a moho class: the engine gives the UI its own objects
 * (35 bindings, engine-api.md). For us it is the methods of
 * `__userUnitMethods` (ui-globals.lua).
 */
const userUnitStand = (method: string): Stand => {
  const t = String(
    ui.eval(`
      local m = rawget(_G, '__userUnitMethods')
      if not m then return 'FEHLT' end
      -- UserUnitMeta is the metatable; the methods are in their __index.
      local idx = m.__index or m
      if type(idx) ~= 'table' then return 'FEHLT' end
      return idx['${methode}'] ~= nil and 'ECHT' or 'FEHLT'
    `),
  )
  return t as stand
}

const methodStand = (h: LuaHost, class: string, method: string): Stand => {
  if (class === 'UserUnit') return userUnitStand(method)
  const key = classMap[class]
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

// --- The report ------------------------------------------------------------
interface Zeile {
  bereich: string
  name: string
  stand: Stand
  vm: string
}
const zeilen: Zeile[] = []

for (const a of abschnitte) {
  const h = a.vm === 'UI' ? ui: sim
  const isUi = a.vm === 'UI'
  for (const g of a.globals) {
    lines.push({ range: `${a.vm}-Globals`, name: g, stand: globalStand(h, g, istUi), vm: a.vm })
  }
  for (const k of a.classes) {
    for (const m of k.methods) {
      lines.push({ range: k.name, name: m, stand: methodsstand(h, k.name, m), vm: a.vm })
    }
  }
}

const ranges = [...new Set(rows.map((z) => z.range))]
const count = (b: string, s: stand): number =>
  lines.filter((z) => z.area === b && z.stand === s).length

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

let totalTotal = 0
let face = 0
for (const b of sorted) {
  const total = rows.filter((z) => z.range === b).length
  const real = count(b, 'ECHT')
  const noop = zaehle(b, 'NO-OP')
  const missing = count(b, 'FEHLT')
  totalTotal += total
  face += real
  const pct = total > 0 ? Math.round((real / total) * 100) : 0
  const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '·')
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

// Details: what is specifically missing in the biggest gaps.
console.log('\nThe biggest gaps in detail:')
for (const b of sorted.slice(0, showAll ? sorted.length : 8)) {
  const open = lines.filter((z) => z.area === b && z.state !== 'ECHT')
  if (offen.length === 0) continue
  console.log(`\n[${b}] ${offen.length} offen`)
  const noops = offen.filter((z) => z.stand === 'NO-OP').map((z) => z.name)
  const missing = open.filter((z) => z.stand === 'FEHLT').map((z) => z.name)
  if (missing.length) console.log(` MISSING: ${missing.join(', ')}`)
  if (noops.length) console.log(`   NO-OP: ${noops.join(', ')}`)
}

await game.close()
process.exit(0)
