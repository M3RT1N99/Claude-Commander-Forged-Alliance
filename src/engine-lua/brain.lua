-- The ARMY BRAIN. The engine creates them (SimInit step 5a) and reports
-- each to the Lua: `OnCreateArmyBrain(index, brain, name, nickname)`
-- (siminit.lua:113-125). There it ends up in the global list `ArmyBrains`, which
-- SetupSession angelegt hat (siminit.lua:57).
--
-- This list is not an accessory: unit.lua:1429 (OnKilledVO) iterates it at TOD
-- each unit — `for num, aiBrain in ArmyBrains do`. Without it he dies
-- Death path in the middle of OnKilled, the DeathThread never starts and there is no
-- Wreck. (Exactly how I found it.)
--
-- We can't fully use SimInit.lua yet: its SetupSession()
-- loads the map files (`ScenarioInfo.save`/`.script`, siminit.lua:91-98),
-- and the real session start only comes with M10. Until then, lay it down
-- Engine page `ArmyBrains` exactly as OnCreateArmyBrain would —
-- Name and nickname included.
__brains = __brains or {}

-- Strict _G (config.lua:51-56): the READ ACCESS to a non-existent
-- Global throws. Therefore rawget/rawset instead of `ArmyBrains = ArmyBrains or {}`.
if rawget(_G, 'ArmyBrains') == nil then rawset(_G, 'ArmyBrains', {}) end

function __createBrain(army, planName)
  local mod = import('/lua/aibrain.lua')
  local b = mod.AIBrain()
  b.__army = army
  b.Name = 'ARMY_' .. tostring(army)
  b.Nickname = b.Name
  b:OnCreateHuman(planName or '')
  __brains[army] = b
  -- This is what OnCreateArmyBrain (siminit.lua:115-117) does.
  ArmyBrains[army] = b
  return b
end

function __getBrain(army)
  return __brains[army] or __createBrain(army)
end
