import type { LuaHost } from './host'
import DAMAGE_LUA from '../engine-lua/damage.lua?raw'
import PROJECTILES_LUA from '../engine-lua/projectiles.lua?raw'
import PROPS_LUA from '../engine-lua/props.lua?raw'
import WEAPONS_LUA from '../engine-lua/weapons.lua?raw'

/**
 * Der KAMPF-Teil der Engine: Schaden, Projektile, Props, Waffen-Tasks.
 *
 * Wer was tut (docs/research/combat-projectiles.md §1):
 *   Engine  Ziel finden, zielen, Feuertakt, Projektil erzeugen, Flugbahn,
 *           Treffer erkennen, Schaden verrechnen (Rüstung/Handicap), töten
 *   Lua     Salven-Zustandsmaschine (defaultweapons.lua), Schadensmenge
 *           (Projectile:DoDamage), Todes-Thread, Wrack (Unit:CreateWreckage)
 *
 * TS ist hier nur Loader — der Code steht in src/engine-lua/*.lua.
 */
export function installCombat(host: LuaHost): void {
  host.eval(DAMAGE_LUA)
  host.eval(PROJECTILES_LUA)
  host.eval(PROPS_LUA)
  host.eval(WEAPONS_LUA)
}

/**
 * Die Kampf-Phasen eines Beats, in der Reihenfolge der Engine:
 *
 *   Moho::Sim::AdvanceBeat (Cfile:1076363)
 *     → CArmyImpl::OnTick → die Waffen-Tasks je Armee (Zielsuche, Feuertakt)
 *     → CTaskStage::DoFrame  (die Lua-Coroutinen — die Salven-FSM)
 *     → Projektile bewegen, Kollision prüfen
 *     → Löschwarteschlange leeren (OnDestroy), Cfile:1076638
 *
 * Der Waffen-Tick läuft VOR der Thread-Stage: `OnFire` wechselt nur den Zustand
 * der FSM; der Schuss selbst passiert im Coroutinen-Slice desselben Beats.
 */
export function weaponTick(host: LuaHost): void {
  host.eval('__weaponTick()')
}

export function projectileTick(host: LuaHost): void {
  host.eval('__projectileTick()')
}

export function flushDeletions(host: LuaHost): void {
  host.eval('__flushDeletions()')
}
