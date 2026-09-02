/**
 * Die Bedrohungskarte (Moho::CInfluenceMap) — eine Karte je Armee.
 *
 * Sie ist das, woran die KI-Armee zuletzt haengen blieb: `aibrain.lua:3466`
 * fragt `GetHighestThreatPosition` und rechnet mit dem Ergebnis weiter. Die
 * Geometrie steht EINMAL fest, aus den Kartenmassen (Cfile:1017315-1017328):
 *
 *     gridSize = max(32, max(sizeX, sizeZ) / 16)      -- Ganzzahldivision
 *     mWidth = sizeX / gridSize,  mHeight = sizeZ / gridSize
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-threat-map.ts
 */
import { readFileSync } from 'node:fs'
import { LuaHost } from '../src/lua/host'
import { installEngine, beat } from '../src/lua/engine'
import { parseScmap } from '../src/formats/scmap'
import { GameFiles, GAME_DIR } from './gameFiles'

const MAP = 'SCMP_009'
let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const nah = (a: number, b: number, eps = 1e-4): boolean => Math.abs(a - b) < eps

const game = await GameFiles.open()

console.log('== Die Gittergroesse kommt aus den Kartenmassen (Cfile:1017315-1017328) ==')
// Vier Kartengroessen durch dieselbe Formel — mit einem FLACHEN Gelaende, weil
// hier nur die Masse zaehlen. 512 ist der interessante Fall: 512/16 = 32 ist
// NICHT groesser als 32, also bleibt es bei 32.
for (const [groesse, gridSize, zellen] of [
  [256, 32, 8],
  [512, 32, 16],
  [1024, 64, 16],
  [2048, 128, 16],
] as const) {
  const h = await LuaHost.create(game.luaFiles, () => {})
  installEngine(h, undefined, undefined, {
    heightAt: () => 20,
    size: { width: groesse, height: groesse },
  })
  const info = String(h.eval(`local g, w, hh = __influenceGridInfo(1) return g .. ',' .. w .. 'x' .. hh`))
  check(info === `${gridSize},${zellen}x${zellen}`, `${groesse} -> gridSize ${gridSize}, ${zellen}x${zellen} (${info})`)
  h.close()
}

// Ab hier die ECHTE Karte, mit der Reihenfolge der Engine: das Gelaende steht,
// BEVOR die Armeen entstehen (die Bedrohungskarte wird in der Armee-Erzeugung
// angelegt und liest dabei das Heightfield, Cfile:1017321-1017333).
const scmap = parseScmap(new Uint8Array(readFileSync(`${GAME_DIR}/maps/${MAP}/${MAP}.scmap`)))
const stride = scmap.width + 1
const luaErrors: string[] = []
// Die KI-Armee laeuft in dieser Sitzung mit, und sie hat zwei bekannte
// Haltepunkte, die nichts mit der Bedrohungskarte zu tun haben (die Ratsche
// darueber fuehrt `verify-ai-platoon.ts`). Alles ANDERE ist hier ein Fehler.
const KI_HALTE = /scenarioplatoonai\.lua:66|aiarchetype-managerloader\.lua:51/
const host = await LuaHost.create(game.luaFiles, (level, msg) => {
  const t = String(msg)
  if (level === 'WARN' && /Fehler|error/i.test(t) && !KI_HALTE.test(t)) luaErrors.push(t)
})
const session = {
  type: 'skirmish' as const,
  map: `/maps/${MAP}/${MAP}.scmap`,
  scenarioFile: `/maps/${MAP}/${MAP}_scenario.lua`,
  armies: [
    { name: 'ARMY_1', index: 1, faction: 1, human: true },
    { name: 'ARMY_2', index: 2, faction: 1, human: false },
  ],
}
const engine = installEngine(host, undefined, session, {
  heightAt: (x, z) => {
    const xi = Math.max(0, Math.min(scmap.width, Math.round(x)))
    const zi = Math.max(0, Math.min(scmap.height, Math.round(z)))
    return (scmap.heightmap[zi * stride + xi] ?? 0) * scmap.heightScale
  },
  size: {
    width: scmap.width,
    height: scmap.height,
    waterElevation: scmap.water.hasWater ? scmap.water.elevation : undefined,
  },
})
const q = (code: string): unknown => host.eval(code)

