/**
 * CAiPersonality — die Personality, die zu JEDEM Brain gehoert.
 *
 * `CAiBrain::CAiBrain` legt sie an (Cfile:724303-724309) und ruft sofort
 * `CAiPersonality::ReadData` (Cfile:724385). `ReadData` (Cfile:768303-769100)
 * importiert `/lua/aipersonality.lua`, holt `AIPersonalityTemplate` und sucht
 * den Eintrag mit 33 Feldern, dessen Feld 1 case-insensitiv `"AverageJoe"` ist
 * — der Name steht fest im Binaercode (Cfile:768539-768541).
 *
 * Ohne sie stirbt jede KI-Armee zweimal: `aibrain.lua:1373`
 * (CalculateLayerPreference, `personality:GetAirUnitsEmphasis()`) und
 * `aibrain.lua:878` (der Plan-Thread, `personality:AdjustDelay(20, 4)`).
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/verify-ai-personality.ts
 */
import { LuaHost } from '../src/lua/host'
import { installEngine } from '../src/lua/engine'
import { GameFiles } from './gameFiles'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}
const nah = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps

const game = await GameFiles.open()
const host = await LuaHost.create(game.luaFiles, () => {})
installEngine(host)
const q = (code: string): unknown => host.eval(code)

console.log('== Jeder Brain hat eine Personality (CAiBrain::CAiBrain, Cfile:724303) ==')
check(q(`return type(ArmyBrains[1]:GetPersonality())`) === 'table', 'GetPersonality() liefert ein Objekt')
check(
  q(`return ArmyBrains[1]:GetPersonality() ~= ArmyBrains[2]:GetPersonality()`) === true,
  'und jede Armee hat ihre EIGENE — der Konstruktor legt sie je Brain an',
)
check(
  q(`return ArmyBrains[1]:GetPersonality():GetPersonalityName()`) === 'AverageJoe',
  "ReadData nimmt 'AverageJoe' — der Name ist einkompiliert (Cfile:768539)",
)
check(nah(Number(q(`return ArmyBrains[1]:GetPersonality():GetDifficulty()`)), 0.5),
  'mDifficulty = 0.5 aus dem Konstruktor (Cfile:768194); nichts sonst setzt es')

console.log('\n== Die Werte kommen aus /lua/aipersonality.lua, nicht aus der Luft ==')
// Der AverageJoe-Eintrag der Original-Datei, direkt aus der Lua gelesen — die
// Suite vergleicht die Getter gegen DIE Tabelle, nicht gegen abgeschriebene
// Zahlen.
const eintrag = host.pull<Record<string, [number, number]>>(`(function()
  local t
  for _, v in ipairs(import('/lua/aipersonality.lua').AIPersonalityTemplate) do
    if type(v) == 'table' and #v == 33 and string.lower(v[1]) == 'averagejoe' then t = v break end
  end
  local idx = { ArmySize = 3, PlatoonSize = 4, AttackFrequency = 5, AirUnitsEmphasis = 19,
                TankUnitsEmphasis = 20, SeaUnitsEmphasis = 22, ChatFrequency = 33 }
  local teile = {}
  for name, i in pairs(idx) do
    teile[#teile + 1] = string.format('%q:[%.9g,%.9g]', name, t[i][1], t[i][2])
  end
  return '{' .. table.concat(teile, ',') .. '}'
end)()`)
check(Object.keys(eintrag).length === 7, `${Object.keys(eintrag).length} Felder aus der Vorlage gelesen`)
const d = 0.5
for (const [name, [min, max]] of Object.entries(eintrag)) {
  const wert = Number(q(`return ArmyBrains[1]:GetPersonality():Get${name}()`))
  const erwartet = (1 - d) * min + max * d
  check(nah(wert, erwartet), `Get${name}() = ${wert} = (1-d)*${min} + ${max}*d (Cfile:770438-770439)`)
}

console.log('\n== AdjustDelay (Cfile:770360-770392) ==')
// `basis + (int)((1 - d) * (basis * faktor))`, ganzzahlig multipliziert und
// abgeschnitten. Der Plan-Thread ruft genau AdjustDelay(20, 4) (aibrain.lua:878).
for (const [basis, faktor] of [[20, 4], [1, 1], [7, 3], [0, 5]] as const) {
  const wert = Number(q(`return ArmyBrains[1]:GetPersonality():AdjustDelay(${basis}, ${faktor})`))
  const erwartet = basis + Math.trunc((1 - d) * (basis * faktor))
  check(wert === erwartet, `AdjustDelay(${basis}, ${faktor}) = ${wert} (erwartet ${erwartet})`)
}
check(
  q(`return (pcall(function() return ArmyBrains[1]:GetPersonality():AdjustDelay('x', 4) end))`) === false,
  "eine Zeichenkette wirft — die Engine verlangt 'integer' (Cfile:770372)",
)

console.log('\n== Die beiden Listen sind Kopien, keine Referenz ==')
check(q(`return type(ArmyBrains[1]:GetPersonality():GetFavouriteStructures())`) === 'table',
  'GetFavouriteStructures() liefert eine Tabelle (AssignNewTable, Cfile:771170)')
check(
  q(`local p = ArmyBrains[1]:GetPersonality()
     return p:GetFavouriteUnits() ~= p:GetFavouriteUnits()`) === true,
  'und jeder Aufruf eine NEUE — der Aufrufer darf sie nicht der Engine unterschieben',
)

console.log('\n== Und damit laufen die beiden Stellen, an denen die KI starb ==')
check(
  q(`return (pcall(function() return ArmyBrains[1]:CalculateLayerPreference() end))`) === true,
  'aibrain.lua:1368 CalculateLayerPreference laeuft durch (vier Emphasis-Getter)',
)

host.close()
await game.close()
console.log(failures === 0 ? '\nAI-PERSONALITY BESTANDEN' : `\nAI-PERSONALITY: ${failures} FEHLER`)
process.exit(failures === 0 ? 0 : 1)
