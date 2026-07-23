-- =====================================================================
-- PROPS — wrecks, rocks, trees. Everything that stands around and can be reclaimed.
--
-- A WRECK is not an engine object: `Unit:CreateWreckage` (unit.lua:1076) and
-- `CreateWreckageProp` (unit.lua:1090) are pure LUA. The engine supplies only
-- `CreateProp(location, prop_blueprint_id)` (Cfile:1015366) and the single
-- prop binding `AddBoundedProp` (Cfile:1015752). Everything else —
-- SetReclaimValues, SetPropCollision, SetMaxReclaimValues — is in
-- /lua/sim/prop.lua and /lua/wreckage.lua.
--
-- A prop's class comes from the blueprint (func_FindBlueprintScriptModule,
-- Cfile:914189): props/defaultwreckage/defaultwreckage_prop.bp:16-17 explicitly
-- specifies `ScriptClass = 'Wreckage'`, `ScriptModule = '/lua/wreckage.lua'`.
-- Without blueprint fields, the default applies: /lua/sim/prop.lua, class "Prop".
--
-- STANDARD-LUA 5.4.
-- =====================================================================

__props = {}

local function propClass(bp)
  local path = bp.ScriptModule
  if (not path or path == '') then
    local src = bp.Source or bp.BlueprintId or ''
    local cut = string.match(src, '^(.*)_[^_/]*$')
    if cut then path = cut .. '_script.lua' end
  end
  if path and path ~= '' and exists(path) then
    local ok, mod = pcall(import, path)
    if ok and mod then
      local cls = mod[bp.ScriptClass or 'TypeClass']
      if cls then return cls end
    end
  end
  return import('/lua/sim/Prop.lua').Prop
end

--- CreateProp(location, prop_blueprint_id) (Cfile:1015366).
function CreateProp(location, bpId)
  local key = string.lower(tostring(bpId))
  local bp = __registered.Prop[key]
  if not bp then
    error('CreateProp: Invalid blueprint ' .. tostring(bpId), 2)
  end
  local pos = __vec3(location)
  local cls = propClass(bp)
  local p = cls()

  local id = __nextUnitId
  __nextUnitId = id + 1

  p.__isProp = true
  p.__bp = bp
  p.__id = id
  p.__army = -1 -- Props belong to nobody (the civilian army is -1).
  p.__pos = pos
  p.__heading = 0
  -- Creation time: the wreckage shader varies its noise with it
  -- (mesh.fx WreckageVS: material.x = creation time, PS: frac(0.01*depth.y)).
  p.__spawnTick = __gameTick or 0
  p.__bones = { names = {}, xform = {}, index = {} }
  p.__health = (bp.Defense and bp.Defense.MaxHealth) or 1
  p.__fraction = 1
  p.Trash = TrashBag()
  __props[id] = p

  if p.OnCreate then
    local ok, err = pcall(function() p:OnCreate() end)
    if not ok then WARN('Prop ' .. tostring(bp.BlueprintId) .. ': OnCreate — ' .. tostring(err)) end
  end
  return p
end

--- CreatePropHPR(bp, x, y, z, heading, pitch, roll) (Cfile:1015219).
function CreatePropHPR(bpId, x, y, z, heading, pitch, roll)
  local p = CreateProp({ x, y, z }, bpId)
  p.__heading = heading or 0
  return p
end

-- =====================================================================
-- MAP PROPS — the engine creates them in Sim::Setup step 7, after the
-- armies and BEFORE Lua BeginSession (Cfile:1072041-1072105): one
-- PROP_Create per scmap entry. Health = Defense.Health, reclaim values
-- from Economy.ReclaimMassMax/EnergyMax (Prop ctor, Cfile:1013859-1013927).
-- Stock props never write pathfinding occupancy: every retail prop bp has
-- footprint size 0, and the occupancy call is additionally gated on
-- reclaim value > 0 (Cfile:1013912-1013923) — so there is NOTHING to do
-- for movement here. "Physics.BlockPath" is not an engine field at all
-- (zero decomp hits).
-- =====================================================================

-- Map-prop indices whose props died since the last drain — the browser
-- keeps map props in one InstancedMesh and hides these instances.
__removedMapProps = {}

