/**
 * Zwei Lua-VMs, und jede Engine-Bindung gehört in genau einen.
 *
 * Die Engine registriert jede Bindung über `mPrevDef` in genau einer Init-Liste
 * (`scr_CoreInits` = beide VMs, `scr_UserInits` = nur UI, `sim_SimInits` = nur
 * Sim). Deshalb kennt die Sim `_c_CreateCursor` nicht und die UI kein
 * `CreateUnit`. Beides in einen VM zu legen erzeugt etwas, das es im Original
 * nie gab — und die Original-Lua darf darauf stoßen.
 *
 * Diese Prüfung liest die generierte Liste `docs/research/engine-api.md`, bootet
 * BEIDE VMs und vergleicht. Vierzehn Namen stehen in beiden Abschnitten (sie
 * sind wirklich zweimal registriert) und sind deshalb überall erlaubt.
 *
 * Gefunden hat sie: `installEngineGlobals` lädt `globals.lua` in beide VMs,
 * aber ein Teil dieser Datei ist `sim_SimInits` — 51 Sim-Bindungen standen im
 * UI-VM. Behoben in `engine-lua/ui-sim-globals.lua`.
 *
 *   npx tsx --import ./scripts/register-lua.mjs scripts/check-vm-separation.ts
 */
import { readFile } from 'node:fs/promises'
import { LuaHost } from '../src/lua/host'
import { installEngine } from '../src/lua/engine'
import { installUiEngine } from '../src/lua/uiEngine'
import { findFiles } from '../src/vfs/glob'
import { GameFiles } from './gameFiles'
import { FLAT_TEST_TERRAIN, FLAT_TEST_MAP_SIZE } from '../src/sim/terrain'

let failures = 0
const check = (ok: boolean, label: string): void => {
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}`)
  if (!ok) failures++
}

const md = (await readFile('docs/research/engine-api.md', 'utf-8')).replace(/\r\n/g, '\n')
const abschnitt = (ueberschrift: string): string => {
  const i = md.indexOf(ueberschrift)
  if (i < 0) throw new Error(`engine-api.md: Abschnitt "${ueberschrift}" fehlt`)
  const j = md.indexOf('\n## ', i + 1)
  return md.slice(i, j === -1 ? undefined : j)
}
const globalsAus = (text: string): Set<string> => {
  const i = text.indexOf('### Globals')
  if (i < 0) return new Set()
  const zeile = text.slice(i).split('\n').find((z) => z.startsWith('`'))
  return new Set(zeile ? [...zeile.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string) : [])
}

const ui = globalsAus(abschnitt('## User'))
const sim = globalsAus(abschnitt('## Sim'))
const beide = [...ui].filter((n) => sim.has(n))
const nurUi = [...ui].filter((n) => !sim.has(n))
const nurSim = [...sim].filter((n) => !ui.has(n))

console.log('== Die Bindungslisten aus engine-api.md ==')
console.log(`  ${ui.size} UI-Globals, ${sim.size} Sim-Globals, davon ${beide.length} in BEIDEN Listen`)
// Ohne geparste Listen prüft die Suite nichts und wäre immer grün.
check(ui.size > 150 && sim.size > 100, 'beide Listen geparst')
check(beide.length > 0 && beide.length < 30, `die doppelt registrierten Namen erkannt (${beide.length})`)
check(nurUi.length > 100, `${nurUi.length} Namen gehören NUR in die UI`)
check(nurSim.length > 100, `${nurSim.length} Namen gehören NUR in die Sim`)

const game = await GameFiles.open()
const simHost = await LuaHost.create(game.luaFiles, () => {})
installEngine(simHost, undefined, undefined, { heightAt: FLAT_TEST_TERRAIN, size: FLAT_TEST_MAP_SIZE })
const pfade = new Set(game.luaFiles.keys())
const uiHost = await LuaHost.create(game.luaFiles, () => {})
installUiEngine(uiHost, {
  exists: (p) => pfade.has(p.replace(/^\/+/, '').toLowerCase()),
  find: (dir, pattern) => findFiles(pfade, dir, pattern),
})

const da = (host: LuaHost, name: string): boolean => {
  try {
    return host.eval(`return rawget(_G, ${JSON.stringify(name)}) ~= nil`) === true
  } catch {
    return false
  }
}

console.log('\n== Und was wirklich in den VMs steht ==')
// Gegenprobe zuerst: findet die Prüfung überhaupt Bindungen? Sonst wäre eine
// leere Schnittmenge kein Beweis, sondern ein kaputter Boot.
const simHatSeine = nurSim.filter((n) => da(simHost, n)).length
const uiHatSeine = nurUi.filter((n) => da(uiHost, n)).length
console.log(`  Sim kennt ${simHatSeine}/${nurSim.length} seiner eigenen, UI ${uiHatSeine}/${nurUi.length}`)
check(simHatSeine > 50, `die Sim hat ihre eigenen Bindungen (${simHatSeine})`)
check(uiHatSeine > 100, `die UI hat ihre eigenen (${uiHatSeine})`)

const simInUi = nurSim.filter((n) => da(uiHost, n))
const uiInSim = nurUi.filter((n) => da(simHost, n))
if (simInUi.length) console.log(`  Sim-Bindungen im UI-VM: ${simInUi.join(', ')}`)
if (uiInSim.length) console.log(`  UI-Bindungen im Sim-VM: ${uiInSim.join(', ')}`)
check(simInUi.length === 0, `keine Sim-Bindung im UI-VM (${simInUi.length})`)
// Zwei bleiben in der Gegenrichtung, und nur EINE davon ist unsere:
//
//   SyncPlayableRect       kommt aus der ORIGINAL-Lua: `/lua/SimSync.lua` wird
//                          in der Sim per `doscript` geladen, und seine
//                          obersten Funktionen sind damit global. Die Lua ruft
//                          es ohnehin nur als Modulglied auf
//                          (scenarioframework.lua:1084). Kein Fehler von uns.
//   EntityCategoryFilterOut steht in `globals.lua`, gehört aber nach
//                          `ui-globals.lua` — offener Punkt in docs/STATUS.md.
//
// Die Schranke ist eine RATSCHE: sie darf sinken, nicht steigen.
check(uiInSim.length <= 2, `höchstens 2 UI-Bindungen im Sim-VM (${uiInSim.length})`)

simHost.close()
uiHost.close()
await game.close()
console.log(failures === 0 ? '\nVM-TRENNUNG BESTANDEN' : `\nVM-TRENNUNG: ${failures} FEHLER`)
process.exit(failures === 0 ? 0 : 1)
