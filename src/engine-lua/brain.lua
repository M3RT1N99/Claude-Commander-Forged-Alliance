-- The ARMY BRAINS. The engine creates them (SimInit step 5a) and reports each
-- one to Lua: `OnCreateArmyBrain(index, brain, name, nickname)`
-- (siminit.lua:113-125). There it enters the global `ArmyBrains` list that
-- SetupSession created (siminit.lua:57).
--
-- This list is essential: unit.lua:1429 (OnKilledVO) iterates it when EVERY
-- unit dies — `for num, aiBrain in ArmyBrains do`. Without it, the death path
-- dies in the middle of OnKilled, DeathThread never starts, and no wreck is
-- created. (Found exactly this way.)
--
-- We cannot yet run SimInit.lua completely: its SetupSession() loads the map
-- files (`ScenarioInfo.save`/`.script`, siminit.lua:91-98), and the real
-- session start only arrives with M10. Until then, the engine side creates
-- `ArmyBrains` exactly as OnCreateArmyBrain would — including name and nickname.
__brains = __brains or {}

-- Strict _G (config.lua:51-56): READING a nonexistent global throws. Therefore
-- use rawget/rawset instead of `ArmyBrains = ArmyBrains or {}`.
if rawget(_G, 'ArmyBrains') == nil then rawset(_G, 'ArmyBrains', {}) end

function __createBrain(army, planName)
  local mod = import('/lua/aibrain.lua')
  local b = mod.AIBrain()
  b.__army = army
  b.Name = 'ARMY_' .. tostring(army)
  b.Nickname = b.Name
  b:OnCreateHuman(planName or '')
  __brains[army] = b
  -- This is what OnCreateArmyBrain does (siminit.lua:115-117).
  ArmyBrains[army] = b
  return b
end

function __getBrain(army)
  return __brains[army] or __createBrain(army)
end
