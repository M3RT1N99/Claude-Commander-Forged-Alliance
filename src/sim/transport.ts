import type { LuaHost } from '../lua/host'
import TRANSPORT_LUA from '../engine-lua/transport.lua?raw'

/**
 * The transport -- Moho::CAiTransportImpl (the attach points, the pickup, the
 * reservations, attach and detach) and the three command tasks behind
 * UNITCOMMAND_TransportLoadUnits / TransportReverseLoadUnits /
 * TransportUnloadUnits, plus the Sim bindings IssueTransportLoad and
 * IssueTransportUnload. Engine code in the Lua VM (src/engine-lua/transport.lua);
 * the tasks tick inside __ordersTick, the ballistic drop inside __advanceMotion.
 */
export function installTransport(host: LuaHost): void {
  host.eval(TRANSPORT_LUA)
}
