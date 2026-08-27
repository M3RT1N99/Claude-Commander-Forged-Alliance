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

-- A LOOKUP, never a creator. `__createBrain` is called once per DECLARED army
-- by setupSession (session.ts:86) — the engine's SimInit step 5a. Every retail
-- binding that takes an army index validates it against `mArmiesList` and
-- errors instead of inventing a player: `CreateUnit` at Cfile:980706-980713 and
-- the position/threat bindings at Cfile:980344-980352 both raise
-- "Invalid army index; must be >= 1 and < %d but got %d.".
--
-- Auto-vivifying here would hand out a brain with faction 1, name ARMY_<n> and
-- a fresh economy, register it in the global `ArmyBrains` that unit.lua:1429
-- walks on EVERY unit death, and look entirely valid — the exact "silently
-- behaves as a valid engine object" case the fail-loudly rule forbids.
function __getBrain(army)
  local b = __brains[army]
  if b then return b end
  local maxArmy = 0
  for _ in pairs(__brains) do maxArmy = maxArmy + 1 end
  -- The message is the engine's, off-by-one wording included.
  error(string.format('Invalid army index; must be >= 1 and < %d but got %s',
    maxArmy, tostring(army)), 2)
end
