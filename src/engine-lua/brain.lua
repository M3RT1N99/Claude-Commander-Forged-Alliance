__brains = __brains or {}
function __createBrain(army, planName)
  local mod = import('/lua/aibrain.lua')
  local b = mod.AIBrain()
  b.__army = army
  b.Name = 'ARMY_' .. tostring(army)
  b:OnCreateHuman(planName or '')
  __brains[army] = b
  return b
end
function __getBrain(army)
  return __brains[army] or __createBrain(army)
end
