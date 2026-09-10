import type { LuaHost } from '../lua/host'
import DIVE_LUA from '../engine-lua/dive.lua?raw'

/**
 * The dive -- UNITCOMMAND_Dive of a surfacing submarine: the motion's
 * target layer flips (DispatchTask Cfile:830531-830543,
 * CUnitMotion::SetNewTargetLayer 965234-965274), HandleDivingAndSurfacing
 * (971735-971812) and SnapToWater (970979-971036) move the boat, and the
 * Sim binding IssueDive (1008189-1008260). Engine code in the Lua VM
 * (src/engine-lua/dive.lua); the tick runs inside __advanceMotion
 * (motion.lua), the command through __ordersTick (globals.lua).
 */
export function installDive(host: LuaHost): void {
  host.eval(DIVE_LUA)
}
