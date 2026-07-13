import type { LuaHost } from './host'
import MOHO_LUA from '../engine-lua/moho.lua?raw'

/**
 * Installs the `moho` API (the engine's C++ base classes) into the VM.
 * The implementation lives in src/engine-lua/moho.lua — Lua belongs in .lua
 * files, not in TS template literals.
 */
export function installMoho(host: LuaHost): void {
  host.eval(MOHO_LUA)
}
