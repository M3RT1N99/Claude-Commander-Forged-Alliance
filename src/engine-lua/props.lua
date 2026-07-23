-- =====================================================================
-- PROPS — Wrecks, rocks, trees. Everything that is standing around and can be claimed.
--
-- A WRECK is not an engine thing: `Unit:CreateWreckage` (unit.lua:1076) and
-- `CreateWreckageProp` (unit.lua:1090) are pure LUA. The engine just delivers
-- `CreateProp(location, prop_blueprint_id)` (Cfile:1015366) and the one
-- Prop binding `AddBoundedProp` (Cfile:1015752). Everything else -
-- SetReclaimValues, SetPropCollision, SetMaxReclaimValues ​​— is in
-- /lua/sim/prop.lua and /lua/wreckage.lua.
--
-- The class of a prop comes from the blueprint (func_FindBlueprintScriptModule,
-- Cfile:914189): props/defaultwreckage/defaultwreckage_prop.bp:16-17 sagt
-- ausdruecklich `ScriptClass = 'Wreckage'`, `ScriptModule = '/lua/wreckage.lua'`.
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
  p.__army = -1 -- Props belong to no one (the civilian army is -1)
  p.__pos = pos
  p.__heading = 0
  -- The creation time: the wreckage shader varies its noise accordingly
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

--- TryCopyPose(from, to, stealAnimation) (unit.lua:1135 copies the pose of the
--- dying unit on its wreckage). We take over without an animation system
--- Position and orientation - that's all we can copy.
function TryCopyPose(from, to, stealAnimation)
  if not from or not to then return end
  local p = from.__pos or { 0, 0, 0 }
  to.__pos = { p[1], p[2], p[3] }
  to.__heading = from.__heading or 0
end

--- GetTerrainTypeOffset(x, z) — the elevation offset of the terrain type
--- (unit.lua:1100 puts the wreckage on the ground).
function GetTerrainTypeOffset(x, z)
  return 0
end

--- The state of all props as JSON (the renderer draws the wrecks).
--- meshBp = what prop:SetMesh got (unit.lua:1129: Display.MeshBlueprintWrecked)
--- assoc = the unit behind the wreck (unit.lua:1137: prop.AssociatedBP) —
--- The renderer loads SCM + Albedo/Normals of the unit
--- scale = prop:SetScale (unit.lua:1111: Display.UniformScale of the unit)
--- spawn = creation tick (mesh.fx: the wreckage shader needs the time)
function __readAllPropsJson()
  local parts = {}
  local n = 0
  for id, p in pairs(__props) do
    if not p.__destroyed and not p.__destroyQueued then
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

--- A mesh blueprint as JSON — the renderer uses it to get the
--- Wrack-Varianten (ShaderName 'Wreckage', SpecularName wreckage_noise.dds),
--- which created lua/system/blueprints.lua:187 (ExtractWreckageBlueprint).
function __meshBpJson(bpId)
  local bp = __registered.Mesh[bpId]
  if not bp then return 'null' end
  return __jsonVal(bp)
end
