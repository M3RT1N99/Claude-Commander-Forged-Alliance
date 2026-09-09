import type { LuaHost } from '../lua/host'
import CAPTURE_LUA from '../engine-lua/capture.lua?raw'

/**
 * The capture task -- Moho::CUnitCaptureTask (AiUnitCapture.cpp,
 * Cfile:826337-827453) behind UNITCOMMAND_Capture and the Sim binding
 * IssueCapture. Engine code in the Lua VM (src/engine-lua/capture.lua); the
 * task ticks inside __ordersTick (globals.lua), its own CEconRequest lives in
 * the army economy (economy.ts, the task requests), and the transfer of a
 * captured unit is ChangeUnitArmy (units.lua).
 */
export function installCapture(host: LuaHost): void {
  host.eval(CAPTURE_LUA)
}
