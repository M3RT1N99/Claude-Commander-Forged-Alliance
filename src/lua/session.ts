import type { LuaHost } from './host'
import SESSION_LUA from '../engine-lua/session.lua?raw'

/**
 * Loader for `src/engine-lua/session.lua` — the session-start steps that
 * `SetupSession()` and `BeginSession()` perform in the original.
 *
 * Nothing but a loader: the sequence itself is original Lua and lives in the
 * `.lua` file, because CLAUDE.md forbids Lua in TypeScript template literals.
 */
export function installSession(host: LuaHost): void {
  host.eval(SESSION_LUA)
}
