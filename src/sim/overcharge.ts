import type { LuaHost } from '../lua/host'
import OVERCHARGE_LUA from '../engine-lua/overcharge.lua?raw'

/**
 * The overcharge -- UNITCOMMAND_OverCharge as the attack task pinned to the
 * unit's OverChargeWeapon (Moho::CUnitAttackTargetTask with the overcharge
 * flag, Cfile:812610-812640, 813121-813506) and the Sim binding
 * IssueOverCharge. Engine code in the Lua VM (src/engine-lua/overcharge.lua);
 * the task ticks inside __ordersTick (globals.lua), the shot is the weapon
 * script's OnFire and its economy drain the economy events.
 */
export function installOvercharge(host: LuaHost): void {
  host.eval(OVERCHARGE_LUA)
}