console.log('\n== Weltposition <-> Zelle (Cfile:1034865-1034887, 1035855-1035859) ==')
check(
  String(q(`local g, w, h = __influenceGridInfo(1) return g .. ',' .. w .. 'x' .. h`)) === '64,16x16',
  'SCMP_009 ist 1024 gross -> gridSize 64, 16x16 Zellen',
)
// Der Mittelpunkt der Zelle (10,5) ist x = 64/2 + 10*64 = 672, z = 32 + 5*64 = 352.
// Die Y-Komponente ist IMMER exakt 0 — die Engine fragt hier kein Gelaende ab.
q(`__assignThreatAtPosition(1, {672, 0, 346}, 500, 0, 'Structures')`)
const hp = String(
  q(`local p, t = ArmyBrains[1]:GetHighestThreatPosition(0, true, 'Structures', 1)
     return string.format('%d,%d,%d|%.1f|%s', p[1], p[2], p[3], t, tostring(getmetatable(p) ~= nil))`),
)
check(hp === '672,0,352|500.0|true', `Zellenmitte 672/0/352, Bedrohung 500, Vector-Metatabelle (${hp})`)
check(
  q(`local p = ArmyBrains[1]:GetHighestThreatPosition(0, true, 'Structures', 1)
     return p.x == p[1] and p.y == p[2] and p.z == p[3]`) === true,
  'und .x/.y/.z lesen dieselben Felder 1/2/3 (die Vector-Metatabelle, Cfile:596759-596764)',
)
check(
  Number(q(`local p, t = ArmyBrains[1]:GetHighestThreatPosition(0, true, 'Structures', 1) return t`)) === 500,
  'ZWEI Rueckgabewerte: Position und Bedrohung (Cfile:740710-740718)',
)

console.log('\n== Schreiben und Lesen benutzen NICHT dasselbe Feld ==')
// Cfile:1035574-1035581: `Overall` teilt sich den Fall mit `Unknown` und
// schreibt nach `unknownInfluence`. Cfile:1034567: `GetThreat(Overall)` liest
// `overallInfluence`. Das ist eine Eigenart des echten Spiels.
q(`__assignThreatAtPosition(1, {100, 0, 100}, 42, 0, nil)`)
check(
  Number(q(`return __influenceCellThreat(1, 100, 100, 'Unknown')`)) === 42,
  "ohne Typ (= 'Overall') landet der Wert in unknownInfluence",
)
check(
  Number(q(`return __influenceCellThreat(1, 100, 100, 'Overall')`)) === 0,
  'und eine Abfrage mit Overall sieht ihn NICHT (Cfile:1034567 liest overallInfluence)',
)
check(
  Number(q(`return ArmyBrains[1]:GetThreatAtPosition({100,0,100}, 0, true, 'Unknown', 1)`)) === 42,
  "nur 'Unknown' findet ihn wieder",
)

console.log('\n== Der Ring zaehlt ZELLEN, nicht Welteinheiten (Cfile:1035045-1035081) ==')
q(`__assignThreatAtPosition(1, {672, 0, 346}, 100, 0, 'Naval')`)
q(`__assignThreatAtPosition(1, {672 + 64, 0, 346}, 7, 0, 'Naval')`)
check(
  Number(q(`return ArmyBrains[1]:GetThreatAtPosition({672,0,346}, 0, true, 'Naval', 1)`)) === 100,
  'ring 0 summiert genau EINE Zelle (100)',
)
check(
  Number(q(`return ArmyBrains[1]:GetThreatAtPosition({672,0,346}, 1, true, 'Naval', 1)`)) === 107,
  'ring 1 summiert 3x3 Zellen und findet die Nachbarzelle mit (107)',
)

console.log('\n== Der Armee-Index ist 1-basiert, und -1 ist ein FEHLER ==')
// Cfile:740435-740445. `aiattackutilities.lua:245` uebergibt -1 in der Absicht
// „alle Armeen"; die Engine rechnet -1-1 = -2 und wirft. Der Pfad ist im
// Original tot, und er muss bei uns genauso tot sein.
check(
  q(`return (pcall(function()
       ArmyBrains[1]:GetThreatAtPosition({100,0,100}, 0, true, 'Overall', -1)
     end))`) === false,
  'armyIndex -1 wirft (Invalid army index passed in to GetThreatAtPosition)',
)
check(
  q(`return (pcall(function()
       ArmyBrains[1]:GetThreatAtPosition({100,0,100}, 0, true, 'GibtEsNicht', 1)
     end))`) === false,
  'ein unbekannter Bedrohungstyp wirft (SCR_GetEnum, Cfile:598371-598416)',
)
check(
  Number(q(`return ArmyBrains[1]:GetThreatAtPosition({100,0,100}, 0, true, 'THREATTYPE_Unknown', 1)`)) === 42,
  'das Praefix THREATTYPE_ ist erlaubt und die Schreibweise egal (memicmp)',
)