--- Spawn one map prop (called in a chunked loop from the worker boot).
--- Unknown blueprints WARN once per path and are skipped — exactly what a
--- failed GetPropBlueprint lookup amounts to.
__mapPropMissing = {}
function __spawnMapProp(index, bpId, x, y, z, heading)
  local key = string.lower(tostring(bpId))
  if not __registered.Prop[key] then
    if not __mapPropMissing[key] then
      __mapPropMissing[key] = true
      WARN('map prop blueprint not registered: ' .. tostring(bpId))
    end
    return
  end
  local p = CreatePropHPR(key, x, y, z, heading or 0, 0, 0)
  p.__mapIndex = index
end

--- TryCopyPose(from, to, stealAnimation) (unit.lua:1135 copies the dying unit's
--- pose to its wreck). Without an animation system, copy position and heading —
--- there is nothing more to copy here.
function TryCopyPose(from, to, stealAnimation)
  if not from or not to then return end
  local p = from.__pos or { 0, 0, 0 }
  to.__pos = { p[1], p[2], p[3] }
  to.__heading = from.__heading or 0
end

--- GetTerrainTypeOffset(x, z) — the terrain-type height offset
--- (unit.lua:1100 uses it to place the wreck on the ground).
function GetTerrainTypeOffset(x, z)
  return 0
end

--- The state of all props as JSON (the renderer draws the wrecks).
--- meshBp  = what prop:SetMesh received (unit.lua:1129: Display.MeshBlueprintWrecked)
--- assoc   = the unit behind the wreck (unit.lua:1137: prop.AssociatedBP) —
---           the renderer uses it to load the unit's SCM + albedo/normals
--- scale   = prop:SetScale (unit.lua:1111: Display.UniformScale of the unit)
--- spawn   = creation tick (mesh.fx: the wreckage shader needs the time)
function __readAllPropsJson()
  local parts = {}
  local n = 0
  for id, p in pairs(__props) do
    if p.__destroyed or p.__destroyQueued then
      -- dying props leave the snapshot; map-prop removal reporting lives
      -- in __drainRemovedMapPropsJson (it must work without a snapshot).
    elseif p.__mapIndex == nil then
      -- Map props are NOT serialized per beat: the browser already draws
      -- them from the scmap list (one InstancedMesh per blueprint); only
      -- sim-born props (wrecks) go through this snapshot.
      n = n + 1
      local pos = p.__pos
      parts[n] = string.format(
        '{"id":%d,"bp":%q,"x":%.6g,"y":%.6g,"z":%.6g,"heading":%.6g,"scale":%.6g,"spawn":%d%s%s}',
        id, tostring(p.__bp.BlueprintId), pos[1], pos[2], pos[3], p.__heading or 0,
        p.__drawScale or 1, p.__spawnTick or 0,
        p.__meshBp and string.format(',"meshBp":%q', tostring(p.__meshBp)) or '',
        p.AssociatedBP and string.format(',"assoc":%q', tostring(p.AssociatedBP)) or ''
      )
    end
  end
  return '[' .. table.concat(parts, ',') .. ']'
end

--- Drain the removed-map-prop indices (one JSON array per beat). A dying
--- MAP prop reports its instance index exactly once so the browser can
--- hide it in the instanced renderer.
function __drainRemovedMapPropsJson()
  for id, p in pairs(__props) do
    if p.__mapIndex and (p.__destroyed or p.__destroyQueued) and not p.__removalReported then
      p.__removalReported = true
      __removedMapProps[#__removedMapProps + 1] = p.__mapIndex
    end
  end
  if __removedMapProps[1] == nil then return '[]' end
  local out = '[' .. table.concat(__removedMapProps, ',') .. ']'
  for i = #__removedMapProps, 1, -1 do __removedMapProps[i] = nil end
  return out
end

--- A mesh blueprint as JSON — the renderer uses it to get wreckage variants
--- (ShaderName 'Wreckage', SpecularName wreckage_noise.dds) created by
--- lua/system/blueprints.lua:187 (ExtractWreckageBlueprint).
function __meshBpJson(bpId)
  local bp = __registered.Mesh[bpId]
  if not bp then return 'null' end
  return __jsonVal(bp)
end