console.log('\n== GetThreatsAroundPosition: {x, z, bedrohung}, absteigend, veraenderbar ==')
const um = host.pull<[number, number, number][]>(`(function()
  local t = ArmyBrains[1]:GetThreatsAroundPosition({672,0,346}, 1, true, 'Naval', 1)
  local teile = {}
  for _, v in ipairs(t) do teile[#teile+1] = string.format('[%d,%d,%.9g]', v[1], v[2], v[3]) end
  return '[' .. table.concat(teile, ',') .. ']'
end)()`)
// Nur Zellen mit echter Bedrohung stehen in der Liste (`if (Threat > 0.0)`,
// Cfile:1035944) — nicht alle neun des Quadrats. Sonst sortierte die KI ueber
// Nullen, und `[1]` waere nicht mehr das Maximum.
check(um.length === 2, `von 3x3 Zellen nur die zwei mit Bedrohung (${um.length})`)
const [erster, zweiter] = um
check(
  erster !== undefined && zweiter !== undefined && erster[2] === 100 && zweiter[2] === 7,
  'nach Bedrohung absteigend (100, dann 7)',
)
check(
  erster !== undefined && erster[0] === 672 && erster[1] === 352,
  `der erste Eintrag ist {x, z, bedrohung} — die Mitte der Zelle (${erster?.[0]},${erster?.[1]})`,
)
check(
  q(`local t = ArmyBrains[1]:GetThreatsAroundPosition({672,0,346}, 1, true, 'Naval', 1)
     t[1][3] = 999 return t[1][3] == 999`) === true,
  'und die Eintraege sind veraenderbar (aiattackutilities.lua:327 schreibt zurueck)',
)

console.log('\n== Und die KI schreibt beim Start selbst hinein ==')
// `AIBrain:OnCreateAI` ruft `AddInitialEnemyThreat(200, 0.005)` fuer jedes
// Skirmish (aibrain.lua:398). Das lief bei der ARMEE-ERZEUGUNG, also lange vor
// dieser Zeile — und ohne `TeamSpawn == 'fixed'` und ein `Team`-Feld im
// ArmySetup taete es still gar nichts (aibrain.lua:3610/3618).
const startThreat = Number(
  q(`local x, z = ArmyBrains[1]:GetArmyStartPos() return __influenceCellThreat(2, x, z, 'Unknown')`),
)
check(startThreat >= 200, `die KI-Armee hat 200 Bedrohung am Start von ARMY_1 eingetragen (${startThreat})`)
check(
  Number(q(`local x, z = ArmyBrains[2]:GetArmyStartPos() return __influenceCellThreat(2, x, z, 'Unknown')`)) === 0,
  'und NICHTS an ihrem eigenen Start (aibrain.lua:3618 ueberspringt die eigene Armee)',
)

console.log()
console.log('== GetThreatBetweenPositions laeuft die Linie ab, Radius 0 je Schritt ==')
// Cfile:1035672-1035760. Der einzige Aufrufer im Spiel ist
// `aiattackutilities.lua:1233` (GeneratePath) und uebergibt im dritten Feld nil.
// Drei Zellen einer Reihe: 672 (Zelle 10), 736 (11), 800 (12).
q(`__assignThreatAtPosition(1, {736, 0, 346}, 3, 0, 'Artillery')`)
q(`__assignThreatAtPosition(1, {800, 0, 346}, 5, 0, 'Artillery')`)
q(`__assignThreatAtPosition(1, {672, 0, 346}, 11, 0, 'Artillery')`)
check(
  Number(q(`return ArmyBrains[1]:GetThreatBetweenPositions({672,0,346}, {800,0,346}, nil, 'Artillery', 1)`)) === 19,
  'die drei Zellen der Strecke aufsummiert: 11 + 3 + 5 = 19',
)
check(
  Number(q(`return ArmyBrains[1]:GetThreatBetweenPositions({672,0,346}, {672,0,346}, nil, 'Artillery', 1)`)) === 11,
  'gleiche Start- und Zielzelle: genau EIN Schritt (11)',
)
check(
  Number(q(`return ArmyBrains[1]:GetThreatBetweenPositions({800,0,346}, {672,0,346}, nil, 'Artillery', 1)`)) === 19,
  'und rueckwaerts dasselbe',
)

console.log('\n== Zerfall: alle 30 Ticks je Armee (Cfile:1018010-1018011) ==')
q(`__assignThreatAtPosition(1, {200, 0, 200}, 100, 0.1, 'Commander')`)
check(
  Number(q(`return __influenceCellThreat(1, 200, 200, 'Commander')`)) === 100,
  'frisch geschrieben: 100 (der Zerfallswert ist 100 * 0.1 = 10)',
)
q(`__influenceTick(0)`)
check(
  nah(Number(q(`return __influenceCellThreat(1, 200, 200, 'Commander')`)), 90),
  'nach einem Zerfallsschritt: 90 (threat - decay, Cfile:1034250-1034262)',
)
q(`__influenceTick(1)`)
check(
  nah(Number(q(`return __influenceCellThreat(1, 200, 200, 'Commander')`)), 90),
  'ein Tick fuer eine ANDERE Armee laesst sie unberuehrt (der Versatz ist Absicht)',
)

for (let i = 0; i < 30; i++) beat(engine)
check(luaErrors.length === 0, `keine Lua-Fehler${luaErrors[0] ? `: ${luaErrors[0].slice(0, 160)}` : ''}`)

host.close()
await game.close()
console.log(failures === 0 ? '\nBEDROHUNGSKARTE BESTANDEN' : `\nBEDROHUNGSKARTE: ${failures} FEHLER`)
process.exit(failures === 0 ? 0 : 1)
